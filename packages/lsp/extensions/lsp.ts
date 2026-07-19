/**
 * lsp extension — Language Server Protocol tool + post-edit diagnostics.
 *
 * Phase 0: correct init/settings, didChange sync, multi-server route, wait semantics
 * Phase 1: tool_result hook on edit/write → ERROR diagnostics (default on)
 * Phase 2: rename (preview default), code_actions, type_definition, implementation
 *
 *   pi install npm:@piex-dev/lsp
 *   PI_LSP_DIAGNOSTICS_ON_EDIT=0  # disable post-edit diagnostics
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Types ──────────────────────────────────────────────────────

interface Position { line: number; character: number; }
interface Range { start: Position; end: Position; }
interface Location { uri: string; range: Range; }
interface LocationLink { targetUri: string; targetRange: Range; targetSelectionRange?: Range; }
interface DiagnosticRelated { location: Location; message: string; }
interface Diagnostic {
  range: Range;
  severity?: 1 | 2 | 3 | 4;
  code?: string | number;
  source?: string;
  message: string;
  relatedInformation?: DiagnosticRelated[];
}
interface TextEdit { range: Range; newText: string; }
interface SymbolInfo { name: string; kind: number; location: Location; containerName?: string; }
interface DocumentSymbol {
  name: string; kind: number; range: Range; selectionRange: Range; children?: DocumentSymbol[];
}
interface Hover { contents: unknown; range?: Range; }
interface CodeAction {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  diagnostics?: Diagnostic[];
  edit?: WorkspaceEdit;
  command?: { title: string; command: string; arguments?: unknown[] };
  data?: unknown;
}
interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: Array<
    | { textDocument: { uri: string; version?: number | null }; edits: TextEdit[] }
    | { kind: "create"; uri: string; options?: { overwrite?: boolean } }
    | { kind: "rename"; oldUri: string; newUri: string }
    | { kind: "delete"; uri: string }
  >;
}

interface ServerConfig {
  command: string;
  args?: string[];
  languages?: string[];
  fileTypes?: string[];
  rootMarkers?: string[];
  settings?: Record<string, unknown>;
  initializationOptions?: Record<string, unknown>;
  isLinter?: boolean;
}

// ── Config ─────────────────────────────────────────────────────

function loadDefaults(): Record<string, ServerConfig> {
  const defaultsPath = path.join(__dirname, "defaults.json");
  try {
    const raw = JSON.parse(fs.readFileSync(defaultsPath, "utf-8")) as Record<string, unknown>;
    const servers: Record<string, ServerConfig> = {};
    for (const [name, cfg] of Object.entries(raw)) {
      const c = cfg as Record<string, unknown>;
      if (typeof c.command !== "string" || !c.command) continue;
      const init =
        (c.initOptions && typeof c.initOptions === "object" ? c.initOptions : undefined) ??
        (c.initializationOptions && typeof c.initializationOptions === "object"
          ? c.initializationOptions
          : undefined);
      servers[name] = {
        command: c.command,
        args: Array.isArray(c.args) ? (c.args as string[]) : [],
        languages: Array.isArray(c.languages) ? (c.languages as string[]) : [],
        fileTypes: (Array.isArray(c.fileTypes) ? c.fileTypes as string[] : []).map((f) =>
          String(f).toLowerCase(),
        ),
        rootMarkers: Array.isArray(c.rootMarkers) ? (c.rootMarkers as string[]) : [],
        settings: c.settings && typeof c.settings === "object"
          ? (c.settings as Record<string, unknown>)
          : undefined,
        initializationOptions: init as Record<string, unknown> | undefined,
        isLinter: c.isLinter === true,
      };
    }
    return servers;
  } catch {
    return {};
  }
}

// ── Client ─────────────────────────────────────────────────────

interface LspRequest {
  resolve: (body: unknown) => void;
  reject: (err: Error) => void;
  method: string;
  timer: ReturnType<typeof setTimeout>;
}

class LspClient {
  #proc: ChildProcessWithoutNullStreams;
  #seq = 0;
  #pending = new Map<number, LspRequest>();
  #decoder = new TextDecoder("utf-8");
  #diagnostics = new Map<string, Diagnostic[]>();
  /** URIs that have received at least one publishDiagnostics (including empty). */
  #diagReceived = new Set<string>();
  #openVersions = new Map<string, number>();
  #settings: Record<string, unknown> = {};
  #capabilities: Record<string, unknown> = {};
  alive = true;

  constructor(proc: ChildProcessWithoutNullStreams) {
    this.#proc = proc;
    proc.on("exit", () => {
      this.alive = false;
      this.#rejectAll(new Error("LSP server exited"));
    });
    this.#startReader();
  }

  static spawn(command: string, args: string[], cwd: string): LspClient {
    const proc = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    return new LspClient(proc as ChildProcessWithoutNullStreams);
  }

  get capabilities(): Record<string, unknown> {
    return this.#capabilities;
  }

  getDiagnostics(uri: string): Diagnostic[] {
    return this.#diagnostics.get(uri) ?? [];
  }

  hasReceivedDiagnostics(uri: string): boolean {
    return this.#diagReceived.has(uri);
  }

  clearDiagnosticsFlag(uri: string): void {
    this.#diagReceived.delete(uri);
  }

  async initialize(
    rootUri: string,
    opts?: {
      initializationOptions?: Record<string, unknown>;
      settings?: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown>> {
    this.#settings = opts?.settings ?? {};
    const result = await this.request<Record<string, unknown>>("initialize", {
      processId: process.pid,
      rootUri,
      rootPath: uriToFile(rootUri),
      initializationOptions: opts?.initializationOptions ?? {},
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
          typeDefinition: { linkSupport: true },
          implementation: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          formatting: {},
          rangeFormatting: {},
          rename: { prepareSupport: true },
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: [
                  "",
                  "quickfix",
                  "refactor",
                  "refactor.extract",
                  "refactor.inline",
                  "refactor.rewrite",
                  "source",
                  "source.organizeImports",
                ],
              },
            },
            resolveSupport: { properties: ["edit", "command"] },
          },
          synchronization: { didSave: true, didChange: true, willSave: false },
          publishDiagnostics: { relatedInformation: true, versionSupport: true },
        },
        workspace: {
          symbol: { dynamicRegistration: true },
          configuration: true,
          workspaceFolders: true,
          applyEdit: true,
          workspaceEdit: {
            documentChanges: true,
            resourceOperations: ["create", "rename", "delete"],
          },
        },
      },
      workspaceFolders: [{ uri: rootUri, name: path.basename(uriToFile(rootUri)) }],
    });
    this.#capabilities = (result?.capabilities as Record<string, unknown>) ?? {};
    this.notify("initialized", {});
    if (Object.keys(this.#settings).length > 0) {
      this.notify("workspace/didChangeConfiguration", { settings: this.#settings });
    }
    return this.#capabilities;
  }

  async shutdown(): Promise<void> {
    try {
      await this.request("shutdown", undefined, 5_000);
    } catch { /* ok */ }
    this.notify("exit", {});
    this.alive = false;
    this.#rejectAll(new Error("LSP server shutdown"));
    try {
      this.#proc.kill();
    } catch { /* ok */ }
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw new Error("Aborted");
    const id = ++this.#seq;
    this.#write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const p = this.#pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        this.#pending.delete(id);
        reject(new Error("Aborted"));
      };
      if (signal) {
        if (signal.aborted) {
          reject(new Error("Aborted"));
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`LSP request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        method,
        timer,
        resolve: (body) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(body as T);
        },
        reject: (err) => {
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
      });
    });
  }

  notify(method: string, params?: unknown): void {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  #write(msg: unknown): void {
    const body = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;
    try {
      this.#proc.stdin.write(header + body);
    } catch { /* dead */ }
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
        if (!m) {
          buffer = buffer.subarray(headerEnd + 4);
          continue;
        }
        const contentLen = parseInt(m[1], 10);
        const msgStart = headerEnd + 4;
        const msgEnd = msgStart + contentLen;
        if (buffer.length < msgEnd) break;
        const msgText = this.#decoder.decode(buffer.subarray(msgStart, msgEnd));
        buffer = buffer.subarray(msgEnd);
        try {
          this.#handleMessage(JSON.parse(msgText));
        } catch { /* skip */ }
      }
    });
  }

  #handleMessage(msg: {
    id?: number | string;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code?: number; message?: string };
  }): void {
    // Server → client request
    if (msg.method && msg.id !== undefined && msg.result === undefined && !msg.error) {
      this.#handleServerRequest(msg.id, msg.method, msg.params);
      return;
    }
    // Response
    if (msg.id !== undefined && this.#pending.has(Number(msg.id))) {
      const p = this.#pending.get(Number(msg.id))!;
      this.#pending.delete(Number(msg.id));
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? `LSP error: ${msg.error.code}`));
      else p.resolve(msg.result);
      return;
    }
    // Notification
    if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params as { uri?: string; diagnostics?: Diagnostic[] } | undefined;
      if (params?.uri) {
        this.#diagnostics.set(params.uri, params.diagnostics ?? []);
        this.#diagReceived.add(params.uri);
      }
    }
  }

  #handleServerRequest(id: number | string, method: string, params: unknown): void {
    if (method === "workspace/configuration") {
      const p = params as { items?: Array<{ section?: string }> } | undefined;
      const items = p?.items ?? [];
      const result = items.map((item) => {
        if (!item.section) return this.#settings;
        const parts = item.section.split(".");
        let cur: unknown = this.#settings;
        for (const part of parts) {
          if (cur && typeof cur === "object" && part in (cur as object)) {
            cur = (cur as Record<string, unknown>)[part];
          } else {
            return null;
          }
        }
        return cur ?? null;
      });
      this.#write({ jsonrpc: "2.0", id, result });
      return;
    }
    if (method === "workspace/workspaceFolders") {
      this.#write({ jsonrpc: "2.0", id, result: null });
      return;
    }
    if (method === "window/workDoneProgress/create") {
      this.#write({ jsonrpc: "2.0", id, result: null });
      return;
    }
    if (method === "client/registerCapability" || method === "client/unregisterCapability") {
      this.#write({ jsonrpc: "2.0", id, result: null });
      return;
    }
    if (method === "workspace/applyEdit") {
      // Acknowledge; agent-driven apply goes through tool actions
      this.#write({ jsonrpc: "2.0", id, result: { applied: false } });
      return;
    }
    // Unknown server request
    this.#write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not supported: ${method}` },
    });
  }

  #rejectAll(err: Error): void {
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();
  }

  /** Open or full-text sync document from disk. */
  syncFile(filePath: string, languageId?: string): void {
    const uri = fileToUri(filePath);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return;
    }
    const lang = languageId ?? extToLanguageId(filePath);
    const prev = this.#openVersions.get(uri);
    if (prev === undefined) {
      this.#openVersions.set(uri, 1);
      this.clearDiagnosticsFlag(uri);
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: lang, version: 1, text: content },
      });
    } else {
      const next = prev + 1;
      this.#openVersions.set(uri, next);
      this.clearDiagnosticsFlag(uri);
      this.notify("textDocument/didChange", {
        textDocument: { uri, version: next },
        contentChanges: [{ text: content }],
      });
    }
  }

  notifySaved(filePath: string): void {
    const uri = fileToUri(filePath);
    this.notify("textDocument/didSave", { textDocument: { uri } });
  }

  async waitForDiagnostics(
    uri: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ diagnostics: Diagnostic[]; timedOut: boolean }> {
    const start = Date.now();
    const step = 80;
    while (Date.now() - start < timeoutMs) {
      if (signal?.aborted) throw new Error("Aborted");
      if (this.hasReceivedDiagnostics(uri)) {
        return { diagnostics: this.getDiagnostics(uri), timedOut: false };
      }
      await sleep(step);
    }
    return {
      diagnostics: this.getDiagnostics(uri),
      timedOut: !this.hasReceivedDiagnostics(uri),
    };
  }
}

// ── Path / URI helpers ─────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fileToUri(filePath: string): string {
  const abs = path.resolve(filePath);
  if (process.platform === "win32") {
    const norm = abs.replace(/\\/g, "/");
    return "file:///" + norm.split("/").map(encodeURIComponent).join("/");
  }
  return "file://" + abs.split("/").map((s, i) => (i === 0 && s === "" ? "" : encodeURIComponent(s))).join("/");
}

function uriToFile(uri: string): string {
  let p = uri.replace(/^file:\/\//, "");
  if (process.platform === "win32") {
    p = decodeURIComponent(p.replace(/^\//, ""));
    return p.replace(/\//g, "\\");
  }
  return decodeURIComponent(p);
}

function extToLanguageId(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescriptreact",
    js: "javascript",
    jsx: "javascriptreact",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    rs: "rust",
    go: "go",
    md: "markdown",
    json: "json",
    css: "css",
    html: "html",
    htm: "html",
    yml: "yaml",
    yaml: "yaml",
    sh: "shellscript",
    bash: "shellscript",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    java: "java",
    kt: "kotlin",
    rb: "ruby",
    php: "php",
    lua: "lua",
    swift: "swift",
    dart: "dart",
    vue: "vue",
    svelte: "svelte",
  };
  return map[ext] ?? ext ?? "plaintext";
}

function getFileType(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

function which(cmd: string, cwd?: string): string | null {
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : null;
  const extra: string[] = [];
  if (cwd) {
    extra.push(path.join(cwd, "node_modules", ".bin"));
    extra.push(path.join(cwd, ".venv", "bin"));
    extra.push(path.join(cwd, "venv", "bin"));
  }
  const PATH = process.env.PATH ?? "";
  const dirs = [...extra, ...PATH.split(path.delimiter).filter(Boolean)];
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT?.split(";") ?? [".exe", ".cmd", ".bat", ""])
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        try {
          if (fs.existsSync(candidate)) return candidate;
        } catch { /* continue */ }
      }
    }
  }
  return null;
}

function markerExists(cwd: string, marker: string): boolean {
  if (marker.includes("*") || marker.includes("?")) {
    // Simple glob: only support prefix*suffix in a single path segment
    try {
      const entries = fs.readdirSync(cwd);
      const re = new RegExp(
        "^" + marker.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
      );
      return entries.some((e) => re.test(e));
    } catch {
      return false;
    }
  }
  return fs.existsSync(path.join(cwd, marker));
}

function findServers(cwd: string): Array<{ name: string; config: ServerConfig }> {
  const defaults = loadDefaults();
  const results: Array<{ name: string; config: ServerConfig }> = [];
  for (const [name, config] of Object.entries(defaults)) {
    if (config.rootMarkers && config.rootMarkers.length > 0) {
      if (config.rootMarkers.some((m) => markerExists(cwd, m))) {
        results.push({ name, config });
      }
    }
  }
  if (results.length === 0) {
    for (const [name, config] of Object.entries(defaults)) {
      if (!config.rootMarkers || config.rootMarkers.length === 0) {
        results.push({ name, config });
      }
    }
  }
  return results;
}

function getServersForFile(
  cwd: string,
  filePath: string,
): Array<{ name: string; config: ServerConfig }> {
  const servers = findServers(cwd);
  const ext = getFileType(filePath);
  const matched = servers.filter((s) => s.config.fileTypes?.includes(ext));
  if (matched.length > 0) return matched;
  // basename match e.g. Dockerfile
  const base = path.basename(filePath).toLowerCase();
  const byBase = servers.filter((s) =>
    s.config.fileTypes?.some((ft) => ft.toLowerCase() === base || ft.toLowerCase() === `.${base}`),
  );
  if (byBase.length > 0) return byBase;
  return [];
}

function getPrimaryServerForFile(
  cwd: string,
  filePath: string,
): { name: string; config: ServerConfig } | null {
  const all = getServersForFile(cwd, filePath);
  const primary = all.find((s) => !s.config.isLinter);
  return primary ?? all[0] ?? null;
}

// ── Formatting / edits ─────────────────────────────────────────

const SYMBOL_KINDS: Record<number, string> = {
  1: "F", 2: "M", 3: "N", 4: "P", 5: "C", 6: "m", 7: "p", 8: "f",
  9: "ctor", 10: "E", 11: "I", 12: "fn", 13: "v", 14: "c", 15: "s",
  16: "n", 20: "e", 22: "t", 23: "S", 26: "T",
};

function formatDiag(d: Diagnostic, fileRel: string): string {
  const sev =
    d.severity === 1 ? "error" : d.severity === 2 ? "warning" : d.severity === 3 ? "info" : "hint";
  const pos = `L${d.range.start.line + 1}:${d.range.start.character + 1}`;
  const src = d.source ? `[${d.source}]` : "";
  let line = `${fileRel}:${pos} ${sev} ${src} ${d.message}`.replace(/\s+/g, " ").trim();
  if (d.relatedInformation?.length) {
    for (const r of d.relatedInformation.slice(0, 3)) {
      line += `\n    → ${formatLocation(r.location)} ${r.message}`;
    }
  }
  return line;
}

function formatLocation(loc: Location): string {
  const file = uriToFile(loc.uri);
  return `${file}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
}

function normalizeLocations(raw: unknown): Location[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const out: Location[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Location & LocationLink;
    if ("uri" in o && o.uri && o.range) out.push({ uri: o.uri, range: o.range });
    else if ("targetUri" in o && o.targetUri) {
      out.push({
        uri: o.targetUri,
        range: o.targetSelectionRange ?? o.targetRange,
      });
    }
  }
  return out;
}

function formatHover(h: Hover): string {
  if (typeof h.contents === "string") return h.contents;
  if (Array.isArray(h.contents)) {
    return h.contents
      .map((c) => (typeof c === "string" ? c : (c as { value?: string }).value ?? ""))
      .join("\n");
  }
  return (h.contents as { value?: string })?.value ?? JSON.stringify(h.contents);
}

function applyTextEditsToContent(text: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => {
    if (a.range.start.line !== b.range.start.line) return b.range.start.line - a.range.start.line;
    if (a.range.start.character !== b.range.start.character) {
      return b.range.start.character - a.range.start.character;
    }
    return 0;
  });
  // Work on full string offsets
  const lines = text.split("\n");
  const offsetAt = (line: number, character: number): number => {
    let off = 0;
    for (let i = 0; i < line && i < lines.length; i++) off += lines[i].length + 1;
    return off + character;
  };
  let result = text;
  for (const e of sorted) {
    const start = offsetAt(e.range.start.line, e.range.start.character);
    const end = offsetAt(e.range.end.line, e.range.end.character);
    result = result.slice(0, start) + e.newText + result.slice(end);
  }
  return result;
}

function assertPathInCwd(cwd: string, filePath: string): string {
  const abs = path.resolve(cwd, filePath);
  const root = path.resolve(cwd);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path escapes project cwd: ${filePath}`);
  }
  return abs;
}

function applyWorkspaceEdit(cwd: string, edit: WorkspaceEdit): string[] {
  const touched: string[] = [];
  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      const fp = assertPathInCwd(cwd, uriToFile(uri));
      const text = fs.existsSync(fp) ? fs.readFileSync(fp, "utf-8") : "";
      fs.writeFileSync(fp, applyTextEditsToContent(text, edits));
      touched.push(path.relative(cwd, fp) || fp);
    }
  }
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("textDocument" in change && change.textDocument) {
        const fp = assertPathInCwd(cwd, uriToFile(change.textDocument.uri));
        const text = fs.existsSync(fp) ? fs.readFileSync(fp, "utf-8") : "";
        fs.writeFileSync(fp, applyTextEditsToContent(text, change.edits));
        touched.push(path.relative(cwd, fp) || fp);
      } else if ("kind" in change && change.kind === "create") {
        const fp = assertPathInCwd(cwd, uriToFile(change.uri));
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        if (!fs.existsSync(fp) || change.options?.overwrite) fs.writeFileSync(fp, "");
        touched.push(path.relative(cwd, fp) || fp);
      } else if ("kind" in change && change.kind === "rename") {
        const oldP = assertPathInCwd(cwd, uriToFile(change.oldUri));
        const newP = assertPathInCwd(cwd, uriToFile(change.newUri));
        fs.mkdirSync(path.dirname(newP), { recursive: true });
        fs.renameSync(oldP, newP);
        touched.push(`${path.relative(cwd, oldP)} → ${path.relative(cwd, newP)}`);
      } else if ("kind" in change && change.kind === "delete") {
        const fp = assertPathInCwd(cwd, uriToFile(change.uri));
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
        touched.push(`deleted ${path.relative(cwd, fp)}`);
      }
    }
  }
  return touched;
}

function summarizeWorkspaceEdit(edit: WorkspaceEdit): string {
  const files = new Set<string>();
  if (edit.changes) for (const u of Object.keys(edit.changes)) files.add(uriToFile(u));
  if (edit.documentChanges) {
    for (const c of edit.documentChanges) {
      if ("textDocument" in c) files.add(uriToFile(c.textDocument.uri));
      else if ("kind" in c && c.kind === "create") files.add(uriToFile(c.uri));
      else if ("kind" in c && c.kind === "rename") {
        files.add(uriToFile(c.oldUri));
        files.add(uriToFile(c.newUri));
      } else if ("kind" in c && c.kind === "delete") files.add(uriToFile(c.uri));
    }
  }
  return `${files.size} file(s): ${[...files].slice(0, 10).join(", ")}${files.size > 10 ? "…" : ""}`;
}

// ── Manager ────────────────────────────────────────────────────

interface ActiveServer {
  name: string;
  client: LspClient;
  cwd: string;
  config: ServerConfig;
}

const activeServers = new Map<string, ActiveServer>();
const brokenServers = new Set<string>();

function serverKey(name: string, cwd: string): string {
  return `${name}::${path.resolve(cwd)}`;
}

async function getOrCreateServer(
  name: string,
  config: ServerConfig,
  cwd: string,
): Promise<LspClient> {
  const key = serverKey(name, cwd);
  const existing = activeServers.get(key);
  if (existing?.client.alive) return existing.client;
  if (brokenServers.has(key)) {
    throw new Error(`LSP server '${name}' previously failed to start (reload to retry)`);
  }

  const cmd = which(config.command, cwd);
  if (!cmd) throw new Error(`LSP server '${name}' not found: ${config.command} not on PATH`);

  try {
    const client = LspClient.spawn(cmd, config.args ?? [], cwd);
    const rootUri = fileToUri(cwd);
    await client.initialize(rootUri, {
      initializationOptions: config.initializationOptions,
      settings: config.settings,
    });
    activeServers.set(key, { name, client, cwd, config });
    return client;
  } catch (err) {
    brokenServers.add(key);
    throw err;
  }
}

async function collectDiagnosticsForFile(
  cwd: string,
  absPath: string,
  timeoutMs: number,
  signal?: AbortSignal,
  errorsOnly = false,
): Promise<{ text: string; count: number; servers: string[] }> {
  const servers = getServersForFile(cwd, absPath);
  if (servers.length === 0) {
    return { text: "", count: 0, servers: [] };
  }
  const fileRel = path.relative(cwd, absPath) || path.basename(absPath);
  const uri = fileToUri(absPath);
  const all: Array<{ d: Diagnostic; server: string }> = [];
  const used: string[] = [];

  for (const srv of servers) {
    try {
      const client = await getOrCreateServer(srv.name, srv.config, cwd);
      client.syncFile(absPath);
      client.notifySaved(absPath);
      const { diagnostics } = await client.waitForDiagnostics(uri, timeoutMs, signal);
      used.push(srv.name);
      for (const d of diagnostics) {
        if (errorsOnly && d.severity !== undefined && d.severity !== 1) continue;
        all.push({ d, server: srv.name });
      }
    } catch {
      /* skip unavailable */
    }
  }

  // Dedupe by range+message
  const seen = new Set<string>();
  const unique: typeof all = [];
  for (const item of all) {
    const k = `${item.d.range.start.line}:${item.d.range.start.character}:${item.d.message}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(item);
  }

  unique.sort((a, b) => {
    const sa = a.d.severity ?? 4;
    const sb = b.d.severity ?? 4;
    if (sa !== sb) return sa - sb;
    return a.d.range.start.line - b.d.range.start.line;
  });

  const cap = 20;
  const limited = unique.slice(0, cap);
  if (limited.length === 0) {
    return {
      text: `${fileRel}: no ${errorsOnly ? "errors" : "diagnostics"} (${used.join(", ") || "no server"})`,
      count: 0,
      servers: used,
    };
  }
  const lines = limited.map(({ d }) => formatDiag(d, fileRel));
  if (unique.length > cap) lines.push(`…and ${unique.length - cap} more`);
  return {
    text: `${fileRel}: ${unique.length} issue(s) [${used.join(", ")}]\n${lines.join("\n")}`,
    count: unique.length,
    servers: used,
  };
}

function extractEditedPath(toolName: string, input: unknown, resultText: string, cwd: string): string | null {
  const inp = input as Record<string, unknown> | undefined;
  if (toolName === "write" || toolName === "edit") {
    if (typeof inp?.path === "string" && inp.path) return path.resolve(cwd, inp.path);
    if (typeof inp?.file_path === "string" && inp.file_path) return path.resolve(cwd, inp.file_path);
    if (typeof inp?.filePath === "string" && inp.filePath) return path.resolve(cwd, inp.filePath);
  }
  // hashline edit: look for "updated: path" / "created: path"
  const m = resultText.match(/\b(?:updated|created):\s+(.+)$/m);
  if (m?.[1]) {
    const p = m[1].trim();
    if (p && !p.includes("\n")) return path.resolve(cwd, p);
  }
  // [path#TAG] headers in result
  const h = resultText.match(/\[([^\]#\n]+)#([0-9A-Fa-f]{4})\]/);
  if (h?.[1] && !h[1].startsWith("/")) {
    // might be relative path in header from edit result
  }
  if (h?.[1] && (h[1].includes("/") || h[1].includes("."))) {
    return path.resolve(cwd, h[1]);
  }
  return null;
}

function diagnosticsOnEditEnabled(): boolean {
  const v = process.env.PI_LSP_DIAGNOSTICS_ON_EDIT;
  if (v === "0" || v === "false" || v === "off") return false;
  return true;
}

// ── Extension ──────────────────────────────────────────────────

const NAV_ACTIONS = new Set([
  "definition",
  "type_definition",
  "implementation",
  "references",
  "hover",
]);

export default function lspExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: `Language Server Protocol: diagnostics, navigation, rename, code actions, format.

Actions:
  diagnostics       — errors/warnings for a file (aggregates matching servers)
  definition        — go to definition
  type_definition   — go to type definition
  implementation    — go to implementation
  references        — find references
  hover             — docs/types at position
  symbols           — document outline
  workspace_symbols — search symbols by name
  rename            — rename symbol (default preview; set apply=true to write)
  code_actions      — list or apply code actions at position
  format            — format document (writes file)
  status            — configured / running servers
  reload            — shutdown all servers

Post-edit diagnostics: after edit/write, ERROR diagnostics are appended automatically
(disable with PI_LSP_DIAGNOSTICS_ON_EDIT=0).`,

    parameters: Type.Object({
      action: Type.String({
        description:
          "diagnostics | definition | type_definition | implementation | references | hover | symbols | workspace_symbols | rename | code_actions | format | status | reload",
      }),
      file: Type.Optional(Type.String({ description: "File path (relative to cwd)" })),
      line: Type.Optional(Type.Number({ description: "Line (1-indexed)" })),
      column: Type.Optional(Type.Number({ description: "Column (1-indexed, default 1)" })),
      symbol: Type.Optional(Type.String({ description: "workspace_symbols query / new name for rename" })),
      new_name: Type.Optional(Type.String({ description: "New name for rename" })),
      apply: Type.Optional(Type.Boolean({ description: "Apply rename/code_action (default false = preview)" })),
      index: Type.Optional(Type.Number({ description: "code_actions: 1-based index to apply" })),
      query: Type.Optional(Type.String({ description: "code_actions: filter by kind or title substring" })),
      timeout: Type.Optional(Type.Number({ default: 15, description: "Timeout seconds" })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const action = String(params.action ?? "").trim().toLowerCase();
      const cwd = ctx.cwd;
      const timeoutMs =
        (typeof params.timeout === "number" && params.timeout > 0 ? params.timeout : 15) * 1000;
      const abort = signal ?? undefined;

      const ok = (text: string, details: Record<string, unknown> = {}) => ({
        content: [{ type: "text" as const, text }],
        details: { action, success: true, ...details },
      });
      const fail = (text: string) => ({
        content: [{ type: "text" as const, text }],
        details: { action, success: false },
      });

      try {
        if (action === "status") {
          const available = findServers(cwd);
          const lines = available.map((s) => {
            const key = serverKey(s.name, cwd);
            const active = activeServers.get(key);
            const broken = brokenServers.has(key);
            const state = broken
              ? "broken"
              : active?.client.alive
                ? "running"
                : "not started";
            const lint = s.config.isLinter ? " linter" : "";
            const onPath = which(s.config.command, cwd) ? "" : " (command missing)";
            return `  ${s.name}: ${state}${lint}${onPath} [${s.config.fileTypes?.join(", ") ?? "any"}]`;
          });
          const postEdit = diagnosticsOnEditEnabled() ? "on" : "off";
          return ok(
            `LSP servers (post-edit diagnostics: ${postEdit}):\n${lines.length ? lines.join("\n") : "  (none matched project markers)"}`,
          );
        }

        if (action === "reload") {
          for (const srv of activeServers.values()) {
            try {
              await srv.client.shutdown();
            } catch { /* ok */ }
          }
          activeServers.clear();
          brokenServers.clear();
          return ok("LSP servers reloaded.");
        }

        if (action === "workspace_symbols") {
          const q = typeof params.symbol === "string" ? params.symbol : params.query;
          if (typeof q !== "string" || !q) throw new Error("'symbol' required for workspace_symbols");
          const servers = findServers(cwd).filter((s) => !s.config.isLinter);
          for (const srv of servers) {
            try {
              const client = await getOrCreateServer(srv.name, srv.config, cwd);
              const syms = await client.request<SymbolInfo[]>(
                "workspace/symbol",
                { query: q },
                timeoutMs,
                abort,
              );
              if (syms?.length) {
                const limited = syms.slice(0, 30);
                return ok(
                  `Workspace symbols '${q}' (${syms.length}):\n${limited
                    .map(
                      (s) =>
                        `  ${SYMBOL_KINDS[s.kind] ?? "?"} ${s.name} — ${formatLocation(s.location)}`,
                    )
                    .join("\n")}${syms.length > 30 ? `\n  …and ${syms.length - 30} more` : ""}`,
                );
              }
            } catch { /* next */ }
          }
          return ok(`No symbols found for '${q}'`);
        }

        // File-based actions
        const fileActions = new Set([
          "diagnostics",
          "definition",
          "type_definition",
          "implementation",
          "references",
          "hover",
          "symbols",
          "format",
          "rename",
          "code_actions",
        ]);
        if (!fileActions.has(action)) {
          throw new Error(
            `Unknown action: ${action}. Supported: diagnostics, definition, type_definition, implementation, references, hover, symbols, workspace_symbols, rename, code_actions, format, status, reload`,
          );
        }
        if (typeof params.file !== "string" || !params.file) {
          throw new Error(`'file' required for action '${action}'`);
        }
        const absPath = path.resolve(cwd, params.file);
        const fileRel = path.relative(cwd, absPath) || params.file;

        if (action === "diagnostics") {
          const result = await collectDiagnosticsForFile(cwd, absPath, Math.min(timeoutMs, 8_000), abort, false);
          if (!result.servers.length) throw new Error(`No LSP server found for ${params.file}`);
          return ok(result.text, { servers: result.servers, count: result.count });
        }

        const server = getPrimaryServerForFile(cwd, absPath);
        if (!server) throw new Error(`No LSP server found for ${params.file}`);
        const client = await getOrCreateServer(server.name, server.config, cwd);
        client.syncFile(absPath);

        const needPos = NAV_ACTIONS.has(action) || action === "rename" || action === "code_actions";
        if (needPos && (typeof params.line !== "number" || params.line < 1)) {
          throw new Error(`'line' (1-indexed) required for ${action}`);
        }
        const col =
          (typeof params.column === "number" && params.column >= 1 ? params.column : 1) - 1;
        const position =
          typeof params.line === "number"
            ? { line: params.line - 1, character: col }
            : { line: 0, character: 0 };
        const textDocument = { uri: fileToUri(absPath) };

        if (action === "definition" || action === "type_definition" || action === "implementation") {
          const method =
            action === "definition"
              ? "textDocument/definition"
              : action === "type_definition"
                ? "textDocument/typeDefinition"
                : "textDocument/implementation";
          const raw = await client.request(method, { textDocument, position }, timeoutMs, abort);
          const locs = normalizeLocations(raw);
          if (!locs.length) return ok(`No ${action.replace("_", " ")} found.`);
          return ok(locs.map((l) => formatLocation(l)).join("\n"), { server: server.name });
        }

        if (action === "references") {
          const refs = normalizeLocations(
            await client.request(
              "textDocument/references",
              { textDocument, position, context: { includeDeclaration: true } },
              timeoutMs,
              abort,
            ),
          );
          if (!refs.length) return ok("No references found.");
          const limited = refs.slice(0, 50);
          return ok(
            `References (${refs.length}):\n${limited.map((r) => `  ${formatLocation(r)}`).join("\n")}${
              refs.length > 50 ? `\n  …and ${refs.length - 50} more` : ""
            }`,
            { server: server.name },
          );
        }

        if (action === "hover") {
          const h = await client.request<Hover | null>(
            "textDocument/hover",
            { textDocument, position },
            timeoutMs,
            abort,
          );
          if (!h) return ok("No hover information.");
          return ok(formatHover(h), { server: server.name });
        }

        if (action === "symbols") {
          const syms = await client.request<DocumentSymbol[] | SymbolInfo[]>(
            "textDocument/documentSymbol",
            { textDocument },
            timeoutMs,
            abort,
          );
          if (!syms?.length) return ok("No symbols found.");
          const lines: string[] = [];
          const walk = (arr: Array<DocumentSymbol | SymbolInfo>, indent: string) => {
            for (const s of arr) {
              const icon = SYMBOL_KINDS[s.kind] ?? "?";
              if ("children" in s) {
                lines.push(
                  `${indent}${icon} ${s.name} (L${s.range.start.line + 1}-L${s.range.end.line + 1})`,
                );
                if (s.children?.length) walk(s.children, indent + "  ");
              } else {
                lines.push(`${indent}${icon} ${s.name} — ${formatLocation(s.location)}`);
              }
            }
          };
          walk(syms, "  ");
          return ok(`Symbols in ${fileRel}:\n${lines.join("\n")}`, { server: server.name });
        }

        if (action === "format") {
          const edits = await client.request<TextEdit[] | null>(
            "textDocument/formatting",
            { textDocument, options: { tabSize: 2, insertSpaces: true } },
            timeoutMs,
            abort,
          );
          if (!edits?.length) return ok(`No formatting changes for ${fileRel}`);
          const text = fs.readFileSync(absPath, "utf-8");
          fs.writeFileSync(absPath, applyTextEditsToContent(text, edits));
          client.syncFile(absPath);
          return ok(`Formatted ${fileRel} (${edits.length} edit(s))`, { server: server.name });
        }

        if (action === "rename") {
          const newName =
            (typeof params.new_name === "string" && params.new_name) ||
            (typeof params.symbol === "string" && params.symbol) ||
            "";
          if (!newName) throw new Error("'new_name' (or symbol) required for rename");
          const edit = await client.request<WorkspaceEdit | null>(
            "textDocument/rename",
            { textDocument, position, newName },
            timeoutMs,
            abort,
          );
          if (!edit) return ok("Rename returned no edits (symbol may not be renameable).");
          const summary = summarizeWorkspaceEdit(edit);
          const apply = params.apply === true;
          if (!apply) {
            return ok(
              `Rename preview → ${newName}\n${summary}\nRe-run with apply=true to write. Then re-read affected files.`,
              { server: server.name, preview: true },
            );
          }
          const touched = applyWorkspaceEdit(cwd, edit);
          return ok(
            `Renamed to ${newName}\nUpdated: ${touched.join(", ")}\nRe-read files before further edits.`,
            { server: server.name, applied: true },
          );
        }

        if (action === "code_actions") {
          const raw = await client.request<Array<CodeAction | { title: string; command: string }>>(
            "textDocument/codeAction",
            {
              textDocument,
              range: { start: position, end: position },
              context: { diagnostics: client.getDiagnostics(fileToUri(absPath)) },
            },
            timeoutMs,
            abort,
          );
          let actions = (raw ?? []).map((a, i) => ({ i: i + 1, a }));
          const q = typeof params.query === "string" ? params.query.toLowerCase() : "";
          if (q) {
            actions = actions.filter(({ a }) => {
              const title = a.title?.toLowerCase() ?? "";
              const kind = "kind" in a && a.kind ? String(a.kind).toLowerCase() : "";
              return title.includes(q) || kind.includes(q);
            });
          }
          if (!actions.length) return ok("No code actions.");

          const apply = params.apply === true;
          const idx = typeof params.index === "number" ? params.index : undefined;
          if (!apply) {
            const list = actions
              .map(({ i, a }) => {
                const kind = "kind" in a && a.kind ? ` [${a.kind}]` : "";
                const pref = "isPreferred" in a && a.isPreferred ? " ★" : "";
                return `  ${i}. ${a.title}${kind}${pref}`;
              })
              .join("\n");
            return ok(
              `Code actions at ${fileRel}:${params.line}:${col + 1}\n${list}\nApply with apply=true and index=N.`,
              { server: server.name, preview: true },
            );
          }
          if (idx === undefined || idx < 1) {
            throw new Error("code_actions apply requires index (1-based)");
          }
          const picked = actions.find((x) => x.i === idx)?.a ?? (raw ?? [])[idx - 1];
          if (!picked) throw new Error(`No code action at index ${idx}`);

          let actionObj = picked as CodeAction;
          if (!actionObj.edit && actionObj.data !== undefined) {
            try {
              actionObj = await client.request<CodeAction>(
                "codeAction/resolve",
                actionObj,
                timeoutMs,
                abort,
              );
            } catch { /* use unresolved */ }
          }
          if (actionObj.edit) {
            const touched = applyWorkspaceEdit(cwd, actionObj.edit);
            return ok(
              `Applied: ${actionObj.title}\nUpdated: ${touched.join(", ")}\nRe-read before further edits.`,
              { server: server.name, applied: true },
            );
          }
          if (actionObj.command) {
            await client.request(
              "workspace/executeCommand",
              {
                command: actionObj.command.command,
                arguments: actionObj.command.arguments,
              },
              timeoutMs,
              abort,
            );
            return ok(
              `Executed command for: ${actionObj.title}\nRe-read files; server may have applied edits.`,
              { server: server.name, applied: true },
            );
          }
          return fail(`Code action '${actionObj.title}' has no edit or command to apply.`);
        }

        throw new Error(`Unhandled action: ${action}`);
      } catch (err) {
        return fail(`LSP ${action} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  // ── Phase 1: post-edit diagnostics ─────────────────
  pi.on("tool_result", async (event, ctx) => {
    if (!diagnosticsOnEditEnabled()) return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    // Skip failed tools when isError is set
    if ((event as { isError?: boolean }).isError) return;

    const content = Array.isArray(event.content)
      ? event.content
      : [{ type: "text", text: String(event.content ?? "") }];
    const textBlocks = content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text);
    const resultText = textBlocks.join("\n");
    if (/^Error\b|failed:|E_NOOP_LOOP|E_DUPLICATE_EDIT|Tag mismatch/i.test(resultText)) {
      // likely failure; still try if path extractable and not hard error markers only
      if (/Tag mismatch|E_NOOP_LOOP|E_DUPLICATE_EDIT|Error parsing|Error applying/i.test(resultText)) {
        return;
      }
    }

    const absPath = extractEditedPath(event.toolName, event.input, resultText, ctx.cwd);
    if (!absPath || !fs.existsSync(absPath)) return;

    // Only if some server matches
    if (getServersForFile(ctx.cwd, absPath).length === 0) return;

    try {
      const { text, count } = await collectDiagnosticsForFile(
        ctx.cwd,
        absPath,
        6_000,
        undefined,
        true, // errors only for automatic feedback
      );
      if (!text) return;
      const suffix =
        count > 0
          ? `\n\n[lsp diagnostics]\n${text}`
          : ""; // stay quiet on clean files to save tokens
      if (!suffix) return;

      const updated = [...content];
      const firstText = updated.findIndex((c) => c.type === "text");
      if (firstText >= 0) {
        updated[firstText] = {
          ...updated[firstText],
          text: `${(updated[firstText] as { text: string }).text}${suffix}`,
        };
        return { content: updated };
      }
      return {
        content: [...content, { type: "text", text: suffix.trimStart() }],
      };
    } catch {
      return;
    }
  });

  pi.on("session_shutdown", async () => {
    for (const srv of activeServers.values()) {
      try {
        await srv.client.shutdown();
      } catch { /* ok */ }
    }
    activeServers.clear();
    brokenServers.clear();
  });
}

/** Test-only exports (not part of the public package API). */
export const __test__ = {
  loadDefaults,
  which,
  getServersForFile,
  getPrimaryServerForFile,
  findServers,
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
  serverKey,
  resetManager(): void {
    activeServers.clear();
    brokenServers.clear();
  },
  getActiveCount(): number {
    return activeServers.size;
  },
};
