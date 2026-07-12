/**
 * DAP Client — Node.js port.
 * Communicates with debug adapters via stdin/stdout (JSON-RPC over DAP).
 * @source oh-my-pi packages/coding-agent/src/dap/client.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { NON_INTERACTIVE_ENV } from "./non-interactive-env";
import { toErrorMessage } from "./utils";
import type {
  DapCapabilities,
  DapEventMessage,
  DapInitializeArguments,
  DapPendingRequest,
  DapRequestMessage,
  DapResolvedAdapter,
  DapResponseMessage,
} from "./types";

export class DapAbortError extends Error {
  constructor(message = "Operation aborted") {
    super(message);
    this.name = "DapAbortError";
  }
}

type DapEventHandler = (body: unknown, event: DapEventMessage) => void | Promise<void>;
type DapReverseRequestHandler = (args: unknown) => unknown | Promise<unknown>;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MESSAGE_DECODER = new TextDecoder("utf-8");

// ---------------------------------------------------------------------------
// Framing helpers
// ---------------------------------------------------------------------------

function findHeaderEnd(buf: Buffer): number {
  for (let i = 3; i < buf.length; i++) {
    if (buf[i - 3] === 13 && buf[i - 2] === 10 && buf[i - 1] === 13 && buf[i] === 10) {
      return i - 3;
    }
  }
  return -1;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// DapClient
// ---------------------------------------------------------------------------

export class DapClient {
  readonly adapter: DapResolvedAdapter;
  readonly cwd: string;
  readonly #proc: ChildProcess;
  #requestSeq = 0;
  #pendingRequests = new Map<number, DapPendingRequest>();
  #messageBuffer = Buffer.alloc(0);
  #disposed = false;
  #lastActivity = Date.now();
  #capabilities?: DapCapabilities;
  #eventHandlers = new Map<string, Set<DapEventHandler>>();
  #anyEventHandlers = new Set<DapEventHandler>();
  #reverseRequestHandlers = new Map<string, DapReverseRequestHandler>();
  #stderrChunks: string[] = [];

  constructor(adapter: DapResolvedAdapter, cwd: string, proc: ChildProcess) {
    this.adapter = adapter;
    this.cwd = cwd;
    this.#proc = proc;

    if (proc.stderr) {
      proc.stderr.on("data", (chunk: Buffer) => {
        this.#stderrChunks.push(chunk.toString());
      });
    }

    proc.on("exit", () => this.#handleProcessExit());
    this.#startMessageReader();
  }

  static async spawn(opts: { adapter: DapResolvedAdapter; cwd: string }): Promise<DapClient> {
    const { adapter, cwd } = opts;
    const cmd = adapter.resolvedCommand;
    const args = adapter.args;

    const proc = spawn(cmd, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...NON_INTERACTIVE_ENV },
    });

    return new DapClient(adapter, cwd, proc);
  }

  // ── Public API ───────────────────────────────────────────────

  get capabilities(): DapCapabilities | undefined { return this.#capabilities; }
  get lastActivity(): number { return this.#lastActivity; }

  isAlive(): boolean {
    return !this.#disposed && this.#proc.exitCode === null;
  }

  async initialize(args: DapInitializeArguments, signal?: AbortSignal, timeoutMs?: number): Promise<DapCapabilities> {
    const body = await this.sendRequest("initialize", args, signal, timeoutMs) as DapCapabilities | undefined;
    this.#capabilities = body ?? {};
    return this.#capabilities;
  }

  onEvent(event: string, handler: DapEventHandler): () => void {
    const handlers = this.#eventHandlers.get(event) ?? new Set<DapEventHandler>();
    handlers.add(handler);
    this.#eventHandlers.set(event, handlers);
    return () => { handlers.delete(handler); if (handlers.size === 0) this.#eventHandlers.delete(event); };
  }

  onAnyEvent(handler: DapEventHandler): () => void {
    this.#anyEventHandlers.add(handler);
    return () => { this.#anyEventHandlers.delete(handler); };
  }

  onReverseRequest(command: string, handler: DapReverseRequestHandler): () => void {
    this.#reverseRequestHandlers.set(command, handler);
    return () => { if (this.#reverseRequestHandlers.get(command) === handler) this.#reverseRequestHandlers.delete(command); };
  }

  async waitForEvent<TBody>(
    event: string, predicate?: (body: TBody) => boolean,
    signal?: AbortSignal, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<TBody> {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DapAbortError();
    const { promise, resolve, reject } = Promise.withResolvers<TBody>();
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      unsubscribe();
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", abortHandler);
    };
    const abortHandler = () => { cleanup(); reject(signal?.reason instanceof Error ? signal.reason : new DapAbortError()); };

    const unsubscribe = this.onEvent(event, body => {
      const typed = body as TBody;
      if (predicate && !predicate(typed)) return;
      cleanup();
      resolve(typed);
    });

    if (signal) signal.addEventListener("abort", abortHandler, { once: true });
    timeout = setTimeout(() => { cleanup(); reject(new Error(`DAP event ${event} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    return promise;
  }

  async sendRequest<TBody = unknown>(
    command: string, args?: unknown, signal?: AbortSignal, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<TBody> {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DapAbortError();
    if (this.#disposed) throw new Error(`DAP adapter ${this.adapter.name} is not running`);

    const seq = ++this.#requestSeq;
    const request: DapRequestMessage = { seq, type: "request", command, arguments: args };
    const { promise, resolve, reject } = Promise.withResolvers<TBody>();
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", abortHandler);
    };
    const abortHandler = () => {
      this.#pendingRequests.delete(seq);
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new DapAbortError());
    };

    timeout = setTimeout(() => {
      if (!this.#pendingRequests.has(seq)) return;
      this.#pendingRequests.delete(seq);
      cleanup();
      reject(new Error(`DAP request ${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    if (signal) signal.addEventListener("abort", abortHandler, { once: true });

    this.#pendingRequests.set(seq, {
      command,
      resolve: body => { cleanup(); resolve(body as TBody); },
      reject: err => { cleanup(); reject(err); },
    });

    this.#lastActivity = Date.now();
    await this.#write(request);
    return promise;
  }

  async sendResponse(request: DapRequestMessage, success: boolean, body?: unknown, message?: string): Promise<void> {
    const response: DapResponseMessage = {
      seq: ++this.#requestSeq, type: "response",
      request_seq: request.seq, success, command: request.command,
      ...(message ? { message } : {}),
      ...(body !== undefined ? { body } : {}),
    };
    await this.#write(response);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#rejectPending(new Error(`DAP adapter ${this.adapter.name} disposed`));
    try { this.#proc.kill(); } catch { /* ok */ }
  }

  // ── Private ──────────────────────────────────────────────────

  async #write(message: DapRequestMessage | DapResponseMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const content = JSON.stringify(message);
      const header = `Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n`;
      const stream = this.#proc.stdin!;
      if (!stream.writable) { reject(new Error("stdin closed")); return; }
      stream.write(header + content, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  #startMessageReader(): void {
    const stream = this.#proc.stdout!;
    let buffer = this.#messageBuffer;

    stream.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (true) {
        const headerEnd = findHeaderEnd(buffer);
        if (headerEnd === -1) break;

        const headerText = MESSAGE_DECODER.decode(buffer.subarray(0, headerEnd));
        const match = headerText.match(/Content-Length: (\d+)/i);
        if (!match) {
          buffer = buffer.subarray(headerEnd + 4);
          continue;
        }

        const contentLength = parseInt(match[1], 10);
        const msgStart = headerEnd + 4;
        const msgEnd = msgStart + contentLength;
        if (buffer.length < msgEnd) break;

        const messageText = MESSAGE_DECODER.decode(buffer.subarray(msgStart, msgEnd));
        buffer = buffer.subarray(msgEnd);
        this.#lastActivity = Date.now();

        try {
          const msg = JSON.parse(messageText) as DapResponseMessage | DapEventMessage | DapRequestMessage;
          if (msg.type === "response") {
            this.#handleResponse(msg);
          } else if (msg.type === "event") {
            void this.#dispatchEvent(msg);
          } else {
            void this.#handleAdapterRequest(msg);
          }
        } catch { /* skip malformed */ }
      }
    });
  }

  #handleResponse(msg: DapResponseMessage): void {
    const pending = this.#pendingRequests.get(msg.request_seq);
    if (!pending) return;
    this.#pendingRequests.delete(msg.request_seq);
    if (msg.success) { pending.resolve(msg.body); return; }
    pending.reject(new Error(msg.message ?? `DAP request ${pending.command} failed`));
  }

  async #dispatchEvent(msg: DapEventMessage): Promise<void> {
    const handlers = [...(this.#eventHandlers.get(msg.event) ?? []), ...this.#anyEventHandlers];
    for (const handler of handlers) {
      try { await handler(msg.body, msg); } catch { /* best effort */ }
    }
  }

  async #handleAdapterRequest(msg: DapRequestMessage): Promise<void> {
    try {
      const handler = this.#reverseRequestHandlers.get(msg.command);
      if (handler) {
        try {
          const body = await handler(msg.arguments);
          await this.sendResponse(msg, true, body);
        } catch (err) {
          await this.sendResponse(msg, false, { error: { id: 1, format: toErrorMessage(err) } }, toErrorMessage(err));
        }
        return;
      }
      await this.sendResponse(msg, false, { error: { id: 1, format: `Unsupported: ${msg.command}` } }, `Unsupported: ${msg.command}`);
    } catch { /* best effort */ }
  }

  #handleProcessExit(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const stderr = this.#stderrChunks.join("").trim();
    const exitCode = this.#proc.exitCode;
    this.#rejectPending(new Error(
      stderr ? `DAP adapter exited (code ${exitCode}): ${stderr}` : `DAP adapter exited unexpectedly (code ${exitCode})`,
    ));
  }

  #rejectPending(err: Error): void {
    for (const p of this.#pendingRequests.values()) p.reject(err);
    this.#pendingRequests.clear();
  }
}
