/**
 * Unit tests for xai-oauth helpers (no live network).
 * Run: bun test packages/xai-oauth/extensions/xai-oauth.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  formatOAuthErrorDetail,
  LoginCancelledError,
  OAuthError,
  parseXAITokenResponse,
  pollDeviceCodeFlow,
  validateXAIEndpoint,
} from "./extensions/xai-oauth.ts";

describe("validateXAIEndpoint", () => {
  test("accepts https x.ai hosts", () => {
    expect(validateXAIEndpoint("https://auth.x.ai/oauth2/token", "token_endpoint")).toBe(
      "https://auth.x.ai/oauth2/token",
    );
    expect(validateXAIEndpoint("https://x.ai/device", "verification_uri")).toBe("https://x.ai/device");
  });

  test("rejects non-https", () => {
    expect(() => validateXAIEndpoint("http://auth.x.ai/oauth2/token", "token_endpoint")).toThrow(OAuthError);
  });

  test("rejects non-x.ai hosts", () => {
    expect(() => validateXAIEndpoint("https://evil.example/oauth2/token", "token_endpoint")).toThrow(OAuthError);
    expect(() => validateXAIEndpoint("https://x.ai.evil.com/oauth2/token", "token_endpoint")).toThrow(OAuthError);
  });

  test("rejects invalid URL", () => {
    expect(() => validateXAIEndpoint("not-a-url", "token_endpoint")).toThrow(OAuthError);
  });
});

describe("parseXAITokenResponse", () => {
  test("parses valid payload and applies client skew floor", () => {
    const before = Date.now();
    const creds = parseXAITokenResponse(
      {
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
      },
      "test",
    );
    expect(creds.access).toBe("access-1");
    expect(creds.refresh).toBe("refresh-1");
    // 3600s - 5min skew ≈ 3300s from now
    expect(creds.expires).toBeGreaterThan(before + 3000_000);
    expect(creds.expires).toBeLessThan(before + 3600_000);
  });

  test("floors short-lived tokens so expires is not in the past", () => {
    const before = Date.now();
    const creds = parseXAITokenResponse(
      {
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 60, // 1 min < 5 min skew
      },
      "test",
    );
    expect(creds.expires).toBeGreaterThanOrEqual(before + 30_000 - 5);
  });

  test("falls back to previous refresh token", () => {
    const creds = parseXAITokenResponse(
      {
        access_token: "access-2",
        expires_in: 3600,
      },
      "refresh",
      "old-refresh",
    );
    expect(creds.refresh).toBe("old-refresh");
  });

  test("rejects missing fields", () => {
    expect(() => parseXAITokenResponse({}, "test")).toThrow(/missing access_token/);
    expect(() =>
      parseXAITokenResponse({ access_token: "a", expires_in: 10 }, "test"),
    ).toThrow(/missing refresh_token/);
    expect(() =>
      parseXAITokenResponse({ access_token: "a", refresh_token: "r" }, "test"),
    ).toThrow(/missing expires_in/);
  });
});

describe("formatOAuthErrorDetail", () => {
  test("prefers error_description from JSON", () => {
    expect(
      formatOAuthErrorDetail(JSON.stringify({ error: "invalid_grant", error_description: "token expired" }), 400),
    ).toBe("token expired");
  });

  test("falls back to error code", () => {
    expect(formatOAuthErrorDetail(JSON.stringify({ error: "slow_down" }), 400)).toBe("slow_down");
  });

  test("truncates long non-JSON bodies", () => {
    const body = "x".repeat(500);
    const detail = formatOAuthErrorDetail(body, 500);
    expect(detail.startsWith("500 ")).toBe(true);
    expect(detail.endsWith("…")).toBe(true);
    expect(detail.length).toBeLessThan(body.length);
  });
});

describe("pollDeviceCodeFlow", () => {
  test("returns on complete", async () => {
    const creds = await pollDeviceCodeFlow(
      async () => ({
        status: "complete",
        value: { access: "a", refresh: "r", expires: Date.now() + 60_000 },
      }),
      1,
      30,
    );
    expect(creds.access).toBe("a");
  });

  test("handles pending then complete", async () => {
    let n = 0;
    const creds = await pollDeviceCodeFlow(
      async () => {
        n++;
        if (n === 1) return { status: "pending" };
        return {
          status: "complete",
          value: { access: "a2", refresh: "r2", expires: Date.now() + 60_000 },
        };
      },
      0.01, // 10ms interval
      5,
    );
    expect(creds.access).toBe("a2");
    expect(n).toBe(2);
  });

  test("aborts on signal", async () => {
    const controller = new AbortController();
    const promise = pollDeviceCodeFlow(
      async () => {
        controller.abort();
        return { status: "pending" };
      },
      1,
      30,
      controller.signal,
    );
    await expect(promise).rejects.toBeInstanceOf(LoginCancelledError);
  });

  test("times out", async () => {
    await expect(
      pollDeviceCodeFlow(async () => ({ status: "pending" }), 0.01, 0.05),
    ).rejects.toThrow(/timed out/);
  });

  test("slow_down then timeout message mentions clock drift", async () => {
    await expect(
      pollDeviceCodeFlow(async () => ({ status: "slow_down" }), 0.01, 0.05),
    ).rejects.toThrow(/clock drift/);
  });
});
