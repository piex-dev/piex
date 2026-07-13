/**
 * lsp extension — registers an `lsp` tool for Language Server Protocol operations.
 *
 *   pi install npm:@piex-dev/lsp
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";

// ── LSP Types ──────────────────────────────────────────────────

interface Position { line: number; character: number; }
interface Range { start: Position; end: Position; }
interface Location { uri: string; range: Range; }
interface Diagnostic {
  range: Range; severity?: 1 | 2 | 3 | 4;
  code?: string | number; source?: string; message: string;
}
interface TextEdit { range: Range; newText: string; }
interface SymbolInfo { name: string; kind: number; location: Location; containerName?: string; }
interface DocumentSymbol { name: string; kind: number; range: Range; selectionRange: Range; children?: DocumentSymbol[]; }
interface Hover { contents: unknown; range?: Range; }

interface ServerConfig {
  command: string; args?: string[];
  languages?: string[]; fileTypes?: string[];
  rootMarkers?: string[];
  settings?: Record<string, unknown>;
  initializationOptions?: Record<string, unknown>;
}

// ── Config Loading ─────────────────────────────────────────────

function loadDefaults(): Record<string, ServerConfig> {
  const defaultsPath = path.join(__dirname, "defaults.json");
  try {
    const raw = JSON.parse(fs.readFileSync(defaultsPath, "utf-8"));
    const servers: Record<string, ServerConfig> = {};
    for (const [name, cfg] of Object.entries(raw)) {
      const c = cfg as Record<string, unknown>;
      if (typeof c.command === "string" && c.command.length > 0) {
        servers[name] = {
          command: c.command as string,
          args: Array.isArray(c.args) ? c.args as string[] : [],
          languages: Array.isArray(c.languages) ? c.languages as string[] : [],
          fileTypes: (Array.isArray(c.fileTypes) ? c.fileTypes as string[] : []).map(f => String(f).toLowerCase()),
          rootMarkers: Array.isArray(c.rootMarkers) ? c.rootMarkers as string[] : [],
          settings: c.settings && typeof c.settings === "object" ? c.settings as Record<string, unknown> : undefined,
          initializationOptions: c.initializationOptions && typeof c.initializationOptions === "object" ? c.initializationOptions as Record<string, unknown> : undefined,
        };
      }
    }
    return servers;
  } catch { return {}; }
}

// ── LSP Client ─────────────────────────────────────────────────

interface LspRequest {
  resolve: (body: unknown) => void;
  reject: (err: Error) => void;
  method: string;
}

class LspClient {
  // Per-URI diagnostic storage (populated by publishDiagnostics notifications)
  #diagnostics = new Map<string, Diagnostic[]>();

  getDiagnostics(uri: string): Diagnostic[] {
    return this.#diagnostics.get(uri) ?? [];
  }
  #proc: ChildProcessWithoutNullStreams;
  #seq = 0;
  #pending = new Map<number, LspRequest>();
  #buffer = Buffer.alloc(0);
  #decoder = new TextDecoder("utf-8");
  #capabilities: Record<string, unknown> = {};
  alive = true;

  constructor(proc: ChildProcessWithoutNullStreams) {
    this.#proc = proc;
    proc.on("exit", () => { this.alive = false; this.#rejectAll(new Error("LSP server exited")); });
    this.#startReader();
  }

  static spawn(command: string, args: string[], cwd: string): LspClient {
    const proc = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
    const client = new LspClient(proc as ChildProcessWithoutNullStreams);
    return client;
  }

  async initialize(rootUri: string, capOverrides?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.request<Record<string, unknown>>("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          formatting: {},
          rangeFormatting: {},
          rename: {},
          codeAction: {},
          synchronization: { didSave: true, didChange: false },
          publishDiagnostics: { relatedInformation: true },
        },
        workspace: {
          symbol: { dynamicRegistration: true },
          configuration: true,
        },
        ...capOverrides,
      },
    });
    this.#capabilities = (result?.capabilities as Record<string, unknown>) ?? {};
    this.notify("initialized", {});
    this.notify("workspace/didChangeConfiguration", { settings: {} });
    return this.#capabilities;
  }

  async shutdown(): Promise<void> {
    try { await this.request("shutdown"); } catch { /* ok */ }
    this.notify("exit", {});
    this.alive = false;
    this.#rejectAll(new Error("LSP server shutdown"));
    try { this.#proc.kill(); } catch { /* ok */ }
  }

  async request<T = unknown>(method: string, params?: unknown, timeoutMs: number = 30_000): Promise<T> {
    const id = ++this.#seq;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const header = `Content-Length: ${Buffer.byteLength(msg, "utf-8")}\r\n\r\n`;
    this.#proc.stdin.write(header + msg);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`LSP request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (body) => { clearTimeout(timer); resolve(body as T); },
        reject: (err) => { clearTimeout(timer); reject(err); },
        method,
      });
    });
  }

  notify(method: string, params?: unknown): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    const header = `Content-Length: ${Buffer.byteLength(msg, "utf-8")}\r\n\r\n`;
    this.#proc.stdin.write(header + msg);
  }

  #startReader(): void {
    let buffer = Buffer.alloc(0);
    this.#proc.stdout.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;
        const headerText = this.#decoder.decode(buffer.subarray(0, headerEnd));
        const m = headerText.match(/Content-Length: (\d+)/i);
        if (!m) { buffer = buffer.subarray(headerEnd + 4); continue; }
        const contentLen = parseInt(m[1], 10);
        const msgStart = headerEnd + 4;
        const msgEnd = msgStart + contentLen;
        if (buffer.length < msgEnd) break;
        const msgText = this.#decoder.decode(buffer.subarray(msgStart, msgEnd));
        buffer = buffer.subarray(msgEnd);
        try {
          const msg = JSON.parse(msgText);
          if (msg.id && this.#pending.has(msg.id)) {
            const p = this.#pending.get(msg.id)!;
            this.#pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message ?? `LSP error: ${msg.error.code}`));
            else p.resolve(msg.result);
          } else if (msg.method === "textDocument/publishDiagnostics") {
            const params = msg.params as { uri: string; diagnostics: Diagnostic[] } | undefined;
            if (params?.uri) this.#diagnostics.set(params.uri, params.diagnostics ?? []);
          }
        } catch { /* skip */ }
      }
    });
  }

  #rejectAll(err: Error): void {
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
  }
}

// ── LSP Manager ─────────────────────────────────────────────────

function fileToUri(filePath: string): string {
  const abs = path.resolve(filePath);
  const p = process.platform === "win32" ? "/" + abs.replace(/\\/g, "/") : abs;
  // URL-encode the path
  return "file://" + p.split("/").map(encodeURIComponent).join("/");
}

function uriToFile(uri: string): string {
  let p = decodeURIComponent(uri.replace(/^file:\/\/\//, "").replace(/^file:\/\//, ""));
  if (process.platform === "win32") p = p.replace(/\//g, "\\");
  return p;
}

function findServers(cwd: string): Array<{ name: string; config: ServerConfig }> {
  const defaults = loadDefaults();
  const results: Array<{ name: string; config: ServerConfig }> = [];

  for (const [name, config] of Object.entries(defaults)) {
    if (!config.rootMarkers || config.rootMarkers.length === 0) continue;
    const hasMarker = config.rootMarkers.some(marker => {
      const fullPath = path.join(cwd, marker);
      return fs.existsSync(fullPath);
    });
    if (hasMarker || !config.rootMarkers?.length) {
      results.push({ name, config });
    }
  }

  // If no root-marker matches found, return all servers that have no markers (universal)
  if (results.length === 0) {
    for (const [name, config] of Object.entries(defaults)) {
      if (!config.rootMarkers || config.rootMarkers.length === 0) {
        results.push({ name, config });
      }
    }
  }

  return results;
}

function which(cmd: string): string | null {
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : null;
  const PATH = process.env.PATH ?? "";
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT?.split(";") ?? [".exe", ".cmd", ".bat"])
    : [""];
  for (const dir of PATH.split(path.delimiter)) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; }
      catch { /* continue */ }
    }
  }
  return null;
}

function getFileType(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

function getServerForFile(cwd: string, filePath: string): { name: string; config: ServerConfig } | null {
  const servers = findServers(cwd);
  const ext = getFileType(filePath);

  // Exact file type match first
  for (const s of servers) {
    if (s.config.fileTypes?.includes(ext)) return s;
  }

  // Then by language
  for (const s of servers) {
    if (s.config.fileTypes?.length === 0 && !s.config.rootMarkers?.length) return s;
  }

  return servers[0] ?? null;
}

// ── Diagnostic Rendering ───────────────────────────────────────

const SYMBOL_KINDS: Record<number, string> = {
  1: "F", 2: "M", 3: "N", 4: "E", 5: "C",
  6: "I", 7: "P", 9: "C", 11: "I12", 12: "F12",
  13: "V", 14: "K", 15: "KI", 23: "S",
};

function formatDiag(d: Diagnostic, fileRel: string): string {
  const sev = d.severity === 1 ? "error" : d.severity === 2 ? "warning" : d.severity === 3 ? "info" : "hint";
  const pos = `L${d.range.start.line + 1}:${d.range.start.character + 1}`;
  const src = d.source ? `[${d.source}]` : "";
  return `${fileRel}:${pos} ${sev} ${src} ${d.message}`;
}

function formatLocation(loc: Location): string {
  const file = uriToFile(loc.uri);
  return `${file}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
}

function formatHover(h: Hover): string {
  if (typeof h.contents === "string") return h.contents;
  if (Array.isArray(h.contents)) {
    // MarkedString[]
    return h.contents.map(c => typeof c === "string" ? c : (c as any).value ?? "").join("\n");
  }
  // MarkupContent
  return (h.contents as any).value ?? JSON.stringify(h.contents);
}

// ── Launched LSP manager ───────────────────────────────────────

interface ActiveServer {
  name: string;
  client: LspClient;
  cwd: string;
}

const activeServers = new Map<string, ActiveServer>();

function serverKey(name: string, cwd: string): string {
  return `${name}::${path.resolve(cwd)}`;
}

async function getOrCreateServer(name: string, config: ServerConfig, cwd: string): Promise<LspClient> {
  const key = serverKey(name, cwd);
  const existing = activeServers.get(key);
  if (existing && existing.client.alive) return existing.client;

  const cmd = which(config.command);
  if (!cmd) throw new Error(`LSP server '${name}' not found: ${config.command} not on PATH`);
  const client = LspClient.spawn(cmd, config.args ?? [], cwd);
  const rootUri = fileToUri(cwd);
  const caps = await client.initialize(rootUri, config.initializationOptions);

  activeServers.set(key, { name, client, cwd });
  return client;
}

async function ensureFileOpen(client: LspClient, filePath: string): Promise<void> {
  const uri = fileToUri(filePath);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    client.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: getFileType(filePath).replace(".", ""), version: 1, text: content },
    });
  } catch { /* file might not exist */ }
}

// ── Pi Extension ───────────────────────────────────────────────

export default function lspExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: `Query Language Server Protocol for diagnostics, definitions, references, hover, symbols, and formatting.

Supported actions:
  diagnostics  — Get diagnostics/errors for a file
  definition   — Go to definition
  references   — Find all references to a symbol
  hover        — Get documentation for a symbol at cursor
  symbols      — List document symbols (outline)
  workspace_symbols — Search workspace symbols by name
  format       — Format a document
  status       — Show LSP server status
  reload       — Reload LSP servers`,

    parameters: Type.Object({
      action: Type.String({ description: "LSP action: diagnostics, definition, references, hover, symbols, workspace_symbols, format, status, reload" }),
      file: Type.Optional(Type.String({ description: "File path (relative to cwd)" })),
      line: Type.Optional(Type.Number({ description: "Line number (1-indexed)" })),
      column: Type.Optional(Type.Number({ description: "Column number (1-indexed, default: 1)" })),
      symbol: Type.Optional(Type.String({ description: "Symbol name to search for (workspace_symbols)" })),
      query: Type.Optional(Type.String({ description: "Filter query for symbols" })),
      timeout: Type.Optional(Type.Number({ default: 15, description: "Timeout in seconds" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = String(params.action ?? "").trim().toLowerCase();
      const cwd = ctx.cwd;
      const timeoutMs = (typeof params.timeout === "number" && params.timeout > 0 ? params.timeout : 15) * 1000;

      // ── Status ──────────────────────────────────────
      if (action === "status") {
        const defaults = loadDefaults();
        const available = findServers(cwd);
        const serverList = available.map(s => {
          const key = serverKey(s.name, cwd);
          const active = activeServers.get(key);
          return `${s.name} (${active && active.client.alive ? "running" : "not started"}) [${s.config.fileTypes?.join(", ") ?? "any"}]`;
        });
        return {
          content: [{ type: "text", text: serverList.length > 0
            ? `LSP servers:\n${serverList.join("\n")}`
            : "No LSP servers configured for this project." }],
          details: { action, success: true },
        };
      }

      // ── Actions requiring file ─────────────────────
      if (action === "diagnostics" || action === "definition" || action === "references" || action === "hover" || action === "symbols" || action === "format") {
        if (typeof params.file !== "string" || !params.file) {
          throw new Error(`'file' parameter is required for action '${action}'`);
        }
        const absPath = path.resolve(cwd, params.file);
        const server = getServerForFile(cwd, absPath);
        if (!server) throw new Error(`No LSP server found for ${params.file}`);

        const client = await getOrCreateServer(server.name, server.config, cwd);
        const fileRel = path.relative(cwd, absPath);

        try {
          switch (action) {
            case "diagnostics": {
              await ensureFileOpen(client, absPath);
              const uri = fileToUri(absPath);
              client.notify("textDocument/didSave", { textDocument: { uri } });

              // Wait up to 3s for publishDiagnostics notification
              const maxWait = 3000;
              const pollInterval = 100;
              let elapsed = 0;
              while (elapsed < maxWait) {
                await new Promise(r => setTimeout(r, pollInterval));
                elapsed += pollInterval;
                const diags = client.getDiagnostics(uri);
                if (diags.length > 0) {
                  const lines = diags.map(d => formatDiag(d, fileRel));
                  return {
                    content: [{ type: "text", text: `${fileRel}: ${diags.length} issue${diags.length > 1 ? "s" : ""}\n${lines.join("\n")}` }],
                    details: { action, success: true, server: server.name, count: diags.length },
                  };
                }
              }
              return {
                content: [{ type: "text", text: `${fileRel}: no diagnostics (server: ${server.name})` }],
                details: { action, success: true, server: server.name, count: 0 },
              };
            }

            case "definition": {
              if (typeof params.line !== "number" || params.line < 1) throw new Error("'line' required for definition.");
              const col = (typeof params.column === "number" && params.column >= 1 ? params.column : 1) - 1;
              await ensureFileOpen(client, absPath);
              const locs = await client.request<Location[]>("textDocument/definition", {
                textDocument: { uri: fileToUri(absPath) },
                position: { line: params.line - 1, character: col },
              }, timeoutMs);
              if (!locs || (Array.isArray(locs) && locs.length === 0)) {
                return { content: [{ type: "text", text: "No definition found." }], details: { action, success: true } };
              }
              const arr = Array.isArray(locs) ? locs : [locs];
              return {
                content: [{ type: "text", text: arr.map(l => formatLocation(l)).join("\n") }],
                details: { action, success: true },
              };
            }

            case "references": {
              if (typeof params.line !== "number") throw new Error("'line' required for references.");
              const col = (typeof params.column === "number" && params.column >= 1 ? params.column : 1) - 1;
              await ensureFileOpen(client, absPath);
              const refs = await client.request<Location[]>("textDocument/references", {
                textDocument: { uri: fileToUri(absPath) },
                position: { line: params.line - 1, character: col },
                context: { includeDeclaration: true },
              }, timeoutMs);
              if (!refs || refs.length === 0) return { content: [{ type: "text", text: "No references found." }], details: { action, success: true } };
              const limited = refs.slice(0, 50);
              const lines = limited.map(r => `  ${formatLocation(r)}`);
              if (refs.length > 50) lines.push(`  ...and ${refs.length - 50} more`);
              return { content: [{ type: "text", text: `References (${refs.length}):\n${lines.join("\n")}` }], details: { action, success: true } };
            }

            case "hover": {
              if (typeof params.line !== "number") throw new Error("'line' required for hover.");
              const col = (typeof params.column === "number" && params.column >= 1 ? params.column : 1) - 1;
              await ensureFileOpen(client, absPath);
              const h = await client.request<Hover | null>("textDocument/hover", {
                textDocument: { uri: fileToUri(absPath) },
                position: { line: params.line - 1, character: col },
              }, timeoutMs);
              if (!h) return { content: [{ type: "text", text: "No hover information available." }], details: { action, success: true } };
              return { content: [{ type: "text", text: formatHover(h) }], details: { action, success: true } };
            }

            case "symbols": {
              await ensureFileOpen(client, absPath);
              const syms = await client.request<DocumentSymbol[] | SymbolInfo[]>("textDocument/documentSymbol", {
                textDocument: { uri: fileToUri(absPath) },
              }, timeoutMs);
              if (!syms || syms.length === 0) return { content: [{ type: "text", text: "No symbols found." }], details: { action, success: true } };
              const lines: string[] = [];
              function walk(arr: (DocumentSymbol | SymbolInfo)[], indent: string) {
                for (const s of arr) {
                  const icon = SYMBOL_KINDS[s.kind] ?? "?";
                  if ("children" in s && s.children) {
                    lines.push(`${indent}${icon} ${s.name} (L${s.range.start.line + 1}-L${s.range.end.line + 1})`);
                    walk(s.children, indent + "  ");
                  } else {
                    const loc = "location" in s ? ` at ${formatLocation(s.location)}` : ` (L${s.range.start.line + 1})`;
                    lines.push(`${indent}${icon} ${s.name}${loc}`);
                  }
                }
              }
              walk(syms, "  ");
              return { content: [{ type: "text", text: `Symbols in ${fileRel}:\n${lines.join("\n")}` }], details: { action, success: true } };
            }

            case "format": {
              await ensureFileOpen(client, absPath);
              const edits = await client.request<TextEdit[] | null>("textDocument/formatting", {
                textDocument: { uri: fileToUri(absPath) },
                options: { tabSize: 2, insertSpaces: true },
              }, timeoutMs);
              if (!edits || edits.length === 0) return { content: [{ type: "text", text: `No formatting changes needed for ${fileRel}` }], details: { action, success: true } };

              // Apply edits
              let text = fs.readFileSync(absPath, "utf-8");
              // Apply in reverse order to preserve positions
              const sorted = [...edits].sort((a, b) => {
                if (a.range.start.line !== b.range.start.line) return b.range.start.line - a.range.start.line;
                return b.range.start.character - a.range.start.character;
              });
              const lines = text.split("\n");
              for (const e of sorted) {
                const before = lines[e.range.start.line].substring(0, e.range.start.character);
                const after = e.range.end.line < lines.length
                  ? lines[e.range.end.line].substring(e.range.end.character)
                  : "";
                lines[e.range.start.line] = before + e.newText + after;
                if (e.range.end.line > e.range.start.line) {
                  lines.splice(e.range.start.line + 1, e.range.end.line - e.range.start.line);
                }
              }
              const newText = lines.join("\n");
              fs.writeFileSync(absPath, newText);
              return { content: [{ type: "text", text: `Formatted ${fileRel}` }], details: { action, success: true } };
            }

            default:
              throw new Error(`Unknown action: ${action}`);
          }
        } catch (err) {
          return {
            content: [{ type: "text", text: `LSP ${action} failed: ${err instanceof Error ? err.message : String(err)}` }],
            details: { action, success: false },
          };
        }
      }

      // ── Workspace symbols ───────────────────────────
      if (action === "workspace_symbols") {
        if (typeof params.symbol !== "string" || !params.symbol) throw new Error("'symbol' required for workspace_symbols");
        const servers = findServers(cwd);
        if (servers.length === 0) throw new Error("No LSP servers configured.");

        for (const srv of servers) {
          try {
            const client = await getOrCreateServer(srv.name, srv.config, cwd);
            const syms = await client.request<SymbolInfo[]>("workspace/symbol", { query: params.symbol }, timeoutMs);
            if (syms && syms.length > 0) {
              const limited = syms.slice(0, 30);
              return {
                content: [{ type: "text",
                  text: `Workspace symbols matching '${params.symbol}' (${syms.length} results):\n${limited.map(s => `  ${SYMBOL_KINDS[s.kind] ?? "?"} ${s.name} — ${formatLocation(s.location)}`).join("\n")}${syms.length > 30 ? `\n  ...and ${syms.length - 30} more` : ""}` }],
                details: { action, success: true },
              };
            }
          } catch { /* try next server */ }
        }
        return { content: [{ type: "text", text: `No symbols found for '${params.symbol}'` }], details: { action, success: true } };
      }

      // ── Reload ──────────────────────────────────────
      if (action === "reload") {
        // Dispose all active servers
        for (const [key, srv] of activeServers) {
          try { await srv.client.shutdown(); } catch { /* ok */ }
        }
        activeServers.clear();
        return { content: [{ type: "text", text: "LSP servers reloaded." }], details: { action, success: true } };
      }

      throw new Error(`Unknown action: ${action}. Supported: diagnostics, definition, references, hover, symbols, workspace_symbols, format, status, reload`);
    },
  });

  // ── Cleanup on shutdown ────────────────────────────
  pi.on("session_shutdown", async () => {
    for (const [key, srv] of activeServers) {
      try { await srv.client.shutdown(); } catch { /* ok */ }
    }
    activeServers.clear();
  });
}
