/**
 * Model definitions & live catalog discovery for xAI Grok OAuth.
 *
 * - Hardcoded fallback list covers all currently known models.
 * - On login, a fire-and-forget fetch of /models from api.x.ai and
 *   cli-chat-proxy.grok.com refreshes the discovery cache. The next
 *   `/reload` (or model load) applies the new catalog.
 * - PI_XAI_OAUTH_MODELS env var filters / reorders models.
 * - Proxy-preferred routing: models available on cli-chat-proxy ride the
 *   subscription quota path; everything else hits the public API.
 *
 * Ported & adapted from stnly/pi-grok (MIT).
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface XaiModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat: { supportsStore: boolean; supportsDeveloperRole: boolean; supportsReasoningEffort: boolean };
  /** Override base URL — set for proxy-only models. */
  baseUrl?: string;
  /** Extra headers — set alongside baseUrl for proxy routing. */
  headers?: Record<string, string>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

/** Public API base. */
export const XAI_PUBLIC_BASE_URL = "https://api.x.ai/v1";

/** CLI chat proxy — models here ride the subscription quota instead of API billing. */
export const CLI_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";

/** Client version matching the shipped grok-build CLI. Override with PI_XAI_CLIENT_VERSION. */
const GROK_CLIENT_VERSION = process.env.PI_XAI_CLIENT_VERSION || "0.2.101";

/** Headers sent on every cli-chat-proxy request so the proxy treats us as a first-class client. */
export const CLI_PROXY_HEADERS: Record<string, string> = {
  "x-grok-client-version": GROK_CLIENT_VERSION,
  "x-grok-client-surface": "grok-build",
  "x-grok-client-mode": "grok-shell",
};

/** Default compat for models that don't have a matching base entry. */
const DEFAULT_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// Cost constants ($ / million tokens)
// ═══════════════════════════════════════════════════════════════════════════════

const COST_BUILD = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const COST_43 = { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 };
const COST_420 = { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 };
const COST_45 = { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 };
const COST_3 = { input: 3, output: 15, cacheRead: 0.75, cacheWrite: 0 };
const COST_3_FAST = { input: 5, output: 25, cacheRead: 1.25, cacheWrite: 0 };
const COST_CODE_FAST = { input: 0.2, output: 1.5, cacheRead: 0.02, cacheWrite: 0 };

// ═══════════════════════════════════════════════════════════════════════════════
// Fallback model list
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Hardcoded fallback catalog.  Ordered so the most generally useful models
 * appear first in the picker.  Live discovery can reorder and add new entries.
 *
 * Proxy-only models carry their own baseUrl + headers so they route through
 * the subscription quota path even before discovery has run.
 */
export const FALLBACK_MODELS: XaiModelConfig[] = [
  // ── Proxy-only (subscription quota) ──
  {
    id: "grok-composer-2.5-fast",
    name: "Composer 2.5",
    reasoning: true,
    input: ["text", "image"],
    cost: COST_BUILD,
    contextWindow: 200_000,
    maxTokens: 30000,
    compat: DEFAULT_COMPAT,
    baseUrl: CLI_PROXY_BASE_URL,
    headers: CLI_PROXY_HEADERS,
  },
  // ── Latest / flagship ──
  {
    id: "grok-4.5",
    name: "Grok 4.5",
    reasoning: true,
    input: ["text", "image"],
    cost: COST_45,
    contextWindow: 500_000,
    maxTokens: 500_000,
    compat: { ...DEFAULT_COMPAT, supportsReasoningEffort: true },
  },
  {
    id: "grok-4.3",
    name: "Grok 4.3",
    reasoning: true,
    input: ["text", "image"],
    cost: COST_43,
    contextWindow: 1_000_000,
    maxTokens: 30000,
    compat: { ...DEFAULT_COMPAT, supportsReasoningEffort: true },
  },
  // ── Grok 4.20 family ──
  {
    id: "grok-4.20-0309-reasoning",
    name: "Grok 4.20 (Reasoning)",
    reasoning: true,
    input: ["text", "image"],
    cost: COST_420,
    contextWindow: 1_000_000,
    maxTokens: 30000,
    compat: DEFAULT_COMPAT,
  },
  {
    id: "grok-4.20-0309-non-reasoning",
    name: "Grok 4.20 (Non-Reasoning)",
    reasoning: false,
    input: ["text", "image"],
    cost: COST_420,
    contextWindow: 1_000_000,
    maxTokens: 30000,
    compat: DEFAULT_COMPAT,
  },
  {
    id: "grok-4.20-multi-agent-0309",
    name: "Grok 4.20 Multi-Agent",
    reasoning: true,
    input: ["text", "image"],
    cost: COST_420,
    contextWindow: 2_000_000,
    maxTokens: 30000,
    compat: { ...DEFAULT_COMPAT, supportsReasoningEffort: true },
  },
  // ── Build / legacy ──
  {
    id: "grok-build",
    name: "Grok Build",
    reasoning: true,
    input: ["text", "image"],
    cost: COST_BUILD,
    contextWindow: 256_000,
    maxTokens: 256_000,
    compat: DEFAULT_COMPAT,
  },
  // ── Grok 3 family (public API only) ──
  {
    id: "grok-3",
    name: "Grok 3",
    reasoning: false,
    input: ["text"],
    cost: COST_3,
    contextWindow: 131072,
    maxTokens: 8192,
    compat: DEFAULT_COMPAT,
  },
  {
    id: "grok-3-fast",
    name: "Grok 3 Fast",
    reasoning: false,
    input: ["text"],
    cost: COST_3_FAST,
    contextWindow: 131072,
    maxTokens: 8192,
    compat: DEFAULT_COMPAT,
  },
  {
    id: "grok-code-fast-1",
    name: "Grok Code Fast 1",
    reasoning: false,
    input: ["text"],
    cost: COST_CODE_FAST,
    contextWindow: 32768,
    maxTokens: 8192,
    compat: DEFAULT_COMPAT,
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// PI_XAI_OAUTH_MODELS env filter
// ═══════════════════════════════════════════════════════════════════════════════

/** Parse PI_XAI_OAUTH_MODELS into an id list (empty = no filter). */
export function envModelIds(): string[] {
  return (process.env.PI_XAI_OAUTH_MODELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Filter / reorder models by an explicit id list.  Unknown ids get sensible
 * defaults so env can pre-declare models not yet in the fallback catalog.
 * Empty `envIds` returns `models` unchanged.
 */
export function filterModelsByEnv(models: XaiModelConfig[], envIds: string[]): XaiModelConfig[] {
  if (envIds.length === 0) return models;

  const byId = new Map(models.map((m) => [m.id, m]));
  return envIds.map((id) =>
    byId.get(id) ?? {
      id,
      name: id,
      reasoning: true,
      input: ["text"] as ("text" | "image")[],
      cost: COST_BUILD,
      contextWindow: 1_000_000,
      maxTokens: 30000,
      compat: DEFAULT_COMPAT,
    },
  );
}

/** Resolve the active model list with env filtering. */
export function resolveModels(): XaiModelConfig[] {
  return filterModelsByEnv(FALLBACK_MODELS, envModelIds());
}

// ═══════════════════════════════════════════════════════════════════════════════
// Live catalog
// ═══════════════════════════════════════════════════════════════════════════════

interface ApiModelEntry {
  id: string;
  owned_by?: string;
  context_length?: number;
  max_output_tokens?: number;
}

function isChatModel(id: string): boolean {
  if (!id.startsWith("grok")) return false;
  const lower = id.toLowerCase();
  if (lower.includes("imagine")) return false;
  if (lower.includes("embedding")) return false;
  if (lower.includes("tts")) return false;
  return true;
}

/** Fetch raw /models from one endpoint, or null on any failure. */
async function fetchRawCatalog(
  accessToken: string,
  baseUrl: string,
): Promise<{ data?: ApiModelEntry[] } | null> {
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...CLI_PROXY_HEADERS,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as { data?: ApiModelEntry[] };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Merge
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Merge a live /models response into the fallback list.  Pure & testable.
 *
 * - Live catalog is authoritative for context_window and max_tokens.
 * - Base list fills name / cost / reasoning / compat.
 * - proxyIds drives routing: ids in the set get the proxy base URL so they
 *   ride the subscription quota path; others fall back to the public API.
 */
export function mergeLiveModels(
  base: XaiModelConfig[],
  body: { data?: ApiModelEntry[] } | null,
  proxyIds: Set<string> = new Set(),
): XaiModelConfig[] {
  if (!body || !Array.isArray(body.data)) return base;

  const entries = body.data.filter((e) => isChatModel(e.id));
  const baseById = new Map(base.map((m) => [m.id, m]));
  const seen = new Set<string>();
  const merged: XaiModelConfig[] = [];

  const route = (id: string): Pick<XaiModelConfig, "baseUrl" | "headers"> =>
    proxyIds.has(id)
      ? { baseUrl: CLI_PROXY_BASE_URL, headers: CLI_PROXY_HEADERS }
      : {};

  for (const entry of entries) {
    seen.add(entry.id);
    const existing = baseById.get(entry.id);
    if (existing) {
      merged.push({
        ...existing,
        contextWindow: entry.context_length ?? existing.contextWindow,
        maxTokens: entry.max_output_tokens ?? existing.maxTokens,
        ...route(entry.id),
      });
    } else {
      merged.push({
        id: entry.id,
        name: entry.id,
        reasoning: true,
        input: ["text", "image"],
        cost: COST_420,
        contextWindow: entry.context_length ?? 1_000_000,
        maxTokens: entry.max_output_tokens ?? 30000,
        compat: DEFAULT_COMPAT,
        ...route(entry.id),
      });
    }
  }

  // Append base entries the live response omitted.
  for (const fb of base) {
    if (!seen.has(fb.id)) {
      merged.push({ ...fb, ...route(fb.id) });
    }
  }

  return merged;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Discovery cache
// ═══════════════════════════════════════════════════════════════════════════════

let discoveredBody: { data?: ApiModelEntry[] } | null = null;
let discoveredProxyIds: Set<string> = new Set();
let discoveryInFlight: Promise<void> | null = null;

/** Merge the cached discovery into a base list.  Returns base unchanged when no fetch has run yet. */
export function mergeDiscoveredModels(base: XaiModelConfig[]): XaiModelConfig[] {
  return discoveredBody ? mergeLiveModels(base, discoveredBody, discoveredProxyIds) : base;
}

/** Pure helper: merge discovery + re-apply env filter. */
export function applyDiscoveredModels(
  providerModels: XaiModelConfig[],
  envIds: string[] = envModelIds(),
): XaiModelConfig[] {
  return filterModelsByEnv(mergeDiscoveredModels(providerModels), envIds);
}

/**
 * Fire-and-forget dual-catalog fetch.  Deduplicates concurrent calls.
 * Errors are swallowed — a failed fetch leaves the existing cache as-is.
 */
export function triggerDiscovery(accessToken: string, baseUrl: string): void {
  if (discoveryInFlight) return;
  discoveryInFlight = (async () => {
    try {
      const [body, proxyBody] = await Promise.all([
        fetchRawCatalog(accessToken, baseUrl),
        fetchRawCatalog(accessToken, CLI_PROXY_BASE_URL),
      ]);
      if (body && Array.isArray(body.data)) discoveredBody = body;
      if (proxyBody && Array.isArray(proxyBody.data)) {
        discoveredProxyIds = new Set(
          proxyBody.data.filter((e) => isChatModel(e.id)).map((e) => e.id),
        );
      }
    } finally {
      discoveryInFlight = null;
    }
  })();
}

/** Clear the discovery cache (for tests). */
export function resetDiscoveryForTests(): void {
  discoveredBody = null;
  discoveredProxyIds = new Set();
  discoveryInFlight = null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// modifyModels integration
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Rebuild the model list for `modifyModels`:
 * 1. Keep non-provider models untouched
 * 2. Merge live discovery into this provider's models
 * 3. Re-apply PI_XAI_OAUTH_MODELS
 * 4. Stamp api / provider on entries missing them
 * 5. Fill baseUrl from provider default when unset (public API path)
 */
export function rebuildModelsForOAuth(
  allModels: Array<Record<string, unknown>>,
  provider: string,
  effectiveBaseUrl: string,
  envIds: string[] = envModelIds(),
): Array<Record<string, unknown>> {
  const others = allModels.filter((m) => m.provider !== provider);
  const ours = allModels.filter((m) => m.provider === provider);
  const template = ours[0] as Record<string, unknown> | undefined;

  const merged = applyDiscoveredModels(ours as unknown as XaiModelConfig[], envIds).map((m) => {
    return {
      ...m,
      api: (m as Record<string, unknown>).api ?? (template?.api as string | undefined) ?? "openai-completions",
      provider: (m as Record<string, unknown>).provider ?? provider,
      baseUrl: m.baseUrl ?? effectiveBaseUrl,
    } as Record<string, unknown>;
  });

  return [...others, ...merged];
}
