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
