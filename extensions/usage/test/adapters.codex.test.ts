/**
 * OpenAI Codex quota adapter tests.
 *
 * Codex backend: GET https://chatgpt.com/backend-api/wham/usage
 * (ChatGPT subscription quota; reset_at is epoch SECONDS).
 *
 * Run: bun test extensions/usage/test/adapters.codex.test.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  codexAdapter,
  adapterForProvider,
  type AdapterFetchContext,
} from "../src/adapters.ts";

const ORIGINAL_FETCH = globalThis.fetch;
const NOW_SECONDS = Math.floor(Date.now() / 1000);

interface CtxOptions {
  modelBaseUrl?: string;
  authBaseUrl?: string;
  useAuthHeader?: boolean;
}

function makeCtx(
  token = "t-123",
  options: CtxOptions = {},
): AdapterFetchContext {
  return {
    provider: "openai-codex",
    model: {
      provider: "openai-codex",
      baseUrl: options.modelBaseUrl ?? "https://chatgpt.com/backend-api/codex",
    },
    modelRegistry: {
      async getProviderAuth() {
        return {
          auth: {
            ...(options.useAuthHeader
              ? { headers: { Authorization: `Bearer ${token}` } }
              : { apiKey: token }),
            baseUrl: options.authBaseUrl,
          },
        };
      },
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockPayload(body: unknown, status = 200): void {
  globalThis.fetch = () => Promise.resolve(jsonResponse(body, status));
}

const fullPayload = {
  plan_type: "pro",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 60,
      limit_window_seconds: 18_000,
      reset_after_seconds: 3_600,
      reset_at: NOW_SECONDS + 3_600,
    },
    secondary_window: {
      used_percent: 80,
      limit_window_seconds: 604_800,
      reset_after_seconds: 86_400,
      reset_at: NOW_SECONDS + 604_800,
    },
  },
  credits: { has_credits: true, unlimited: false, balance: "12" },
  rate_limit_reset_credits: { available_count: 2 },
  additional_rate_limits: [
    {
      limit_name: "GPT-5.3 Codex Spark",
      metered_feature: "gpt-5.3-codex-spark",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 10,
          limit_window_seconds: 18_000,
          reset_at: NOW_SECONDS + 18_000,
        },
      },
    },
  ],
};

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("codex adapter", () => {
  test("matches the openai-codex provider id", () => {
    expect(codexAdapter.providerIds).toContain("openai-codex");
    expect(adapterForProvider("openai-codex")).toBe(codexAdapter);
    expect(adapterForProvider("other")).toBeUndefined();
  });

  test("fetches wham/usage with bearer auth and parses windows + credits", async () => {
    let requestedUrl: string | undefined;
    let requestedAuth: string | undefined;
    globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(url);
      requestedAuth = String(
        (init?.headers as Record<string, string>).Authorization,
      );
      return Promise.resolve(jsonResponse(fullPayload));
    }) as typeof fetch;

    const snapshot = await codexAdapter.fetch(
      makeCtx("t-abc", { useAuthHeader: true }),
    );

    expect(requestedUrl).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(requestedAuth).toBe("Bearer t-abc");
    expect(snapshot.segments.map((s) => s.text)).toEqual([
      "5H:60%",
      "7D:80%",
      "Spark 5H:10%",
      "Credits:12",
    ]);
    expect(snapshot.segments[0]?.ratio).toBe(0.6);
    expect(snapshot.segments[0]?.countdownMs).toBeGreaterThan(0);
    expect(snapshot.detail[0]).toBe("OpenAI Codex (Pro)");
    expect(snapshot.detail.join("\n")).toContain("Primary limit: 60% used");
    expect(snapshot.detail.join("\n")).toContain("Secondary limit: 80% used");
    expect(snapshot.detail.join("\n")).toContain("Credits: 12 available");
    expect(snapshot.detail.join("\n")).toContain("usage limit resets: 2");
    expect(snapshot.detail.join("\n")).toContain(
      "GPT-5.3 Codex Spark Primary limit: 10% used",
    );
  });

  test("supports credits-only payloads instead of reporting offline", async () => {
    mockPayload({
      plan_type: "pro",
      credits: { has_credits: true, unlimited: false, balance: "12" },
    });
    expect(
      (await codexAdapter.fetch(makeCtx())).segments.map((s) => s.text),
    ).toEqual(["Credits:12"]);

    mockPayload({
      plan_type: "pro",
      credits: { has_credits: true, unlimited: false },
    });
    expect(
      (await codexAdapter.fetch(makeCtx())).segments.map((s) => s.text),
    ).toEqual(["Credits:available"]);

    mockPayload({ plan_type: "pro", credits: { has_credits: false } });
    expect(
      (await codexAdapter.fetch(makeCtx())).segments.map((s) => s.text),
    ).toEqual(["Credits:none"]);
  });

  test("unlimited credits render as ∞ segment", async () => {
    mockPayload({
      plan_type: "team",
      rate_limit: fullPayload.rate_limit,
      credits: { has_credits: true, unlimited: true },
    });
    const snapshot = await codexAdapter.fetch(makeCtx());
    expect(snapshot.segments.map((s) => s.text)).toContain("Credits:∞");
    expect(snapshot.detail).toContain("Credits: unlimited");
    expect(snapshot.detail[0]).toBe("OpenAI Codex (Team)");
  });

  test("no credits omits the fallback while windows are present", async () => {
    mockPayload({
      plan_type: "free",
      rate_limit: fullPayload.rate_limit,
      credits: { has_credits: false },
    });
    const snapshot = await codexAdapter.fetch(makeCtx());
    expect(snapshot.segments.map((s) => s.text)).toEqual(["5H:60%", "7D:80%"]);
    expect(snapshot.detail).toContain("Credits: none");
  });

  test("surfaces denied or exhausted accounts as an error segment", async () => {
    mockPayload({
      plan_type: "pro",
      rate_limit: { allowed: false, limit_reached: true },
      rate_limit_reached_type: {
        type: "workspace_member_credits_depleted",
      },
    });
    const snapshot = await codexAdapter.fetch(makeCtx());
    expect(snapshot.segments[0]).toEqual({
      text: "Codex limited",
      tone: "error",
    });
    expect(snapshot.detail.join("\n")).toContain(
      "status: limited (workspace member credits depleted)",
    );
  });

  test("preserves both additional windows and surfaces the nearest limit", async () => {
    mockPayload({
      plan_type: "pro",
      additional_rate_limits: [
        {
          limit_name: "GPT-5.3 Codex Spark",
          rate_limit: {
            primary_window: {
              used_percent: 10,
              limit_window_seconds: 18_000,
              reset_at: NOW_SECONDS + 18_000,
            },
            secondary_window: {
              used_percent: 95,
              limit_window_seconds: 604_800,
              reset_at: NOW_SECONDS + 604_800,
            },
          },
        },
      ],
    });
    const snapshot = await codexAdapter.fetch(makeCtx());
    expect(snapshot.segments.map((s) => s.text)).toEqual(["Spark 7D:95%"]);
    expect(snapshot.detail.join("\n")).toContain(
      "GPT-5.3 Codex Spark Primary limit: 10% used",
    );
    expect(snapshot.detail.join("\n")).toContain(
      "GPT-5.3 Codex Spark Secondary limit: 95% used",
    );
    expect(
      snapshot.detail.filter((line) => line.includes("resets")),
    ).toHaveLength(2);
  });

  test("does not fabricate reset times or 0M window labels", async () => {
    mockPayload({
      plan_type: "pro",
      rate_limit: { primary_window: { used_percent: 30 } },
      additional_rate_limits: [
        {
          limit_name: "GPT-5.3 Codex Spark",
          rate_limit: { primary_window: { used_percent: 40 } },
        },
      ],
    });
    const snapshot = await codexAdapter.fetch(makeCtx());
    expect(snapshot.segments.map((s) => s.text)).toEqual([
      "Primary:30%",
      "Spark Limit:40%",
    ]);
    expect(snapshot.detail.join("\n")).not.toContain("resets");
    expect(snapshot.detail.join("\n")).not.toContain("0M");
  });

  test("uses reset_after_seconds when reset_at is absent", async () => {
    mockPayload({
      plan_type: "pro",
      rate_limit: {
        primary_window: {
          used_percent: 30,
          limit_window_seconds: 18_000,
          reset_after_seconds: 3_600,
        },
      },
    });
    const snapshot = await codexAdapter.fetch(makeCtx());
    const countdown = snapshot.segments[0]?.countdownMs ?? 0;
    expect(countdown).toBeGreaterThan(3_000_000);
    expect(countdown).toBeLessThan(3_700_000);
  });

  test("rejects custom model and auth origins before sending credentials", async () => {
    let fetchCalled = false;
    globalThis.fetch = () => {
      fetchCalled = true;
      return Promise.resolve(jsonResponse(fullPayload));
    };

    await expect(
      codexAdapter.fetch(
        makeCtx("proxy-token", { modelBaseUrl: "https://proxy.example/v1" }),
      ),
    ).rejects.toThrow("custom model base URL");
    await expect(
      codexAdapter.fetch(
        makeCtx("proxy-token", { authBaseUrl: "https://proxy.example/v1" }),
      ),
    ).rejects.toThrow("proxy-resolved credentials");
    expect(fetchCalled).toBeFalse();
  });

  test("throws when payload has no displayable data", async () => {
    mockPayload({ plan_type: "pro" });
    await expect(codexAdapter.fetch(makeCtx())).rejects.toThrow(
      "has no quota data",
    );
  });

  test("throws on non-2xx response", async () => {
    mockPayload({ error: "nope" }, 401);
    await expect(codexAdapter.fetch(makeCtx())).rejects.toThrow("returned 401");
  });
});
