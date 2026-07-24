import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ResolvedModel,
  SingleResult,
  SubagentDetails,
  SubagentParams,
  ThinkingLevel,
} from "./types.js";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_CONCURRENCY,
  MAX_PARALLEL_TASKS,
  STATUS_KEY,
} from "./types.js";
import {
  resolveAgent,
  resolveModel,
  readSettings,
  loadAgents,
} from "./agents.js";
import { runSingleAgent } from "./subprocess.js";

// ─────────────────────────────────────────────────────────────────────────────
// Depth guard
// ─────────────────────────────────────────────────────────────────────────────

export function assertSubagentDepthAllowed(): void {
  const depth =
    Number.parseInt(process.env.PIEX_SUBAGENT_DEPTH ?? "0", 10) || 0;
  const settings = readSettings();
  const maxDepth = settings.maxDepth ?? 1;
  if (depth >= maxDepth) {
    throw new Error(`Subagent recursion depth limit reached (${maxDepth})`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parent model extraction (true inherit)
// ─────────────────────────────────────────────────────────────────────────────

function modelId(model: Model<Api> | undefined): string | undefined {
  if (!model) return undefined;
  // Prefer provider/id form so --model resolves unambiguously.
  if (model.provider && model.id) return `${model.provider}/${model.id}`;
  return model.id;
}

function resolveParentThinking(
  ctx: ExtensionContext,
): ThinkingLevel | undefined {
  // ExtensionContext does not expose the current thinking level directly.
  // ExtensionContext exposes the current model (ctx.model) but NOT the
  // current thinking level. We do a best-effort scan of the effective
  // system prompt for a thinking marker; if absent, thinking inherit is
  // a no-op and the child falls back to its own default. This is an
  // acknowledged limitation of the MVP (see docs/packages/subagent.md):
  // model inherit works reliably; thinking inherit is best-effort only.
  const prompt = ctx.getSystemPrompt?.() ?? "";
  const match = prompt.match(
    /thinking[:\s]+(off|minimal|low|medium|high|xhigh|max)/i,
  );
  if (match) return match[1].toLowerCase() as ThinkingLevel;
  return undefined;
}

function resolveForAgent(
  agent: ReturnType<typeof resolveAgent>,
  ctx: ExtensionContext,
  paramsThinking?: ThinkingLevel,
): ResolvedModel {
  const settings = readSettings();
  const parentModel = modelId(ctx.model);
  const parentThinking = resolveParentThinking(ctx);
  const resolved = resolveModel(agent, settings, parentModel, parentThinking);
  // Per-call thinking override wins.
  if (paramsThinking) resolved.thinkingLevel = paramsThinking;
  return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status management
// ─────────────────────────────────────────────────────────────────────────────

const activeStatuses = new Map<string, string>();

function publishStatus(ctx: ExtensionContext): void {
  const values = [...activeStatuses.values()];
  if (values.length === 0) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  const suffix = values.length > 1 ? ` +${values.length - 1}` : "";
  ctx.ui.setStatus(STATUS_KEY, `${values[0]}${suffix}`);
}

function withStatus<T>(
  ctx: ExtensionContext,
  id: string,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  activeStatuses.set(id, label);
  publishStatus(ctx);
  return fn().finally(() => {
    activeStatuses.delete(id);
    publishStatus(ctx);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency limiter
// ─────────────────────────────────────────────────────────────────────────────

async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const i = cursor++;
        results[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Result shaping
// ─────────────────────────────────────────────────────────────────────────────

function isResultError(r: SingleResult): boolean {
  return (
    r.exitCode !== 0 || r.timedOut === true || r.aborted === true || !!r.error
  );
}

function toToolResult(
  mode: "single" | "parallel",
  results: SingleResult[],
): AgentToolResult<SubagentDetails> & { isError?: boolean } {
  const isError = results.some(isResultError);
  const text = results
    .map((r) => {
      const head = `[${r.agent}] ${r.task}`;
      const status = r.exitCode === 0 ? "ok" : `exit ${r.exitCode}`;
      const body = r.output || r.error || "(no output)";
      return `${head}\nstatus: ${status}\n${body}`;
    })
    .join("\n\n---\n\n");
  return {
    content: [{ type: "text", text }],
    details: { mode, results, isError: isError || undefined },
  };
}

function emitDetails(
  results: SingleResult[],
  mode: "single" | "parallel",
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
): void {
  onUpdate?.({
    content: [
      {
        type: "text",
        text: results
          .map((r) => `[${r.agent}] ${r.output || r.error || "..."}`)
          .join("\n"),
      },
    ],
    details: { mode, results },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// executeSubagent
// ─────────────────────────────────────────────────────────────────────────────

export async function executeSubagent(
  toolCallId: string,
  params: SubagentParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<SubagentDetails> & { isError?: boolean }> {
  assertSubagentDepthAllowed();
  const settings = readSettings();

  const hasSingle = Boolean(params.agent && params.task);
  const hasTasks = Boolean(params.tasks?.length);

  if (hasSingle === hasTasks) {
    throw new Error(
      "subagent requires either {agent, task} (single) or {tasks:[]} (parallel), not both/neither.",
    );
  }

  // ── single ──────────────────────────────────────────────────────────────
  if (hasSingle && params.agent && params.task) {
    const agent = resolveAgent(params.agent);
    const resolved = resolveForAgent(agent, ctx, params.thinkingLevel);
    const timeoutMs =
      params.timeoutMs ??
      agent.timeoutMs ??
      settings.timeoutMs ??
      DEFAULT_TIMEOUT_MS;

    const result = await withStatus(ctx, toolCallId, agent.name, () =>
      runSingleAgent({
        cwd: ctx.cwd,
        agent,
        task: params.task as string,
        context: params.context,
        model: resolved,
        timeoutMs,
        signal,
        onUpdate: (snap) =>
          onUpdate?.({
            content: [
              { type: "text", text: `[${agent.name}] ${snap.output || "..."}` },
            ],
            details: { mode: "single", results: [] },
          }),
      }),
    );
    emitDetails([result], "single", onUpdate);
    return toToolResult("single", [result]);
  }

  // ── parallel ────────────────────────────────────────────────────────────
  const tasks = params.tasks ?? [];
  if (tasks.length > MAX_PARALLEL_TASKS) {
    throw new Error(
      `Too many parallel tasks: ${tasks.length} (max ${MAX_PARALLEL_TASKS})`,
    );
  }

  const results = await mapWithConcurrencyLimit(
    tasks,
    MAX_CONCURRENCY,
    async (item, index) => {
      const agent = resolveAgent(item.agent);
      const resolved = resolveForAgent(
        agent,
        ctx,
        item.thinkingLevel ?? params.thinkingLevel,
      );
      const timeoutMs =
        item.timeoutMs ??
        params.timeoutMs ??
        agent.timeoutMs ??
        settings.timeoutMs ??
        DEFAULT_TIMEOUT_MS;
      return withStatus(ctx, `${toolCallId}-${index}`, agent.name, () =>
        runSingleAgent({
          cwd: ctx.cwd,
          agent,
          task: item.task,
          context: item.context,
          model: resolved,
          timeoutMs,
          signal,
        }),
      );
    },
  );
  emitDetails(results, "parallel", onUpdate);
  return toToolResult("parallel", results);
}

// Re-export for the /subagents command.
export { loadAgents };
