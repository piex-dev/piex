/**
 * usage extension — real-time subscription quota in the status bar.
 *
 *   pi install npm:@piex-dev/usage
 *   pi -e ./src/usage.ts
 *
 * Shows quota for the provider of the currently active model only:
 *
 *   Kimi:  5-Hour:21%🕙3h45 7-Day:26%🕙6d17h
 *   Grok:  7-Day:32%🕙4d3h
 *
 * Auto-refreshes after every turn, on a background poll, and via a local
 * countdown ticker. Switching to a non-subscription model clears the status.
 *
 * Configuration (environment variables):
 *   USAGE_POLL_SECONDS   API refetch interval, default 300
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  adapterForProvider,
  type AdapterFetchContext,
  type AdapterSnapshot,
  type QuotaAdapter,
} from "./adapters.ts";

const STATUS_KEY = "usage";

const COUNTDOWN_TICK_MS = 30_000; // local countdown re-render (no fetch)
const WARNING_RATIO = 0.7; // warn when 70% of quota used
const ERROR_RATIO = 0.9; // error when 90% of quota used

interface ThemeLike {
  fg(name: string, text: string): string;
}

interface UiLike {
  setStatus(key: string, text: string | undefined): void;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  theme: ThemeLike;
}

interface CtxLike extends AdapterFetchContext {
  ui: UiLike;
}

let activeAdapter: QuotaAdapter | null = null;
let activeSnapshot: AdapterSnapshot | null = null;
let lastError: string | null = null;
let latestCtx: CtxLike | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;

function formatCountdown(ms: number): string {
  if (ms <= 0) return "0m";
  const totalMin = Math.ceil(ms / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const minutes = totalMin % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}`;
  return `${minutes}m`;
}

function colorize(theme: ThemeLike, ratio: number | undefined, text: string): string {
  if (ratio === undefined) return text;
  if (ratio >= ERROR_RATIO) return theme.fg("error", text);
  if (ratio >= WARNING_RATIO) return theme.fg("warning", text);
  return text;
}

function renderStatus(theme: ThemeLike): string {
  if (!activeSnapshot) return theme.fg("dim", "Usage: loading…");
  const body = activeSnapshot.segments
    .map((seg) => {
      const text = seg.tone ? theme.fg(seg.tone, seg.text) : colorize(theme, seg.ratio, seg.text);
      if (seg.countdownMs === undefined) return text;
      return `${text}🕙${theme.fg("dim", formatCountdown(seg.countdownMs))}`;
    })
    .join(" ");
  return `Usage: ${body}`;
}

async function refresh(ctx: CtxLike): Promise<void> {
  latestCtx = ctx;
  const ui = ctx.ui;
  // Capture the adapter this refresh belongs to; a model switch while the
  // request is in flight must not let a stale result repaint the status bar.
  const adapter = activeAdapter;
  if (!adapter) {
    ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  try {
    const snapshot = await adapter.fetch(ctx);
    if (activeAdapter !== adapter) return; // stale: model switched mid-flight
    activeSnapshot = snapshot;
    lastError = null;
    ui.setStatus(STATUS_KEY, renderStatus(ui.theme));
  } catch (err) {
    if (activeAdapter !== adapter) return; // stale: model switched mid-flight
    lastError = err instanceof Error ? err.message : String(err);
    ui.setStatus(STATUS_KEY, ui.theme.fg("error", `${adapter.label}: offline`));
  }
}

function tickCountdown(): void {
  if (!activeAdapter || !activeSnapshot || !latestCtx) return;
  latestCtx.ui.setStatus(STATUS_KEY, renderStatus(latestCtx.ui.theme));
}

function detailMessage(): string {
  if (!activeAdapter || !activeSnapshot) return "quota: no data yet";
  const lines = [...activeSnapshot.detail];
  lines.unshift(activeAdapter.label);
  return lines.join("\n");
}

export default function usageExtension(pi: ExtensionAPI): void {
  // Show quota only when the active model's provider has an adapter; clear otherwise.
  const activateFor = (provider: string | undefined, ctx: CtxLike): void => {
    latestCtx = ctx; // keep the poll/ticker on the freshest session's ui
    const adapter = adapterForProvider(provider);
    if (adapter === activeAdapter) {
      if (adapter) void refresh(ctx);
      return;
    }
    activeAdapter = adapter ?? null;
    activeSnapshot = null;
    if (adapter) {
      void refresh(ctx);
    } else {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    activateFor(ctx.model?.provider, ctx as unknown as CtxLike);
  });

  pi.on("model_select", async (event, ctx) => {
    activateFor(event.model?.provider, ctx as unknown as CtxLike);
  });

  // Refresh right after each turn so quota changes appear immediately.
  pi.on("turn_end", async (_event, ctx) => {
    if (activeAdapter) void refresh(ctx as unknown as CtxLike);
  });

  const pollSeconds = Number(process.env.USAGE_POLL_SECONDS ?? 300);
  pollTimer = setInterval(() => {
    if (activeAdapter && latestCtx) void refresh(latestCtx);
  }, Number.isFinite(pollSeconds) && pollSeconds > 0 ? pollSeconds * 1000 : 300_000);

  // Local countdown ticker — re-renders from cached reset times, no API call.
  tickTimer = setInterval(tickCountdown, COUNTDOWN_TICK_MS);

  pi.registerCommand("usage", {
    description: "Refresh and show subscription quota details",
    handler: async (_args, ctx) => {
      await refresh(ctx as unknown as CtxLike);
      ctx.ui.notify(detailMessage(), lastError ? "warning" : "info");
    },
  });

  pi.on("session_shutdown", () => {
    if (pollTimer) clearInterval(pollTimer);
    if (tickTimer) clearInterval(tickTimer);
    pollTimer = null;
    tickTimer = null;
  });
}
