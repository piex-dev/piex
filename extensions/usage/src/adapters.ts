/**
 * Quota adapters — one per subscription-backed provider.
 * Each adapter knows how to fetch quota data for its provider and how to
 * render it as status-bar segments (value + optional 🕙 countdown).
 * No pi runtime dependencies; pure logic + fetch.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AdapterSegment {
  text: string;
  /** 0..1 quota ratio used, drives warning/error coloring. */
  ratio?: number;
  /** Countdown (ms) rendered after the segment as 🕙hh… */
  countdownMs?: number;
}

export interface AdapterSnapshot {
  segments: AdapterSegment[];
  detail: string[];
}

export interface AdapterFetchContext {
  modelRegistry: {
    getProviderAuth(
      provider: string,
    ): Promise<{ auth?: { apiKey?: string; headers?: Record<string, string> } } | undefined>;
  };
}

export interface QuotaAdapter {
  id: string;
  label: string;
  /** Model provider ids this adapter is active for. */
  providerIds: string[];
  fetch(ctx: AdapterFetchContext): Promise<AdapterSnapshot>;
}

// ────────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ────────────────────────────────────────────────────────────────────────────────

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const val = (value as Record<string, unknown>).val;
    if (typeof val === "number" && Number.isFinite(val)) return val;
  }
  return undefined;
}

function parseTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : undefined;
}

function percent(used: number, limit: number): number {
  return limit > 0 ? Math.round((used / limit) * 100) : 0;
}

function formatResetTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Resolve the raw token via pi auth for the first provider that has one. */
async function resolveBearer(ctx: AdapterFetchContext, providers: string[]): Promise<string> {
  for (const provider of providers) {
    const auth = await ctx.modelRegistry.getProviderAuth(provider);
    const headers = auth?.auth?.headers ?? {};
    const authHeader = headers["Authorization"] ?? headers["authorization"];
    const apiKey = auth?.auth?.apiKey;
    const token = authHeader ? authHeader.replace(/^Bearer\s+/i, "") : apiKey;
    if (token) return token;
  }
  throw new Error(`no ${providers.join("/")} credential; run /login or set the API key`);
}

// ────────────────────────────────────────────────────────────────────────────────
// Kimi For Coding — GET https://api.kimi.com/coding/v1/usages
// Weekly request quota + rolling window rate limits.
// ────────────────────────────────────────────────────────────────────────────────

interface KimiUsageLimit {
  window?: { duration?: number; timeUnit?: string };
  detail?: { limit?: number; used?: number; remaining?: number; resetTime?: string };
}

interface KimiUsagesPayload {
  usage?: { limit?: number; used?: number; remaining?: number; resetTime?: string };
  limits?: KimiUsageLimit[];
  parallel?: { limit?: number };
  user?: { membership?: { level?: string } };
}

function kimiWindowLabel(duration?: number, timeUnit?: string): string {
  const unit = (timeUnit ?? "").toUpperCase();
  const d = duration ?? 0;
  if (unit.includes("MINUTE")) {
    if (d > 0 && d % 60 === 0) return `${d / 60}-Hour`;
    return d > 0 ? `${d}-Min` : "Window";
  }
  if (unit.includes("HOUR")) return d > 0 ? `${d}-Hour` : "Window";
  if (unit.includes("DAY")) return d > 0 ? `${d}-Day` : "Window";
  return d > 0 ? `${d}-Window` : "Window";
}

export const kimiAdapter: QuotaAdapter = {
  id: "kimi",
  label: "Kimi",
  providerIds: ["kimi-coding"],
  async fetch(ctx) {
    const token = await resolveBearer(ctx, ["kimi-coding"]);
    const res = await fetch("https://api.kimi.com/coding/v1/usages", {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "KimiCLI/1.6" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`kimi usages API returned ${res.status}`);
    const payload = (await res.json()) as KimiUsagesPayload;

    const usage = payload.usage ?? {};
    const weeklyUsed = toNumber(usage.used) ?? 0;
    const weeklyLimit = toNumber(usage.limit) ?? 0;
    const weeklyReset = parseTime(usage.resetTime) ?? Date.now();

    const segments: AdapterSegment[] = [];
    const detail: string[] = [];
    const level = payload.user?.membership?.level;
    detail.push(`Kimi For Coding${level ? ` (${level})` : ""}`);

    for (const w of payload.limits ?? []) {
      const detailObj = w.detail ?? {};
      const u = toNumber(detailObj.used);
      const l = toNumber(detailObj.limit);
      if (u === undefined && l === undefined) continue;
      const used = u ?? 0;
      const limit = l ?? 0;
      const label = kimiWindowLabel(w.window?.duration, w.window?.timeUnit);
      const reset = parseTime(detailObj.resetTime) ?? weeklyReset;
      segments.push({
        text: `${label}:${percent(used, limit)}%`,
        ratio: limit > 0 ? used / limit : 0,
        countdownMs: reset - Date.now(),
      });
      detail.push(`${label}: ${used}/${limit}`);
      detail.push(`  window reset ${formatResetTime(reset)}`);
    }

    segments.push({
      text: `7-Day:${percent(weeklyUsed, weeklyLimit)}%`,
      ratio: weeklyLimit > 0 ? weeklyUsed / weeklyLimit : 0,
      countdownMs: weeklyReset - Date.now(),
    });
    detail.push(
      `7-Day: ${percent(weeklyUsed, weeklyLimit)}% (${weeklyUsed}/${weeklyLimit} requests, ${weeklyLimit - weeklyUsed} left)`,
    );
    detail.push(`  reset ${formatResetTime(weeklyReset)}`);

    const parallel = toNumber(payload.parallel?.limit);
    if (parallel !== undefined) detail.push(`parallel limit: ${parallel}`);
    return { segments, detail };
  },
};

// ────────────────────────────────────────────────────────────────────────────────
// xAI Grok (SuperGrok / X Premium+) — GET https://cli-chat-proxy.grok.com/v1/billing
// Weekly credits pool (+ optional monthly unified billing).
// ────────────────────────────────────────────────────────────────────────────────

interface XaiConfig {
  currentPeriod?: { type?: string; start?: string; end?: string };
  creditUsagePercent?: number;
  productUsage?: Array<{ product?: string; usagePercent?: number }>;
  isUnifiedBillingUser?: boolean;
  monthlyLimit?: { val?: number } | number;
  used?: { val?: number } | number;
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
}

interface XaiBillingPayload {
  config?: XaiConfig;
}

const XAI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";
const XAI_PROVIDERS = ["xai", "xai-oauth"];

async function fetchXaiBilling(token: string, format?: string): Promise<XaiBillingPayload> {
  const url = format ? `${XAI_BILLING_URL}?format=${format}` : XAI_BILLING_URL;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "X-XAI-Token-Auth": "xai-grok-cli",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`xai billing API returned ${res.status}`);
  return (await res.json()) as XaiBillingPayload;
}

export const xaiAdapter: QuotaAdapter = {
  id: "xai",
  label: "Grok",
  providerIds: ["xai", "xai-oauth"],

  async fetch(ctx) {
    const token = await resolveBearer(ctx, XAI_PROVIDERS);
    let weeklyPayload: XaiBillingPayload;
    try {
      weeklyPayload = await fetchXaiBilling(token, "credits");
    } catch (err) {
      throw new Error(`xai billing API unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }

    const config = weeklyPayload.config ?? {};
    const segments: AdapterSegment[] = [];
    const detail: string[] = [];
    detail.push("xAI Grok (SuperGrok / X Premium+)");

    const weeklyPercent = toNumber(config.creditUsagePercent) ?? 0;
    const periodEnd = parseTime(config.currentPeriod?.end) ?? Date.now();
    segments.push({
      text: `7-Day:${Math.round(weeklyPercent)}%`,
      ratio: weeklyPercent / 100,
      countdownMs: periodEnd - Date.now(),
    });
    detail.push(`7-Day credits: ${Math.round(weeklyPercent)}% used`);
    if (config.currentPeriod?.end) {
      detail.push(`  resets ${formatResetTime(periodEnd)}`);
    }

    for (const p of config.productUsage ?? []) {
      if (!p.product) continue;
      const pct = toNumber(p.usagePercent);
      if (pct === undefined) continue;
      detail.push(`  ${p.product}: ${Math.round(pct)}%`);
    }

    // Best-effort monthly unified billing — separate endpoint, failure is
    // non-fatal. Off by default: the official console does not show this
    // figure, so it may confuse. Enable with USAGE_SHOW_XAI_MONTHLY=1.
    if (config.isUnifiedBillingUser && process.env.USAGE_SHOW_XAI_MONTHLY === "1") {
      try {
        const monthlyPayload = await fetchXaiBilling(token);
        const monthly = monthlyPayload?.config;
        const limit = toNumber(monthly?.monthlyLimit);
        const used = toNumber(monthly?.used);
        const monthlyEnd = parseTime(monthly?.billingPeriodEnd);
        if (limit !== undefined && used !== undefined) {
          segments.push({
            text: `1-Month:${percent(used, limit)}%`,
            ratio: limit > 0 ? used / limit : 0,
            countdownMs: monthlyEnd !== undefined ? monthlyEnd - Date.now() : undefined,
          });
          detail.push(`1-Month: ${used}/${limit} units (${percent(used, limit)}%)`);
          if (monthlyEnd !== undefined) {
            detail.push(`  resets ${formatResetTime(monthlyEnd)}`);
          }
        }
      } catch {
        // monthly is best-effort — skip
      }
    }

    if (segments.length === 0) throw new Error("xai billing payload has no quota data");
    return { segments, detail };
  },
};

// ────────────────────────────────────────────────────────────────────────────────
// GitHub Copilot — copilot_internal/v2/token
// No public usage/balance endpoint (billing API needs a `copilot`-scoped app).
// What the official token endpoint exposes: subscription SKU + limited-user
// quota (non-null only while rate-limited). Show both, best-effort.
// ────────────────────────────────────────────────────────────────────────────────

const COPILOT_PROVIDER = "github-copilot";
const COPILOT_INTERNAL_URL = "https://api.github.com/copilot_internal/v2/token";
const COPILOT_HEADERS = {
  Accept: "application/json",
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
} as const;

/** Parse `sku=...` from the copilot token field string (tid=…;sku=…;proxy-ep=…). */
function copilotSku(token: string): string | undefined {
  const match = token.match(/(?:^|;)sku=([^;]+)/);
  return match?.[1];
}

function skuLabel(sku: string | undefined): string {
  switch (sku) {
    case "pro":
      return "Pro";
    case "pro+":
      return "Pro+";
    case "free":
      return "Free";
    case "free_engaged_oss_quota":
      return "Free(OSS)";
    case "business":
      return "Business";
    case "enterprise":
      return "Enterprise";
    default:
      return sku || "unknown";
  }
}

/** Best-effort: read the GitHub OAuth token pi stores in auth.json (refresh slot). */
function readGitHubToken(): string | undefined {
  try {
    const configuredAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = configuredAgentDir
      ? configuredAgentDir === "~" || configuredAgentDir.startsWith("~/")
        ? join(homedir(), configuredAgentDir.slice(2))
        : configuredAgentDir
      : join(homedir(), ".pi", "agent");
    const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")) as Record<
      string,
      { refresh?: string }
    >;
    return auth["github-copilot"]?.refresh;
  } catch {
    return undefined;
  }
}

export const copilotAdapter: QuotaAdapter = {
  id: "copilot",
  label: "Copilot",
  providerIds: [COPILOT_PROVIDER],

  async fetch(ctx) {
    // Copilot token carries the SKU; pi auto-refreshes it via copilot_internal.
    const auth = await ctx.modelRegistry.getProviderAuth(COPILOT_PROVIDER);
    const copilotToken = auth?.auth?.apiKey ?? auth?.auth?.headers?.["Authorization"]?.replace(/^Bearer\s+/i, "");
    if (!copilotToken) throw new Error("no github-copilot credential; run /login");

    const sku = copilotSku(copilotToken);
    const segments: AdapterSegment[] = [];
    const detail: string[] = [];
    detail.push("GitHub Copilot");
    detail.push(`sku: ${sku ?? "unknown"} (${skuLabel(sku)})`);
    segments.push({ text: `Copilot:${skuLabel(sku)}` });

    // Limited-user quota only exists while rate-limited; best-effort fetch.
    const gitToken = readGitHubToken();
    if (gitToken) {
      try {
        const res = await fetch(COPILOT_INTERNAL_URL, {
          headers: { ...COPILOT_HEADERS, Authorization: `Bearer ${gitToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            limited_user_quotas?: unknown;
            limited_user_reset_date?: string;
          };
          const limited = data.limited_user_quotas;
          if (limited != null) {
            const resetMs = data.limited_user_reset_date
              ? Date.parse(data.limited_user_reset_date)
              : undefined;
            segments.push({
              text: "Copilot:limited",
              ratio: 1,
              countdownMs:
                resetMs !== undefined && Number.isFinite(resetMs) ? resetMs - Date.now() : undefined,
            });
            detail.push("limited-user quota active");
            detail.push(`  reset ${formatResetTime(resetMs ?? Date.now())}`);
            detail.push(`  ${JSON.stringify(limited).slice(0, 200)}`);
          } else {
            detail.push("limited-user quota: none");
          }
        }
      } catch {
        // best-effort — skip limited status
      }
    } else {
      detail.push("limited-user quota: unknown (auth.json unreadable)");
    }

    return { segments, detail };
  },
};

export const adapters: QuotaAdapter[] = [kimiAdapter, xaiAdapter, copilotAdapter];

/** Find the adapter matching a model provider id, or undefined. */
export function adapterForProvider(provider: string | undefined): QuotaAdapter | undefined {
  if (!provider) return undefined;
  return adapters.find((a) => a.providerIds.includes(provider));
}
