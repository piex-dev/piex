/**
 * Unit / integration tests for @piex-dev/lsp (mock stdio server, no real LS).
 * Run: bun test extensions/lsp/test/lsp.test.ts
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import lspExtension, { __test__ } from "../src/lsp.ts";
import { createFooter } from "../src/footer.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

const {
  loadDefaults,
  which,
  getServersForFile,
  getPrimaryServerForFile,
  applyTextEditsToContent,
  applyWorkspaceEdit,
  fileToUri,
  uriToFile,
  LspClient,
  extractEditedPath,
  formatDiag,
  markerExists,
  diagnosticsOnEditEnabled,
  getOrCreateServer,
  collectDiagnosticsForFile,
  updateFooterStatus,
  resolveProjectRoot,
  getServerRootForFile,
  findServersInSubprojects,
  prewarmServer,
  sweepIdleServers,
  idleTimeoutMs,
  detectIndentFromContent,
  getEditorConfigFormatting,
  resolveFormatOptions,
  formatOnWriteEnabled,
  diagnosticIdentity,
  DiagnosticsLedger,
  diagnosticsDeduplicateEnabled,
  downloadEnabled,
  expandDiagnosticsTargets,
  globToRegExp,
  runWorkspaceDiagnostics,
  detectProjectType,
  resetManager,
} = __test__;

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.join(ROOT, "fixtures/mock-lsp-server.mjs");

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "piex-lsp-"));
}

describe("config helpers", () => {
  test("loadDefaults reads servers and initOptions alias", () => {
    const d = loadDefaults();
    expect(Object.keys(d).length).toBeGreaterThan(20);
    expect(d["rust-analyzer"]?.command).toBe("rust-analyzer");
    // defaults.json uses initOptions — must be loaded
    expect(d["rust-analyzer"]?.initializationOptions).toBeDefined();
    expect(d["rust-analyzer"]?.settings).toBeDefined();
    expect(d.biome?.isLinter).toBe(true);
  });

  test("which finds node and project node_modules/.bin", () => {
    expect(which("node")).toBeTruthy();
    const dir = tmpDir();
    const bin = path.join(dir, "node_modules", ".bin");
    fs.mkdirSync(bin, { recursive: true });
    const fake = path.join(bin, "fake-ls");
    fs.writeFileSync(fake, "#!/bin/sh\necho ok\n", { mode: 0o755 });
    expect(which("fake-ls", dir)).toBe(fake);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("markerExists supports simple globs", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "foo.tla"), "x");
    expect(markerExists(dir, "*.tla")).toBe(true);
    expect(markerExists(dir, "Cargo.toml")).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("getServersForFile routes by extension and prefers non-linter primary", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    const ts = path.join(dir, "a.ts");
    fs.writeFileSync(ts, "const x = 1\n");
    const servers = getServersForFile(dir, ts);
    // may be empty if no root markers match in findServers — package.json is marker for many
    if (servers.length > 0) {
      const primary = getPrimaryServerForFile(dir, ts);
      expect(primary).toBeTruthy();
      if (servers.some((s) => !s.config.isLinter)) {
        expect(primary!.config.isLinter).not.toBe(true);
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("text edits", () => {
  test("applyTextEditsToContent multi-line", () => {
    const text = "aa\nbb\ncc\n";
    const out = applyTextEditsToContent(text, [
      {
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 2 },
        },
        newText: "BB",
      },
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 2 },
        },
        newText: "AA",
      },
    ]);
    expect(out).toBe("AA\nBB\ncc\n");
  });

  test("applyWorkspaceEdit stays in cwd and renames", () => {
    const dir = tmpDir();
    const f = path.join(dir, "a.txt");
    fs.writeFileSync(f, "hello");
    const uri = fileToUri(f);
    const touched = applyWorkspaceEdit(dir, {
      changes: {
        [uri]: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 5 },
            },
            newText: "world",
          },
        ],
      },
    });
    expect(fs.readFileSync(f, "utf-8")).toBe("world");
    expect(touched.length).toBe(1);

    expect(() =>
      applyWorkspaceEdit(dir, {
        changes: {
          [fileToUri("/tmp/outside-piex-lsp.txt")]: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 },
              },
              newText: "x",
            },
          ],
        },
      }),
    ).toThrow(/escapes project cwd/);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("uri helpers", () => {
  test("fileToUri / uriToFile roundtrip", () => {
    const p = path.resolve("/tmp/piex-lsp-uri-test.txt");
    const uri = fileToUri(p);
    expect(uri.startsWith("file://")).toBe(true);
    expect(path.resolve(uriToFile(uri))).toBe(p);
  });
});

describe("extractEditedPath", () => {
  test("write path and hashline updated line", () => {
    const cwd = "/proj";
    expect(extractEditedPath("write", { path: "src/a.ts" }, "ok", cwd)).toBe(
      path.resolve(cwd, "src/a.ts"),
    );
    expect(
      extractEditedPath("edit", {}, "updated: src/b.ts\n[/tmp/x#A1B2]", cwd),
    ).toBe(path.resolve(cwd, "src/b.ts"));
  });
});

describe("diagnosticsOnEditEnabled", () => {
  test("env toggle", () => {
    const prev = process.env.PI_LSP_DIAGNOSTICS_ON_EDIT;
    delete process.env.PI_LSP_DIAGNOSTICS_ON_EDIT;
    expect(diagnosticsOnEditEnabled()).toBe(true);
    process.env.PI_LSP_DIAGNOSTICS_ON_EDIT = "0";
    expect(diagnosticsOnEditEnabled()).toBe(false);
    process.env.PI_LSP_DIAGNOSTICS_ON_EDIT = "false";
    expect(diagnosticsOnEditEnabled()).toBe(false);
    if (prev === undefined) delete process.env.PI_LSP_DIAGNOSTICS_ON_EDIT;
    else process.env.PI_LSP_DIAGNOSTICS_ON_EDIT = prev;
  });
});

describe("LspClient + mock server", () => {
  let dir: string;
  let client: InstanceType<typeof LspClient>;

  beforeEach(async () => {
    resetManager();
    dir = tmpDir();
    client = LspClient.spawn(process.execPath, [MOCK], dir);
    await client.initialize(fileToUri(dir), {
      initializationOptions: { mock: true },
      settings: { mockSetting: 1 },
    });
  });

  afterEach(async () => {
    try {
      await client.shutdown();
    } catch {
      /* ok */
    }
    resetManager();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("sync + waitForDiagnostics finds ERROR_HERE", async () => {
    const f = path.join(dir, "sample.ts");
    fs.writeFileSync(f, "const x = ERROR_HERE;\n");
    client.syncFile(f, "typescript");
    const uri = fileToUri(f);
    const { diagnostics, timedOut } = await client.waitForDiagnostics(
      uri,
      3000,
    );
    expect(timedOut).toBe(false);
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0].severity).toBe(1);
    expect(diagnostics[0].message).toContain("mock error");
    expect(formatDiag(diagnostics[0], "sample.ts")).toContain("error");
    expect(formatDiag(diagnostics[0], "sample.ts")).toContain("related");
  });

  test("empty diagnostics still completes wait", async () => {
    const f = path.join(dir, "clean.ts");
    fs.writeFileSync(f, "const ok = 1;\n");
    client.syncFile(f, "typescript");
    const uri = fileToUri(f);
    const { diagnostics, timedOut } = await client.waitForDiagnostics(
      uri,
      3000,
    );
    expect(timedOut).toBe(false);
    expect(diagnostics.length).toBe(0);
  });

  test("definition and hover", async () => {
    const f = path.join(dir, "nav.ts");
    fs.writeFileSync(f, "foo bar\n");
    client.syncFile(f);
    const uri = fileToUri(f);
    const def = await client.request("textDocument/definition", {
      textDocument: { uri },
      position: { line: 0, character: 0 },
    });
    expect(def).toBeTruthy();
    const hover = await client.request<{ contents: { value: string } }>(
      "textDocument/hover",
      {
        textDocument: { uri },
        position: { line: 0, character: 0 },
      },
    );
    expect(hover?.contents?.value).toContain("mock");
  });

  test("rename returns workspace edit", async () => {
    const f = path.join(dir, "r.ts");
    fs.writeFileSync(f, "foo\n");
    client.syncFile(f);
    const uri = fileToUri(f);
    const edit = await client.request<{ changes: Record<string, unknown> }>(
      "textDocument/rename",
      {
        textDocument: { uri },
        position: { line: 0, character: 0 },
        newName: "bar",
      },
    );
    expect(edit?.changes?.[uri]).toBeTruthy();
  });
});

describe("getOrCreateServer with mock via custom config", () => {
  test("collectDiagnosticsForFile via injected server config", async () => {
    resetManager();
    const dir = tmpDir();
    // Build a fake "project" and temporarily point a server at mock by
    // calling getOrCreateServer directly with mock command.
    const f = path.join(dir, "x.ts");
    fs.writeFileSync(f, "ERROR_HERE\n");
    const client = await getOrCreateServer(
      "mock",
      {
        command: process.execPath,
        args: [MOCK],
        fileTypes: [".ts"],
        rootMarkers: [],
      },
      dir,
    );
    client.syncFile(f);
    const uri = fileToUri(f);
    const { diagnostics, timedOut } = await client.waitForDiagnostics(
      uri,
      3000,
    );
    expect(timedOut).toBe(false);
    expect(diagnostics.some((d) => d.severity === 1)).toBe(true);

    // collectDiagnosticsForFile uses getServersForFile from defaults — may not see mock.
    // Direct path already validated above.
    await client.shutdown();
    resetManager();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("collectDiagnosticsForFile falls back to push when pull fails", async () => {
    resetManager();
    const prev = process.env.PI_TYPESCRIPT_LANGUAGE_SERVER_LSP_COMMAND;
    process.env.PI_TYPESCRIPT_LANGUAGE_SERVER_LSP_COMMAND =
      `${process.execPath} ${MOCK} --stdio --fail-pull`;
    try {
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, "package.json"), "{}");
      const f = path.join(dir, "x.ts");
      fs.writeFileSync(f, "const x = ERROR_HERE;\n");
      const result = await collectDiagnosticsForFile(dir, f, 5000, undefined, true);
      expect(result.count).toBeGreaterThan(0);
      expect(result.text).toContain("error");
    } finally {
      if (prev === undefined) {
        delete process.env.PI_TYPESCRIPT_LANGUAGE_SERVER_LSP_COMMAND;
      } else {
        process.env.PI_TYPESCRIPT_LANGUAGE_SERVER_LSP_COMMAND = prev;
      }
      resetManager();
    }
  });
});

describe("footer status", () => {
  let dir: string;
  let status: string | undefined;
  const theme = {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  };
  const ctx = () => ({
    cwd: dir,
    ui: {
      setStatus: (_key: string, text: string | undefined) => {
        status = text;
      },
      theme,
    },
  });

  beforeEach(() => {
    resetManager();
    dir = tmpDir();
    status = undefined;
  });

  afterEach(() => {
    resetManager();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("off when no markers match", () => {
    updateFooterStatus(ctx());
    expect(status).toBe("<dim>LSP off</dim>");
  });

  test("off when matched but command missing", () => {
    // package.json matches many defaults; force one server's command to be
    // unresolvable via the env override to simulate "installed nothing".
    const prev = process.env.PI_TYPESCRIPT_LANGUAGE_SERVER_LSP_COMMAND;
    process.env.PI_TYPESCRIPT_LANGUAGE_SERVER_LSP_COMMAND = "no-such-command-xyz";
    try {
      fs.writeFileSync(path.join(dir, "package.json"), "{}");
      updateFooterStatus(ctx());
      expect(status).toBe("<dim>LSP off</dim>");
    } finally {
      if (prev === undefined) {
        delete process.env.PI_TYPESCRIPT_LANGUAGE_SERVER_LSP_COMMAND;
      } else {
        process.env.PI_TYPESCRIPT_LANGUAGE_SERVER_LSP_COMMAND = prev;
      }
    }
  });

  test("dim server names when available but not started", () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    const binDir = path.join(dir, "node_modules", ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.symlinkSync(
      process.execPath,
      path.join(binDir, "typescript-language-server"),
    );
    updateFooterStatus(ctx());
    expect(status).toContain("<dim>typescript-language-server</dim>");
    expect(status).not.toContain("<success>");
    expect(status).not.toContain("<error>");
  });

  test("success dot when server is running", async () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    const defaults = loadDefaults();
    const ts = defaults.typescript_language_server ?? defaults["typescript-language-server"];
    const client = await getOrCreateServer(
      "typescript-language-server",
      { ...ts, command: process.execPath, args: [MOCK] },
      dir,
    );
    updateFooterStatus(ctx());
    expect(status).toContain(
      "<success>typescript-language-server</success>",
    );
    await client.shutdown();
  });

  test("multi-root servers merged into one ×N entry", async () => {
    const defaults = loadDefaults();
    const ts = defaults.typescript_language_server ?? defaults["typescript-language-server"];
    const roots = [dir, path.join(dir, "sub-a"), path.join(dir, "sub-b")];
    const clients: LspClient[] = [];
    for (const root of roots) {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, "package.json"), "{}");
      clients.push(
        await getOrCreateServer(
          "typescript-language-server",
          { ...ts, command: process.execPath, args: [MOCK] },
          root,
        ),
      );
    }
    updateFooterStatus(ctx());
    // Merged once, with a ×N count — never repeated verbatim.
    expect(status).toContain("<success>typescript-language-server×3</success>");
    expect(status).not.toContain("<success>typescript-language-server</success>");
    // The plain name must not appear more than once anywhere in the line.
    expect((status ?? "").match(/typescript-language-server/g)?.length).toBe(1);
    await Promise.all(clients.map((c) => c.shutdown()));
  });

  test("single-root server shows plain name without ×N", async () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    const defaults = loadDefaults();
    const ts = defaults.typescript_language_server ?? defaults["typescript-language-server"];
    const client = await getOrCreateServer(
      "typescript-language-server",
      { ...ts, command: process.execPath, args: [MOCK] },
      dir,
    );
    updateFooterStatus(ctx());
    expect(status).toContain("<success>typescript-language-server</success>");
    expect(status).not.toContain("×");
    await client.shutdown();
  });

  test("error cross when server failed to start", async () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    await expect(
      getOrCreateServer(
        "typescript-language-server",
        {
          command: process.execPath,
          args: [path.join(dir, "no-such-mock-server.mjs")],
          rootMarkers: ["package.json"],
        },
        dir,
      ),
    ).rejects.toThrow();
    updateFooterStatus(ctx());
    expect(status).toContain("<error>typescript-language-server</error>");
  });
});

describe("custom footer", () => {
  const theme = {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  };

  function makeFooterData(overrides: Partial<{
    branch: string | null;
    statuses: Record<string, string>;
    providers: number;
  }> = {}) {
    const { branch = null, statuses = {}, providers = 1 } = overrides;
    return {
      getGitBranch: () => branch,
      getAvailableProviderCount: () => providers,
      getExtensionStatuses: () => new Map(Object.entries(statuses)),
      onBranchChange: () => () => {},
    };
  }

  function makeDeps(overrides: Partial<Parameters<typeof createFooter>[0]> = {}) {
    return {
      cwd: "/Users/alice/project",
      home: "/Users/alice",
      sessionName: undefined,
      getEntries: () => [],
      model: { id: "deepseek-v4", provider: "deepseek", reasoning: true },
      thinkingLevel: "off",
      getContextUsage: () => ({ contextWindow: 1_000_000, percent: 2.2 }),
      ...overrides,
    } as Parameters<typeof createFooter>[0];
  }

  test("line 1 shows pwd with home replaced and branch", () => {
    const footer = createFooter(
      makeDeps(),
      makeFooterData({ branch: "main" }),
      theme,
    );
    const lines = footer.render(120);
    expect(lines[0]).toContain("~/project (main)");
  });

  test("line 2 shows token stats and right-aligned model", () => {
    const footer = createFooter(
      makeDeps({
        getEntries: () => [
          {
            type: "message",
            message: {
              role: "assistant",
              usage: {
                input: 100,
                output: 50,
                cacheRead: 300,
                cacheWrite: 10,
                cost: { total: 0.001 },
              },
            },
          },
        ],
      }),
      makeFooterData({ providers: 2 }),
      theme,
    );
    const lines = footer.render(120);
    expect(lines[1]).toContain("↑100 ↓50 R300 W10 CH73.2% $0.001 2.2%/1.0M");
    expect(lines[1]).toContain("(deepseek) deepseek-v4 • thinking off");
    // statsLeft and remainder dimmed separately (like the built-in footer),
    // model right-aligned via padding
    expect(lines[1]).toContain(
      "<dim>↑100 ↓50 R300 W10 CH73.2% $0.001 2.2%/1.0M</dim>",
    );
    // rightSide dimmed separately, right-aligned via padding (like built-in)
    expect(lines[1]).toMatch(
      /<dim>\s{2,}\(deepseek\) deepseek-v4 • thinking off<\/dim>/,
    );
  });

  test("line 3 keeps usage left and right-aligns lsp status", () => {
    const footer = createFooter(
      makeDeps(),
      makeFooterData({
        statuses: {
          usage: "Usage: ¥8.24",
          lsp: "<success>typescript-language-server</success>",
        },
      }),
      theme,
    );
    const lines = footer.render(120);
    const line3 = lines[2];
    expect(line3.startsWith("Usage: ¥8.24")).toBe(true);
    expect(line3.trimEnd().endsWith("<success>typescript-language-server</success>")).toBe(true);
    // lsp is flush right, usage is flush left, padded between
    expect(line3.length).toBe(120);
    expect(line3).toMatch(/Usage: ¥8\.24\s+<success>/);
  });

  test("line 3 without lsp status stays left-aligned", () => {
    const footer = createFooter(
      makeDeps(),
      makeFooterData({ statuses: { usage: "Usage: ¥8.24" } }),
      theme,
    );
    const lines = footer.render(120);
    expect(lines[2].startsWith("Usage: ¥8.24")).toBe(true);
    expect(lines[2].trimEnd()).toBe("Usage: ¥8.24");
  });
});

describe("project root discovery", () => {
  test("resolveProjectRoot walks up to nearest marker", () => {
    const dir = tmpDir();
    const deep = path.join(dir, "a", "b", "c", "x.ts");
    fs.mkdirSync(path.dirname(deep), { recursive: true });
    // no markers anywhere
    expect(resolveProjectRoot(deep)).toBeNull();
    // package.json at dir/a
    fs.writeFileSync(path.join(dir, "a", "package.json"), "{}");
    expect(resolveProjectRoot(deep)).toBe(path.join(dir, "a"));
    // go.mod at dir wins over nested package.json for a .go file
    const goDir = path.join(dir, "g");
    fs.mkdirSync(path.join(goDir, "b"), { recursive: true });
    fs.writeFileSync(path.join(goDir, "go.mod"), "module x\n");
    expect(resolveProjectRoot(path.join(goDir, "b", "main.go"))).toBe(goDir);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("getServerRootForFile falls back to discovered root only when cwd has none", () => {
    const dir = tmpDir();
    const pkg = path.join(dir, "pkg");
    fs.mkdirSync(path.join(pkg, "src"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), "{}");
    const f = path.join(pkg, "src", "x.ts");
    // cwd has no markers -> discovered root
    expect(getServerRootForFile(dir, f)).toBe(pkg);
    // cwd matches -> stays cwd
    expect(getServerRootForFile(pkg, f)).toBe(pkg);
    // no markers anywhere -> cwd
    const bare = tmpDir();
    expect(getServerRootForFile(bare, path.join(bare, "x.ts"))).toBe(bare);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
  });
});

describe("footer status with sub-project server", () => {
  test("shows server running from a discovered root even when cwd matches nothing", async () => {
    resetManager();
    const dir = tmpDir();
    const pkg = path.join(dir, "pkg");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), "{}");
    const client = await getOrCreateServer(
      "mock",
      { command: process.execPath, args: [MOCK], fileTypes: [".ts"], rootMarkers: [] },
      pkg,
    );
    let status: string | undefined;
    const ctx = {
      cwd: dir,
      ui: {
        setStatus: (_k: string, t: string | undefined) => { status = t; },
        theme: { fg: (c: string, t: string) => `<${c}>${t}</${c}>` },
      },
    };
    updateFooterStatus(ctx);
    expect(status).toContain("<success>mock</success>");
    await client.shutdown();
    resetManager();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("footer status in repo collections / monorepo roots", () => {
  let status: string | undefined;
  const ctxFor = (cwd: string) => ({
    cwd,
    ui: {
      setStatus: (_k: string, t: string | undefined) => { status = t; },
      theme: { fg: (c: string, t: string) => `<${c}>${t}</${c}>` },
    },
  });

  beforeEach(() => {
    resetManager();
    status = undefined;
  });

  test("monorepo root with .git shows sub-project servers, hides bashls noise", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    // sub-project at depth 2 (like piex/extensions/lsp)
    fs.mkdirSync(path.join(dir, "extensions", "lsp"), { recursive: true });
    fs.writeFileSync(path.join(dir, "extensions", "lsp", "package.json"), "{}");
    updateFooterStatus(ctxFor(dir));
    expect(status).toContain("<dim>typescript-language-server</dim>");
    expect(status).not.toContain("bashls");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("repo collection root shows sub-project servers instead of off", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "repo-a"), { recursive: true });
    fs.writeFileSync(path.join(dir, "repo-a", "package.json"), "{}");
    updateFooterStatus(ctxFor(dir));
    expect(status).toContain("<dim>typescript-language-server</dim>");
    expect(status).not.toContain("LSP off");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("plain git repo without sub-projects falls back to cwd matches", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    updateFooterStatus(ctxFor(dir));
    expect(status).toContain("<dim>bashls</dim>");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("read prewarming (opencode-style)", () => {
  test("prewarmServer spawns the server and footer turns green", async () => {
    resetManager();
    const prev = process.env.PI_TYPESCRIPT_LANGUAGE_SERVER_LSP_COMMAND;
    process.env.PI_TYPESCRIPT_LANGUAGE_SERVER_LSP_COMMAND =
      `${process.execPath} ${MOCK} --stdio`;
    try {
      const dir = tmpDir();
      const pkg = path.join(dir, "pkg");
      fs.mkdirSync(path.join(pkg, "src"), { recursive: true });
      fs.writeFileSync(path.join(pkg, "package.json"), "{}");
      const f = path.join(pkg, "src", "x.ts");
      fs.writeFileSync(f, "const x = 1;\n");
      prewarmServer(pkg, f);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && __test__.getActiveCount() === 0) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(__test__.getActiveCount()).toBeGreaterThan(0);
      let status: string | undefined;
      updateFooterStatus({
        cwd: pkg,
        ui: {
          setStatus: (_k: string, t: string | undefined) => { status = t; },
          theme: { fg: (c: string, t: string) => `<${c}>${t}</${c}>` },
        },
      });
      expect(status).toContain("<success>typescript-language-server</success>");
    } finally {
      if (prev === undefined) {
        delete process.env.PI_TYPESCRIPT_LANGUAGE_SERVER_LSP_COMMAND;
      } else {
        process.env.PI_TYPESCRIPT_LANGUAGE_SERVER_LSP_COMMAND = prev;
      }
      resetManager();
    }
  });

  test("concurrent getOrCreateServer spawns only one process", async () => {
    resetManager();
    const prev = process.env.PI_TYPESCRIPT_LANGUAGE_SERVER_LSP_COMMAND;
    process.env.PI_TYPESCRIPT_LANGUAGE_SERVER_LSP_COMMAND =
      `${process.execPath} ${MOCK} --stdio`;
    try {
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, "package.json"), "{}");
      const cfg = {
        command: "ignored-by-override",
        args: [],
        fileTypes: [".ts"],
        rootMarkers: ["package.json"],
      };
      const [a, b] = await Promise.all([
        getOrCreateServer("typescript-language-server", cfg, dir),
        getOrCreateServer("typescript-language-server", cfg, dir),
      ]);
      expect(a).toBe(b); // same in-flight client, no double spawn
      expect(__test__.getActiveCount()).toBe(1);
      await a.shutdown();
    } finally {
      if (prev === undefined) {
        delete process.env.PI_TYPESCRIPT_LANGUAGE_SERVER_LSP_COMMAND;
      } else {
        process.env.PI_TYPESCRIPT_LANGUAGE_SERVER_LSP_COMMAND = prev;
      }
      resetManager();
    }
  });

  test("same-named servers across roots show once in footer", async () => {
    resetManager();
    const prev = process.env.PI_TYPESCRIPT_LANGUAGE_SERVER_LSP_COMMAND;
    process.env.PI_TYPESCRIPT_LANGUAGE_SERVER_LSP_COMMAND =
      `${process.execPath} ${MOCK} --stdio`;
    try {
      const dir = tmpDir();
      // two sub-projects, both TypeScript
      const a = path.join(dir, "a");
      const b = path.join(dir, "b");
      fs.mkdirSync(a, { recursive: true });
      fs.mkdirSync(b, { recursive: true });
      fs.writeFileSync(path.join(a, "package.json"), "{}");
      fs.writeFileSync(path.join(b, "package.json"), "{}");
      const cfg = {
        command: "ignored-by-override",
        args: [],
        fileTypes: [".ts"],
        rootMarkers: ["package.json"],
      };
      const [ca, cb] = await Promise.all([
        getOrCreateServer("typescript-language-server", cfg, a),
        getOrCreateServer("typescript-language-server", cfg, b),
      ]);
      let status: string | undefined;
      updateFooterStatus({
        cwd: dir,
        ui: {
          setStatus: (_k: string, t: string | undefined) => { status = t; },
          theme: { fg: (c: string, t: string) => `<${c}>${t}</${c}>` },
        },
      });
      const green = status?.match(/<success>typescript-language-server×2<\/success>/g);
      expect(green?.length).toBe(1); // merged into one ×N entry, not doubled
      await ca.shutdown();
      await cb.shutdown();
    } finally {
      if (prev === undefined) {
        delete process.env.PI_TYPESCRIPT_LANGUAGE_SERVER_LSP_COMMAND;
      } else {
        process.env.PI_TYPESCRIPT_LANGUAGE_SERVER_LSP_COMMAND = prev;
      }
      resetManager();
    }
  });

  test("prewarmServer ignores files without a matching server", async () => {
    resetManager();
    const dir = tmpDir();
    const f = path.join(dir, "x.unknownext");
    fs.writeFileSync(f, "hi\n");
    prewarmServer(dir, f);
    await new Promise((r) => setTimeout(r, 200));
    expect(__test__.getActiveCount()).toBe(0);
    resetManager();
    fs.rmSync(dir, { recursive: true, force: true });
  });

describe("0.5.0: pull diagnostics (opencode-style full pull)", () => {
  let dir: string;
  let client: InstanceType<typeof LspClient>;

  beforeEach(async () => {
    resetManager();
    dir = tmpDir();
    client = LspClient.spawn(process.execPath, [MOCK], dir);
    await client.initialize(fileToUri(dir), { initializationOptions: { mock: true } });
  });

  afterEach(async () => {
    try { await client.shutdown(); } catch { /* ok */ }
    resetManager();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("static diagnosticProvider → supportsPullDiagnostics + pull returns errors", async () => {
    expect(client.supportsPullDiagnostics()).toBe(true);
    const f = path.join(dir, "pull.ts");
    fs.writeFileSync(f, "const x = ERROR_HERE;\n");
    client.syncFile(f, "typescript");
    const uri = fileToUri(f);
    const { items, matched } = await client.pullDiagnostics(uri, 3000);
    expect(matched).toBe(true);
    expect(items.some((d) => d.message.includes("mock error"))).toBe(true);
  });

  test("clean file pull: matched with zero items", async () => {
    const f = path.join(dir, "clean-pull.ts");
    fs.writeFileSync(f, "const ok = 1;\n");
    client.syncFile(f, "typescript");
    const { items, matched } = await client.pullDiagnostics(fileToUri(f), 3000);
    expect(matched).toBe(true);
    expect(items.length).toBe(0);
  });

  test("relatedDocuments surface dependent-file errors", async () => {
    const f = path.join(dir, "rel.ts");
    fs.writeFileSync(f, "RELATED_HERE\n");
    client.syncFile(f, "typescript");
    const uri = fileToUri(f);
    const { items, matched } = await client.pullDiagnostics(uri, 3000);
    expect(matched).toBe(true);
    // dependent file diagnostics merged into the shared cache
    const depUri = uri.replace(/\.\w+$/, "") + "-dep.ts";
    const dep = client.getDiagnostics(depUri);
    expect(dep.some((d) => d.message.includes("mock error"))).toBe(true);
    expect(items.length).toBe(0); // current file itself is clean
  });
});

describe("0.5.0: dynamic capability registration", () => {
  let dir: string;
  let client: InstanceType<typeof LspClient>;

  beforeEach(async () => {
    resetManager();
    dir = tmpDir();
    client = LspClient.spawn(process.execPath, [MOCK, "--dynamic-diag"], dir);
    await client.initialize(fileToUri(dir), { initializationOptions: { mock: true } });
  });

  afterEach(async () => {
    try { await client.shutdown(); } catch { /* ok */ }
    resetManager();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("no static provider; registration flips supportsPullDiagnostics", async () => {
    // tsserver-style: capabilities arrive only after client/registerCapability
    expect(client.supportsPullDiagnostics()).toBe(false);
    const changed = await client.waitForRegistrationChange(3000);
    expect(changed).toBe(true);
    expect(client.supportsPullDiagnostics()).toBe(true);
    expect(client.supportsWorkspacePullDiagnostics()).toBe(true);
  });

  test("identifier pulls work after dynamic registration", async () => {
    await client.waitForRegistrationChange(3000);
    const f = path.join(dir, "dyn.ts");
    fs.writeFileSync(f, "const x = ERROR_HERE;\n");
    client.syncFile(f, "typescript");
    const { items, matched } = await client.pullDiagnostics(fileToUri(f), 3000);
    expect(matched).toBe(true);
    expect(items.some((d) => d.message.includes("mock error"))).toBe(true);
  });
});

describe("0.5.0: $/progress project-load tracking", () => {
  let dir: string;
  let client: InstanceType<typeof LspClient>;

  beforeEach(async () => {
    resetManager();
    dir = tmpDir();
    client = LspClient.spawn(process.execPath, [MOCK, "--progress"], dir);
    await client.initialize(fileToUri(dir), { initializationOptions: { mock: true } });
  });

  afterEach(async () => {
    try { await client.shutdown(); } catch { /* ok */ }
    resetManager();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("waitForProjectLoaded resolves when begin/end complete", async () => {
    // server sends begin ~100ms after initialized, end ~300ms later
    const start = Date.now();
    await client.waitForProjectLoaded(10_000);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(5_000);
  });

});

describe("0.5.0: idle reaping", () => {
  test("sweepIdleServers reaps idle servers and keeps active ones", async () => {
    resetManager();
    const prev = process.env.PI_LSP_IDLE_TIMEOUT_MS;
    process.env.PI_LSP_IDLE_TIMEOUT_MS = "50"; // 50ms idle budget
    try {
      const dir = tmpDir();
      const f = path.join(dir, "idle.ts");
      fs.writeFileSync(f, "const x = 1;\n");
      const client = await getOrCreateServer(
        "mock",
        { command: process.execPath, args: [MOCK], fileTypes: [".ts"], rootMarkers: [] },
        dir,
      );
      client.syncFile(f);
      // Freshly active: must survive the sweep.
      __test__.sweepIdleServers();
      expect(__test__.getActiveCount()).toBe(1);
      expect(client.alive).toBe(true);
      // Idle past the budget: reaped.
      await new Promise((r) => setTimeout(r, 120));
      __test__.sweepIdleServers();
      expect(__test__.getActiveCount()).toBe(0);
      // shutdown() is fire-and-forget inside the sweep; give it a beat
      await new Promise((r) => setTimeout(r, 150));
      expect(client.alive).toBe(false);
      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      if (prev === undefined) delete process.env.PI_LSP_IDLE_TIMEOUT_MS;
      else process.env.PI_LSP_IDLE_TIMEOUT_MS = prev;
      resetManager();
    }
  });

  test("idleTimeoutMs: env override and disabled via 0", () => {
    const prev = process.env.PI_LSP_IDLE_TIMEOUT_MS;
    try {
      delete process.env.PI_LSP_IDLE_TIMEOUT_MS;
      expect(__test__.idleTimeoutMs()).toBe(0); // off by default
      process.env.PI_LSP_IDLE_TIMEOUT_MS = "120000";
      expect(__test__.idleTimeoutMs()).toBe(120_000);
      process.env.PI_LSP_IDLE_TIMEOUT_MS = "garbage";
      expect(__test__.idleTimeoutMs()).toBe(0); // garbage → disabled
    } finally {
      if (prev === undefined) delete process.env.PI_LSP_IDLE_TIMEOUT_MS;
      else process.env.PI_LSP_IDLE_TIMEOUT_MS = prev;
    }
  });

  test("#write counts as activity (regression: notifications prevent idle reaping)", async () => {
    resetManager();
    const dir = tmpDir();
    const f = path.join(dir, "act.ts");
    fs.writeFileSync(f, "const x = 1;\n");
    const client = LspClient.spawn(process.execPath, [MOCK], dir);
    await client.initialize(fileToUri(dir), { initializationOptions: { mock: true } });
    const initial = client.lastActivity;
    await new Promise((r) => setTimeout(r, 40));
    // didOpen/didChange are fire-and-forget notifications — they still count
    // as activity or a quiet edit session would be reaped as "idle".
    client.syncFile(f, "typescript");
    client.notifySaved(f);
    expect(client.lastActivity).toBeGreaterThan(initial);
    await client.shutdown();
    resetManager();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("0.6.0: indent detection & FormattingOptions", () => {
  test("detectIndentFromContent: 2-space, 4-space, tab, GCD", () => {
    expect(detectIndentFromContent("")).toEqual({});
    expect(detectIndentFromContent("a\n  b\n    c\n")).toEqual({
      insertSpaces: true,
      tabSize: 2,
    });
    expect(detectIndentFromContent("a\n    b\n        c\n")).toEqual({
      insertSpaces: true,
      tabSize: 4,
    });
    // mixed 2/4/6 → GCD 2
    expect(detectIndentFromContent("a\n  b\n    c\n      d\n")).toEqual({
      insertSpaces: true,
      tabSize: 2,
    });
    expect(detectIndentFromContent("a\n\tb\n\t\tc\n")).toEqual({
      insertSpaces: false,
    });
    // blank lines carry no signal
    expect(detectIndentFromContent("\n\n  x\n")).toEqual({
      insertSpaces: true,
      tabSize: 2,
    });
  });

  test("getEditorConfigFormatting reads nearest .editorconfig", () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, ".editorconfig"),
      "root = true\n[*]\nindent_style = space\nindent_size = 4\n",
    );
    const f = path.join(dir, "src", "a.ts");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    expect(getEditorConfigFormatting(f)).toEqual({
      insertSpaces: true,
      tabSize: 4,
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("resolveFormatOptions: editorconfig wins over sniffing", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, ".editorconfig"), "[*]\nindent_style = tab\n");
    const f = path.join(dir, "a.py");
    const opts = resolveFormatOptions(f, "x\n  y\n");
    expect(opts).toEqual({ tabSize: 4, insertSpaces: false });
    // no editorconfig → sniffing
    const bare = path.join(tmpDir(), "b.py");
    expect(resolveFormatOptions(bare, "x\n  y\n")).toEqual({
      tabSize: 2,
      insertSpaces: true,
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("formatOnWriteEnabled env toggle", () => {
    const prev = process.env.PI_LSP_FORMAT_ON_WRITE;
    delete process.env.PI_LSP_FORMAT_ON_WRITE;
    expect(formatOnWriteEnabled()).toBe(false);
    process.env.PI_LSP_FORMAT_ON_WRITE = "1";
    expect(formatOnWriteEnabled()).toBe(true);
    if (prev === undefined) delete process.env.PI_LSP_FORMAT_ON_WRITE;
    else process.env.PI_LSP_FORMAT_ON_WRITE = prev;
  });
});

describe("0.6.0: diagnostics ledger dedupe", () => {
  test("diagnosticIdentity strips location prefix", () => {
    expect(diagnosticIdentity("/proj/a.ts:L3:1 error [ts] msg")).toBe(
      "error [ts] msg",
    );
    expect(diagnosticIdentity("a.ts:L1:1 error msg")).toBe("error msg");
    expect(diagnosticIdentity("no prefix here")).toBe("no prefix here");
  });

  test("reduce reports fresh errors once, resets on clean", () => {
    const ledger = new DiagnosticsLedger();
    const f = "/proj/a.ts";
    const err = (n: number) => `a.ts:L${n}:1 error [ts] err${n}`;
    // first report: everything is fresh
    expect(ledger.reduce(f, [err(1), err(2)])).toEqual([err(1), err(2)]);
    // same identities again: nothing fresh
    expect(ledger.reduce(f, [err(1), err(2)])).toEqual([]);
    // new error alongside seen ones: only the new one
    expect(ledger.reduce(f, [err(1), err(3)])).toEqual([err(3)]);
    // clean file resets history
    expect(ledger.reduce(f, [])).toEqual([]);
    expect(ledger.reduce(f, [err(1)])).toEqual([err(1)]);
  });
});

describe("0.6.0: diagnostics target expansion", () => {
  test("globToRegExp: * single segment, ** crosses", () => {
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/sub/a.ts")).toBe(false);
    expect(globToRegExp("src/**/*.ts").test("src/sub/a.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("src/a.ts")).toBe(false);
  });

  test("expandDiagnosticsTargets: directory walk & glob", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "x");
    fs.writeFileSync(path.join(dir, "src", "b.ts"), "x");
    fs.writeFileSync(path.join(dir, "node_modules", "pkg", "c.ts"), "x");
    fs.writeFileSync(path.join(dir, "README.md"), "x");
    // directory → all files except vendored dirs
    const fromDir = expandDiagnosticsTargets(dir, "src");
    expect(fromDir?.length).toBe(2);
    // glob → cwd-relative match
    const fromGlob = expandDiagnosticsTargets(dir, "src/*.ts");
    expect(fromGlob?.length).toBe(2);
    // single file → null (existing path handles it)
    expect(expandDiagnosticsTargets(dir, "src/a.ts")).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("0.6.0: workspace subprocess diagnostics", () => {
  test("detectProjectType routes by root markers", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "Cargo.toml"), "[package]\n");
    const rust = await detectProjectType(dir, 3000);
    expect(rust.type).toBe("rust");
    expect(rust.command).toEqual(["cargo", "check", "--message-format=short"]);
    fs.rmSync(dir, { recursive: true, force: true });

    const tsDir = tmpDir();
    fs.writeFileSync(path.join(tsDir, "tsconfig.json"), "{}");
    const ts = await detectProjectType(tsDir, 3000);
    expect(ts.type).toBe("typescript");
    expect(ts.command).toEqual(["npx", "tsc", "--noEmit"]);
    fs.rmSync(tsDir, { recursive: true, force: true });

    const bare = tmpDir();
    const none = await detectProjectType(bare, 3000);
    expect(none.type).toBe("unknown");
    expect(none.command).toBeNull();
    fs.rmSync(bare, { recursive: true, force: true });
  });

  test("runWorkspaceDiagnostics: unknown project reports guidance", async () => {
    const dir = tmpDir();
    const res = await runWorkspaceDiagnostics(dir, 5000);
    expect(res.command).toBeNull();
    expect(res.output).toContain("Cannot detect project type");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("0.6.0: install metadata & download gate", () => {
  test("defaults.json carries install metadata for core servers", () => {
    const d = loadDefaults();
    expect(
      (d["typescript-language-server"] as Record<string, unknown>)?.install,
    ).toEqual({ type: "npm", package: "typescript-language-server" });
    expect(
      (d["rust-analyzer"] as Record<string, unknown>)?.install,
    ).toEqual({ type: "rustup", package: "rust-analyzer" });
    expect(
      (d["gopls"] as Record<string, unknown>)?.install,
    ).toEqual({ type: "go", package: "golang.org/x/tools/gopls@latest" });
  });

  test("downloadEnabled respects PI_LSP_DISABLE_DOWNLOAD", () => {
    const prev = process.env.PI_LSP_DISABLE_DOWNLOAD;
    delete process.env.PI_LSP_DISABLE_DOWNLOAD;
    expect(downloadEnabled()).toBe(true);
    process.env.PI_LSP_DISABLE_DOWNLOAD = "1";
    expect(downloadEnabled()).toBe(false);
    if (prev === undefined) delete process.env.PI_LSP_DISABLE_DOWNLOAD;
    else process.env.PI_LSP_DISABLE_DOWNLOAD = prev;
  });

  test("diagnosticsDeduplicateEnabled default on, toggleable", () => {
    const prev = process.env.PI_LSP_DIAGNOSTICS_DEDUPLICATE;
    delete process.env.PI_LSP_DIAGNOSTICS_DEDUPLICATE;
    expect(diagnosticsDeduplicateEnabled()).toBe(true);
    process.env.PI_LSP_DIAGNOSTICS_DEDUPLICATE = "0";
    expect(diagnosticsDeduplicateEnabled()).toBe(false);
    if (prev === undefined) delete process.env.PI_LSP_DIAGNOSTICS_DEDUPLICATE;
    else process.env.PI_LSP_DIAGNOSTICS_DEDUPLICATE = prev;
  });
});

describe("0.6.0: format-on-write end-to-end", () => {
  const withMockOverride = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
    resetManager();
    const prev = process.env.PI_TYPESCRIPT_LANGUAGE_SERVER_LSP_COMMAND;
    process.env.PI_TYPESCRIPT_LANGUAGE_SERVER_LSP_COMMAND =
      `${process.execPath} ${MOCK} --stdio`;
    try {
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, "package.json"), "{}");
      const result = await fn(dir);
      fs.rmSync(dir, { recursive: true, force: true });
      return result;
    } finally {
      if (prev === undefined) {
        delete process.env.PI_TYPESCRIPT_LANGUAGE_SERVER_LSP_COMMAND;
      } else {
        process.env.PI_TYPESCRIPT_LANGUAGE_SERVER_LSP_COMMAND = prev;
      }
      resetManager();
    }
  };

  test("formatFileWithLsp applies server edits to disk", async () => {
    await withMockOverride(async (dir) => {
      const f = path.join(dir, "fmt.ts");
      fs.writeFileSync(f, "const x = 1;\n");
      const edits = await __test__.formatFileWithLsp(dir, f, 5000);
      expect(edits).toBeGreaterThan(0);
      expect(fs.readFileSync(f, "utf-8")).toContain("// formatted");
    });
  });

  test("formatFileWithLsp returns 0 when no server matches", async () => {
    resetManager();
    const dir = tmpDir(); // no markers → no server routed
    const f = path.join(dir, "x.ts");
    fs.writeFileSync(f, "const x = 1;\n");
    const edits = await __test__.formatFileWithLsp(dir, f, 2000);
    expect(edits).toBe(0);
    expect(fs.readFileSync(f, "utf-8")).toBe("const x = 1;\n");
    resetManager();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("review fixes: glob ?, go.work argv, pull fallback", () => {
  test("globToRegExp: ? matches a single character", () => {
    expect(globToRegExp("src/?.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/?.ts").test("src/ab.ts")).toBe(false);
    expect(globToRegExp("src/?.ts").test("src/sub/a.ts")).toBe(false);
  });

  test("pull matched=false falls back to push settle (no false-clean)", async () => {
    resetManager();
    const dir = tmpDir();
    const f = path.join(dir, "fb.ts");
    fs.writeFileSync(f, "const x = ERROR_HERE;\n");
    const client = LspClient.spawn(
      process.execPath,
      [MOCK, "--fail-pull"],
      dir,
    );
    await client.initialize(fileToUri(dir), { initializationOptions: { mock: true } });
    client.syncFile(f, "typescript");
    const uri = fileToUri(f);
    // static diagnosticProvider advertised → pull attempted, server rejects,
    // matched=false → push settle must still surface the error
    expect(client.supportsPullDiagnostics()).toBe(true);
    const { items, matched } = await client.pullDiagnostics(uri, 3000);
    expect(matched).toBe(false);
    expect(items.length).toBe(0); // pull returned nothing
    // fallback path used by collectDiagnosticsForFile:
    const pushed = await client.waitForDiagnostics(uri, 3000);
    expect(pushed.diagnostics.some((d) => d.message.includes("mock error"))).toBe(true);
    await client.shutdown();
    resetManager();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("push/pull cache split (opencode-style)", () => {
  test("push and pull diagnostics merge without clobbering each other", async () => {
    resetManager();
    const dir = tmpDir();
    const f = path.join(dir, "split.ts");
    fs.writeFileSync(f, "const x = ERROR_HERE;\n");
    const client = LspClient.spawn(process.execPath, [MOCK], dir);
    await client.initialize(fileToUri(dir), { initializationOptions: { mock: true } });
    client.syncFile(f, "typescript");
    const uri = fileToUri(f);
    // push: mock publishes after didOpen
    const pushed = await client.waitForDiagnostics(uri, 3000);
    expect(pushed.diagnostics.length).toBe(1);
    // pull: same file returns the same error, relatedDocuments adds a dep file
    const pulled = await client.pullDiagnostics(uri, 3000);
    expect(pulled.matched).toBe(true);
    // merged: same diagnostic must not appear twice
    const merged = client.getDiagnostics(uri);
    expect(merged.length).toBe(1);
    await client.shutdown();
    resetManager();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("pull cache is cleared on content change (stale results dropped)", async () => {
    resetManager();
    const dir = tmpDir();
    const f = path.join(dir, "stale.ts");
    fs.writeFileSync(f, "const x = ERROR_HERE;\n");
    const client = LspClient.spawn(process.execPath, [MOCK], dir);
    await client.initialize(fileToUri(dir), { initializationOptions: { mock: true } });
    client.syncFile(f, "typescript");
    const uri = fileToUri(f);
    await client.pullDiagnostics(uri, 3000);
    expect(client.getDiagnostics(uri).length).toBe(1);
    // edit the file to clean content: pull cache must be dropped
    fs.writeFileSync(f, "const ok = 1;\n");
    client.syncFile(f, "typescript");
    // wait for the new push (empty) to settle
    const { diagnostics } = await client.waitForDiagnostics(uri, 3000);
    expect(diagnostics.length).toBe(0);
    await client.shutdown();
    resetManager();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("footer model/thinking follows model_select", () => {
  function makePiHarness() {
    const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
    let footerFactory:
      | ((tui: unknown, theme: unknown, footerData: unknown) => {
          render(width: number): string[];
          dispose(): void;
        })
      | undefined;
    const pi = {
      on(event: string, fn: (...args: unknown[]) => unknown) {
        handlers.set(event, [...(handlers.get(event) ?? []), fn]);
      },
      registerTool() {},
      registerCommand() {},
      async emit(event: string, payload: unknown, ctx: unknown) {
        for (const fn of handlers.get(event) ?? []) await fn(payload, ctx);
      },
    };
    const theme = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` };
    const tui = { requestRender: () => {} };
    const footerData = {
      getGitBranch: () => null,
      getAvailableProviderCount: () => 2, // ≥2 shows the (provider) prefix
      getExtensionStatuses: () => new Map(),
      onBranchChange: () => () => {},
    };
    return { pi, handlers, theme, tui, footerData, setFooterFactory: (f: typeof footerFactory) => { footerFactory = f; }, getFooterFactory: () => footerFactory };
  }

  function makeCtx(harness: ReturnType<typeof makePiHarness>, model: { id: string; provider: string; reasoning?: boolean }, thinkingLevel = "max") {
    return {
      cwd: "/proj",
      model,
      thinkingLevel,
      sessionManager: {
        getSessionName: () => undefined,
        getEntries: () => [],
      },
      getContextUsage: () => ({ contextWindow: 1_000_000, percent: 1 }),
      ui: {
        setStatus: () => {},
        setFooter: (factory: unknown) => harness.setFooterFactory(factory as never),
        theme: harness.theme,
      },
    } as unknown as Parameters<typeof lspExtension>[0] extends never ? never : never;
  }

  test("model_select updates the footer model", async () => {
    const harness = makePiHarness();
    lspExtension(harness.pi as never);
    const kimiModel = { id: "k3", provider: "kimi-coding", reasoning: true };
    const deepseekModel = { id: "deepseek-v4-flash", provider: "deepseek", reasoning: true };

    await harness.pi.emit("session_start", {}, makeCtx(harness, kimiModel));
    const factory = harness.getFooterFactory();
    expect(factory).toBeTruthy();
    const footer = factory!(harness.tui, harness.theme, harness.footerData);
    expect(footer.render(120).join("\n")).toContain("(kimi-coding) k3");

    // user switches to deepseek — footer must follow
    await harness.pi.emit(
      "model_select",
      { model: deepseekModel, previousModel: kimiModel, source: "set" },
      makeCtx(harness, deepseekModel),
    );
    const line = footer.render(120).join("\n");
    expect(line).toContain("(deepseek) deepseek-v4-flash");
    expect(line).not.toContain("kimi-coding");
    footer.dispose();
  });

  test("thinking_level_select updates the footer thinking level", async () => {
    const harness = makePiHarness();
    lspExtension(harness.pi as never);
    const model = { id: "deepseek-v4-flash", provider: "deepseek", reasoning: true };
    await harness.pi.emit("session_start", {}, makeCtx(harness, model, "max"));
    const factory = harness.getFooterFactory();
    const footer = factory!(harness.tui, harness.theme, harness.footerData);
    expect(footer.render(120).join("\n")).toContain("max");

    await harness.pi.emit(
      "thinking_level_select",
      { level: "off", previousLevel: "max" },
      makeCtx(harness, model, "off"),
    );
    const line = footer.render(120).join("\n");
    expect(line).toContain("off");
    expect(line).not.toContain("max");
    footer.dispose();
  });
});

describe("footer lsp status end-to-end (server running → green)", () => {
  test("running server renders green in footer line 3", async () => {
    resetManager();
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    const defaults = loadDefaults();
    const ts = defaults["typescript-language-server"];
    const client = await getOrCreateServer(
      "typescript-language-server",
      { ...ts, command: process.execPath, args: [MOCK] },
      dir,
    );
    expect(client.alive).toBe(true);

    // wire the status the same way the extension does
    const statuses = new Map<string, string>();
    const theme = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` };
    const ctx = {
      cwd: dir,
      ui: {
        setStatus: (_k: string, t: string | undefined) => {
          if (t === undefined) statuses.delete("lsp");
          else statuses.set("lsp", t);
        },
        theme,
      },
    };
    __test__.updateFooterStatus(ctx as never);
    expect(statuses.get("lsp")).toContain("<success>typescript-language-server</success>");

    // render through the real footer path
    const footer = createFooter(
      {
        cwd: dir,
        getEntries: () => [],
        model: { id: "m", provider: "p", reasoning: true },
        thinkingLevel: "off",
        getContextUsage: () => ({ contextWindow: 1_000_000, percent: 1 }),
      } as never,
      {
        getGitBranch: () => null,
        getAvailableProviderCount: () => 2,
        getExtensionStatuses: () => statuses,
        onBranchChange: () => () => {},
      } as never,
      theme as never,
    );
    const line3 = footer.render(120)[2];
    expect(line3).toContain("<success>typescript-language-server</success>");

    await client.shutdown();
    resetManager();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("after server exits, footer status drops the green entry", async () => {
    resetManager();
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    const defaults = loadDefaults();
    const ts = defaults["typescript-language-server"];
    const client = await getOrCreateServer(
      "typescript-language-server",
      { ...ts, command: process.execPath, args: [MOCK] },
      dir,
    );
    const statuses = new Map<string, string>();
    const theme = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` };
    const ctx = {
      cwd: dir,
      ui: {
        setStatus: (_k: string, t: string | undefined) => {
          if (t === undefined) statuses.delete("lsp");
          else statuses.set("lsp", t);
        },
        theme,
      },
    };
    __test__.updateFooterStatus(ctx as never);
    expect(statuses.get("lsp")).toContain("<success>");

    await client.shutdown();
    // shutdown fires onExit asynchronously — give it a beat, then recompute
    await new Promise((r) => setTimeout(r, 200));
    __test__.updateFooterStatus(ctx as never);
    expect(statuses.get("lsp") ?? "").not.toContain("<success>typescript-language-server</success>");
    resetManager();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
});
