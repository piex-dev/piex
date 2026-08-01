#!/usr/bin/env node
/**
 * Minimal stdio LSP server for piex lsp tests.
 * Supports: initialize, initialized, didOpen/didChange/didSave,
 * publishDiagnostics (on open/change), definition, hover, rename, codeAction,
 * formatting, shutdown, LSP 3.17 pull diagnostics (textDocument/diagnostic +
 * workspace/diagnostic), dynamic capability registration, $/progress.
 *
 * Flags:
 *   --dynamic-diag  advertise NO static diagnosticProvider; register
 *                   textDocument/diagnostic via client/registerCapability
 *                   after `initialized` (document + workspace identifiers).
 *   --progress      emit $/progress begin ~100ms after initialized and
 *                   end ~400ms later (project-load tracking).
 */
import * as readline from "node:readline";
import { Buffer } from "node:buffer";

const DYNAMIC_DIAG = process.argv.includes("--dynamic-diag");
const PROGRESS = process.argv.includes("--progress");
const FAIL_PULL = process.argv.includes("--fail-pull");

const docs = new Map(); // uri -> text
let seq = 0;

function write(msg) {
  const body = JSON.stringify(msg);
  process.stdout.write(
    `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`,
  );
}

function computeDiags(uri, text) {
  const diagnostics = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const idx = line.indexOf("ERROR_HERE");
    if (idx >= 0) {
      diagnostics.push({
        range: {
          start: { line: i, character: idx },
          end: { line: i, character: idx + "ERROR_HERE".length },
        },
        severity: 1,
        source: "mock-lsp",
        message: "intentional mock error",
        relatedInformation: [
          {
            location: {
              uri,
              range: {
                start: { line: i, character: idx },
                end: { line: i, character: idx + 1 },
              },
            },
            message: "related note",
          },
        ],
      });
    }
  });
  return diagnostics;
}

function publishDiags(uri, text) {
  write({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics: computeDiags(uri, text) },
  });
}

/** Pull-diagnostic response for a uri: current file + (optionally) a
 *  related document when the content references RELATED_HERE. */
function diagnosticReport(uri) {
  const text = docs.get(uri) ?? "";
  const items = computeDiags(uri, text);
  const report = { kind: "full", items };
  if (text.includes("RELATED_HERE")) {
    const relatedUri = uri.replace(/\.\w+$/, "") + "-dep.ts";
    const relatedText = "const dep = ERROR_HERE;\n";
    docs.set(relatedUri, relatedText);
    report.relatedDocuments = {
      [relatedUri]: { kind: "full", items: computeDiags(relatedUri, relatedText) },
    };
  }
  return report;
}

function handle(msg) {
  if (msg.id !== undefined && msg.method) {
    // request
    if (msg.method === "initialize") {
      const capabilities = {
        textDocumentSync: { openClose: true, change: 1, save: {} },
        definitionProvider: true,
        hoverProvider: true,
        referencesProvider: true,
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        documentFormattingProvider: true,
        renameProvider: true,
        codeActionProvider: true,
      };
      if (!DYNAMIC_DIAG) {
        capabilities.diagnosticProvider = { identifier: "mock" };
        capabilities.workspace = { diagnosticProvider: true };
      }
      write({
        jsonrpc: "2.0",
        id: msg.id,
        result: { capabilities },
      });
      return;
    }
    if (msg.method === "shutdown") {
      write({ jsonrpc: "2.0", id: msg.id, result: null });
      return;
    }
    if (msg.method === "textDocument/diagnostic") {
      if (FAIL_PULL) {
        write({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: "pull not supported (mock)" },
        });
        return;
      }
      write({
        jsonrpc: "2.0",
        id: msg.id,
        result: diagnosticReport(msg.params.textDocument.uri),
      });
      return;
    }
    if (msg.method === "workspace/diagnostic") {
      const items = [];
      for (const [uri, text] of docs) {
        items.push({ uri, items: computeDiags(uri, text) });
      }
      write({ jsonrpc: "2.0", id: msg.id, result: { items } });
      return;
    }
    if (msg.method === "textDocument/definition") {
      const uri = msg.params.textDocument.uri;
      write({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          uri,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 3 },
          },
        },
      });
      return;
    }
    if (msg.method === "textDocument/hover") {
      write({
        jsonrpc: "2.0",
        id: msg.id,
        result: { contents: { kind: "markdown", value: "**mock** hover" } },
      });
      return;
    }
    if (msg.method === "textDocument/rename") {
      const uri = msg.params.textDocument.uri;
      const name = msg.params.newName;
      write({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          changes: {
            [uri]: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 3 },
                },
                newText: name,
              },
            ],
          },
        },
      });
      return;
    }
    if (msg.method === "textDocument/codeAction") {
      const uri = msg.params.textDocument.uri;
      write({
        jsonrpc: "2.0",
        id: msg.id,
        result: [
          {
            title: "Mock fix",
            kind: "quickfix",
            edit: {
              changes: {
                [uri]: [
                  {
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 0, character: 0 },
                    },
                    newText: "// fixed\n",
                  },
                ],
              },
            },
          },
        ],
      });
      return;
    }
    if (msg.method === "textDocument/formatting") {
      write({
        jsonrpc: "2.0",
        id: msg.id,
        result: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 0 },
            },
            newText: "// formatted\n",
          },
        ],
      });
      return;
    }
    if (msg.method === "textDocument/documentSymbol") {
      write({
        jsonrpc: "2.0",
        id: msg.id,
        result: [
          {
            name: "mockFn",
            kind: 12,
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 10 },
            },
            selectionRange: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 6 },
            },
          },
        ],
      });
      return;
    }
    if (msg.method === "workspace/symbol") {
      write({
        jsonrpc: "2.0",
        id: msg.id,
        result: [],
      });
      return;
    }
    write({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `unknown ${msg.method}` },
    });
    return;
  }

  if (msg.method === "initialized") {
    if (DYNAMIC_DIAG) {
      // Register pull diagnostics dynamically, like tsserver does.
      write({
        jsonrpc: "2.0",
        id: "reg-doc",
        method: "client/registerCapability",
        params: {
          registrations: [
            {
              id: "mock-dyn-doc",
              method: "textDocument/diagnostic",
              registerOptions: { identifier: "mock-dyn", workspaceDiagnostics: false },
            },
            {
              id: "mock-dyn-ws",
              method: "textDocument/diagnostic",
              registerOptions: { identifier: "mock-dyn-ws", workspaceDiagnostics: true },
            },
          ],
        },
      });
    }
    if (PROGRESS) {
      setTimeout(() => {
        write({
          jsonrpc: "2.0",
          method: "$/progress",
          params: { token: "mock-load", value: { kind: "begin", title: "loading" } },
        });
        setTimeout(() => {
          write({
            jsonrpc: "2.0",
            method: "$/progress",
            params: { token: "mock-load", value: { kind: "end" } },
          });
        }, 300);
      }, 100);
    }
    return;
  }
  if (msg.method === "exit") {
    process.exit(0);
  }
  if (msg.method === "workspace/didChangeConfiguration") return;
  if (msg.method === "workspace/didChangeWatchedFiles") return;
  if (msg.method === "textDocument/didOpen") {
    const { uri, text } = msg.params.textDocument;
    docs.set(uri, text);
    // small delay then publish
    setTimeout(() => publishDiags(uri, text), 30);
    return;
  }
  if (msg.method === "textDocument/didChange") {
    const uri = msg.params.textDocument.uri;
    const text = msg.params.contentChanges?.[0]?.text ?? docs.get(uri) ?? "";
    docs.set(uri, text);
    setTimeout(() => publishDiags(uri, text), 30);
    return;
  }
  if (msg.method === "textDocument/didSave") return;
}

// Content-Length framing on stdin
let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const header = buf.subarray(0, headerEnd).toString("utf8");
    const m = header.match(/Content-Length:\s*(\d+)/i);
    if (!m) {
      buf = buf.subarray(headerEnd + 4);
      continue;
    }
    const len = parseInt(m[1], 10);
    const start = headerEnd + 4;
    const end = start + len;
    if (buf.length < end) break;
    const body = buf.subarray(start, end).toString("utf8");
    buf = buf.subarray(end);
    try {
      handle(JSON.parse(body));
    } catch (e) {
      process.stderr.write(String(e) + "\n");
    }
  }
});
