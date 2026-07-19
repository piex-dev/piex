#!/usr/bin/env node
/**
 * Minimal stdio LSP server for piex lsp tests.
 * Supports: initialize, initialized, didOpen/didChange/didSave,
 * publishDiagnostics (on open/change), definition, hover, rename, codeAction, formatting, shutdown.
 */
import * as readline from "node:readline";
import { Buffer } from "node:buffer";

const docs = new Map(); // uri -> text
let seq = 0;

function write(msg) {
  const body = JSON.stringify(msg);
  process.stdout.write(
    `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`,
  );
}

function publishDiags(uri, text) {
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
  write({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics },
  });
}

function handle(msg) {
  if (msg.id !== undefined && msg.method) {
    // request
    if (msg.method === "initialize") {
      write({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          capabilities: {
            textDocumentSync: { openClose: true, change: 1, save: {} },
            definitionProvider: true,
            hoverProvider: true,
            referencesProvider: true,
            documentSymbolProvider: true,
            workspaceSymbolProvider: true,
            documentFormattingProvider: true,
            renameProvider: true,
            codeActionProvider: true,
          },
        },
      });
      return;
    }
    if (msg.method === "shutdown") {
      write({ jsonrpc: "2.0", id: msg.id, result: null });
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

  if (msg.method === "initialized") return;
  if (msg.method === "exit") {
    process.exit(0);
  }
  if (msg.method === "workspace/didChangeConfiguration") return;
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
