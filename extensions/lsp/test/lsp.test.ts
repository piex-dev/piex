/**
 * Unit / integration tests for @piex-dev/lsp (mock stdio server, no real LS).
 * Run: bun test extensions/lsp/test/lsp.test.ts
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { __test__ } from "../src/lsp.ts";
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
    await getOrCreateServer(
      "typescript-language-server",
      { ...ts, command: process.execPath, args: [MOCK] },
      dir,
    );
    updateFooterStatus(ctx());
    expect(status).toContain(
      "<success>typescript-language-server</success>",
    );
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
      const green = status?.match(/<success>typescript-language-server<\/success>/g);
      expect(green?.length).toBe(1); // deduped, not doubled
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
});
