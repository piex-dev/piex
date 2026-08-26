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
  /** Direct tone override (e.g. low money balance); takes precedence over ratio. */
  tone?: "warning" | "error";
}

export interface AdapterSnapshot {
  segments: AdapterSegment[];
  detail: string[];
}

export interface AdapterFetchContext {
  /** Model provider id currently active (drives per-provider routing). */
  provider: string;
  /** Active model origin, used to avoid forwarding proxy credentials upstream. */
  model?: { provider?: string; baseUrl?: string };
  modelRegistry: {
    getProviderAuth(
      provider: string,
    ): Promise<
      | {
          auth?: {
            apiKey?: string;
            headers?: Record<string, string>;
            baseUrl?: string;
          };
        }
      | undefined
    >;
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

/** Reset timestamp in ms: numeric epoch (s or ms) or ISO string. */
function parseResetMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // cc-switch convention: values < 1e12 are seconds, else milliseconds.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
    const n = Number(value);
    if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  }
  return undefined;
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
    segments.push({ text: `Copilot ${skuLabel(sku)}` });

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
              text: "Copilot limited",
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

// ────────────────────────────────────────────────────────────────────────────────
// DeepSeek API — GET https://api.deepseek.com/user/balance
// Official balance endpoint (API key auth): total/granted/topped-up money.
// ────────────────────────────────────────────────────────────────────────────────

interface DeepSeekBalanceInfo {
  currency?: string;
  total_balance?: string;
  granted_balance?: string;
  topped_up_balance?: string;
}

interface DeepSeekBalancePayload {
  is_available?: boolean;
  balance_infos?: DeepSeekBalanceInfo[];
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function currencySymbol(currency: string | undefined): string {
  switch (currency) {
    case "CNY":
      return "¥";
    case "USD":
      return "$";
    case "EUR":
      return "€";
    default:
      return currency ? `${currency} ` : "";
  }
}

function formatAmount(value: number): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ────────────────────────────────────────────────────────────────────────────────
// DeepSeek official billing — platform.deepseek.com/api/v0/usage/cost
// Requires a browser session token (API keys are rejected: 40003). Set
// DEEPSEEK_PLATFORM_TOKEN (from platform.deepseek.com devtools → any
// api/v0 request → Authorization header). Token expires; failures degrade
// to balance-only display.
// ────────────────────────────────────────────────────────────────────────────────

const DEEPSEEK_COST_URL = "https://platform.deepseek.com/api/v0/usage/cost";
const DEEPSEEK_BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

interface CostDay {
  date: string;
  data: Array<{ model?: string; usage?: Array<{ type?: string; amount?: unknown }> }>;
}

/** Sum all amounts in the monthly cost payload's days. Returns Map<date, CNY>. */
function parseCostDays(payload: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const biz = (payload as { data?: { biz_data?: Array<{ days?: CostDay[] }> } })?.data?.biz_data;
  for (const entry of biz ?? []) {
    for (const day of entry.days ?? []) {
      let total = 0;
      for (const m of day.data ?? []) {
        for (const u of m.usage ?? []) {
          const amount = toNumber(u.amount);
          if (amount !== undefined) total += amount;
        }
      }
      if (total > 0) out.set(day.date, (out.get(day.date) ?? 0) + total);
    }
  }
  return out;
}

async function fetchDeepseekCost(token: string, year: number, month: number): Promise<Map<string, number> | null> {
  const res = await fetch(`${DEEPSEEK_COST_URL}?month=${month}&year=${year}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "x-app-version": "1.0.0",
      Referer: "https://platform.deepseek.com/usage",
      "User-Agent": DEEPSEEK_BROWSER_UA,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const payload = (await res.json()) as { code?: number };
  if (payload.code === 40003) throw new Error("token-invalid");
  if (payload.code !== 0) return null;
  return parseCostDays(payload);
}

export const deepseekAdapter: QuotaAdapter = {
  id: "deepseek",
  label: "DeepSeek",
  providerIds: ["deepseek"],

  async fetch(ctx) {
    const token = await resolveBearer(ctx, ["deepseek"]);
    const res = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`deepseek balance API returned ${res.status}`);
    const payload = (await res.json()) as DeepSeekBalancePayload;
    const infos = payload.balance_infos ?? [];
    if (!payload.is_available || infos.length === 0) {
      throw new Error("deepseek balance payload has no data");
    }

    const segments: AdapterSegment[] = [];
    const detail: string[] = [];
    detail.push("DeepSeek API");
    const balances: Array<{ symbol: string; total: number }> = [];
    for (const info of infos) {
      const total = toNumber(info.total_balance) ?? 0;
      const symbol = currencySymbol(info.currency);
      balances.push({ symbol, total });
      detail.push(`balance: ${symbol}${formatAmount(total)}`);
      const toppedUp = toNumber(info.topped_up_balance);
      const granted = toNumber(info.granted_balance);
      if (toppedUp !== undefined || granted !== undefined) {
        detail.push(
          `  topped up ${symbol}${formatAmount(toppedUp ?? 0)} / granted ${symbol}${formatAmount(granted ?? 0)}`,
        );
      }
    }
    detail.push(`available: ${payload.is_available ? "yes" : "no"}`);

    // Official billing via browser token (DEEPSEEK_PLATFORM_TOKEN); optional.
    const platformToken = process.env.DEEPSEEK_PLATFORM_TOKEN;
    const fmt = (n: number): string => `¥${formatAmount(n)}`;
    if (platformToken) {
      try {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1; // 1-12
        const prev = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
        const maps = await Promise.all([
          fetchDeepseekCost(platformToken, year, month),
          fetchDeepseekCost(platformToken, prev.year, prev.month),
        ]);
        const dayCost = new Map<string, number>();
        for (const m of maps) {
          if (m) for (const [k, v] of m) dayCost.set(k, (dayCost.get(k) ?? 0) + v);
        }
        const key = (offset: number): string => dayKey(now.getTime() - offset * 86_400_000);
        let today = 0;
        let d7 = 0;
        let d30 = 0;
        for (let i = 0; i < 30; i++) {
          const v = dayCost.get(key(i)) ?? 0;
          if (i < 7) d7 += v;
          d30 += v;
        }
        today = dayCost.get(key(0)) ?? 0;
        segments.push({ text: `今${fmt(today)} 7d${fmt(d7)} 30d${fmt(d30)}` });
        detail.push("cost (official, platform.deepseek.com):");
        detail.push(`  today ${fmt(today)} / 7d ${fmt(d7)} / 30d ${fmt(d30)}`);
        const recent = [...dayCost.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 7);
        for (const [date, v] of recent) detail.push(`  ${date} ${fmt(v)}`);
      } catch {
        // token expired / WAF — degrade to balance-only with a hint
        segments.push({ text: "token失效", tone: "warning" });
        detail.push("cost: DEEPSEEK_PLATFORM_TOKEN invalid or expired — refresh it from platform.deepseek.com devtools");
      }
    } else {
      detail.push("cost: set DEEPSEEK_PLATFORM_TOKEN (platform.deepseek.com devtools → Authorization) to show official billing");
    }

    // Balance last: 充值余额:¥xx（消费在前、余额在后）
    for (const b of balances) {
      // Money thresholds: below ¥20 warn, below ¥5 error.
      const tone = b.total < 5 ? "error" : b.total < 20 ? "warning" : undefined;
      segments.push({ text: `充值余额:${b.symbol}${formatAmount(b.total)}`, tone });
    }
    return { segments, detail };
  },
};


// ────────────────────────────────────────────────────────────────────────────────
// Zhipu GLM (智谱) — GET {open.bigmodel.cn|api.z.ai}/api/monitor/usage/quota/limit
// Coding-plan quota. Auth: raw API key WITHOUT the Bearer prefix (cc-switch
// convention, verified against bigmodel.cn and z.ai). Response data.limits[]
// holds TOKENS_LIMIT entries: unit=3 → 5-hour rolling window, unit=6 → weekly;
// percentage is the used percentage, nextResetTime is epoch ms.
// ────────────────────────────────────────────────────────────────────────────────

interface ZhipuQuotaLimit {
  type?: string;
  unit?: number;
  percentage?: number;
  nextResetTime?: unknown;
}

interface ZhipuQuotaPayload {
  success?: boolean;
  msg?: string;
  data?: {
    level?: string;
    limits?: ZhipuQuotaLimit[];
  };
}

function zhipuQuotaHost(provider: string): string {
  return provider === "zai" ? "https://api.z.ai" : "https://open.bigmodel.cn";
}

export const zhipuAdapter: QuotaAdapter = {
  id: "zhipu",
  label: "Zhipu",
  providerIds: ["zai-coding-cn", "zai"],

  async fetch(ctx) {
    const token = await resolveBearer(ctx, ["zai-coding-cn", "zai"]);
    const host = zhipuQuotaHost(ctx.provider);
    const res = await fetch(`${host}/api/monitor/usage/quota/limit`, {
      headers: {
        Authorization: token, // 智谱: raw key, no Bearer prefix
        "Content-Type": "application/json",
        "Accept-Language": "en-US,en",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`zhipu quota API returned ${res.status}`);
    const payload = (await res.json()) as ZhipuQuotaPayload;
    if (payload.success === false) throw new Error(`zhipu quota API: ${payload.msg ?? "unknown error"}`);
    const data = payload.data;
    if (!data) throw new Error("zhipu quota payload has no data");

    const segments: AdapterSegment[] = [];
    const detail: string[] = [];
    detail.push(`Zhipu GLM${data.level ? ` (${data.level})` : ""}`);

    // 5-hour window (unit=3) and weekly (unit=6); unclassified entries fall
    // back to reset-time ordering like cc-switch.
    let fiveHour: ZhipuQuotaLimit | undefined;
    let weekly: ZhipuQuotaLimit | undefined;
    const unclassified: ZhipuQuotaLimit[] = [];
    for (const item of data.limits ?? []) {
      if ((item.type ?? "").toUpperCase() !== "TOKENS_LIMIT") continue;
      const u = item.unit;
      if (u === 3 && !fiveHour) fiveHour = item;
      else if (u === 6 && !weekly) weekly = item;
      else unclassified.push(item);
    }
    unclassified.sort((a, b) => {
      const ra = parseResetMs(a.nextResetTime) ?? 0;
      const rb = parseResetMs(b.nextResetTime) ?? 0;
      return ra - rb;
    });
    for (const item of unclassified) {
      if (!fiveHour) fiveHour = item;
      else if (!weekly) weekly = item;
    }

    const pushWindow = (label: string, item: ZhipuQuotaLimit | undefined): void => {
      if (!item) return;
      const used = item.percentage ?? 0;
      const reset = parseResetMs(item.nextResetTime);
      segments.push({
        text: `${label}:${Math.round(used)}%`,
        ratio: used / 100,
        countdownMs: reset !== undefined ? reset - Date.now() : undefined,
      });
      detail.push(`${label}: ${Math.round(used)}%`);
      if (reset !== undefined) detail.push(`  reset ${formatResetTime(reset)}`);
    };
    pushWindow("5-Hour", fiveHour);
    pushWindow("7-Day", weekly);
    if (segments.length === 0) throw new Error("zhipu quota payload has no limits");
    return { segments, detail };
  },
};

// ────────────────────────────────────────────────────────────────────────────────
// MiniMax — GET https://api.minimaxi.com|io/v1/api/openplatform/coding_plan/remains
// Coding-plan quota. Bearer auth. Response model_remains[]: take the "general"
// entry; current_interval_remaining_percent is the 5-hour bucket REMAINING
// percent (invert to used), current_weekly_status==1 gates the weekly bucket.
// end_time / weekly_end_time are epoch ms.
// ────────────────────────────────────────────────────────────────────────────────

interface MiniMaxRemainsItem {
  model_name?: string;
  current_interval_remaining_percent?: number;
  current_weekly_status?: number;
  current_weekly_remaining_percent?: number;
  end_time?: unknown;
  weekly_end_time?: unknown;
}

interface MiniMaxRemainsPayload {
  base_resp?: { status_code?: number; status_msg?: string };
  model_remains?: MiniMaxRemainsItem[];
}

export const minimaxAdapter: QuotaAdapter = {
  id: "minimax",
  label: "MiniMax",
  providerIds: ["minimax-cn", "minimax"],

  async fetch(ctx) {
    const token = await resolveBearer(ctx, ["minimax-cn", "minimax"]);
    const host = ctx.provider === "minimax" ? "https://api.minimax.io" : "https://api.minimaxi.com";
    const res = await fetch(`${host}/v1/api/openplatform/coding_plan/remains`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`minimax remains API returned ${res.status}`);
    const payload = (await res.json()) as MiniMaxRemainsPayload;
    const baseResp = payload.base_resp;
    if (baseResp && baseResp.status_code !== 0) {
      throw new Error(`minimax remains API: ${baseResp.status_msg ?? `code ${baseResp.status_code}`}`);
    }

    const segments: AdapterSegment[] = [];
    const detail: string[] = [];
    detail.push("MiniMax coding plan");

    const item = (payload.model_remains ?? []).find((m) => m.model_name === "general");
    if (!item) throw new Error("minimax remains payload has no 'general' entry");

    const pushWindow = (label: string, remainPct: number | undefined, reset: unknown): void => {
      if (remainPct === undefined) return;
      const used = Math.max(0, 100 - remainPct);
      const resetMs = parseResetMs(reset);
      segments.push({
        text: `${label}:${Math.round(used)}%`,
        ratio: used / 100,
        countdownMs: resetMs !== undefined ? resetMs - Date.now() : undefined,
      });
      detail.push(`${label}: ${Math.round(used)}% used (${Math.round(remainPct)}% remaining)`);
      if (resetMs !== undefined) detail.push(`  reset ${formatResetTime(resetMs)}`);
    };
    pushWindow("5-Hour", item.current_interval_remaining_percent, item.end_time);
    // Weekly bucket only exists when current_weekly_status == 1 (tolerate string).
    if (Number(item.current_weekly_status) === 1) {
      pushWindow("7-Day", item.current_weekly_remaining_percent, item.weekly_end_time);
    }
    return { segments, detail };
  },
};

// ────────────────────────────────────────────────────────────────────────────────
// OpenRouter — GET https://openrouter.ai/api/v1/credits
// Prepaid credit balance. Bearer auth. Response data: { total_credits, total_usage }.
// ────────────────────────────────────────────────────────────────────────────────

interface OpenRouterCreditsPayload {
  data?: { total_credits?: number; total_usage?: number };
}

export const openrouterAdapter: QuotaAdapter = {
  id: "openrouter",
  label: "OpenRouter",
  providerIds: ["openrouter"],

  async fetch(ctx) {
    const token = await resolveBearer(ctx, ["openrouter"]);
    const res = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`openrouter credits API returned ${res.status}`);
    const payload = (await res.json()) as OpenRouterCreditsPayload;
    const data = payload.data;
    if (!data) throw new Error("openrouter credits payload has no data");

    const total = toNumber(data.total_credits) ?? 0;
    const used = toNumber(data.total_usage) ?? 0;
    const remaining = Math.max(0, total - used);
    // Credit thresholds in USD: below $10 warn, below $2 error.
    const tone = remaining < 2 ? "error" : remaining < 10 ? "warning" : undefined;
    const fmt = (n: number): string => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return {
      segments: [{ text: `余额:${fmt(remaining)}`, tone }],
      detail: [
        "OpenRouter credits",
        `  remaining ${fmt(remaining)} / total ${fmt(total)} / used ${fmt(used)}`,
      ],
    };
  },
};

// ────────────────────────────────────────────────────────────────────────────────
// OpenAI Codex — GET https://chatgpt.com/backend-api/wham/usage
// ChatGPT 订阅额度（Plus/Pro/Team）：primary_window + secondary_window 的
// used_percent / limit_window_seconds / reset_at（epoch 秒，非毫秒）；
// credits（has_credits/unlimited/balance）、plan_type（pro/plus/…）。
// 认证：Pi 的 `openai-codex` provider OAuth bearer token（pi 自动刷新）。
// ────────────────────────────────────────────────────────────────────────────────

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_ORIGIN = "https://chatgpt.com";

interface CodexRateLimitWindow {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_at?: unknown;
  reset_after_seconds?: unknown;
}

interface CodexRateLimitDetails {
  allowed?: unknown;
  limit_reached?: unknown;
  primary_window?: CodexRateLimitWindow | null;
  secondary_window?: CodexRateLimitWindow | null;
}

interface CodexCredits {
  has_credits?: unknown;
  unlimited?: unknown;
  balance?: unknown;
}

interface CodexUsagePayload {
  plan_type?: unknown;
  rate_limit?: CodexRateLimitDetails | null;
  credits?: CodexCredits | null;
  additional_rate_limits?: unknown;
  rate_limit_reset_credits?: { available_count?: unknown } | null;
  rate_limit_reached_type?: { type?: unknown } | null;
  spend_control?: { reached?: unknown } | null;
}

interface CodexFeatureWindow {
  name: string;
  position: "Primary" | "Secondary";
  window: CodexRateLimitWindow;
}

function codexRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function sanitizeCodexText(value: unknown, maxLength = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  return text || undefined;
}

/** Window label from limit_window_seconds: 18_000→5H, 604_800→7D. */
function codexWindowLabel(seconds: number | undefined, fallback = "Limit"): string {
  if (seconds === undefined || seconds <= 0) return fallback;
  const totalMin = Math.max(1, Math.round(seconds / 60));
  if (totalMin % 1440 === 0) return `${totalMin / 1440}D`;
  if (totalMin % 60 === 0) return `${totalMin / 60}H`;
  return `${totalMin}M`;
}

function codexUsedPercent(value: unknown): number | undefined {
  const used = toNumber(value);
  if (used === undefined) return undefined;
  return Math.min(100, Math.max(0, used));
}

function codexResetMs(window: CodexRateLimitWindow | undefined): number | undefined {
  if (!window) return undefined;
  const resetAt = parseResetMs(window.reset_at);
  if (resetAt !== undefined && resetAt > 0) return resetAt;
  const resetAfter = toNumber(window.reset_after_seconds);
  return resetAfter !== undefined && resetAfter > 0
    ? Date.now() + resetAfter * 1000
    : undefined;
}

function planLabel(planType: unknown): string | undefined {
  const raw = sanitizeCodexText(planType, 80);
  if (!raw) return undefined;
  const label = raw.replace(/_/g, "-").replace(/-/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** "GPT-5.3-Codex-Spark" → "Spark"; falls back to a truncated name. */
function codexFeatureLabel(name: string): string {
  const parts = name.split(/[-_\s]+/).filter(Boolean);
  const last = parts[parts.length - 1] ?? name;
  if (last && last.length <= 14) return last;
  return name.length <= 14 ? name : `${name.slice(0, 12)}…`;
}

function codexWindowSeconds(window: CodexRateLimitWindow): number {
  const seconds = toNumber(window.limit_window_seconds);
  return seconds !== undefined && seconds > 0 ? seconds : Number.MAX_SAFE_INTEGER;
}

function codexPushWindow(
  segments: AdapterSegment[],
  detail: string[],
  position: string,
  window: CodexRateLimitWindow | null | undefined,
): void {
  if (!window) return;
  const used = codexUsedPercent(window.used_percent);
  if (used === undefined) return;
  const seconds = toNumber(window.limit_window_seconds);
  const label = codexWindowLabel(seconds, position);
  const resetMs = codexResetMs(window);
  segments.push({
    text: `${label}:${Math.round(used)}%`,
    ratio: used / 100,
    countdownMs: resetMs !== undefined ? resetMs - Date.now() : undefined,
  });
  detail.push(`${position} limit: ${Math.round(used)}% used`);
  detail.push(`  window ${label}${resetMs !== undefined ? ` · resets ${formatResetTime(resetMs)}` : ""}`);
}

/** Preserve both windows for every additional feature limit. */
function codexAdditionalEntries(item: unknown): CodexFeatureWindow[] {
  const value = codexRecord(item);
  const rawName = value?.limit_name ?? value?.metered_feature;
  const name = sanitizeCodexText(rawName);
  const rateLimit = codexRecord(value?.rate_limit);
  if (!name || !rateLimit) return [];

  const entries: CodexFeatureWindow[] = [];
  for (const [key, position] of [
    ["primary_window", "Primary"],
    ["secondary_window", "Secondary"],
  ] as const) {
    const window = codexRecord(rateLimit[key]) as CodexRateLimitWindow | undefined;
    if (window && codexUsedPercent(window.used_percent) !== undefined) {
      entries.push({ name, position, window });
    }
  }
  return entries;
}

function codexOfficialOrigin(value: string | undefined): boolean {
  if (!value) return true;
  try {
    return new URL(value).origin === CODEX_ORIGIN;
  } catch {
    return false;
  }
}

async function resolveCodexBearer(ctx: AdapterFetchContext): Promise<string> {
  if (
    ctx.model?.provider === "openai-codex" &&
    !codexOfficialOrigin(ctx.model.baseUrl)
  ) {
    throw new Error("codex usage refuses a custom model base URL");
  }

  const resolved = await ctx.modelRegistry.getProviderAuth("openai-codex");
  const auth = resolved?.auth;
  if (!codexOfficialOrigin(auth?.baseUrl)) {
    throw new Error("codex usage refuses proxy-resolved credentials");
  }
  const headers = auth?.headers ?? {};
  const authHeader = headers.Authorization ?? headers.authorization;
  const token = authHeader ? authHeader.replace(/^Bearer\s+/i, "") : auth?.apiKey;
  if (!token) throw new Error("no openai-codex credential; run /login");
  return token;
}

export const codexAdapter: QuotaAdapter = {
  id: "codex",
  label: "Codex",
  providerIds: ["openai-codex"],

  async fetch(ctx) {
    const token = await resolveCodexBearer(ctx);
    const res = await fetch(CODEX_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "pi-usage",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`codex usage API returned ${res.status}`);
    const rawPayload = await res.json();
    if (!codexRecord(rawPayload)) throw new Error("codex usage response was not an object");
    const payload = rawPayload as CodexUsagePayload;

    const segments: AdapterSegment[] = [];
    const detail: string[] = [];
    const plan = planLabel(payload.plan_type);
    detail.push(`OpenAI Codex${plan ? ` (${plan})` : ""}`);

    const rateLimitRecord = codexRecord(payload.rate_limit);
    const rateLimit = rateLimitRecord as CodexRateLimitDetails | undefined;
    if (rateLimit) {
      codexPushWindow(segments, detail, "Primary", rateLimit.primary_window);
      codexPushWindow(segments, detail, "Secondary", rateLimit.secondary_window);
    }

    const reachedType = sanitizeCodexText(payload.rate_limit_reached_type?.type, 80);
    const isLimited =
      rateLimit?.limit_reached === true ||
      rateLimit?.allowed === false ||
      payload.spend_control?.reached === true ||
      (reachedType !== undefined && reachedType !== "unknown");
    if (isLimited) {
      segments.unshift({ text: "Codex limited", tone: "error" });
      detail.push(
        `status: limited${reachedType ? ` (${reachedType.replace(/_/g, " ")})` : ""}`,
      );
    }

    // Preserve all per-feature windows in detail. Surface the most-used one
    // (shortest window as tie-breaker) so status reflects the nearest limit.
    const rawAdditional = Array.isArray(payload.additional_rate_limits)
      ? payload.additional_rate_limits
      : [];
    const additionalEntries = rawAdditional.flatMap(codexAdditionalEntries);
    const tightest = [...additionalEntries].sort((a, b) => {
      const usedDiff =
        (codexUsedPercent(b.window.used_percent) ?? -1) -
        (codexUsedPercent(a.window.used_percent) ?? -1);
      return usedDiff || codexWindowSeconds(a.window) - codexWindowSeconds(b.window);
    })[0];
    if (tightest) {
      const used = codexUsedPercent(tightest.window.used_percent);
      const seconds = toNumber(tightest.window.limit_window_seconds);
      const resetMs = codexResetMs(tightest.window);
      if (used !== undefined) {
        segments.push({
          text: `${codexFeatureLabel(tightest.name)} ${codexWindowLabel(seconds)}:${Math.round(used)}%`,
          ratio: used / 100,
          countdownMs: resetMs !== undefined ? resetMs - Date.now() : undefined,
        });
      }
    }
    for (const entry of additionalEntries) {
      const used = codexUsedPercent(entry.window.used_percent);
      if (used === undefined) continue;
      const seconds = toNumber(entry.window.limit_window_seconds);
      const resetMs = codexResetMs(entry.window);
      const label = codexWindowLabel(seconds, entry.position);
      detail.push(`${entry.name} ${entry.position} limit: ${Math.round(used)}% used`);
      detail.push(
        `  window ${label}${resetMs !== undefined ? ` · resets ${formatResetTime(resetMs)}` : ""}`,
      );
    }

    // Keep no-balance states as a fallback so credits-only payloads remain useful
    // without adding noise when rate-limit windows are present.
    let creditsFallback: AdapterSegment | undefined;
    const creditsRecord = codexRecord(payload.credits);
    const credits = creditsRecord as CodexCredits | undefined;
    if (credits?.has_credits === true) {
      if (credits.unlimited === true) {
        segments.push({ text: "Credits:∞" });
        detail.push("Credits: unlimited");
      } else {
        const balance = toNumber(credits.balance);
        if (balance !== undefined) {
          segments.push({ text: `Credits:${balance}` });
          detail.push(`Credits: ${balance} available`);
        } else {
          creditsFallback = { text: "Credits:available" };
          detail.push("Credits: available");
        }
      }
    } else if (credits?.has_credits === false) {
      creditsFallback = { text: "Credits:none" };
      detail.push("Credits: none");
    }

    const resetCount = toNumber(payload.rate_limit_reset_credits?.available_count);
    if (resetCount !== undefined && resetCount >= 0) {
      detail.push(`usage limit resets: ${Math.floor(resetCount)}`);
    }

    if (segments.length === 0 && creditsFallback) segments.push(creditsFallback);
    if (segments.length === 0) throw new Error("codex usage payload has no quota data");
    return { segments, detail };
  },
};

export const adapters: QuotaAdapter[] = [kimiAdapter, xaiAdapter, copilotAdapter, deepseekAdapter, zhipuAdapter, minimaxAdapter, openrouterAdapter, codexAdapter];

/** Find the adapter matching a model provider id, or undefined. */
export function adapterForProvider(provider: string | undefined): QuotaAdapter | undefined {
  if (!provider) return undefined;
  return adapters.find((a) => a.providerIds.includes(provider));
}
