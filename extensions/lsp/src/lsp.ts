/**
 * lsp extension — Language Server Protocol tool + post-edit diagnostics.
 *
 * Phase 0: correct init/settings, didChange sync, multi-server route
 * Phase 1: tool_result hook on edit/write → ERROR diagnostics (default on)
 * Phase 2: rename (preview default), code_actions, type_definition, implementation
 * Phase 3: settle-based push diagnostics, LSP 3.17 pull diagnostics,
 *          stderr capture, resolveProvider gating, overlapping-edit guard
 *
 *   pi install npm:@piex-dev/lsp
 *   PI_LSP_DIAGNOSTICS_ON_EDIT=0       # disable post-edit diagnostics
 *   PI_<NAME>_LSP_COMMAND="cmd args"   # override a server's command
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import { createFooter } from "./footer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Types ──────────────────────────────────────────────────────

interface Position {
  line: number;
  character: number;
}
interface Range {
  start: Position;
  end: Position;
}
interface Location {
  uri: string;
  range: Range;
}
interface LocationLink {
  targetUri: string;
  targetRange: Range;
  targetSelectionRange?: Range;
}
interface DiagnosticRelated {
  location: Location;
  message: string;
}
interface Diagnostic {
  range: Range;
  severity?: 1 | 2 | 3 | 4;
  code?: string | number;
  source?: string;
  message: string;
  relatedInformation?: DiagnosticRelated[];
}
interface TextEdit {
  range: Range;
  newText: string;
}
interface SymbolInfo {
  name: string;
  kind: number;
  location: Location;
  containerName?: string;
}
interface DocumentSymbol {
  name: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}
interface Hover {
  contents: unknown;
  range?: Range;
}
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
    | {
        textDocument: { uri: string; version?: number | null };
        edits: TextEdit[];
      }
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
  /** On-demand install metadata ({type, package}) for auto-download. */
  install?: { type?: string; package?: string };
  /** Quiet period (ms) after the last publishDiagnostics before push
   *  diagnostics are treated as settled. Defaults to 800. */
  diagnosticsSettleMs?: number;
}
// ── Config ─────────────────────────────────────────────────────

let cachedDefaults: Record<string, ServerConfig> | null = null;

function loadDefaults(): Record<string, ServerConfig> {
  if (cachedDefaults) return cachedDefaults;
  const defaultsPath = path.join(__dirname, "defaults.json");
  try {
    const raw = JSON.parse(fs.readFileSync(defaultsPath, "utf-8")) as Record<
      string,
      unknown
    >;
    const servers: Record<string, ServerConfig> = {};
    for (const [name, cfg] of Object.entries(raw)) {
      const c = cfg as Record<string, unknown>;
      if (typeof c.command !== "string" || !c.command) continue;
      const init =
        (c.initOptions && typeof c.initOptions === "object"
          ? c.initOptions
          : undefined) ??
        (c.initializationOptions && typeof c.initializationOptions === "object"
          ? c.initializationOptions
          : undefined);
      servers[name] = {
        command: c.command,
        args: Array.isArray(c.args) ? (c.args as string[]) : [],
        languages: Array.isArray(c.languages) ? (c.languages as string[]) : [],
        fileTypes: (Array.isArray(c.fileTypes)
          ? (c.fileTypes as string[])
          : []
        ).map((f) => String(f).toLowerCase()),
        rootMarkers: Array.isArray(c.rootMarkers)
          ? (c.rootMarkers as string[])
          : [],
        settings:
          c.settings && typeof c.settings === "object"
            ? (c.settings as Record<string, unknown>)
            : undefined,
        initializationOptions: init as Record<string, unknown> | undefined,
        isLinter: c.isLinter === true,
        install:
          c.install && typeof c.install === "object"
            ? (c.install as { type?: string; package?: string })
            : undefined,
        diagnosticsSettleMs:
          typeof c.diagnosticsSettleMs === "number" &&
          Number.isFinite(c.diagnosticsSettleMs) &&
          c.diagnosticsSettleMs > 0
            ? c.diagnosticsSettleMs
            : undefined,
      };
    }
    cachedDefaults = servers;
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

/** LSP 3.17 pull-diagnostic capability registration (client/registerCapability). */
interface DiagnosticRegistration {
  identifier?: string;
  workspaceDiagnostics?: boolean;
}
interface DiagnosticReportResult {
  matched: boolean;
  byFile: Map<string, Diagnostic[]>;
}

interface DocumentDiagnosticReport {
  items?: Diagnostic[];
  relatedDocuments?: Record<string, { items?: Diagnostic[] }>;
}

interface WorkspaceDiagnosticReport {
  items?: Array<{ uri?: string; items?: Diagnostic[] }>;
}


/** Timeout before we stop waiting for a server's initial project load. */
const PROJECT_LOAD_TIMEOUT_MS = 15_000;

class LspClient {
  #proc: ChildProcessWithoutNullStreams;
  #seq = 0;
  #pending = new Map<number, LspRequest>();
  #decoder = new TextDecoder("utf-8");
  /** Push cache: server-published diagnostics. */
  #diagnostics = new Map<string, Diagnostic[]>();
  /** Pull cache: results pulled via textDocument/diagnostic — kept separate
   *  from push so one source never clobbers the other (opencode's design). */
  #pullDiagnostics = new Map<string, Diagnostic[]>();
  /** URIs that have received at least one publishDiagnostics (including empty). */
  #diagReceived = new Set<string>();
  /** Last publishDiagnostics timestamp per uri, for settle detection. */
  #diagLastUpdate = new Map<string, number>();
  #openVersions = new Map<string, number>();
  /** Last synced content per uri — needed for incremental didChange ranges. */
  #openContents = new Map<string, string>();
  #settings: Record<string, unknown> = {};
  #capabilities: Record<string, unknown> = {};
  #stderr = "";
  /** textDocumentSync kind: 1 = full, 2 = incremental (from server capabilities). */
  #syncKind = 1;
  /** Dynamic `textDocument/diagnostic` registrations (client/registerCapability). */
  #diagnosticRegistrations = new Map<string, DiagnosticRegistration>();
  #registrationListeners = new Set<() => void>();
  /** `$/progress` tokens currently loading — all ended ⇒ project loaded. */
  #activeProgressTokens = new Set<string | number>();
  #resolveProjectLoaded!: () => void;
  #projectLoaded: Promise<void>;
  #projectLoadTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last activity (write or read) — drives idle reaping. */
  #lastActivity = Date.now();
  alive = true;
  #exitListeners: Array<() => void> = [];

  constructor(proc: ChildProcessWithoutNullStreams) {
    this.#proc = proc;
    this.#projectLoaded = new Promise((resolve) => {
      this.#resolveProjectLoaded = resolve;
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      // Cap the buffer so a noisy server cannot grow memory unbounded.
      if (this.#stderr.length < 16_000) this.#stderr += chunk.toString();
    });
    proc.on("exit", () => {
      this.alive = false;
      this.#rejectAll(new Error(`LSP server exited.${this.#formatStderr()}`));
      this.#resolveProjectLoaded();
      for (const fn of this.#exitListeners) fn();
    });
    this.#startReader();
  }

  touchActivity(): void {
    this.#lastActivity = Date.now();
  }
  get lastActivity(): number {
    return this.#lastActivity;
  }


  /** Register a callback fired when the server process exits. */
  onExit(fn: () => void): void {
    this.#exitListeners.push(fn);
  }

  static spawn(command: string, args: string[], cwd: string): LspClient {
    // Windows cannot spawn .bat/.cmd directly; wrap via cmd.exe.
    let cmd = command;
    let cmdArgs = args;
    if (process.platform === "win32" && /\.(?:bat|cmd)$/i.test(command)) {
      cmd = process.env.ComSpec?.trim() || "cmd.exe";
      cmdArgs = ["/d", "/s", "/c", command, ...args];
    }
    const proc = spawn(cmd, cmdArgs, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    return new LspClient(proc as ChildProcessWithoutNullStreams);
  }

  #formatStderr(): string {
    const stderr = this.#stderr.trim();
    return stderr ? `\nServer stderr:\n${stderr}` : "";
  }
  get capabilities(): Record<string, unknown> {
    return this.#capabilities;
  }

  getDiagnostics(uri: string): Diagnostic[] {
    return dedupeDiagnostics([
      ...(this.#diagnostics.get(uri) ?? []),
      ...(this.#pullDiagnostics.get(uri) ?? []),
    ]);
  }

  hasReceivedDiagnostics(uri: string): boolean {
    return this.#diagReceived.has(uri);
  }

  clearDiagnosticsFlag(uri: string): void {
    this.#diagReceived.delete(uri);
    this.#diagLastUpdate.delete(uri);
    this.#pullDiagnostics.delete(uri); // content changed — stale pull results
  }

  /** LSP 3.17 pull diagnostics: server advertised textDocument/diagnostic,
   *  either statically in initialize capabilities or via dynamic
   *  registration (client/registerCapability) after initialize. */
  supportsPullDiagnostics(): boolean {
    return (
      "diagnosticProvider" in this.#capabilities ||
      this.#diagnosticRegistrations.size > 0
    );
  }

  /** Workspace-level pull (workspace/diagnostic) is only reachable via
   *  dynamic registration with workspaceDiagnostics: true. */
  supportsWorkspacePullDiagnostics(): boolean {
    return this.#workspacePullState().supported;
  }

  /** codeAction/resolve is only valid when the server advertises it. */
  canResolveCodeActions(): boolean {
    const provider = this.#capabilities.codeActionProvider;
    return (
      typeof provider === "object" &&
      provider !== null &&
      (provider as { resolveProvider?: boolean }).resolveProvider === true
    );
  }

  /**
   * Wait for the server's initial project load to finish, tracked via
   * `$/progress` begin/end notifications (15s fallback timer). Navigation
   * requests made before the project is loaded can produce false negatives
   * (rust-analyzer cold-start can take tens of seconds).
   */
  async waitForProjectLoaded(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return;
    await Promise.race([
      this.#projectLoaded,
      sleep(timeoutMs),
      ...(signal
        ? [
            new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), {
                once: true,
              }),
            ),
          ]
        : []),
    ]);
  }

  /** Wait for a dynamic capability registration change (or timeout). */
  waitForRegistrationChange(timeoutMs: number): Promise<boolean> {
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      let finished = false;
      const finish = (result: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.#registrationListeners.delete(listener);
        resolve(result);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      const listener = () => finish(true);
      this.#registrationListeners.add(listener);
    });
  }

  #documentPullState(): { identifiers: string[]; supported: boolean } {
    const registrations = [...this.#diagnosticRegistrations.values()].filter(
      (r) => r.workspaceDiagnostics !== true,
    );
    return {
      identifiers: [
        ...new Set(
          registrations.flatMap((r) => (r.identifier ? [r.identifier] : [])),
        ),
      ],
      supported:
        "diagnosticProvider" in this.#capabilities ||
        registrations.length > 0,
    };
  }

  #workspacePullState(): { identifiers: string[]; supported: boolean } {
    const registrations = [...this.#diagnosticRegistrations.values()].filter(
      (r) => r.workspaceDiagnostics === true,
    );
    return {
      identifiers: [
        ...new Set(
          registrations.flatMap((r) => (r.identifier ? [r.identifier] : [])),
        ),
      ],
      supported: registrations.length > 0,
    };
  }

  async #requestDocumentDiagnosticReport(
    uri: string,
    identifier: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<DiagnosticReportResult> {
    const report = await this.request<DocumentDiagnosticReport | undefined>(
      "textDocument/diagnostic",
      {
        ...(identifier ? { identifier } : {}),
        textDocument: { uri },
      },
      timeoutMs,
      signal,
    ).catch((err) => {
      if (signal?.aborted) throw err; // abort must propagate, not masquerade as "no report"
      return undefined;
    });
    if (!report) return { matched: false, byFile: new Map() };
    const byFile = new Map<string, Diagnostic[]>();
    let matched = false;
    const push = (target: string, items: Diagnostic[]) => {
      const existing = byFile.get(target) ?? [];
      byFile.set(target, existing.concat(items));
    };
    if (Array.isArray(report.items)) {
      push(uri, report.items);
      matched = true;
    }
    // relatedDocuments: diagnostics for other files that depend on this one.
    // Changing a symbol signature now surfaces the callers' errors too.
    const related: Record<string, { items?: Diagnostic[] }> =
      report.relatedDocuments ?? {};
    for (const [relUri, rel] of Object.entries(related)) {
      if (!Array.isArray(rel.items)) continue;
      push(relUri, rel.items);
      matched = matched || relUri === uri;
    }
    return { matched, byFile };
  }

  async #requestWorkspaceDiagnosticReport(
    uri: string,
    identifier: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<DiagnosticReportResult> {
    const report = await this.request<
      | { items?: Array<{ uri?: string; items?: Diagnostic[] }> }
      | undefined
    >(
      "workspace/diagnostic",
      {
        ...(identifier ? { identifier } : {}),
        previousResultIds: [],
      },
      timeoutMs,
      signal,
    ).catch((err) => {
      if (signal?.aborted) throw err;
      return undefined;
    });
    if (!report) return { matched: false, byFile: new Map() };
    const byFile = new Map<string, Diagnostic[]>();
    let matched = false;
    for (const item of report.items ?? []) {
      if (!item.uri || !Array.isArray(item.items)) continue;
      const existing = byFile.get(item.uri) ?? [];
      byFile.set(item.uri, existing.concat(item.items));
      matched = matched || item.uri === uri;
    }
    return { matched, byFile };
  }

  /** Merge pull results into the shared push cache (keeps settle coherent). */
  #absorbPullResults(
    uri: string,
    results: DiagnosticReportResult[],
  ): { matched: boolean; current: Diagnostic[] } {
    let matched = false;
    const merged = new Map<string, Diagnostic[]>();
    for (const r of results) {
      matched = matched || r.matched;
      for (const [target, items] of r.byFile) {
        const existing = merged.get(target) ?? [];
        merged.set(target, existing.concat(items));
      }
    }
    for (const [target, items] of merged) {
      this.#pullDiagnostics.set(target, dedupeDiagnostics(items));
      this.#diagReceived.add(target);
      this.#diagLastUpdate.set(target, Date.now());
    }
    return { matched, current: this.getDiagnostics(uri) };
  }

  /**
   * Document-level pull: dispatch identifier pulls in parallel and unblock
   * as soon as one batch produced diagnostics for the current file (slower
   * pulls keep merging in the background). Falls back to workspace pull
   * when the server only registered workspaceDiagnostics.
   */
  async pullDiagnostics(
    uri: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ items: Diagnostic[]; matched: boolean }> {
    const state = this.#documentPullState();
    if (!state.supported) {
      const ws = this.#workspacePullState();
      if (!ws.supported) return { items: [], matched: false };
      const wsResults = await Promise.all([
        this.#requestWorkspaceDiagnosticReport(uri, undefined, timeoutMs, signal),
        ...ws.identifiers.map((id) =>
          this.#requestWorkspaceDiagnosticReport(uri, id, timeoutMs, signal),
        ),
      ]);
      const absorbed = this.#absorbPullResults(uri, wsResults);
      return { items: absorbed.current, matched: absorbed.matched };
    }

    const requests = [
      this.#requestDocumentDiagnosticReport(uri, undefined, timeoutMs, signal),
      ...state.identifiers.map((id) =>
        this.#requestDocumentDiagnosticReport(uri, id, timeoutMs, signal),
      ),
    ];
    const { absorbedAtResolve } = await new Promise<{
      absorbedAtResolve: DiagnosticReportResult[];
    }>((resolve) => {
      const completed: DiagnosticReportResult[] = [];
      let pending = requests.length;
      let resolved = false;
      const finish = (force = false) => {
        if (resolved) return;
        const currentHasDiags = completed.some(
          (r) => (r.byFile.get(uri)?.length ?? 0) > 0,
        );
        if (!force && !currentHasDiags) return;
        resolved = true;
        resolve({ absorbedAtResolve: completed });
      };
      for (const p of requests) {
        p.then((r) => {
          completed.push(r);
          // Absorb immediately so diagnostics arriving after the early return
          // still land in the shared cache (slow identifier pulls).
          this.#absorbPullResults(uri, [r]);
          pending -= 1;
          finish();
          if (pending === 0) finish(true);
        });
      }
    });
    // Current-file items: already absorbed; read the merged cache directly.
    return {
      items: this.getDiagnostics(uri),
      matched: absorbedAtResolve.some((r) => r.matched),
    };
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
          diagnostic: {
            dynamicRegistration: true,
            relatedDocumentSupport: true,
          },
          publishDiagnostics: {
            relatedInformation: true,
            versionSupport: true,
          },
        },
        workspace: {
          symbol: { dynamicRegistration: true },
          configuration: true,
          workspaceFolders: true,
          applyEdit: true,
          diagnostics: { refreshSupport: false },
          didChangeWatchedFiles: { dynamicRegistration: true },
          workspaceEdit: {
            documentChanges: true,
            resourceOperations: ["create", "rename", "delete"],
          },
        },
      },
      workspaceFolders: [
        { uri: rootUri, name: path.basename(uriToFile(rootUri)) },
      ],
    });
    this.#capabilities =
      (result?.capabilities as Record<string, unknown>) ?? {};
    // Sync kind: 1 = full, 2 = incremental — drives didChange contentChanges.
    const sync = this.#capabilities.textDocumentSync as
      | number
      | { change?: number }
      | undefined;
    this.#syncKind = typeof sync === "number" ? sync : (sync?.change ?? 1);
    // Fallback for servers that never send $/progress: treat loading as done
    // after a fixed budget so waitForProjectLoaded never hangs.
    this.#projectLoadTimer = setTimeout(() => {
      this.#resolveProjectLoaded();
    }, PROJECT_LOAD_TIMEOUT_MS);
    this.notify("initialized", {});
    if (Object.keys(this.#settings).length > 0) {
      this.notify("workspace/didChangeConfiguration", {
        settings: this.#settings,
      });
    }
    return this.#capabilities;
  }

  async shutdown(): Promise<void> {
    if (this.#projectLoadTimer) {
      clearTimeout(this.#projectLoadTimer);
      this.#projectLoadTimer = null;
    }
    try {
      await this.request("shutdown", undefined, 5_000);
    } catch {
      /* ok */
    }
    this.notify("exit", {});
    this.alive = false;
    this.#rejectAll(new Error("LSP server shutdown"));
    try {
      this.#proc.kill();
    } catch {
      /* ok */
    }
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
        reject(
          new Error(
            `LSP request ${method} timed out after ${timeoutMs}ms.${this.#formatStderr()}`,
          ),
        );
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
    this.#lastActivity = Date.now();
    const body = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;
    try {
      this.#proc.stdin.write(header + body);
    } catch {
      /* dead */
    }
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
        } catch {
          /* skip */
        }
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
    this.#lastActivity = Date.now();
    // Server → client request
    if (
      msg.method &&
      msg.id !== undefined &&
      msg.result === undefined &&
      !msg.error
    ) {
      this.#handleServerRequest(msg.id, msg.method, msg.params);
      return;
    }
    // Response
    if (msg.id !== undefined && this.#pending.has(Number(msg.id))) {
      const p = this.#pending.get(Number(msg.id))!;
      this.#pending.delete(Number(msg.id));
      clearTimeout(p.timer);
      if (msg.error)
        p.reject(
          new Error(msg.error.message ?? `LSP error: ${msg.error.code}`),
        );
      else p.resolve(msg.result);
      return;
    }
    // Notification
    if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params as
        { uri?: string; diagnostics?: Diagnostic[] } | undefined;
      if (params?.uri) {
        this.#diagnostics.set(params.uri, params.diagnostics ?? []);
        this.#diagReceived.add(params.uri);
        this.#diagLastUpdate.set(params.uri, Date.now());
      }
    } else if (msg.method === "$/progress") {
      // Project-load tracking: all begin tokens ended ⇒ project loaded.
      const params = msg.params as
        | { token?: string | number; value?: { kind?: string } }
        | undefined;
      const token = params?.token;
      const kind = params?.value?.kind;
      if (token !== undefined) {
        if (kind === "begin") {
          this.#activeProgressTokens.add(token);
        } else if (kind === "end") {
          this.#activeProgressTokens.delete(token);
          if (this.#activeProgressTokens.size === 0) {
            this.#resolveProjectLoaded();
          }
        }
      }
    }
  }

  #handleServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): void {
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
    if (method === "client/registerCapability") {
      const registrations = (
        (params as { registrations?: unknown[] } | undefined)
          ?.registrations ?? []
      ) as Array<{
        id?: string;
        method?: string;
        registerOptions?: {
          identifier?: string;
          workspaceDiagnostics?: boolean;
        };
      }>;
      let changed = false;
      for (const reg of registrations) {
        if (reg.method !== "textDocument/diagnostic" || !reg.id) continue;
        this.#diagnosticRegistrations.set(reg.id, {
          identifier: reg.registerOptions?.identifier,
          workspaceDiagnostics:
            reg.registerOptions?.workspaceDiagnostics === true,
        });
        changed = true;
      }
      if (changed) {
        for (const fn of this.#registrationListeners) fn();
      }
      this.#write({ jsonrpc: "2.0", id, result: null });
      return;
    }
    if (method === "client/unregisterCapability") {
      const registrations = (
        (params as { unregisterations?: unknown[] } | undefined)
          ?.unregisterations ?? []
      ) as Array<{ id?: string; method?: string }>;
      let changed = false;
      for (const reg of registrations) {
        if (reg.method !== "textDocument/diagnostic" || !reg.id) continue;
        if (this.#diagnosticRegistrations.delete(reg.id)) changed = true;
      }
      if (changed) {
        for (const fn of this.#registrationListeners) fn();
      }
      this.#write({ jsonrpc: "2.0", id, result: null });
      return;
    }
    if (method === "workspace/diagnostic/refresh") {
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
      this.#openContents.set(uri, content);
      this.clearDiagnosticsFlag(uri);
      this.notify("workspace/didChangeWatchedFiles", {
        changes: [{ uri, type: 1 }], // created
      });
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: lang, version: 1, text: content },
      });
    } else {
      const next = prev + 1;
      this.#openVersions.set(uri, next);
      const prevText = this.#openContents.get(uri) ?? "";
      this.#openContents.set(uri, content);
      this.clearDiagnosticsFlag(uri);
      this.notify("workspace/didChangeWatchedFiles", {
        changes: [{ uri, type: 2 }], // changed
      });
      // Servers that advertise incremental sync (change: 2) get a range
      // covering the previous content; others get full-text replacement.
      this.notify("textDocument/didChange", {
        textDocument: { uri, version: next },
        contentChanges:
          this.#syncKind === 2
            ? [
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: endPosition(prevText),
                  },
                  text: content,
                },
              ]
            : [{ text: content }],
      });
    }
  }
  notifySaved(filePath: string): void {
    const uri = fileToUri(filePath);
    this.notify("textDocument/didSave", { textDocument: { uri } });
  }

  /**
   * Wait until push diagnostics settle: at least one publishDiagnostics was
   * received and no newer publish arrived within settleMs. Some servers
   * (e.g. intelephense) publish an empty set first and real diagnostics a
   * few seconds later; returning on first publish would report a clean file.
   */
  async waitForDiagnostics(
    uri: string,
    timeoutMs: number,
    settleMs = 800,
    signal?: AbortSignal,
  ): Promise<{ diagnostics: Diagnostic[]; timedOut: boolean }> {
    const start = Date.now();
    const step = 60;
    while (Date.now() - start < timeoutMs) {
      if (signal?.aborted) throw new Error("Aborted");
      const lastUpdate = this.#diagLastUpdate.get(uri);
      if (lastUpdate !== undefined && Date.now() - lastUpdate >= settleMs) {
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
/** End position of a text buffer (for incremental didChange ranges). */
function endPosition(text: string): Position {
  const lines = text.split(/\r\n|\r|\n/);
  return {
    line: lines.length - 1,
    character: lines.at(-1)?.length ?? 0,
  };
}
/** Dedupe diagnostics by range + severity + message + source (pull and push
 *  results are merged into one cache, so the same issue can arrive twice). */
function dedupeDiagnostics(items: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = JSON.stringify({
      code: item.code,
      severity: item.severity,
      message: item.message,
      source: item.source,
      range: item.range,
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}


function fileToUri(filePath: string): string {
  const abs = path.resolve(filePath);
  if (process.platform === "win32") {
    const norm = abs.replace(/\\/g, "/");
    return "file:///" + norm.split("/").map(encodeURIComponent).join("/");
  }
  return (
    "file://" +
    abs
      .split("/")
      .map((s, i) => (i === 0 && s === "" ? "" : encodeURIComponent(s)))
      .join("/")
  );
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
        } catch {
          /* continue */
        }
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
        "^" +
          marker
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".") +
          "$",
      );
      return entries.some((e) => re.test(e));
    } catch {
      return false;
    }
  }
  return fs.existsSync(path.join(cwd, marker));
}

function findServers(
  cwd: string,
): Array<{ name: string; config: ServerConfig }> {
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

// ── Project-root discovery ──────────────────────────────────────
// When the session cwd (a monorepo root or a collection of repos) has no
// matching markers, walk up from the file to find the nearest project root.

const PROJECT_MARKERS = [
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "go.mod",
  "go.work",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "Pipfile",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "composer.json",
  "Gemfile",
  "mix.exs",
  "CMakeLists.txt",
  "compile_commands.json",
  "*.sln",
  "*.csproj",
];

function resolveProjectRoot(absFile: string): string | null {
  const home = os.homedir();
  let dir = path.dirname(absFile);
  for (;;) {
    if (PROJECT_MARKERS.some((m) => markerExists(dir, m))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) return null;
    dir = parent;
  }
}

/** Root to launch servers for a file: session cwd when it is a real project
 *  root (file-based markers only — `.git` alone must not short-circuit),
 *  otherwise the nearest ancestor project root (fallback: cwd). */
function getServerRootForFile(cwd: string, absPath: string): string {
  const cwdIsProjectRoot = PROJECT_MARKERS.some((m) => markerExists(cwd, m));
  if (cwdIsProjectRoot && findServers(cwd).length > 0) return cwd;
  const root = resolveProjectRoot(absPath);
  if (root && root !== cwd && findServers(root).length > 0) return root;
  return cwd;
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
    s.config.fileTypes?.some(
      (ft) => ft.toLowerCase() === base || ft.toLowerCase() === `.${base}`,
    ),
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
  1: "F",
  2: "M",
  3: "N",
  4: "P",
  5: "C",
  6: "m",
  7: "p",
  8: "f",
  9: "ctor",
  10: "E",
  11: "I",
  12: "fn",
  13: "v",
  14: "c",
  15: "s",
  16: "n",
  20: "e",
  22: "t",
  23: "S",
  26: "T",
};

function formatDiag(d: Diagnostic, fileRel: string): string {
  const sev =
    d.severity === 1
      ? "error"
      : d.severity === 2
        ? "warning"
        : d.severity === 3
          ? "info"
          : "hint";
  const pos = `L${d.range.start.line + 1}:${d.range.start.character + 1}`;
  const src = d.source ? `[${d.source}]` : "";
  let line = `${fileRel}:${pos} ${sev} ${src} ${d.message}`
    .replace(/\s+/g, " ")
    .trim();
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
    if ("uri" in o && o.uri && o.range)
      out.push({ uri: o.uri, range: o.range });
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
      .map((c) =>
        typeof c === "string" ? c : ((c as { value?: string }).value ?? ""),
      )
      .join("\n");
  }
  return (
    (h.contents as { value?: string })?.value ?? JSON.stringify(h.contents)
  );
}

/** True when any two edits cover intersecting ranges (applying them would corrupt text). */
function hasOverlappingTextEdits(edits: TextEdit[]): boolean {
  const sorted = [...edits].sort((a, b) => {
    if (a.range.start.line !== b.range.start.line)
      return a.range.start.line - b.range.start.line;
    return a.range.start.character - b.range.start.character;
  });
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].range.end;
    const curr = sorted[i].range.start;
    if (
      prev.line > curr.line ||
      (prev.line === curr.line && prev.character > curr.character)
    ) {
      return true;
    }
  }
  return false;
}

function applyTextEditsToContent(text: string, edits: TextEdit[]): string {
  if (hasOverlappingTextEdits(edits)) {
    throw new Error(
      "LSP returned overlapping text edits; refusing to apply (would corrupt the file).",
    );
  }
  const sorted = [...edits].sort((a, b) => {
    if (a.range.start.line !== b.range.start.line)
      return b.range.start.line - a.range.start.line;
    if (a.range.start.character !== b.range.start.character) {
      return b.range.start.character - a.range.start.character;
    }
    return 0;
  });
  // Work on full string offsets
  const lines = text.split("\n");
  const offsetAt = (line: number, character: number): number => {
    let off = 0;
    for (let i = 0; i < line && i < lines.length; i++)
      off += lines[i].length + 1;
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
        if (!fs.existsSync(fp) || change.options?.overwrite)
          fs.writeFileSync(fp, "");
        touched.push(path.relative(cwd, fp) || fp);
      } else if ("kind" in change && change.kind === "rename") {
        const oldP = assertPathInCwd(cwd, uriToFile(change.oldUri));
        const newP = assertPathInCwd(cwd, uriToFile(change.newUri));
        fs.mkdirSync(path.dirname(newP), { recursive: true });
        fs.renameSync(oldP, newP);
        touched.push(
          `${path.relative(cwd, oldP)} → ${path.relative(cwd, newP)}`,
        );
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
  if (edit.changes)
    for (const u of Object.keys(edit.changes)) files.add(uriToFile(u));
  if (edit.documentChanges) {
    for (const c of edit.documentChanges) {
      if ("textDocument" in c) files.add(uriToFile(c.textDocument.uri));
      else if ("kind" in c && c.kind === "create") files.add(uriToFile(c.uri));
      else if ("kind" in c && c.kind === "rename") {
        files.add(uriToFile(c.oldUri));
        files.add(uriToFile(c.newUri));
      } else if ("kind" in c && c.kind === "delete")
        files.add(uriToFile(c.uri));
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
/** In-flight spawn promises — dedupe concurrent getOrCreateServer calls. */
const pendingServers = new Map<string, Promise<LspClient>>();

// ── Idle reaping ─────────────────────────────────
// Long sessions accumulate server processes that are no longer needed.
// PI_LSP_IDLE_TIMEOUT_MS controls how long a server may sit idle before it is
// shut down (default 30 min; 0 disables reaping entirely).

const IDLE_SCAN_INTERVAL_MS = 60_000;

/** Idle reaping is OFF by default: a coding session naturally has discussion
 *  and review gaps with no read/edit activity, and a 30min default killed
 *  servers mid-session (the footer lost its green entries and the next edit
 *  paid a cold-start). Set PI_LSP_IDLE_TIMEOUT_MS to opt in explicitly. */
function idleTimeoutMs(): number {
  const v = Number(process.env.PI_LSP_IDLE_TIMEOUT_MS);
  if (Number.isFinite(v) && v >= 0) return v;
  return 0; // 0 = disabled
}

let idleTimer: ReturnType<typeof setInterval> | null = null;

function startIdleSweeper(): void {
  if (idleTimer) return;
  idleTimer = setInterval(sweepIdleServers, IDLE_SCAN_INTERVAL_MS);
  idleTimer.unref?.();
}

function stopIdleSweeper(): void {
  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
}

/** Shut down servers that have been idle longer than the configured budget. */
function sweepIdleServers(): void {
  const limit = idleTimeoutMs();
  if (limit <= 0) return; // disabled
  const now = Date.now();
  for (const [key, srv] of activeServers) {
    if (!srv.client.alive) {
      activeServers.delete(key);
      continue;
    }
    if (now - srv.client.lastActivity > limit) {
      void srv.client.shutdown().catch(() => {});
      activeServers.delete(key);
      notifyStatusChange();
    }
  }
}

// ── Footer status ──────────────────────────────────

let statusReporter: (() => void) | undefined;

function setStatusReporter(r: (() => void) | undefined): void {
  statusReporter = r;
}

function notifyStatusChange(): void {
  statusReporter?.();
}

/** Scan nearby subdirectories (depth ≤ 2, skipping build/vendor dirs) for
 *  project roots and collect the servers they would use — for monorepo roots
 *  and repo collections where the session cwd itself is not a project. */
function findServersInSubprojects(cwd: string): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    if (depth > 2) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (
        e.name.startsWith(".") ||
        e.name === "node_modules" ||
        e.name === "dist" ||
        e.name === "build" ||
        e.name === "target" ||
        e.name === ".venv" ||
        e.name === "venv"
      ) {
        continue;
      }
      const sub = path.join(dir, e.name);
      if (PROJECT_MARKERS.some((m) => markerExists(sub, m))) {
        for (const srv of findServers(sub)) names.add(srv.name);
        continue; // project root — do not descend further
      }
      walk(sub, depth + 1);
    }
  };
  walk(cwd, 1);
  return names;
}

/** Refresh the `lsp` status text shown in the footer (opencode-style `• N LSP`). */
function updateFooterStatus(ctx: {
  cwd: string;
  ui: {
    setStatus(key: string, text: string | undefined): void;
    theme: { fg(color: string, text: string): string };
  };
}): void {
  const cwd = ctx.cwd;
  const cwdIsProject = PROJECT_MARKERS.some((m) => markerExists(cwd, m));
  const matched = findServers(cwd);
  const shown = new Set<string>();
  const parts: string[] = [];

  // Servers running from any root (incl. discovered sub-projects) come first.
  // Same-named servers across multiple roots are merged into one entry with a
  // ×N count (e.g. `typescript-language-server×3` in a multi-project session).
  const activeByName = new Map<string, number>();
  for (const { name, client } of activeServers.values()) {
    if (client.alive) {
      activeByName.set(name, (activeByName.get(name) ?? 0) + 1);
    }
  }
  for (const [name, count] of activeByName) {
    const label = count > 1 ? `${name}×${count}` : name;
    parts.push(ctx.ui.theme.fg("success", label));
    shown.add(name);
  }

  const addIdle = (name: string, config: ServerConfig): void => {
    if (shown.has(name)) return;
    if (brokenServers.has(serverKey(name, cwd))) {
      parts.push(ctx.ui.theme.fg("error", name));
      shown.add(name);
      return;
    }
    const override = commandOverrideFromEnv(name);
    const cmd = override?.command ?? config.command;
    if (!which(cmd, cwd)) return;
    parts.push(ctx.ui.theme.fg("dim", name));
    shown.add(name);
  };

  if (cwdIsProject) {
    // Real project root: show matching servers as before.
    for (const srv of matched) addIdle(srv.name, srv.config);
  } else {
    // Not a project root: prefer nearby sub-projects over `.git`-marker
    // noise (bashls, yamlls, …) when any exist.
    const subNames = findServersInSubprojects(cwd);
    if (subNames.size > 0) {
      const defaults = loadDefaults();
      for (const name of subNames) {
        const config = defaults[name];
        if (config) addIdle(name, config);
      }
    } else {
      // Plain repo with no sub-projects: fall back to cwd matches.
      for (const srv of matched) addIdle(srv.name, srv.config);
    }
  }

  if (parts.length === 0) {
    ctx.ui.setStatus("lsp", ctx.ui.theme.fg("dim", "LSP off"));
    return;
  }
  ctx.ui.setStatus("lsp", `LSP ${parts.join(" ")}`);
}

function serverKey(name: string, cwd: string): string {
  return `${name}::${path.resolve(cwd)}`;
}

function commandOverrideFromEnv(
  name: string,
): { command: string; args: string[] } | undefined {
  const envName = `PI_${name
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()}_LSP_COMMAND`;
  const raw = process.env[envName]?.trim();
  if (!raw) return undefined;
  const [command, ...args] = raw.split(/\s+/).filter(Boolean);
  return command ? { command, args } : undefined;
}

let cachedGlobalTypeScript: string | null | undefined;

/** Locate a global `typescript` install (npm/bun prefix) for typescript-language-server. */
function findGlobalTypeScript(): string | undefined {
  if (cachedGlobalTypeScript !== undefined)
    return cachedGlobalTypeScript ?? undefined;
  for (const cmd of [
    ["npm", "root", "-g"],
    ["bun", "pm", "root", "-g"],
  ]) {
    try {
      const root = execFileSync(cmd[0], cmd.slice(1), {
        encoding: "utf8",
        timeout: 5_000,
      })
        .trim()
        .split("\n")[0];
      if (!root) continue;
      const pkg = path.join(root, "typescript", "package.json");
      if (fs.existsSync(pkg)) {
        cachedGlobalTypeScript = path.dirname(pkg);
        return cachedGlobalTypeScript;
      }
    } catch {
      /* try next package manager */
    }
  }
  cachedGlobalTypeScript = null;
  return undefined;
}

/**
 * typescript-language-server refuses to start without a `typescript` install:
 * it checks `tsserver.path`, then the workspace's node_modules. When the
 * workspace has no local typescript but a global one exists, point it there.
 */
function resolveTypeScriptInitOptions(
  name: string,
  cwd: string,
  initOptions: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (name !== "typescript-language-server") return initOptions;
  const tsserver = (
    initOptions as { tsserver?: { path?: unknown } } | undefined
  )?.tsserver;
  if (tsserver?.path) return initOptions;
  if (
    fs.existsSync(path.join(cwd, "node_modules", "typescript", "package.json"))
  ) {
    return initOptions;
  }
  const global = findGlobalTypeScript();
  if (!global) return initOptions;
  return {
    ...(initOptions ?? {}),
    tsserver: { ...tsserver, path: global },
  };
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
    throw new Error(
      `LSP server '${name}' previously failed to start (reload to retry)`,
    );
  }
  const pending = pendingServers.get(key);
  if (pending) return pending;

  // Per-server command override: PI_<NAME>_LSP_COMMAND="cmd arg1 arg2"
  const override = commandOverrideFromEnv(name);
  const command = override?.command ?? config.command;
  const args = override?.args ?? config.args ?? [];

  let cmd = which(command, cwd);
  if (!cmd && !override && downloadEnabled()) {
    // On-demand install (learned from opencode): defaults.json `install`
    // metadata tells us how to fetch the server binary at runtime instead
    // of failing. Overridden commands are user-controlled and never auto-
    // installed.
    try {
      cmd = await installServer(name, config, cwd);
    } catch {
      cmd = null;
    }
  }
  if (!cmd)
    throw new Error(
      `LSP server '${name}' not found: ${command} not on PATH` +
        (downloadEnabled()
          ? " (auto-install failed or no install metadata)"
          : " (auto-install disabled via PI_LSP_DISABLE_DOWNLOAD=1)"),
    );

  const promise = (async () => {
    try {
      const client = LspClient.spawn(cmd, args, cwd);
      client.onExit(() => {
        activeServers.delete(key);
        notifyStatusChange();
      });
      const rootUri = fileToUri(cwd);
      await client.initialize(rootUri, {
        initializationOptions: resolveTypeScriptInitOptions(
          name,
          cwd,
          config.initializationOptions,
        ),
        settings: config.settings,
      });
      activeServers.set(key, { name, client, cwd, config });
      notifyStatusChange();
      return client;
    } catch (err) {
      brokenServers.add(key);
      notifyStatusChange();
      throw err;
    } finally {
      pendingServers.delete(key);
    }
  })();
  pendingServers.set(key, promise);
  return promise;
}

async function collectDiagnosticsForFile(
  cwd: string,
  absPath: string,
  timeoutMs: number,
  signal?: AbortSignal,
  errorsOnly = false,
): Promise<{
  text: string;
  count: number;
  servers: string[];
  /** One formatted line per diagnostic (no header) — for the dedupe ledger. */
  lines: string[];
}> {
  const serverRoot = getServerRootForFile(cwd, absPath);
  const servers = getServersForFile(serverRoot, absPath);
  if (servers.length === 0) {
    return { text: "", count: 0, servers: [], lines: [] };
  }
  const fileRel = path.relative(cwd, absPath) || path.basename(absPath);
  const uri = fileToUri(absPath);
  const all: Array<{ d: Diagnostic; server: string }> = [];
  const used: string[] = [];

  for (const srv of servers) {
    try {
      const client = await getOrCreateServer(srv.name, srv.config, serverRoot);
      client.syncFile(absPath);
      client.notifySaved(absPath);
      // Prefer LSP 3.17 pull diagnostics when advertised: the server computes
      // fresh results on demand, so there is no publish race to settle.
      // Prefer pull (fresh on demand); when the server cannot serve it
      // (matched=false — unsupported or timed out), fall back to push settle
      // rather than reporting a false-clean file.
      let diagnostics: Diagnostic[] = [];
      let pullMatched = false;
      if (client.supportsPullDiagnostics()) {
        const pulled = await client.pullDiagnostics(uri, timeoutMs, signal);
        diagnostics = pulled.items;
        pullMatched = pulled.matched;
      }
      if (!pullMatched) {
        diagnostics = (
          await client.waitForDiagnostics(
            uri,
            timeoutMs,
            srv.config.diagnosticsSettleMs ?? 800,
            signal,
          )
        ).diagnostics;
      }
      for (const d of diagnostics) {
        if (errorsOnly && d.severity !== undefined && d.severity !== 1)
          continue;
        all.push({ d, server: srv.name });
      }
      used.push(srv.name);
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
      lines: [],
    };
  }
  const lines = limited.map(({ d }) => formatDiag(d, fileRel));
  if (unique.length > cap) lines.push(`…and ${unique.length - cap} more`);
  return {
    text: `${fileRel}: ${unique.length} issue(s) [${used.join(", ")}]\n${lines.join("\n")}`,
    count: unique.length,
    servers: used,
    lines,
  };
}

function extractEditedPath(
  toolName: string,
  input: unknown,
  resultText: string,
  cwd: string,
): string | null {
  const inp = input as Record<string, unknown> | undefined;
  if (toolName === "write" || toolName === "edit") {
    if (typeof inp?.path === "string" && inp.path)
      return path.resolve(cwd, inp.path);
    if (typeof inp?.file_path === "string" && inp.file_path)
      return path.resolve(cwd, inp.file_path);
    if (typeof inp?.filePath === "string" && inp.filePath)
      return path.resolve(cwd, inp.filePath);
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

/** opencode-style warm-up: spawn the server for a file and sync it
 *  (didOpen) so the footer lights up on read, not only after edits.
 *  Fire-and-forget — failures are swallowed and never block the caller. */
function prewarmServer(cwd: string, absPath: string): void {
  const root = getServerRootForFile(cwd, absPath);
  if (getServersForFile(root, absPath).length === 0) return;
  void (async () => {
    try {
      for (const srv of getServersForFile(root, absPath)) {
        const client = await getOrCreateServer(srv.name, srv.config, root);
        client.syncFile(absPath);
      }
    } catch {
      /* silent — prewarming must never surface */
    }
  })();
}


// ── Diagnostics target expansion ──────────────────────────
// `diagnostics` accepts a single file, a directory, or a glob. Directories are
// walked (≤4 levels, skipping vendor dirs) and globs match cwd-relative paths.
// `*` itself is reserved for workspace-wide subprocess diagnostics.

const MAX_GLOB_DIAGNOSTIC_TARGETS = 50;

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000") // **/ → zero or more segments (trailing / included)
    .replace(/\*\*/g, "\u0001") // bare ** → anything
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  return new RegExp("^" + escaped + "$");
}

function collectFilesRecursive(dir: string, depth: number, out: string[]): void {
  if (depth > 4) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (
      e.name.startsWith(".") ||
      e.name === "node_modules" ||
      e.name === "target" ||
      e.name === "dist" ||
      e.name === "build" ||
      e.name === ".venv" ||
      e.name === "venv"
    ) {
      continue;
    }
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collectFilesRecursive(full, depth + 1, out);
    else out.push(full);
  }
}

/** Expand a diagnostics target to an absolute file list, or null when it is a
 *  plain single file (handled by the existing path). */
function expandDiagnosticsTargets(cwd: string, target: string): string[] | null {
  const abs = path.resolve(cwd, target);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    const files: string[] = [];
    collectFilesRecursive(abs, 0, files);
    return files.slice(0, MAX_GLOB_DIAGNOSTIC_TARGETS);
  }
  if (target.includes("*") || target.includes("?")) {
    const files: string[] = [];
    collectFilesRecursive(cwd, 0, files);
    const re = globToRegExp(target);
    const matched = files
      .map((f) => path.relative(cwd, f))
      .filter((rel) => re.test(rel))
      .slice(0, MAX_GLOB_DIAGNOSTIC_TARGETS);
    return matched.length ? matched.map((rel) => path.resolve(cwd, rel)) : null;
  }
  return null;
}

// ── Workspace diagnostics (subprocess) ──────────────────────
// `diagnostics` with file:"*" runs the project's native checker in a child
// process (cargo check / tsc --noEmit / go build / pyright) — the same signal
// a CI pipeline would produce, without depending on LSP server state.

async function execCollect(
  cmd: string[],
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let output = "";
    const cap = (chunk: Buffer) => {
      if (output.length < 64_000) output += chunk.toString();
    };
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    const onAbort = () => child.kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => child.kill(), opts.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code: code ?? -1, output });
    });
    child.on("error", () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code: -1, output });
    });
  });
}

/** Resolve `go build` patterns for a go.work workspace (fallback ./...). */
async function resolveGoWorkspaceBuildPatterns(
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const { code, output } = await execCollect(
    ["go", "work", "edit", "-json"],
    { cwd, timeoutMs, signal },
  );
  if (code !== 0) return [];
  try {
    const parsed = JSON.parse(output) as {
      Use?: Array<{ DiskPath?: string }>;
    };
    const dirs = (parsed.Use ?? [])
      .map((u) => u.DiskPath)
      .filter((d): d is string => Boolean(d));
    // One argv entry per module — a joined string would be a single bogus path.
    return dirs.map((d) => (d.startsWith(".") || d.startsWith("/") ? d : `./${d}`));
  } catch {
    return [];
  }
}

async function detectProjectType(
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ type: string; command: string[] | null; description: string }> {
  if (fs.existsSync(path.join(cwd, "Cargo.toml"))) {
    return {
      type: "rust",
      command: ["cargo", "check", "--message-format=short"],
      description: "Rust (cargo check)",
    };
  }
  if (fs.existsSync(path.join(cwd, "tsconfig.json"))) {
    return {
      type: "typescript",
      command: ["npx", "tsc", "--noEmit"],
      description: "TypeScript (tsc --noEmit)",
    };
  }
  if (fs.existsSync(path.join(cwd, "go.work"))) {
    const patterns = await resolveGoWorkspaceBuildPatterns(cwd, timeoutMs, signal);
    return {
      type: "go",
      command: patterns.length > 0 ? ["go", "build", ...patterns] : ["go", "build", "./..."],
      description: "Go workspace (go build)",
    };
  }
  if (fs.existsSync(path.join(cwd, "go.mod"))) {
    return {
      type: "go",
      command: ["go", "build", "./..."],
      description: "Go (go build)",
    };
  }
  if (
    fs.existsSync(path.join(cwd, "pyproject.toml")) ||
    fs.existsSync(path.join(cwd, "pyrightconfig.json"))
  ) {
    return {
      type: "python",
      command: ["pyright"],
      description: "Python (pyright)",
    };
  }
  return { type: "unknown", command: null, description: "Unknown project type" };
}

/** Run the project-native checker; output capped at 50 lines (OMP-style). */
async function runWorkspaceDiagnostics(
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ output: string; projectType: string; command: string[] | null }> {
  if (signal?.aborted) throw new Error("Aborted");
  const { type, command, description } = await detectProjectType(cwd, timeoutMs, signal);
  if (!command) {
    return {
      output:
        "Cannot detect project type. Supported: Rust (Cargo.toml), TypeScript (tsconfig.json), Go (go.work/go.mod), Python (pyproject.toml)",
      projectType: description,
      command: null,
    };
  }
  const { code, output } = await execCollect(command, { cwd, timeoutMs, signal });
  if (signal?.aborted) throw new Error("Aborted");
  const combined = output.trim();
  if (!combined) {
    return { output: "No issues found", projectType: description, command };
  }
  const lines = combined.split("\n");
  const capped =
    lines.length > 50
      ? `${lines.slice(0, 50).join("\n")}\n[…${lines.length - 50}ln elided…]`
      : combined;
  return {
    output: `exit ${code}${code === 0 ? " (clean)" : ""}\n${capped}`,
    projectType: description,
    command,
  };
}

// ── Format-on-write (FormattingOptions resolution) ───────────
// Learned from OMP lsp/format-options.ts: .editorconfig wins, then content
// indent sniffing (GCD of space widths), then 2-space fallback. The old
// hardcoded `{ tabSize: 2, insertSpaces: true }` re-indented files on every
// write when the server disagreed.

function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

/**
 * Sniff insertSpaces and the indent unit from content. Walks the buffer once:
 * the first indented line decides spaces vs tabs; for space indents, the GCD
 * of all space-indent widths gives the stride (2/4/6 file reports 2).
 */
function detectIndentFromContent(
  content: string,
): { tabSize?: number; insertSpaces?: boolean } {
  if (content.length === 0) return {};
  let insertSpaces: boolean | undefined;
  let unit = 0;
  for (const line of content.split("\n")) {
    if (line.length === 0 || line.trim().length === 0) continue;
    const first = line[0];
    if (first !== " " && first !== "\t") continue;
    if (insertSpaces === undefined) insertSpaces = first === " ";
    if (first === "\t") continue;
    let n = 0;
    while (n < line.length && line[n] === " ") n++;
    if (n === 0) continue;
    unit = unit === 0 ? n : gcd(unit, n);
  }
  const result: { tabSize?: number; insertSpaces?: boolean } = {};
  if (insertSpaces !== undefined) result.insertSpaces = insertSpaces;
  if (unit > 0 && insertSpaces === true) result.tabSize = unit;
  return result;
}

/** Minimal .editorconfig reader: walks up for the nearest file, honors
 *  `root`, reads indent_style / indent_size / tab_width for `*` sections. */
function getEditorConfigFormatting(
  filePath: string,
): { tabSize?: number; insertSpaces?: boolean } {
  const startDir = path.dirname(filePath);
  let dir = startDir;
  for (;;) {
    const cfgPath = path.join(dir, ".editorconfig");
    if (fs.existsSync(cfgPath)) {
      try {
        const text = fs.readFileSync(cfgPath, "utf-8");
        let root = false;
        let style: string | undefined;
        let size: number | undefined;
        let width: number | undefined;
        for (const raw of text.split(/\r?\n/)) {
          const line = raw.trim();
          if (!line || line.startsWith("#") || line.startsWith(";")) continue;
          if (line.startsWith("[")) continue;
          const eq = line.indexOf("=");
          if (eq === -1) continue;
          const key = line.slice(0, eq).trim();
          const value = line.slice(eq + 1).trim();
          if (key === "root" && value === "true") root = true;
          if (key === "indent_style") style = value;
          if (key === "indent_size") {
            const n = Number(value);
            if (Number.isFinite(n) && n > 0) size = n;
          }
          if (key === "tab_width") {
            const n = Number(value);
            if (Number.isFinite(n) && n > 0) width = n;
          }
        }
        const result: { tabSize?: number; insertSpaces?: boolean } = {};
        if (style === "tab") {
          result.insertSpaces = false;
          result.tabSize = width ?? 4;
        } else if (style === "space") {
          result.insertSpaces = true;
          result.tabSize = size ?? 2;
        } else if (size !== undefined) {
          result.tabSize = size;
        }
        return result;
      } catch {
        return {};
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return {};
    dir = parent;
  }
}

/** Resolve LSP FormattingOptions for a file about to be formatted. */
function resolveFormatOptions(
  filePath: string,
  content: string,
): { tabSize: number; insertSpaces: boolean } {
  const fromConfig = getEditorConfigFormatting(filePath);
  const detected = detectIndentFromContent(content);
  return {
    tabSize: fromConfig.tabSize ?? detected.tabSize ?? 2,
    insertSpaces: fromConfig.insertSpaces ?? detected.insertSpaces ?? true,
  };
}

function formatOnWriteEnabled(): boolean {
  const v = process.env.PI_LSP_FORMAT_ON_WRITE;
  return v === "1" || v === "true" || v === "on";
}

/** Format a file via its primary server and write the result back to disk.
 *  Returns the number of edits applied, or 0 when nothing changed. */
async function formatFileWithLsp(
  cwd: string,
  absPath: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<number> {
  const serverRoot = getServerRootForFile(cwd, absPath);
  const server = getPrimaryServerForFile(serverRoot, absPath);
  if (!server) return 0;
  const client = await getOrCreateServer(server.name, server.config, serverRoot);
  const content = fs.readFileSync(absPath, "utf-8");
  client.syncFile(absPath);
  const options = resolveFormatOptions(absPath, content);
  const edits = await client.request<TextEdit[] | null>(
    "textDocument/formatting",
    { textDocument: { uri: fileToUri(absPath) }, options },
    timeoutMs,
    signal,
  );
  if (!edits?.length) return 0;
  const formatted = applyTextEditsToContent(content, edits);
  if (formatted === content) return 0;
  fs.writeFileSync(absPath, formatted);
  client.syncFile(absPath);
  return edits.length;
}

// ── Diagnostics ledger (dedupe) ─────────────────────────────
// Learned from OMP lsp/diagnostics-ledger.ts: consecutive edits of the same
// file re-report the same errors; the ledger tracks which diagnostic
// identities were already shown and only surfaces fresh ones.

/** Strip a leading `path:line:col` prefix so the same error at the same
 *  location after an edit still counts as "seen". */
function diagnosticIdentity(message: string): string {
  // formatDiag renders positions as `L<line>:<col>` — tolerate the L prefix.
  return message.replace(/^.*?:\s*L?\d+:\d+\s+/, "");
}

class DiagnosticsLedger {
  #seen = new Map<string, Set<string>>();

  /** Returns only messages not previously reported for this file. */
  reduce(absPath: string, messages: string[]): string[] {
    const previous = this.#seen.get(absPath);
    const currentIdentities = new Set<string>();
    const fresh: string[] = [];
    for (const message of messages) {
      const identity = diagnosticIdentity(message);
      currentIdentities.add(identity);
      if (!previous?.has(identity)) fresh.push(message);
    }
    if (currentIdentities.size === 0) {
      this.#seen.delete(absPath); // clean file: forget history
    } else {
      this.#seen.set(absPath, currentIdentities);
    }
    return fresh;
  }

  reset(absPath: string): void {
    this.#seen.delete(absPath);
  }
}

const diagnosticsLedger = new DiagnosticsLedger();

function diagnosticsDeduplicateEnabled(): boolean {
  const v = process.env.PI_LSP_DIAGNOSTICS_DEDUPLICATE;
  if (v === "0" || v === "false" || v === "off") return false;
  return true;
}

// ── On-demand server install ─────────────────────────────────
// Learned from opencode lsp/server.ts: when a matched server's command is
// missing, install it at runtime instead of failing. defaults.json carries
// `install` metadata ({type, package}); PI_LSP_DISABLE_DOWNLOAD=1 opts out.

function downloadEnabled(): boolean {
  return process.env.PI_LSP_DISABLE_DOWNLOAD !== "1";
}

/** In-flight installs per server name — dedupe concurrent attempts. */
const pendingInstalls = new Map<string, Promise<string | null>>();

/** Install a server per its `install` metadata; resolves to the installed
 *  command path (same name as the command) or null on failure. */
async function installServer(
  name: string,
  config: ServerConfig,
  cwd: string,
): Promise<string | null> {
  const inst = config.install;
  if (!inst?.type || !inst.package) return null;
  const inflight = pendingInstalls.get(name);
  if (inflight) return inflight;

  const promise = (async (): Promise<string | null> => {
    const installCmd: string[] | null =
      inst.type === "npm"
        ? ["npm", "install", "-g", inst.package]
        : inst.type === "pip"
          ? ["pip3", "install", "--user", inst.package]
          : inst.type === "go"
            ? ["go", "install", inst.package]
            : inst.type === "rustup"
              ? ["rustup", "component", "add", inst.package]
              : inst.type === "cargo"
                ? ["cargo", "install", inst.package]
                : inst.type === "brew"
                  ? ["brew", "install", inst.package]
                  : null;
    if (!installCmd) return null;
    try {
      const { code } = await execCollect(installCmd, {
        cwd,
        timeoutMs: 300_000,
      });
      if (code !== 0) return null;
      // Re-resolve the command after install (node_modules/.bin, PATH…).
      return which(config.command, cwd);
    } catch {
      return null;
    }
  })();

  pendingInstalls.set(name, promise);
  promise.finally(() => {
    if (pendingInstalls.get(name) === promise) pendingInstalls.delete(name);
  });
  return promise;
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
      file: Type.Optional(
        Type.String({ description: "File path (relative to cwd)" }),
      ),
      line: Type.Optional(Type.Number({ description: "Line (1-indexed)" })),
      column: Type.Optional(
        Type.Number({ description: "Column (1-indexed, default 1)" }),
      ),
      symbol: Type.Optional(
        Type.String({
          description: "workspace_symbols query / new name for rename",
        }),
      ),
      new_name: Type.Optional(
        Type.String({ description: "New name for rename" }),
      ),
      apply: Type.Optional(
        Type.Boolean({
          description: "Apply rename/code_action (default false = preview)",
        }),
      ),
      index: Type.Optional(
        Type.Number({ description: "code_actions: 1-based index to apply" }),
      ),
      query: Type.Optional(
        Type.String({
          description: "code_actions: filter by kind or title substring",
        }),
      ),
      timeout: Type.Optional(
        Type.Number({ default: 15, description: "Timeout seconds" }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const action = String(params.action ?? "")
        .trim()
        .toLowerCase();
      const cwd = ctx.cwd;
      const timeoutMs =
        (typeof params.timeout === "number" && params.timeout > 0
          ? params.timeout
          : 15) * 1000;
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
            const onPath = which(s.config.command, cwd)
              ? ""
              : " (command missing)";
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
            } catch {
              /* ok */
            }
          }
          activeServers.clear();
          brokenServers.clear();
          notifyStatusChange();
          return ok("LSP servers reloaded.");
        }

        if (action === "workspace_symbols") {
          const q =
            typeof params.symbol === "string" ? params.symbol : params.query;
          if (typeof q !== "string" || !q)
            throw new Error("'symbol' required for workspace_symbols");
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
                    .join(
                      "\n",
                    )}${syms.length > 30 ? `\n  …and ${syms.length - 30} more` : ""}`,
                );
              }
            } catch {
              /* next */
            }
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
          // file == "*": workspace-wide subprocess diagnostics (cargo check /
          // tsc --noEmit / go build / pyright) — the CI signal without LSP.
          if (params.file === "*") {
            const ws = await runWorkspaceDiagnostics(
              cwd,
              Math.min(timeoutMs, 60_000),
              abort,
            );
            return ok(
              `Workspace diagnostics — ${ws.projectType}\n${ws.output}`,
              { workspace: true, command: ws.command?.join(" ") ?? null },
            );
          }
          // Directory or glob: aggregate per-file diagnostics.
          const expanded = expandDiagnosticsTargets(cwd, params.file);
          if (expanded) {
            const lines: string[] = [];
            let total = 0;
            const servers = new Set<string>();
            for (const f of expanded) {
              const r = await collectDiagnosticsForFile(
                cwd,
                f,
                Math.min(timeoutMs, 8_000),
                abort,
                false,
              );
              if (r.text) {
                lines.push(r.text);
                total += r.count;
                for (const sv of r.servers) servers.add(sv);
              }
            }
            if (!lines.length)
              return ok(`No diagnostics for ${params.file}`);
            const truncated =
              lines.length > MAX_GLOB_DIAGNOSTIC_TARGETS
                ? lines.slice(0, MAX_GLOB_DIAGNOSTIC_TARGETS)
                : lines;
            return ok(
              `Diagnostics for ${params.file} (${expanded.length} file(s), ${total} issue(s)) [${[...servers].join(", ")}]\n${truncated.join("\n")}`,
              { count: total, files: expanded.length },
            );
          }
          const result = await collectDiagnosticsForFile(
            cwd,
            absPath,
            Math.min(timeoutMs, 8_000),
            abort,
            false,
          );
          if (!result.servers.length)
            throw new Error(`No LSP server found for ${params.file}`);
          return ok(result.text, {
            servers: result.servers,
            count: result.count,
          });
        }

        const serverRoot = getServerRootForFile(cwd, absPath);
        const server = getPrimaryServerForFile(serverRoot, absPath);
        if (!server) throw new Error(`No LSP server found for ${params.file}`);
        const client = await getOrCreateServer(
          server.name,
          server.config,
          serverRoot,
        );
        client.syncFile(absPath);

        const needPos =
          NAV_ACTIONS.has(action) ||
          action === "rename" ||
          action === "code_actions";
        // Project-load awareness (learned from OMP): navigation requests made
        // before the server finishes loading the project can return false
        // negatives (rust-analyzer cold-start can take tens of seconds).
        // The $/progress tracker resolves once loading is done; the 15s
        // fallback timer bounds the wait, and failures never block.
        if (NAV_ACTIONS.has(action)) {
          await client
            .waitForProjectLoaded(timeoutMs, abort)
            .catch(() => {});
        }
        if (needPos && (typeof params.line !== "number" || params.line < 1)) {
          throw new Error(`'line' (1-indexed) required for ${action}`);
        }
        const col =
          (typeof params.column === "number" && params.column >= 1
            ? params.column
            : 1) - 1;
        const position =
          typeof params.line === "number"
            ? { line: params.line - 1, character: col }
            : { line: 0, character: 0 };
        const textDocument = { uri: fileToUri(absPath) };

        if (
          action === "definition" ||
          action === "type_definition" ||
          action === "implementation"
        ) {
          const method =
            action === "definition"
              ? "textDocument/definition"
              : action === "type_definition"
                ? "textDocument/typeDefinition"
                : "textDocument/implementation";
          const raw = await client.request(
            method,
            { textDocument, position },
            timeoutMs,
            abort,
          );
          const locs = normalizeLocations(raw);
          if (!locs.length) return ok(`No ${action.replace("_", " ")} found.`);
          return ok(locs.map((l) => formatLocation(l)).join("\n"), {
            server: server.name,
          });
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
          const walk = (
            arr: Array<DocumentSymbol | SymbolInfo>,
            indent: string,
          ) => {
            for (const s of arr) {
              const icon = SYMBOL_KINDS[s.kind] ?? "?";
              if ("children" in s) {
                lines.push(
                  `${indent}${icon} ${s.name} (L${s.range.start.line + 1}-L${s.range.end.line + 1})`,
                );
                if (s.children?.length) walk(s.children, indent + "  ");
              } else {
                lines.push(
                  `${indent}${icon} ${s.name} — ${formatLocation(s.location)}`,
                );
              }
            }
          };
          walk(syms, "  ");
          return ok(`Symbols in ${fileRel}:\n${lines.join("\n")}`, {
            server: server.name,
          });
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
          return ok(`Formatted ${fileRel} (${edits.length} edit(s))`, {
            server: server.name,
          });
        }

        if (action === "rename") {
          const newName =
            (typeof params.new_name === "string" && params.new_name) ||
            (typeof params.symbol === "string" && params.symbol) ||
            "";
          if (!newName)
            throw new Error("'new_name' (or symbol) required for rename");
          const edit = await client.request<WorkspaceEdit | null>(
            "textDocument/rename",
            { textDocument, position, newName },
            timeoutMs,
            abort,
          );
          if (!edit)
            return ok(
              "Rename returned no edits (symbol may not be renameable).",
            );
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
          const raw = await client.request<
            Array<CodeAction | { title: string; command: string }>
          >(
            "textDocument/codeAction",
            {
              textDocument,
              range: { start: position, end: position },
              context: {
                diagnostics: client.getDiagnostics(fileToUri(absPath)),
              },
            },
            timeoutMs,
            abort,
          );
          let actions = (raw ?? []).map((a, i) => ({ i: i + 1, a }));
          const q =
            typeof params.query === "string" ? params.query.toLowerCase() : "";
          if (q) {
            actions = actions.filter(({ a }) => {
              const title = a.title?.toLowerCase() ?? "";
              const kind =
                "kind" in a && a.kind ? String(a.kind).toLowerCase() : "";
              return title.includes(q) || kind.includes(q);
            });
          }
          if (!actions.length) return ok("No code actions.");

          const apply = params.apply === true;
          const idx =
            typeof params.index === "number" ? params.index : undefined;
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
          const picked =
            actions.find((x) => x.i === idx)?.a ?? (raw ?? [])[idx - 1];
          if (!picked) throw new Error(`No code action at index ${idx}`);

          let actionObj = picked as CodeAction;
          if (
            !actionObj.edit &&
            actionObj.data !== undefined &&
            client.canResolveCodeActions()
          ) {
            try {
              actionObj = await client.request<CodeAction>(
                "codeAction/resolve",
                actionObj,
                timeoutMs,
                abort,
              );
            } catch {
              /* use unresolved */
            }
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
          return fail(
            `Code action '${actionObj.title}' has no edit or command to apply.`,
          );
        }

        throw new Error(`Unhandled action: ${action}`);
      } catch (err) {
        return fail(
          `LSP ${action} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  });

  // ── Footer status ─────────────────────────────────
  // Footer deps captured at session_start are static for the session's life,
  // but model / thinking level change at runtime (model_select /
  // thinking_level_select). Read them through getters so the footer follows
  // the live values; re-render proactively on every change.
  let currentModel: Parameters<typeof createFooter>[0]["model"];
  let currentThinkingLevel: string | undefined;
  let footerTui: { requestRender(): void } | undefined;

  pi.on("session_start", async (_event, ctx) => {
    currentModel = ctx.model;
    currentThinkingLevel = ctx.thinkingLevel;
    setStatusReporter(() => updateFooterStatus(ctx));
    startIdleSweeper();
    updateFooterStatus(ctx);
    // Custom footer: keep the built-in layout but right-align the `lsp`
    // status while other extension statuses (usage, …) stay left-aligned.
    ctx.ui.setFooter((tui, theme, footerData) => {
      footerTui = tui;
      const footer = createFooter(
        {
          cwd: ctx.cwd,
          home: process.env.HOME,
          get sessionName() {
            return ctx.sessionManager.getSessionName();
          },
          getEntries: () => ctx.sessionManager.getEntries(),
          get model() {
            return currentModel;
          },
          get thinkingLevel() {
            return currentThinkingLevel;
          },
          getContextUsage: () => ctx.getContextUsage(),
        },
        footerData,
        theme,
      );
      const unsub = footerData.onBranchChange(() => tui.requestRender());
      return {
        ...footer,
        dispose() {
          unsub();
        },
      };
    });
  });

  pi.on("model_select", async (event, ctx) => {
    currentModel = ctx.model ?? event.model;
    footerTui?.requestRender();
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    currentThinkingLevel = ctx.thinkingLevel ?? event.level;
    footerTui?.requestRender();
  });

  // ── Setup command ────────────────────────────────
  pi.registerCommand("lsp:setup", {
    description:
      "Install default language servers (ts/js, bash, python, golang, rust) — best-effort, skips what is already installed",
    handler: async (_args, ctx) => {
      const script = path.join(__dirname, "..", "scripts", "setup-ls.mjs");
      ctx.ui.notify("lsp: installing default language servers…", "info");
      const { execFile } = await import("node:child_process");
      const output = await new Promise<string>((resolve, reject) => {
        execFile(
          process.execPath,
          [script],
          { timeout: 1_800_000 },
          (err, stdout, stderr) => {
            if (err) reject(new Error(`${err.message}\n${stderr}`));
            else resolve(stdout + stderr);
          },
        );
      });
      const lines = output.trim().split("\n");
      ctx.ui.notify(
        lines.slice(-20).join("\n"),
        lines.some((l) => l.includes("need attention")) ? "warning" : "info",
      );
    },
  });

  // ── Phase 1a: warm up servers on read (opencode-style touchFile) ──
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "read") return;
    const file = (event.input as { path?: unknown } | undefined)?.path;
    if (typeof file !== "string" || !file) return;
    const absPath = path.resolve(ctx.cwd, file);
    if (!fs.existsSync(absPath)) return;
    prewarmServer(ctx.cwd, absPath);
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
    if (
      /^Error\b|failed:|E_NOOP_LOOP|E_DUPLICATE_EDIT|Tag mismatch/i.test(
        resultText,
      )
    ) {
      // likely failure; still try if path extractable and not hard error markers only
      if (
        /Tag mismatch|E_NOOP_LOOP|E_DUPLICATE_EDIT|Error parsing|Error applying/i.test(
          resultText,
        )
      ) {
        return;
      }
    }

    const absPath = extractEditedPath(
      event.toolName,
      event.input,
      resultText,
      ctx.cwd,
    );
    if (!absPath || !fs.existsSync(absPath)) return;

    // Only if some server matches
    if (
      getServersForFile(getServerRootForFile(ctx.cwd, absPath), absPath)
        .length === 0
    )
      return;

    try {
      // Format-on-write (default off, PI_LSP_FORMAT_ON_WRITE=1): normalize the
      // file before diagnostics so reported errors match final content.
      let formatNote = "";
      if (formatOnWriteEnabled()) {
        try {
          const edits = await formatFileWithLsp(ctx.cwd, absPath, 8_000);
          if (edits > 0)
            formatNote = `\n[lsp] auto-formatted (${edits} edit(s))`;
        } catch {
          /* formatting is best-effort */
        }
      }
      const result = await collectDiagnosticsForFile(
        ctx.cwd,
        absPath,
        6_000,
        undefined,
        true, // errors only for automatic feedback
      );
      // Dedupe ledger (OMP-style): consecutive edits of the same file must
      // not re-report the same errors. Clean files reset the history.
      let lines = result.lines;
      if (diagnosticsDeduplicateEnabled()) {
        lines = diagnosticsLedger.reduce(absPath, result.lines);
      }
      if (lines.length === 0 && !formatNote) return; // quiet: nothing new
      const header = result.text.split("\n")[0];
      const body = lines.length ? `\n${lines.join("\n")}` : "";
      const suffix = `\n\n[lsp diagnostics]\n${header}${body}${formatNote}`;

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
    // Do NOT stop the idle sweeper here: the timer is process-global and
    // sweeps servers owned by ANY session in this process. Stopping it on one
    // session's shutdown would silently disable reaping for all remaining
    // sessions. The timer is unref'd, so the process can still exit cleanly.
    setStatusReporter(undefined);
    for (const srv of activeServers.values()) {
      try {
        await srv.client.shutdown();
      } catch {
        /* ok */
      }
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
  hasOverlappingTextEdits,
  commandOverrideFromEnv,
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
  updateFooterStatus,
  resolveTypeScriptInitOptions,
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
  formatFileWithLsp,
  installServer,
  resetManager(): void {
    activeServers.clear();
    brokenServers.clear();
  },
  getActiveCount(): number {
    return activeServers.size;
  },
};
