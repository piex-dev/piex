import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Buffer } from "node:buffer";
import type {
  AgentConfig,
  ResolvedModel,
  SingleResult,
  ThinkingLevel,
  UsageStats,
} from "./types.js";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_STDERR_BYTES,
  KILL_GRACE_MS,
  MAX_PENDING_LINE_BYTES,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// pi invocation: build args + locate the pi binary
// ─────────────────────────────────────────────────────────────────────────────

export function buildPiArgs(opts: {
  model?: string;
  thinkingLevel?: ThinkingLevel;
  tools?: string[];
  systemPromptPath?: string;
  message: string;
}): string[] {
  const args = ["--mode", "json", "-p", "--no-session", "--no-extensions"];
  if (opts.model && opts.model !== "inherit") args.push("--model", opts.model);
  if (opts.thinkingLevel) args.push("--thinking", opts.thinkingLevel);
  if (Array.isArray(opts.tools)) {
    if (opts.tools.length > 0) args.push("--tools", opts.tools.join(","));
    else args.push("--no-tools");
  }
  if (opts.systemPromptPath)
    args.push("--system-prompt", opts.systemPromptPath);
  args.push(opts.message);
  return args;
}

export function getPiInvocation(args: string[]): {
  command: string;
  args: string[];
} {
  const currentScript = process.argv[1];
  const isRunnableScript = (p: string) =>
    /\.(?:mjs|cjs|js)$/i.test(p) && fs.existsSync(p);
  const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");

  if (currentScript && !isBunVirtual && isRunnableScript(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };

  return { command: "pi", args };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bounded JSON line decoder
// ─────────────────────────────────────────────────────────────────────────────

interface MessageLike {
  role?: string;
  content?: unknown;
  usage?: Partial<UsageStats> & { cost?: { total?: number } };
  stopReason?: string;
  errorMessage?: string;
  provider?: string;
  model?: string;
  responseModel?: string;
}

interface DecoderHandlers {
  onValue: (value: unknown) => void;
  onOversized?: () => void;
  onMalformed?: () => void;
}

export class JsonLineDecoder {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private exceeded = false;

  constructor(private readonly handlers: DecoderHandlers) {}

  push(chunk: Buffer | string): void {
    if (this.exceeded) return;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== 0x0a) continue;
      if (!this.append(bytes.subarray(start, i))) return;
      this.flush();
      start = i + 1;
    }
    if (start < bytes.length) this.append(bytes.subarray(start));
  }

  finish(): void {
    if (this.pendingBytes > 0) this.flush();
  }

  private append(segment: Buffer): boolean {
    if (segment.length === 0) return true;
    const observed = this.pendingBytes + segment.length;
    if (observed > MAX_PENDING_LINE_BYTES) {
      this.exceeded = true;
      this.pending = [];
      this.pendingBytes = 0;
      this.handlers.onOversized?.();
      return false;
    }
    this.pending.push(segment);
    this.pendingBytes = observed;
    return true;
  }

  private flush(): void {
    if (this.pendingBytes === 0) return;
    const line = Buffer.concat(this.pending, this.pendingBytes).toString(
      "utf8",
    );
    this.pending = [];
    this.pendingBytes = 0;
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      this.handlers.onValue(JSON.parse(trimmed));
    } catch {
      this.handlers.onMalformed?.();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Process termination
// ─────────────────────────────────────────────────────────────────────────────

function signalProcess(
  proc: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== "win32" && proc.pid) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // fall through to direct kill
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // process may already have exited
  }
}

export function terminateProcess(
  proc: ReturnType<typeof spawn>,
  graceMs = KILL_GRACE_MS,
): void {
  const exited = proc.exitCode !== null || proc.signalCode !== null;
  if (!exited) signalProcess(proc, "SIGTERM");
  const escalation = setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null)
      signalProcess(proc, "SIGKILL");
  }, graceMs);
  escalation.unref();
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Truncate to a byte budget, cutting at the last complete UTF-8 char. */
function truncate(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  // subarray(0, n).toString("utf8") drops trailing partial bytes, so no
  // replacement chars / mojibake on multi-byte boundaries.
  return { text: buf.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

/** Append a chunk keeping the tail within a byte budget (diagnostics live at the end). */
function appendBounded(
  existing: string,
  chunk: string,
  maxBytes: number,
): string {
  const combined = existing + chunk;
  const buf = Buffer.from(combined, "utf8");
  if (buf.length <= maxBytes) return combined;
  return buf.subarray(buf.length - maxBytes).toString("utf8");
}

function assistantText(message: MessageLike): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (p): p is { type: "text"; text: string } =>
        !!p &&
        typeof p === "object" &&
        (p as { type?: string }).type === "text",
    )
    .map((p) => p.text)
    .join("\n");
}

function buildUserMessage(task: string, context?: string): string {
  const cleanTask = task.trim();
  if (context && context.trim()) {
    return `<context>\n${context.trim()}\n</context>\n\nTask: ${cleanTask}`;
  }
  return `Task: ${cleanTask}`;
}

async function writePromptToTempFile(
  agentName: string,
  systemPrompt: string,
): Promise<{
  dir: string;
  filePath: string;
}> {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), `piex-subagent-${agentName}-`),
  );
  const filePath = path.join(dir, "system-prompt.md");
  fs.writeFileSync(filePath, systemPrompt, { encoding: "utf-8", mode: 0o600 });
  return { dir, filePath };
}

// ─────────────────────────────────────────────────────────────────────────────
// runSingleAgent
// ─────────────────────────────────────────────────────────────────────────────

export interface RunOptions {
  cwd: string;
  agent: AgentConfig;
  task: string;
  context?: string;
  model: ResolvedModel;
  timeoutMs: number;
  signal?: AbortSignal;
  onUpdate?: (snapshot: { output: string; running: boolean }) => void;
}

export async function runSingleAgent(opts: RunOptions): Promise<SingleResult> {
  const startedAt = Date.now();
  const { cwd, agent, task, context, model, timeoutMs, signal, onUpdate } =
    opts;

  const result: SingleResult = {
    agent: agent.name,
    task,
    exitCode: 0,
    output: "",
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      totalTokens: 0,
      turns: 0,
    },
    model: model.model,
    thinkingLevel: model.thinkingLevel,
    durationMs: 0,
  };

  let latestOutput = "";
  let terminalOutput = "";
  let timedOut = false;
  let wasAborted = false;

  const emitUpdate = () => {
    const snap = truncate(
      latestOutput || terminalOutput || "",
      DEFAULT_MAX_OUTPUT_BYTES,
    );
    result.output = snap.text;
    result.truncated = result.truncated || snap.truncated;
    onUpdate?.({ output: result.output, running: true });
  };

  const setErrorMessage = (msg: string) => {
    result.error = truncate(msg, DEFAULT_MAX_OUTPUT_BYTES).text;
  };

  let tmpDir: string | undefined;
  let tmpPromptPath: string | undefined;

  try {
    if (signal?.aborted) {
      result.exitCode = 130;
      result.aborted = true;
      setErrorMessage("Subagent was aborted before start");
      return result;
    }

    const systemPrompt = agent.systemPrompt.trim();
    if (systemPrompt) {
      const tmp = await writePromptToTempFile(agent.name, systemPrompt);
      tmpDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
    }

    const args = buildPiArgs({
      model: model.model,
      thinkingLevel: model.thinkingLevel,
      tools: agent.tools,
      systemPromptPath: tmpPromptPath,
      message: buildUserMessage(task, context),
    });

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      let abortHandler: (() => void) | undefined;

      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (signal && abortHandler)
          signal.removeEventListener("abort", abortHandler);
        resolve(code);
      };

      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(invocation.command, invocation.args, {
          cwd,
          detached: process.platform !== "win32",
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            PIEX_SUBAGENT_DEPTH: String(
              (Number.parseInt(process.env.PIEX_SUBAGENT_DEPTH ?? "0", 10) ||
                0) + 1,
            ),
          },
        });
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
        finish(1);
        return;
      }

      const processEvent = (raw: unknown) => {
        if (!raw || typeof raw !== "object") return;
        const event = raw as { type?: string; message?: MessageLike };
        if (event.type === "message_end" && event.message) {
          const msg = event.message;
          const text = assistantText(msg);
          if (msg.role === "assistant") {
            const t = truncate(text, DEFAULT_MAX_OUTPUT_BYTES);
            result.truncated = result.truncated || t.truncated;
            if (t.text) latestOutput = t.text;
            if (msg.stopReason === "stop" || msg.stopReason === "length") {
              terminalOutput = t.text;
            }
            result.usage.turns++;
            const u = msg.usage;
            if (u) {
              result.usage.input += u.input || 0;
              result.usage.output += u.output || 0;
              result.usage.cacheRead += u.cacheRead || 0;
              result.usage.cacheWrite += u.cacheWrite || 0;
              result.usage.cost += u.cost?.total || 0;
              result.usage.totalTokens = u.totalTokens || 0;
            }
            if (msg.errorMessage) setErrorMessage(msg.errorMessage);
          }
          emitUpdate();
        }
      };

      const decoder = new JsonLineDecoder({
        onValue: processEvent,
        onOversized: () => {
          result.truncated = true;
        },
      });

      timeout = setTimeout(() => {
        timedOut = true;
        result.timedOut = true;
        setErrorMessage(`Subagent timed out after ${timeoutMs}ms`);
        result.stderr = appendBounded(
          result.stderr,
          `\nSubagent timed out after ${timeoutMs}ms.`,
          DEFAULT_MAX_STDERR_BYTES,
        );
        emitUpdate();
        terminateProcess(proc);
      }, timeoutMs);
      timeout.unref();

      proc.stdout?.on("data", (data: Buffer) => decoder.push(data));
      proc.stderr?.on("data", (data: Buffer) => {
        result.stderr = appendBounded(
          result.stderr,
          data.toString("utf8"),
          DEFAULT_MAX_STDERR_BYTES,
        );
      });
      proc.on("close", (code) => {
        decoder.finish();
        finish(timedOut ? 124 : wasAborted ? 130 : (code ?? 0));
      });
      proc.on("error", (error) => {
        setErrorMessage(error.message);
        finish(1);
      });

      if (signal) {
        abortHandler = () => {
          if (timedOut || settled) return;
          wasAborted = true;
          result.aborted = true;
          setErrorMessage("Subagent was aborted");
          terminateProcess(proc);
        };
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      }
    });

    result.exitCode = exitCode;
    const finalText = terminalOutput || latestOutput;
    const final = truncate(finalText, DEFAULT_MAX_OUTPUT_BYTES);
    result.output = final.text;
    result.truncated = result.truncated || final.truncated;

    // Treat non-error exits with no output as failure.
    if (result.exitCode === 0 && !result.error && !result.output.trim()) {
      result.exitCode = 1;
      setErrorMessage("Subagent completed without final text");
    }
    if (timedOut) result.timedOut = true;
    if (wasAborted) result.aborted = true;
    return result;
  } finally {
    if (tmpPromptPath) {
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {
        /* ignore */
      }
    }
    if (tmpDir) {
      try {
        fs.rmdirSync(tmpDir);
      } catch {
        /* ignore */
      }
    }
    result.durationMs = Date.now() - startedAt;
  }
}
