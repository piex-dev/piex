/**
 * dap extension — registers a `debug` tool for DAP (Debug Adapter Protocol).
 *
 *   pi install npm:@piex-dev/dap
 *   pi -e ./extensions/dap.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { DapSessionManager } from "./session";
import {
  selectLaunchAdapter,
  selectAttachAdapter,
  resolveLaunchOverrides,
  getAvailableAdapters,
} from "./config";
import type { LaunchProgramKind } from "./config";
import type {
  DapBreakpointRecord,
  DapContinueOutcome,
  DapDataBreakpointInfoResponse,
  DapDataBreakpointRecord,
  DapDisassembledInstruction,
  DapEvaluateResponse,
  DapFunctionBreakpointRecord,
  DapInstructionBreakpointRecord,
  DapModule,
  DapResolvedAdapter,
  DapScope,
  DapSessionSummary,
  DapSource,
  DapStackFrame,
  DapThread,
  DapVariable,
} from "./types";
import { isEnoent } from "./utils";

// ── Singleton ──────────────────────────────────────────────────

let _manager: DapSessionManager | null = null;
function mgr(): DapSessionManager {
  if (!_manager) _manager = new DapSessionManager();
  return _manager;
}

// ── Helpers ────────────────────────────────────────────────────

function resolveToCwd(t: string, cwd: string): string {
  return path.isAbsolute(t) ? t : path.resolve(cwd, t);
}

function formatPathRel(t: string, cwd: string): string {
  const r = path.relative(cwd, t);
  return !r.startsWith("..") && !path.isAbsolute(r) ? r : t;
}

async function classifyProgram(p: string): Promise<LaunchProgramKind> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory() ? "directory" : "file";
  } catch (e) {
    if (isEnoent(e)) return "missing";
    throw e;
  }
}

function getAdaptersList(cwd: string): string {
  return (
    getAvailableAdapters(cwd)
      .map((a) => a.name)
      .join(", ") || "none"
  );
}

function requireCap(cap: string, label: string): void {
  const caps = mgr().getCapabilities();
  if (!caps || !(caps as Record<string, unknown>)[cap])
    throw new Error(`This debug adapter does not support ${label}.`);
}

// ── Timeout ────────────────────────────────────────────────────

const T_MIN = 5,
  T_MAX = 300,
  T_DEF = 30;
function clampT(s: unknown): number {
  const n = typeof s === "number" ? s : Number(s);
  return Number.isFinite(n) && n > 0
    ? Math.max(T_MIN, Math.min(T_MAX, n))
    : T_DEF;
}

// ── Formatting ─────────────────────────────────────────────────

function fmtSession(s: DapSessionSummary): string[] {
  const l = [`Adapter: ${s.adapter}`, `Status: ${s.status}`];
  if (s.program) l.push(`Program: ${s.program}`);
  if (s.status === "stopped" && s.stopReason) {
    l.push(
      `Stop reason: ${s.stopReason}${s.stopDescription ? ` (${s.stopDescription})` : ""}`,
    );
    if (s.frameName)
      l.push(
        `Stopped at: ${[s.frameName, s.source?.path, s.line].filter(Boolean).join(":")}`,
      );
  } else if (s.status === "running") {
    l.push("Program is running.");
  } else if (s.status === "terminated") {
    if (s.exitCode !== undefined) l.push(`Exit code: ${s.exitCode}`);
  }
  if (s.breakpointCount > 0)
    l.push(`Breakpoints: ${s.breakpointCount} in ${s.breakpointFiles} files`);
  return l;
}

function fmtBps(sp: string, bps: DapBreakpointRecord[]): string {
  const l = [`Breakpoints in ${path.basename(sp)}:`];
  if (!bps.length) l.push("  (none)");
  else
    for (const bp of bps) {
      l.push(
        `  ${bp.verified ? "✓" : "✗"} L${bp.line}${bp.condition ? ` if ${bp.condition}` : ""}`,
      );
      if (!bp.verified && bp.message) l.push(`    ${bp.message}`);
    }
  return l.join("\n");
}

function fmtFnBps(bps: DapFunctionBreakpointRecord[]): string {
  const l = ["Function breakpoints:"];
  if (!bps.length) l.push("  (none)");
  else
    for (const bp of bps)
      l.push(
        `  ${bp.verified ? "✓" : "✗"} ${bp.name}${bp.condition ? ` if ${bp.condition}` : ""}`,
      );
  return l.join("\n");
}

function fmtThreads(ts: DapThread[]): string {
  return ts.length
    ? ts.map((t) => `  #${t.id} ${t.name}`).join("\n")
    : "(no threads)";
}

function fmtFrames(fs: DapStackFrame[]): string {
  return fs.length
    ? fs
        .map(
          (f, i) =>
            `  #${i} ${f.name}${f.source?.path ? ` — ${path.basename(f.source.path)}:${f.line}` : ""}`,
        )
        .join("\n")
    : "(no stack frames)";
}

function fmtScopes(sc: DapScope[]): string {
  return sc.length
    ? sc
        .map(
          (s) =>
            `  ${s.name} (ref: ${s.variablesReference}, expensive: ${s.expensive})`,
        )
        .join("\n")
    : "(no scopes)";
}

function fmtVars(vs: DapVariable[]): string {
  return vs.length
    ? vs
        .map((v) => `  ${v.name} = ${v.value}${v.type ? ` (${v.type})` : ""}`)
        .join("\n")
    : "(no variables)";
}

function fmtEval(e: DapEvaluateResponse): string {
  return [e.result, e.type ? `Type: ${e.type}` : ""].filter(Boolean).join("\n");
}

function fmtDisasm(ins: DapDisassembledInstruction[]): string {
  return ins.length
    ? ins
        .map(
          (i) =>
            `  ${i.address}: ${i.instruction}${i.symbol ? ` ; ${i.symbol}` : ""}`,
        )
        .join("\n")
    : "(no instructions)";
}

function fmtMemRead(
  addr: string,
  data: string | undefined,
  unreadable: number | undefined,
): string {
  const l = [`Address: ${addr}`];
  if (unreadable) l.push(`Unreadable bytes: ${unreadable}`);
  if (data) l.push(`Data: ${data}`);
  return l.join("\n");
}

function fmtModules(ms: DapModule[]): string {
  return ms.length
    ? ms.map((m) => `  ${m.name} (${m.id})`).join("\n")
    : "(no modules)";
}

function fmtSources(ss: DapSource[]): string {
  return ss.length
    ? ss.map((s) => `  ${s.path ?? s.name ?? "(unnamed)"}`).join("\n")
    : "(no sources)";
}

function fmtSessions(ss: DapSessionSummary[]): string {
  return ss.length
    ? ss
        .map(
          (s) =>
            `  [${s.id}] ${s.adapter} - ${s.status}${s.program ? ` - ${s.program}` : ""}`,
        )
        .join("\n")
    : "No debug sessions.";
}

function outcomeText(o: DapContinueOutcome, t: number, label: string): string {
  return [
    `${label} result: ${o.state}`,
    o.timedOut ? `(timed out after ${t}s)` : "",
    ...fmtSession(o.snapshot),
  ].join("\n");
}

// ── Extension ──────────────────────────────────────────────────

export default function dapExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "debug",
    label: "Debug (DAP)",
    description: `Debug a program using the Debug Adapter Protocol (DAP).

Supports debug adapters: gdb, lldb-dap, codelldb, debugpy (Python), dlv (Go),
js-debug-adapter (JS/TS), netcoredbg (C#), kotlin-debug-adapter, rdbg (Ruby),
php-debug-adapter, bash-debug-adapter, dart-debug-adapter, flutter-debug-adapter,
elixir-ls-debugger.

Actions: launch, attach, set_breakpoint, remove_breakpoint, continue, step_over,
step_in, step_out, pause, evaluate, stack_trace, threads, scopes, variables, output,
terminate, sessions, disassemble, read_memory, write_memory, modules, loaded_sources,
custom_request`,

    parameters: Type.Object({
      action: Type.String({ description: "Debug action to perform" }),
      program: Type.Optional(
        Type.String({ description: "Path to program or script (for launch)" }),
      ),
      args: Type.Optional(
        Type.Array(Type.String(), { description: "Command-line arguments" }),
      ),
      cwd: Type.Optional(
        Type.String({
          description: "Working directory (defaults to project root)",
        }),
      ),
      adapter: Type.Optional(
        Type.String({
          description: "Debug adapter name (auto-selected if omitted)",
        }),
      ),
      pid: Type.Optional(
        Type.Number({ description: "Process ID to attach to" }),
      ),
      port: Type.Optional(Type.Number({ description: "Port to attach to" })),
      host: Type.Optional(
        Type.String({
          description: "Host for TCP attach (default: localhost)",
        }),
      ),
      file: Type.Optional(
        Type.String({ description: "Source file for breakpoints" }),
      ),
      line: Type.Optional(
        Type.Number({ description: "Line number for breakpoints" }),
      ),
      function: Type.Optional(
        Type.String({ description: "Function name for function breakpoints" }),
      ),
      condition: Type.Optional(
        Type.String({ description: "Conditional expression for breakpoints" }),
      ),
      expression: Type.Optional(
        Type.String({ description: "Expression to evaluate" }),
      ),
      context: Type.Optional(
        Type.String({
          description:
            "Evaluation context (repl, watch, hover, clipboard, variables)",
        }),
      ),
      frame_id: Type.Optional(Type.Number({ description: "Stack frame ID" })),
      levels: Type.Optional(
        Type.Number({ description: "Number of stack frames" }),
      ),
      variable_ref: Type.Optional(
        Type.Number({ description: "Variable reference for child variables" }),
      ),
      scope_id: Type.Optional(
        Type.Number({ description: "Scope reference for variables" }),
      ),
      instruction_reference: Type.Optional(
        Type.String({ description: "Instruction pointer reference" }),
      ),
      offset: Type.Optional(Type.Number({ description: "Byte offset" })),
      instruction_count: Type.Optional(
        Type.Number({ description: "Number of instructions" }),
      ),
      resolve_symbols: Type.Optional(
        Type.Boolean({ description: "Resolve symbols in disassembly" }),
      ),
      memory_reference: Type.Optional(
        Type.String({ description: "Memory reference" }),
      ),
      count: Type.Optional(
        Type.Number({ description: "Byte count for memory read" }),
      ),
      data: Type.Optional(
        Type.String({
          description:
            "Data to write (base64 for memory, string for expressions)",
        }),
      ),
      name: Type.Optional(
        Type.String({ description: "Variable name for data breakpoint info" }),
      ),
      data_id: Type.Optional(
        Type.String({ description: "Data ID for data breakpoints" }),
      ),
      access_type: Type.Optional(
        Type.String({ description: "Access type: read, write, or readWrite" }),
      ),
      command: Type.Optional(
        Type.String({ description: "Custom DAP command name" }),
      ),
      arguments: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Custom DAP command arguments",
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          default: 30,
          description: "Timeout in seconds (default: 30)",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const timeout = clampT(params.timeout);
      const timeoutMs = timeout * 1000;
      const signal = AbortSignal.timeout(timeoutMs);
      const cwd =
        typeof params.cwd === "string" && params.cwd
          ? resolveToCwd(params.cwd, ctx.cwd)
          : ctx.cwd;
      const action = String(params.action ?? "").trim();

      switch (action) {
        // ── Session management ─────────────────────────
        case "launch": {
          const program =
            typeof params.program === "string" && params.program
              ? params.program
              : "";
          if (!program) throw new Error("'program' is required for launch.");
          const absProgram = resolveToCwd(program, cwd);
          const kind = await classifyProgram(absProgram);
          const adapter = selectLaunchAdapter(
            absProgram,
            cwd,
            typeof params.adapter === "string" ? params.adapter : undefined,
            kind,
          );
          if (!adapter) {
            if (params.adapter === "debugpy")
              throw new Error(
                "Adapter 'debugpy' is not available. Install it with: pip install debugpy",
              );
            throw new Error(
              `No debug adapter available. Installed: ${getAdaptersList(cwd)}`,
            );
          }
          const extra = resolveLaunchOverrides(adapter, absProgram, kind);
          const args = Array.isArray(params.args)
            ? (params.args as string[])
            : undefined;
          const snap = await mgr().launch(
            {
              adapter,
              program: absProgram,
              args,
              cwd,
              extraLaunchArguments: extra,
            },
            signal,
            timeoutMs,
          );
          return {
            content: [{ type: "text", text: fmtSession(snap).join("\n") }],
            details: {},
          };
        }
        case "attach": {
          const pid = typeof params.pid === "number" ? params.pid : undefined;
          const port =
            typeof params.port === "number" ? params.port : undefined;
          if (pid === undefined && port === undefined)
            throw new Error("'pid' or 'port' is required for attach.");
          const adapter = selectAttachAdapter(
            cwd,
            typeof params.adapter === "string" ? params.adapter : undefined,
            port,
          );
          if (!adapter)
            throw new Error(
              `No debug adapter available. Installed: ${getAdaptersList(cwd)}`,
            );
          const snap = await mgr().attach(
            {
              adapter,
              cwd,
              pid,
              port,
              host: typeof params.host === "string" ? params.host : undefined,
            },
            signal,
            timeoutMs,
          );
          return {
            content: [{ type: "text", text: fmtSession(snap).join("\n") }],
            details: {},
          };
        }
        case "terminate": {
          const snap = await mgr().terminate(signal, timeoutMs);
          if (!snap)
            return {
              content: [
                { type: "text", text: "No debug session to terminate." },
              ],
              details: {},
            };
          return {
            content: [
              {
                type: "text",
                text: [...fmtSession(snap), "Debug session terminated."].join(
                  "\n",
                ),
              },
            ],
            details: {},
          };
        }
        case "sessions": {
          return {
            content: [
              { type: "text", text: fmtSessions(mgr().listSessions()) },
            ],
            details: {},
          };
        }
        case "output": {
          const { snapshot, output } = mgr().getOutput();
          const hdr = fmtSession(snapshot).join("\n");
          return {
            content: [
              {
                type: "text",
                text: output.length
                  ? `${hdr}\n--- output ---\n${output}`
                  : `${hdr}\n(no output captured)`,
              },
            ],
            details: {},
          };
        }

        // ── Breakpoints ───────────────────────────────
        case "set_breakpoint": {
          if (typeof params.function === "string" && params.function) {
            const r = await mgr().setFunctionBreakpoint(
              params.function,
              typeof params.condition === "string"
                ? params.condition
                : undefined,
              signal,
              timeoutMs,
            );
            return {
              content: [{ type: "text", text: fmtFnBps(r.breakpoints) }],
              details: {},
            };
          }
          if (
            typeof params.file !== "string" ||
            typeof params.line !== "number"
          )
            throw new Error("'file' and 'line' required.");
          const r = await mgr().setBreakpoint(
            resolveToCwd(params.file, cwd),
            params.line,
            typeof params.condition === "string" ? params.condition : undefined,
            signal,
            timeoutMs,
          );
          return {
            content: [
              { type: "text", text: fmtBps(r.sourcePath, r.breakpoints) },
            ],
            details: {},
          };
        }
        case "remove_breakpoint": {
          if (typeof params.function === "string" && params.function) {
            const r = await mgr().removeFunctionBreakpoint(
              params.function,
              signal,
              timeoutMs,
            );
            return {
              content: [{ type: "text", text: fmtFnBps(r.breakpoints) }],
              details: {},
            };
          }
          if (
            typeof params.file !== "string" ||
            typeof params.line !== "number"
          )
            throw new Error("'file' and 'line' required.");
          const r = await mgr().removeBreakpoint(
            resolveToCwd(params.file, cwd),
            params.line,
            signal,
            timeoutMs,
          );
          return {
            content: [
              { type: "text", text: fmtBps(r.sourcePath, r.breakpoints) },
            ],
            details: {},
          };
        }

        // ── Execution control ─────────────────────────
        case "continue": {
          const o = await mgr().continue(signal, timeoutMs);
          return {
            content: [
              { type: "text", text: outcomeText(o, timeout, "Continue") },
            ],
            details: {},
          };
        }
        case "step_over": {
          const o = await mgr().stepOver(signal, timeoutMs);
          return {
            content: [
              { type: "text", text: outcomeText(o, timeout, "Step over") },
            ],
            details: {},
          };
        }
        case "step_in": {
          const o = await mgr().stepIn(signal, timeoutMs);
          return {
            content: [
              { type: "text", text: outcomeText(o, timeout, "Step in") },
            ],
            details: {},
          };
        }
        case "step_out": {
          const o = await mgr().stepOut(signal, timeoutMs);
          return {
            content: [
              { type: "text", text: outcomeText(o, timeout, "Step out") },
            ],
            details: {},
          };
        }
        case "pause": {
          const snap = await mgr().pause(signal, timeoutMs);
          return {
            content: [
              {
                type: "text",
                text: [...fmtSession(snap), "Program paused."].join("\n"),
              },
            ],
            details: {},
          };
        }

        // ── State inspection ──────────────────────────
        case "evaluate": {
          if (typeof params.expression !== "string" || !params.expression)
            throw new Error("'expression' required.");
          const evalCtx = (
            typeof params.context === "string" ? params.context : "repl"
          ) as "watch" | "repl" | "hover" | "clipboard" | "variables";
          const r = await mgr().evaluate(
            params.expression,
            evalCtx,
            typeof params.frame_id === "number" ? params.frame_id : undefined,
            signal,
            timeoutMs,
          );
          return {
            content: [{ type: "text", text: fmtEval(r.evaluation) }],
            details: {},
          };
        }
        case "stack_trace": {
          const r = await mgr().stackTrace(
            typeof params.levels === "number" ? params.levels : undefined,
            signal,
            timeoutMs,
          );
          return {
            content: [
              {
                type: "text",
                text: `${fmtSession(r.snapshot).join("\n")}\n${fmtFrames(r.stackFrames)}`,
              },
            ],
            details: {},
          };
        }
        case "threads": {
          const r = await mgr().threads(signal, timeoutMs);
          return {
            content: [{ type: "text", text: fmtThreads(r.threads) }],
            details: {},
          };
        }
        case "scopes": {
          const r = await mgr().scopes(
            typeof params.frame_id === "number" ? params.frame_id : undefined,
            signal,
            timeoutMs,
          );
          return {
            content: [{ type: "text", text: fmtScopes(r.scopes) }],
            details: {},
          };
        }
        case "variables": {
          const ref =
            typeof params.variable_ref === "number"
              ? params.variable_ref
              : typeof params.scope_id === "number"
                ? params.scope_id
                : undefined;
          if (ref === undefined)
            throw new Error("'variable_ref' or 'scope_id' required.");
          const r = await mgr().variables(ref, signal, timeoutMs);
          return {
            content: [{ type: "text", text: fmtVars(r.variables) }],
            details: {},
          };
        }

        // ── Memory & disassembly ──────────────────────
        case "disassemble": {
          requireCap("supportsDisassembleRequest", "disassembly");
          if (typeof params.instruction_count !== "number")
            throw new Error("'instruction_count' required.");
          const mref =
            typeof params.memory_reference === "string"
              ? params.memory_reference
              : (mgr().getActiveSession()?.instructionPointerReference ?? "");
          const r = await mgr().disassemble(
            mref,
            params.instruction_count,
            typeof params.offset === "number" ? params.offset : undefined,
            undefined,
            params.resolve_symbols,
            signal,
            timeoutMs,
          );
          return {
            content: [{ type: "text", text: fmtDisasm(r.instructions) }],
            details: {},
          };
        }
        case "read_memory": {
          requireCap("supportsReadMemoryRequest", "memory reads");
          if (
            typeof params.memory_reference !== "string" ||
            typeof params.count !== "number"
          )
            throw new Error("'memory_reference' and 'count' required.");
          const r = await mgr().readMemory(
            params.memory_reference,
            params.count,
            typeof params.offset === "number" ? params.offset : undefined,
            signal,
            timeoutMs,
          );
          return {
            content: [
              {
                type: "text",
                text: fmtMemRead(r.address, r.data, r.unreadableBytes),
              },
            ],
            details: {},
          };
        }
        case "write_memory": {
          requireCap("supportsWriteMemoryRequest", "memory writes");
          if (
            typeof params.memory_reference !== "string" ||
            typeof params.data !== "string"
          )
            throw new Error(
              "'memory_reference' and 'data' required (data is base64-encoded bytes).",
            );
          const r = await mgr().writeMemory(
            params.memory_reference,
            params.data,
            typeof params.offset === "number" ? params.offset : undefined,
            undefined,
            signal,
            timeoutMs,
          );
          const bytesStr =
            r.bytesWritten !== undefined ? `${r.bytesWritten} bytes` : "";
          const offStr = r.offset !== undefined ? ` at offset ${r.offset}` : "";
          return {
            content: [
              {
                type: "text",
                text: `Wrote ${bytesStr}${offStr} to ${params.memory_reference}`,
              },
            ],
            details: {},
          };
        }
        case "custom_request": {
          if (typeof params.command !== "string" || !params.command)
            throw new Error("'command' required for custom_request.");
          const args = params.arguments as Record<string, unknown> | undefined;
          const r = await mgr().customRequest(
            params.command,
            args,
            signal,
            timeoutMs,
          );
          return {
            content: [{ type: "text", text: JSON.stringify(r, null, 2) }],
            details: {},
          };
        }

        // ── Introspection ─────────────────────────────
        case "modules": {
          requireCap("supportsModulesRequest", "module introspection");
          const r = await mgr().modules(
            undefined,
            undefined,
            signal,
            timeoutMs,
          );
          return {
            content: [{ type: "text", text: fmtModules(r.modules) }],
            details: {},
          };
        }
        case "loaded_sources": {
          requireCap("supportsLoadedSourcesRequest", "loaded sources");
          const r = await mgr().loadedSources(signal, timeoutMs);
          return {
            content: [{ type: "text", text: fmtSources(r.sources) }],
            details: {},
          };
        }

        default:
          throw new Error(
            `Unsupported debug action: ${action}. Supported: launch, attach, set_breakpoint, remove_breakpoint, continue, step_over, step_in, step_out, pause, evaluate, stack_trace, threads, scopes, variables, output, terminate, sessions, disassemble, read_memory, write_memory, modules, loaded_sources, custom_request`,
          );
      }
    },
  });

  // ── Cleanup on session shutdown ────────────────────
  pi.on("session_shutdown", async () => {
    try {
      await mgr().terminate(undefined, 5_000);
    } catch {
      /* best effort */
    }
    mgr().dispose();
    _manager = null;
  });
}
