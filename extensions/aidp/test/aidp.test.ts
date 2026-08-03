/**
 * Unit tests for aidp request building (no live network).
 * Run: bun test extensions/aidp/test/aidp.test.ts
 */
import { describe, expect, test } from "bun:test";
import { buildGatewayRequest, wrapGatewayFetch } from "../src/request.ts";

const BASE = "https://internal.example.com/api/modelhub/online/v2/crawl";

describe("buildGatewayRequest", () => {
  test("strips the /chat/completions suffix appended by the OpenAI SDK", () => {
    const { url } = buildGatewayRequest(
      `${BASE}/chat/completions`,
      undefined,
      "secret-ak",
    );
    expect(url.startsWith(`${BASE}?`)).toBe(true);
    expect(url).not.toContain("/chat/completions");
  });

  test("injects the API key as the ak query param", () => {
    const { url } = buildGatewayRequest(
      `${BASE}/chat/completions`,
      undefined,
      "secret-ak",
    );
    expect(new URL(url).searchParams.get("ak")).toBe("secret-ak");
  });

  test("drops the SDK Authorization header", () => {
    const { headers } = buildGatewayRequest(
      `${BASE}/chat/completions`,
      { headers: { Authorization: "Bearer sk-test" } },
      "secret-ak",
    );
    expect(headers.get("authorization")).toBeNull();
  });

  test("adds an X-TT-LOGID header", () => {
    const { headers } = buildGatewayRequest(
      `${BASE}/chat/completions`,
      undefined,
      "secret-ak",
    );
    expect(headers.get("X-TT-LOGID")).toBeTruthy();
  });

  test("keeps existing query params", () => {
    const { url } = buildGatewayRequest(
      `${BASE}/chat/completions?foo=bar`,
      undefined,
      "secret-ak",
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get("foo")).toBe("bar");
    expect(parsed.searchParams.get("ak")).toBe("secret-ak");
  });

  test("accepts URL object input", () => {
    const { url } = buildGatewayRequest(
      new URL(`${BASE}/chat/completions`),
      undefined,
      "secret-ak",
    );
    expect(new URL(url).pathname).toBe("/api/modelhub/online/v2/crawl");
  });
});

describe("wrapGatewayFetch", () => {
  test("calls fetch with the rewritten URL and headers, preserving other init fields", async () => {
    const calls: Array<{ input: unknown; init?: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response("ok");
    };
    try {
      const wrapped = wrapGatewayFetch("secret-ak");
      const res = await wrapped(`${BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: "Bearer sk-test",
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(await res.text()).toBe("ok");
      expect(calls).toHaveLength(1);
      const call = calls[0];
      expect(String(call.input)).toContain("ak=secret-ak");
      expect(String(call.input)).not.toContain("/chat/completions");
      const headers = new Headers(call.init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("X-TT-LOGID")).toBeTruthy();
      expect(headers.get("content-type")).toBe("application/json");
      expect(call.init?.method).toBe("POST");
      expect(call.init?.body).toBe("{}");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
