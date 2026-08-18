/**
 * ttft extension — per-turn TTFT / decode throughput and session cache-hit
 * rate in the pi status bar.
 *
 *   pi install npm:@piex-dev/ttft
 *   pi -e ./src/ttft.ts
 *
 * Shows one status segment:
 *
 *   TTFT 1.2s · 45.3t/s
 *
 * Metrics:
 *   - TTFT (time to first token): turn_start.timestamp → first message_update
 *   - tokens/s: decode wall time (first token → last update) over usage.output
 *   - cache hit rate (session cumulative, deepseek-harness semantics):
 *     cacheRead / (input + cacheRead + cacheWrite), shown in /ttft detail
 *     (the status bar stays off cache: pi's built-in footer already shows
 *     the latest turn's CH%)
 *
 * Each settled turn is persisted with pi.appendEntry("ttft", …) and rebuilt
 * from session entries on session_start, so /resume keeps the history.
 *
 * The TTFT anchor is turn_start, which pi emits before the request is
 * assembled — so this measures end-to-end first-token latency (including
 * prompt assembly), the same step-level semantics deepseek-harness uses.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "ttft";
const CUSTOM_TYPE = "ttft";

/** The four disjoint token buckets, mirrors pi's UsageTotals convention. */
export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One settled turn's derived metrics, persisted as a custom session entry. */
export interface TurnRecord {
  turn: number;
  /** First-step TTFT in ms; absent when the turn never streamed a token. */
  ttftMs?: number;
  /** Decode throughput over the sampled stream; absent without timing + output. */
  tokensPerSecond?: number;
  outputTokens?: number;
  /** This turn's own cache hit rate (0-100); absent before prompt tokens are billed. */
  cacheRatePercent?: number;
  /** True when t/s was suppressed: the delivery was too bursty to be a real decode. */
  bufferedDelivery?: true;
}

interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface ThemeLike {
  fg(name: string, text: string): string;
}

interface UiLike {
  setStatus(key: string, text: string | undefined): void;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  theme: ThemeLike;
}

interface SessionManagerLike {
  getSessionId(): string;
  getEntries(): Array<Record<string, unknown>>;
}

interface CtxLike {
  ui: UiLike;
  sessionManager: SessionManagerLike;
}

interface PiLike {
  on(
    event: string,
    handler: (event: Record<string, unknown>, ctx: CtxLike) => unknown,
  ): void;
  registerCommand(
    name: string,
    def: {
      description: string;
      handler: (args: string, ctx: CtxLike) => unknown;
    },
  ): void;
  appendEntry<T>(customType: string, data?: T): void;
}

interface ActiveTurn {
  turn: number;
  startTs: number;
  firstTokenTs: number | null;
  lastUpdateTs: number | null;
  /** Usage attached when the assistant message finalizes (message_end), which fires before tools run. */
  finalUsage: UsageLike | null;
}

/**
 * Decode-time floor for throughput sampling. Below this, delivery bursts
 * (buffering gateways replay the whole stream in a few ms) make tokens/s
 * meaningless — e.g. 1252 tokens in 97ms "= 12,907 t/s" is noise, not signal.
 */
export const MIN_DECODE_MS = 200;

/**
 * Decode samples only count when the delivery is continuous enough to be
 * meaningful. Two guards:
 *  - absolute floor (MIN_DECODE_MS): an entire response replayed in <200ms
 *    is gateway buffering, not decoding;
 *  - relative guard: the delivery must span at least half the first-token
 *    latency. A buffering gateway flushes its cache in a fraction of the
 *    TTFT it took to fill it (e.g. TTFT 22s, then 1000 tokens in 0.9s =
 *    "1147 t/s"), which reads as impossible decode speed.
 */
export function isBufferedDelivery(
  decodeMs: number,
  ttftMs: number | undefined,
): boolean {
  return decodeMs < Math.max(MIN_DECODE_MS, (ttftMs ?? 0) / 2);
}

// ══════════════════════════════════════════════════════════════════════════
// Pure metric logic (unit-tested)
// ══════════════════════════════════════════════════════════════════════════

export function createTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** Fold one call's usage into totals; missing buckets count as zero. */
export function addUsage(
  totals: TokenTotals,
  usage: UsageLike | undefined | null,
): void {
  if (!usage) return;
  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.cacheRead += usage.cacheRead ?? 0;
  totals.cacheWrite += usage.cacheWrite ?? 0;
}

/**
 * Session cache hit rate, deepseek-harness semantics: the share of billed
 * prompt tokens served from cache. Undefined before any prompt is billed.
 */
export function cacheHitPercent(totals: TokenTotals): number | undefined {
  const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
  if (prompt <= 0) return undefined;
  return Math.round((totals.cacheRead / prompt) * 100);
}

/** One turn's own hit rate from its usage; undefined before prompt is billed. */
export function turnCacheRate(
  usage: UsageLike | undefined | null,
): number | undefined {
  if (!usage) return undefined;
  return cacheHitPercent({
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
  });
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

export function formatRate(tokensPerSecond: number): string {
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return "—";
  if (tokensPerSecond >= 100) return `${Math.round(tokensPerSecond)}`;
  if (tokensPerSecond < 0.05) return "<0.1"; // 1 token over a minute-long decode
  return tokensPerSecond.toFixed(1);
}

/**
 * Derive one settled turn's record from its timing and provider usage.
 * Returns undefined when neither TTFT nor throughput can be sampled —
 * a turn with no recorded timing carries nothing worth showing.
 */
export function deriveTurnRecord(
  turn: ActiveTurn,
  usage: UsageLike | undefined | null,
): TurnRecord | undefined {
  const record: TurnRecord = { turn: turn.turn };
  if (turn.firstTokenTs !== null) {
    record.ttftMs = Math.max(0, turn.firstTokenTs - turn.startTs);
  }
  const outputTokens = usage?.output;
  if (
    typeof outputTokens === "number" &&
    Number.isFinite(outputTokens) &&
    outputTokens >= 0
  ) {
    record.outputTokens = outputTokens;
  }
  if (
    turn.firstTokenTs !== null &&
    turn.lastUpdateTs !== null &&
    typeof outputTokens === "number" &&
    Number.isFinite(outputTokens) &&
    outputTokens >= 0
  ) {
    const decodeMs = Math.max(0, turn.lastUpdateTs - turn.firstTokenTs);
    if (isBufferedDelivery(decodeMs, record.ttftMs)) {
      record.bufferedDelivery = true;
    } else {
      record.tokensPerSecond = outputTokens / (decodeMs / 1000);
    }
  }
  const rate = turnCacheRate(usage);
  if (rate !== undefined) record.cacheRatePercent = rate;
  if (record.ttftMs === undefined && record.tokensPerSecond === undefined)
    return undefined;
  return record;
}

// ══════════════════════════════════════════════════════════════════════════
// Extension state (per active session; rebuilt on session_start)
// ══════════════════════════════════════════════════════════════════════════

let activeSessionId: string | null = null;
let activeTurn: ActiveTurn | null = null;
let nextTurn = 1;
let turns: TurnRecord[] = [];
let totals: TokenTotals = createTotals();
let nowFn: () => number = Date.now;

/**
 * Rebuild session state from persisted entries.
 *
 * Turn timing comes only from "ttft" custom entries; token totals come only
 * from assistant/toolResult message usage and summary usage, mirroring pi's
 * built-in footer — the two sources never overlap, so rebuilding cannot
 * double-count.
 */
export function rebuildFromEntries(entries: Array<Record<string, unknown>>): {
  turns: TurnRecord[];
  totals: TokenTotals;
} {
  const rebuiltTurns: TurnRecord[] = [];
  const rebuiltTotals = createTotals();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
      const data = entry.data as TurnRecord | undefined;
      if (data && typeof data.turn === "number") rebuiltTurns.push(data);
      continue;
    }
    if (entry.type === "message") {
      const message = entry.message as
        { role?: string; usage?: UsageLike } | undefined;
      // Assistant messages carry the LLM usage; tool results can carry their
      // own usage (custom tools report it) and pi's built-in footer folds
      // both — mirror that so /ttft totals never diverge from the footer.
      if (message?.role === "assistant" || message?.role === "toolResult") {
        addUsage(rebuiltTotals, message.usage);
      }
      continue;
    }
    if (entry.type === "branch_summary" || entry.type === "compaction") {
      addUsage(rebuiltTotals, (entry as { usage?: UsageLike }).usage);
    }
  }
  return { turns: rebuiltTurns, totals: rebuiltTotals };
}

// ══════════════════════════════════════════════════════════════════════════
// Status bar rendering
// ══════════════════════════════════════════════════════════════════════════

/** Exact throughput for an in-flight turn whose usage has already arrived
 * (message_end fires before tools run); undefined while still streaming or
 * when the decode sample is too short to be meaningful. */
export function liveThroughput(turn: ActiveTurn): number | undefined {
  const usage = turn.finalUsage;
  if (!usage || turn.firstTokenTs === null || turn.lastUpdateTs === null)
    return undefined;
  const outputTokens = usage.output;
  if (typeof outputTokens !== "number" || !Number.isFinite(outputTokens))
    return undefined;
  const decodeMs = Math.max(0, turn.lastUpdateTs - turn.firstTokenTs);
  const ttftMs = Math.max(0, turn.firstTokenTs - turn.startTs);
  if (isBufferedDelivery(decodeMs, ttftMs)) return undefined;
  return outputTokens / (decodeMs / 1000);
}

function renderStatus(theme: ThemeLike): string | undefined {
  const parts: string[] = [];
  // An in-flight turn whose first token has arrived is the freshest reading;
  // it shows TTFT plus the exact t/s as soon as message_end delivers usage
  // (before tools run), so the bar is not stuck at TTFT-only for the whole
  // tool-execution phase.
  // Cache stats deliberately stay off the bar: pi's built-in footer already
  // shows the latest turn's CH%, and a second cache number would collide.
  // The session-cumulative rate lives in the /ttft detail instead.
  const live:
    { ttftMs: number; tokensPerSecond?: number } | TurnRecord | undefined =
    activeTurn !== null && activeTurn.firstTokenTs !== null
      ? {
          ttftMs: Math.max(0, activeTurn.firstTokenTs - activeTurn.startTs),
          tokensPerSecond: liveThroughput(activeTurn),
        }
      : turns.length > 0
        ? turns[turns.length - 1]
        : undefined;
  if (live?.ttftMs !== undefined)
    parts.push(`TTFT ${formatDuration(live.ttftMs)}`);
  if (live?.tokensPerSecond !== undefined) {
    parts.push(`${formatRate(live.tokensPerSecond)}t/s`);
  }
  if (parts.length === 0) return undefined;
  return theme.fg("dim", parts.join(" · "));
}

function paintStatus(ctx: CtxLike): void {
  ctx.ui.setStatus(STATUS_KEY, renderStatus(ctx.ui.theme));
}

// ══════════════════════════════════════════════════════════════════════════
// Detail report
// ══════════════════════════════════════════════════════════════════════════

function detailMessage(): string {
  const lines: string[] = [];
  if (turns.length === 0) {
    lines.push("ttft: no turns recorded yet");
    return lines.join("\n");
  }
  const sampled = turns.filter((t) => t.ttftMs !== undefined);
  const avgTtft =
    sampled.length > 0
      ? sampled.reduce((sum, t) => sum + (t.ttftMs ?? 0), 0) / sampled.length
      : undefined;
  const head =
    avgTtft !== undefined
      ? `avg TTFT ${formatDuration(avgTtft)} over ${sampled.length} turn${sampled.length === 1 ? "" : "s"}`
      : `${turns.length} turn${turns.length === 1 ? "" : "s"} (no TTFT sampled)`;
  const rate = cacheHitPercent(totals);
  lines.push(
    `${head} · ↑${totals.input} ↓${totals.output}` +
      ` R${totals.cacheRead} W${totals.cacheWrite}` +
      (rate !== undefined ? ` · cache ${rate}%` : ""),
  );
  for (const t of turns) {
    const parts = [`#${t.turn}`];
    if (t.ttftMs !== undefined) parts.push(formatDuration(t.ttftMs));
    if (t.tokensPerSecond !== undefined)
      parts.push(`${formatRate(t.tokensPerSecond)}t/s`);
    if (t.bufferedDelivery) parts.push("buffered");
    if (t.outputTokens !== undefined) parts.push(`↓${t.outputTokens}`);
    if (t.cacheRatePercent !== undefined)
      parts.push(`cache ${t.cacheRatePercent}%`);
    lines.push(parts.join("  "));
  }
  return lines.join("\n");
}

// ══════════════════════════════════════════════════════════════════════════
// Extension entry
// ══════════════════════════════════════════════════════════════════════════

export default function ttftExtension(pi: ExtensionAPI): void {
  const p = pi as unknown as PiLike;

  const activateFor = (ctx: CtxLike): void => {
    const sessionId = ctx.sessionManager.getSessionId();
    activeSessionId = sessionId;
    activeTurn = null;
    nextTurn = 1;
    const rebuilt = rebuildFromEntries(ctx.sessionManager.getEntries());
    turns = rebuilt.turns;
    totals = rebuilt.totals;
    for (const record of turns) nextTurn = Math.max(nextTurn, record.turn + 1);
    paintStatus(ctx);
  };

  p.on("session_start", async (_event, ctx) => {
    activateFor(ctx);
  });

  p.on("turn_start", async (event, ctx) => {
    if (ctx.sessionManager.getSessionId() !== activeSessionId) activateFor(ctx);
    const timestamp = event.timestamp;
    activeTurn = {
      turn: nextTurn,
      startTs: typeof timestamp === "number" ? timestamp : nowFn(),
      firstTokenTs: null,
      lastUpdateTs: null,
      finalUsage: null,
    };
  });

  p.on("message_update", async (event, ctx) => {
    if (ctx.sessionManager.getSessionId() !== activeSessionId) return;
    if (!activeTurn) return;
    const message = event.message as { role?: string } | undefined;
    if (message?.role !== "assistant") return;
    const now = nowFn();
    if (activeTurn.firstTokenTs === null) {
      // First streamed token: TTFT is now fixed for this turn — paint it
      // immediately and leave it alone (no per-token repaints).
      activeTurn.firstTokenTs = now;
      paintStatus(ctx);
    }
    activeTurn.lastUpdateTs = now;
  });

  p.on("message_end", async (event, ctx) => {
    if (ctx.sessionManager.getSessionId() !== activeSessionId) return;
    if (!activeTurn) return;
    const message = event.message as
      { role?: string; usage?: UsageLike } | undefined;
    if (message?.role !== "assistant") return;
    // message_end fires the moment the stream completes, before tools run:
    // usage is here, so the exact t/s can hit the bar now instead of waiting
    // for the whole tool-execution phase.
    activeTurn.finalUsage = message?.usage ?? null;
    paintStatus(ctx);
  });

  p.on("turn_end", async (event, ctx) => {
    // Stale-session guard: rebuild for the session that owns this event and
    // drop the in-flight turn — its runtime was torn down, so no record is
    // meaningful. Unreachable in pi's normal flow (old runtime shuts down
    // before a new session starts).
    if (ctx.sessionManager.getSessionId() !== activeSessionId) activateFor(ctx);
    if (!activeTurn) return;
    const message = event.message as { usage?: UsageLike } | undefined;
    const usage = message?.usage ?? activeTurn.finalUsage;
    const record = deriveTurnRecord(activeTurn, usage);
    if (record) {
      addUsage(totals, usage);
      turns.push(record);
      nextTurn = Math.max(nextTurn, record.turn + 1);
      try {
        p.appendEntry(CUSTOM_TYPE, record);
      } catch {
        // Persistence is best-effort: a session file that rejects custom
        // entries must not break the live status bar.
      }
    }
    activeTurn = null;
    paintStatus(ctx);
  });

  p.registerCommand("ttft", {
    description: "Show per-turn TTFT, throughput, and session cache hit rate",
    handler: async (_args, ctx) => {
      ctx.ui.notify(detailMessage(), "info");
    },
  });

  p.on("session_shutdown", async (_event, ctx) => {
    // The next session_start rebuilds everything; drop live references so a
    // stale session can never repaint another session's bar.
    activeSessionId = null;
    activeTurn = null;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}

/** Test-only exports (not part of the public package API). */
export const __test__ = {
  reset(): void {
    activeSessionId = null;
    activeTurn = null;
    nextTurn = 1;
    turns = [];
    totals = createTotals();
    nowFn = Date.now;
  },
  setNow(fn: () => number): void {
    nowFn = fn;
  },
  snapshot(): { totals: TokenTotals; turns: TurnRecord[] } {
    return { totals: { ...totals }, turns: [...turns] };
  },
};
