/**
 * Unit tests for xai-oauth models (no live network).
 * Run: bun test packages/xai-oauth/models.test.ts
 */
import { describe, expect, test, beforeAll } from "bun:test";
import {
  FALLBACK_MODELS,
  filterModelsByEnv,
  mergeLiveModels,
  mergeDiscoveredModels,
  applyDiscoveredModels,
  rebuildModelsForOAuth,
  resetDiscoveryForTests,
  XAI_PUBLIC_BASE_URL,
  CLI_PROXY_BASE_URL,
  CLI_PROXY_HEADERS,
} from "./extensions/models.ts";

beforeAll(() => {
  resetDiscoveryForTests();
});

describe("FALLBACK_MODELS", () => {
  test("includes proxy-only models with baseUrl", () => {
    const composer = FALLBACK_MODELS.find(
      (m) => m.id === "grok-composer-2.5-fast",
    );
    expect(composer).toBeDefined();
    expect(composer!.baseUrl).toBe(CLI_PROXY_BASE_URL);
    expect(composer!.headers).toEqual(CLI_PROXY_HEADERS);
  });

  test("includes multi-agent model", () => {
    const ma = FALLBACK_MODELS.find(
      (m) => m.id === "grok-4.20-multi-agent-0309",
    );
    expect(ma).toBeDefined();
    expect(ma!.reasoning).toBe(true);
    expect(ma!.compat.supportsReasoningEffort).toBe(true);
  });

  test("grok-4.5 has correct cost and context window", () => {
    const g45 = FALLBACK_MODELS.find((m) => m.id === "grok-4.5")!;
    expect(g45.cost.input).toBe(2);
    expect(g45.cost.output).toBe(6);
    expect(g45.cost.cacheRead).toBe(0.5);
    expect(g45.contextWindow).toBe(500_000);
  });

  test("grok-build uses zero cost", () => {
    const build = FALLBACK_MODELS.find((m) => m.id === "grok-build")!;
    expect(build.cost.input).toBe(0);
    expect(build.cost.output).toBe(0);
  });

  test("all ids are unique", () => {
    const ids = FALLBACK_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("filterModelsByEnv", () => {
  test("returns all models when envIds is empty", () => {
    expect(filterModelsByEnv(FALLBACK_MODELS, []).length).toBe(
      FALLBACK_MODELS.length,
    );
  });

  test("filters to specified ids", () => {
    const result = filterModelsByEnv(FALLBACK_MODELS, [
      "grok-4.5",
      "grok-build",
    ]);
    expect(result.length).toBe(2);
    expect(result[0]!.id).toBe("grok-4.5");
    expect(result[1]!.id).toBe("grok-build");
  });

  test("reorders by envIds", () => {
    const result = filterModelsByEnv(FALLBACK_MODELS, [
      "grok-build",
      "grok-4.5",
    ]);
    expect(result[0]!.id).toBe("grok-build");
    expect(result[1]!.id).toBe("grok-4.5");
  });

  test("creates sensible defaults for unknown ids", () => {
    const result = filterModelsByEnv(FALLBACK_MODELS, ["future-grok-99"]);
    expect(result.length).toBe(1);
    expect(result[0]!.id).toBe("future-grok-99");
    expect(result[0]!.name).toBe("future-grok-99");
    expect(result[0]!.contextWindow).toBe(1_000_000);
  });
});

describe("mergeLiveModels", () => {
  const base = [
    {
      id: "grok-4.5",
      name: "Grok 4.5",
      reasoning: true,
      input: ["text", "image"] as ("text" | "image")[],
      cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
      contextWindow: 500_000,
      maxTokens: 500_000,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
      },
    },
    {
      id: "grok-build",
      name: "Grok Build",
      reasoning: true,
      input: ["text", "image"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 256_000,
      maxTokens: 256_000,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
    },
  ];

  test("returns base when body is null", () => {
    expect(mergeLiveModels(base, null)).toEqual(base);
  });

  test("returns base when body has no data", () => {
    expect(mergeLiveModels(base, {})).toEqual(base);
  });

  test("updates context from live catalog", () => {
    const body = {
      data: [
        {
          id: "grok-4.5",
          context_length: 1_000_000,
          max_output_tokens: 64_000,
        },
      ],
    };
    const merged = mergeLiveModels(base, body);
    const g45 = merged.find((m) => m.id === "grok-4.5")!;
    expect(g45.contextWindow).toBe(1_000_000);
    expect(g45.maxTokens).toBe(64_000);
    expect(g45.name).toBe("Grok 4.5"); // preserved from base
    expect(g45.cost.input).toBe(2); // preserved from base
  });

  test("adds new models from live catalog", () => {
    const body = {
      data: [
        {
          id: "grok-new-1",
          context_length: 100_000,
          max_output_tokens: 16_000,
        },
      ],
    };
    const merged = mergeLiveModels(base, body);
    const newModel = merged.find((m) => m.id === "grok-new-1")!;
    expect(newModel).toBeDefined();
    expect(newModel.contextWindow).toBe(100_000);
    expect(newModel.maxTokens).toBe(16_000);
    expect(newModel.reasoning).toBe(true); // default
  });

  test("filters non-chat models", () => {
    const body = {
      data: [
        { id: "grok-4.5", context_length: 500_000 },
        { id: "grok-imagine-image", context_length: 0 },
        { id: "grok-embedding-v1", context_length: 0 },
        { id: "grok-tts-1", context_length: 0 },
      ],
    };
    const merged = mergeLiveModels(base, body);
    expect(merged.length).toBe(2); // grok-4.5 + grok-build preserved
    expect(merged.find((m) => m.id === "grok-imagine-image")).toBeUndefined();
  });

  test("routes proxy ids to CLI proxy", () => {
    const body = {
      data: [{ id: "grok-4.5", context_length: 500_000 }],
    };
    const proxyIds = new Set(["grok-4.5"]);
    const merged = mergeLiveModels(base, body, proxyIds);
    const g45 = merged.find((m) => m.id === "grok-4.5")!;
    expect(g45.baseUrl).toBe(CLI_PROXY_BASE_URL);
    expect(g45.headers).toEqual(CLI_PROXY_HEADERS);

    const build = merged.find((m) => m.id === "grok-build")!;
    expect(build.baseUrl).toBeUndefined(); // not in proxy set
  });

  test("preserves hardcoded models not in live response", () => {
    const body = {
      data: [{ id: "grok-4.5", context_length: 500_000 }],
    };
    const merged = mergeLiveModels(base, body);
    expect(merged.find((m) => m.id === "grok-build")).toBeDefined();
  });
});

describe("mergeDiscoveredModels", () => {
  test("returns base when no discovery has run", () => {
    resetDiscoveryForTests();
    expect(mergeDiscoveredModels(FALLBACK_MODELS)).toEqual(FALLBACK_MODELS);
  });
});

describe("applyDiscoveredModels", () => {
  test("returns base when no discovery + no env filter", () => {
    resetDiscoveryForTests();
    const result = applyDiscoveredModels(FALLBACK_MODELS, []);
    expect(result).toEqual(FALLBACK_MODELS);
  });

  test("applies env filter without discovery", () => {
    resetDiscoveryForTests();
    const result = applyDiscoveredModels(FALLBACK_MODELS, ["grok-4.5"]);
    expect(result.length).toBe(1);
    expect(result[0]!.id).toBe("grok-4.5");
  });
});

describe("rebuildModelsForOAuth", () => {
  const providerModels = FALLBACK_MODELS.slice(0, 2).map((m) => ({
    ...m,
    api: "openai-completions",
    provider: "xai-oauth",
  }));

  test("preserves non-provider models", () => {
    const all = [
      ...providerModels,
      {
        id: "other-model",
        name: "Other",
        provider: "other",
        api: "openai-completions",
      },
    ];
    const result = rebuildModelsForOAuth(
      all as Array<Record<string, unknown>>,
      "xai-oauth",
      XAI_PUBLIC_BASE_URL,
      [],
    );
    expect(result.some((m) => m.provider === "other")).toBe(true);
  });

  test("fills baseUrl for models without one", () => {
    const result = rebuildModelsForOAuth(
      providerModels as Array<Record<string, unknown>>,
      "xai-oauth",
      XAI_PUBLIC_BASE_URL,
      [],
    );
    for (const m of result) {
      // Only check models that didn't already have a baseUrl override.
      if (m.provider === "xai-oauth" && m.id !== "grok-composer-2.5-fast") {
        expect(m.baseUrl).toBe(XAI_PUBLIC_BASE_URL);
      }
    }
  });

  test("keeps proxy baseUrl for composer", () => {
    resetDiscoveryForTests();
    const all = FALLBACK_MODELS.map((m) => ({
      ...m,
      api: "openai-completions",
      provider: "xai-oauth",
      ...(m.baseUrl ? {} : { baseUrl: XAI_PUBLIC_BASE_URL }),
    }));
    const result = rebuildModelsForOAuth(
      all as Array<Record<string, unknown>>,
      "xai-oauth",
      XAI_PUBLIC_BASE_URL,
      [],
    );
    const composer = result.find((m) => m.id === "grok-composer-2.5-fast") as
      Record<string, unknown> | undefined;
    expect(composer).toBeDefined();
    expect(composer!.baseUrl).toBe(CLI_PROXY_BASE_URL);
  });
});
