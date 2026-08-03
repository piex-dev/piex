/**
 * Request building for the internal OpenAI-compatible model gateway.
 *
 * The gateway differs from stock OpenAI Chat Completions:
 * - Endpoint path is fixed at `/crawl` — the OpenAI SDK appends `/chat/completions`.
 * - Auth is a `?ak=<key>` query parameter (`Authorization` header is ignored).
 * - Every request needs an `X-TT-LOGID` header (link-tracing id, any value).
 */

/** Fresh link-tracing id for the gateway-required X-TT-LOGID header. Any value is accepted. */
export function makeLogId(): string {
  return `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface GatewayRequest {
  url: string;
  headers: Headers;
}

/**
 * Build the gateway request from the OpenAI SDK's outgoing request:
 * 1. Strip the `/chat/completions` suffix the SDK appends to baseUrl.
 * 2. Put the API key into `?ak=`.
 * 3. Drop the SDK's `Authorization` header (the gateway ignores it, but keep the wire clean).
 * 4. Add `X-TT-LOGID`.
 *
 * Pure function; the actual `fetch` call stays in `wrapGatewayFetch` so the
 * rewrite logic is unit-testable without network access.
 */
export function buildGatewayRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  apiKey: string,
): GatewayRequest {
  const rawUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const url = new URL(rawUrl);
  url.pathname = url.pathname.replace(/\/chat\/completions$/, "");
  url.searchParams.set("ak", apiKey);
  const headers = new Headers(init?.headers);
  headers.delete("authorization");
  headers.set("X-TT-LOGID", makeLogId());
  return { url: url.toString(), headers };
}

/** Wrap fetch so requests hit the real gateway endpoint with query-param auth. */
export function wrapGatewayFetch(apiKey: string): typeof fetch {
  return async (input, init) => {
    const { url, headers } = buildGatewayRequest(input, init, apiKey);
    return fetch(url, { ...init, headers });
  };
}
