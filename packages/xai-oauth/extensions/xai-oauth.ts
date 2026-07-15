/**
 * xAI OAuth Extension — SuperGrok / X Premium+ subscription login for pi.
 *
 * Adds "xAI Grok (SuperGrok / X Premium+)" to `/login` so you can authenticate
 * with an xAI subscription instead of an API key.
 *
 * Based on the RFC 8628 Device Authorization Grant flow, ported from
 * oh-my-pi's xai-oauth provider (which itself draws from NousResearch/hermes-agent).
 *
 * Models include live catalog discovery: on login, both api.x.ai/v1/models and
 * cli-chat-proxy.grok.com/v1/models are fetched in the background. Models
 * available on the proxy route through the subscription quota path; the rest
 * use the public API.  New models appear on the next /reload.
 *
 * Usage:
 *   pi install /path/to/piex/packages/xai-oauth
 *   # Then /login → select "xAI Grok (SuperGrok / X Premium+)"
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import {
  resolveModels,
  triggerDiscovery,
  rebuildModelsForOAuth,
  XAI_PUBLIC_BASE_URL,
} from "./models.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const XAI_OAUTH_ISSUER = "https://auth.x.ai";
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const XAI_OAUTH_DEVICE_CODE_URL = `${XAI_OAUTH_ISSUER}/oauth2/device/code`;
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";

// 5-min client-side skew, mirrors Anthropic / omp conventions
const ACCESS_TOKEN_CLIENT_SKEW_MS = 5 * 60 * 1000;
// Floor so short-lived tokens don't look already-expired after skew.
const MIN_ACCESS_TOKEN_TTL_MS = 30_000;
const ERROR_DETAIL_MAX_LEN = 200;

const DISCOVERY_TIMEOUT_MS = 15_000;
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;
const MIN_DEVICE_FLOW_INTERVAL_MS = 1000;
const SLOW_DOWN_INTERVAL_INCREMENT_MS = 5000;

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Promise.withResolvers polyfill for Node.js < 22. */
function withResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class LoginCancelledError extends Error {
  constructor(message = "Login cancelled") {
    super(message);
    this.name = "LoginCancelledError";
  }
}

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

/** Extract a short, non-sensitive error detail from an OAuth error response body. */
export function formatOAuthErrorDetail(body: string, status: number): string {
  const trimmed = body.trim();
  if (!trimmed) return String(status);
  try {
    const payload: unknown = JSON.parse(trimmed);
    if (isRecord(payload)) {
      const description = typeof payload.error_description === "string" ? payload.error_description.trim() : "";
      const code = typeof payload.error === "string" ? payload.error.trim() : "";
      const detail = description || code;
      if (detail) {
        return detail.length > ERROR_DETAIL_MAX_LEN
          ? `${detail.slice(0, ERROR_DETAIL_MAX_LEN)}…`
          : detail;
      }
    }
  } catch {
    // non-JSON body — fall through
  }
  // Avoid dumping raw bodies that might contain tokens/PII.
  if (trimmed.length > ERROR_DETAIL_MAX_LEN) {
    return `${status} ${trimmed.slice(0, ERROR_DETAIL_MAX_LEN)}…`;
  }
  return `${status} ${trimmed}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// OIDC Discovery
// ═══════════════════════════════════════════════════════════════════════════════

interface XAIOAuthDiscovery {
  token_endpoint: string;
}

/**
 * Validate an xAI OIDC endpoint against its scheme and host.
 * Rejects non-HTTPS or non-`x.ai` / `*.x.ai` hosts.
 */
export function validateXAIEndpoint(url: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OAuthError(`Invalid xAI ${field}: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new OAuthError(`Invalid xAI ${field}: ${url}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (!host || (host !== "x.ai" && !host.endsWith(".x.ai"))) {
    throw new OAuthError(`Invalid xAI ${field}: ${url}`);
  }
  return url;
}

async function xaiOAuthDiscovery(timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<XAIOAuthDiscovery> {
  let response: Response;
  try {
    response = await fetch(XAI_OAUTH_DISCOVERY_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new OAuthError(
      `xAI OIDC discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status !== 200) {
    throw new OAuthError(`xAI OIDC discovery returned status ${response.status}.`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new OAuthError(
      `xAI OIDC discovery returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(payload)) {
    throw new OAuthError("xAI OIDC discovery response was not a JSON object.");
  }
  const tokenEndpoint = typeof payload.token_endpoint === "string" ? payload.token_endpoint.trim() : "";
  if (!tokenEndpoint) {
    throw new OAuthError("xAI OIDC discovery response was missing token_endpoint.");
  }
  validateXAIEndpoint(tokenEndpoint, "token_endpoint");
  return { token_endpoint: tokenEndpoint };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Device Authorization
// ═══════════════════════════════════════════════════════════════════════════════

interface XAIDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUriComplete: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

function parseXAIDeviceAuthorization(payload: unknown): XAIDeviceAuthorization {
  if (!isRecord(payload)) {
    throw new OAuthError("xAI device-code response was not a JSON object.");
  }
  const deviceCode = typeof payload.device_code === "string" ? payload.device_code.trim() : "";
  const userCode = typeof payload.user_code === "string" ? payload.user_code.trim() : "";
  const verificationUri = typeof payload.verification_uri === "string" ? payload.verification_uri.trim() : "";
  const verificationUriComplete =
    typeof payload.verification_uri_complete === "string" ? payload.verification_uri_complete.trim() : "";
  const expiresIn = payload.expires_in;
  const interval = payload.interval;
  if (
    !deviceCode || !userCode || !verificationUri || !verificationUriComplete ||
    typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0 ||
    typeof interval !== "number" || !Number.isFinite(interval) || interval <= 0
  ) {
    throw new OAuthError("xAI device-code response missing or invalid required fields.");
  }
  validateXAIEndpoint(verificationUri, "verification_uri");
  validateXAIEndpoint(verificationUriComplete, "verification_uri_complete");
  return {
    deviceCode,
    userCode,
    verificationUriComplete,
    expiresInSeconds: expiresIn,
    intervalSeconds: interval,
  };
}

async function requestXAIDeviceAuthorization(signal?: AbortSignal): Promise<XAIDeviceAuthorization> {
  let response: Response;
  try {
    const timeoutSignal = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    response = await fetch(XAI_OAUTH_DEVICE_CODE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: XAI_OAUTH_CLIENT_ID,
        scope: XAI_OAUTH_SCOPE,
      }),
      signal: combinedSignal,
    });
  } catch (error) {
    if (signal?.aborted) throw new LoginCancelledError();
    throw new OAuthError(
      `xAI device-code request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    let detail = "";
    try {
      detail = formatOAuthErrorDetail(await response.text(), response.status);
    } catch {
      /* ignore */
    }
    throw new OAuthError(`xAI device-code request failed: ${detail || response.status}`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new OAuthError(
      `xAI device-code response returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseXAIDeviceAuthorization(payload);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Token Polling
// ═══════════════════════════════════════════════════════════════════════════════

type PollResult =
  | { status: "complete"; value: OAuthCredentials }
  | { status: "pending" }
  | { status: "slow_down" };

export function parseXAITokenResponse(
  payload: unknown,
  label: string,
  refreshTokenFallback?: string,
): OAuthCredentials {
  if (!isRecord(payload)) {
    throw new OAuthError(`${label} was not a JSON object`);
  }
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
  const responseRefreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : "";
  const refreshToken = responseRefreshToken || refreshTokenFallback || "";
  const expiresIn = payload.expires_in;
  if (!accessToken) throw new OAuthError(`${label} missing access_token`);
  if (!refreshToken) throw new OAuthError(`${label} missing refresh_token`);
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) {
    throw new OAuthError(`${label} missing expires_in`);
  }
  const expiresAt = Date.now() + expiresIn * 1000 - ACCESS_TOKEN_CLIENT_SKEW_MS;
  return {
    access: accessToken,
    refresh: refreshToken,
    expires: Math.max(Date.now() + MIN_ACCESS_TOKEN_TTL_MS, expiresAt),
  };
}

async function pollXAIDeviceToken(
  tokenEndpoint: string,
  deviceCode: string,
  signal?: AbortSignal,
): Promise<PollResult> {
  let response: Response;
  try {
    const timeoutSignal = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: XAI_OAUTH_CLIENT_ID,
        device_code: deviceCode,
      }),
      signal: combinedSignal,
    });
  } catch (error) {
    if (signal?.aborted) throw new LoginCancelledError();
    throw new OAuthError(
      `xAI device-code token polling failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new OAuthError(
      `xAI device-code token polling returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (response.ok) {
    return {
      status: "complete",
      value: parseXAITokenResponse(payload, "xAI device-code token response"),
    };
  }

  if (!isRecord(payload)) {
    throw new OAuthError(`xAI device-code token polling failed: ${response.status}`);
  }

  const errorCode = typeof payload.error === "string" ? payload.error : "";
  if (errorCode === "authorization_pending") return { status: "pending" };
  if (errorCode === "slow_down") return { status: "slow_down" };

  const errorDescription = typeof payload.error_description === "string" ? payload.error_description : "";
  const detail = errorDescription || errorCode || String(response.status);
  throw new OAuthError(`xAI device-code token polling failed: ${detail}`);
}

async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((r) => setTimeout(r, ms));
    return;
  }
  if (signal.aborted) throw new LoginCancelledError();
  const { promise, resolve, reject } = withResolvers<void>();
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  const onAbort = () => {
    clearTimeout(timer);
    reject(new LoginCancelledError());
  };
  signal.addEventListener("abort", onAbort, { once: true });
  await promise;
}

export async function pollDeviceCodeFlow(
  poll: () => Promise<PollResult>,
  intervalSeconds: number,
  expiresInSeconds: number,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  const deadline = Date.now() + expiresInSeconds * 1000;
  let intervalMs = Math.max(MIN_DEVICE_FLOW_INTERVAL_MS, Math.floor(intervalSeconds * 1000));
  let slowDownCount = 0;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new LoginCancelledError();

    const result = await poll();
    if (result.status === "complete") return result.value;

    if (result.status === "slow_down") {
      slowDownCount++;
      intervalMs = Math.max(MIN_DEVICE_FLOW_INTERVAL_MS, intervalMs + SLOW_DOWN_INTERVAL_INCREMENT_MS);
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    await abortableSleep(Math.min(intervalMs, remaining), signal);
  }

  const msg = slowDownCount > 0
    ? "Device flow timed out after slow_down responses. This may be caused by clock drift. Try syncing your clock."
    : "Device flow timed out";
  throw new OAuthError(msg);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Token Refresh
// ═══════════════════════════════════════════════════════════════════════════════

async function refreshXAIToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  if (typeof credentials.refresh !== "string" || !credentials.refresh.trim()) {
    throw new OAuthError("missing refresh_token");
  }

  // Re-discover token endpoint (it's long-lived but discovery ensures we get the current one)
  const discovery = await xaiOAuthDiscovery();
  const tokenEndpoint = validateXAIEndpoint(discovery.token_endpoint, "token_endpoint");

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: XAI_OAUTH_CLIENT_ID,
      refresh_token: credentials.refresh,
    }),
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    let detail = "";
    try {
      detail = formatOAuthErrorDetail(await response.text(), response.status);
    } catch {
      /* ignore */
    }
    throw new OAuthError(`xAI token refresh failed: ${detail || response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new OAuthError(
      `xAI token refresh returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return parseXAITokenResponse(payload, "xAI token refresh response", credentials.refresh);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Login entry point — called by pi's /login flow
// ═══════════════════════════════════════════════════════════════════════════════

async function loginXAIOAuth(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const signal = callbacks.signal;

  // 1. OIDC discovery
  const discovery = await xaiOAuthDiscovery();

  // 2. Request device code
  const device = await requestXAIDeviceAuthorization(signal);

  // 3. Show verification URL (pi opens browser + shows instructions)
  callbacks.onAuth({
    url: device.verificationUriComplete,
    instructions: `Enter code: ${device.userCode}`,
  });
  callbacks.onProgress?.("Waiting for xAI device authorization...");

  // 4. Poll for token (signal enables /login cancel)
  return pollDeviceCodeFlow(
    () => pollXAIDeviceToken(discovery.token_endpoint, device.deviceCode, signal),
    device.intervalSeconds,
    device.expiresInSeconds,
    signal,
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Extension entry point
// ═══════════════════════════════════════════════════════════════════════════════

export default async function xaiOAuthExtension(pi: ExtensionAPI) {
  const models = resolveModels();

  pi.registerProvider("xai-oauth", {
    name: "xAI Grok (SuperGrok / X Premium+)",
    baseUrl: XAI_PUBLIC_BASE_URL,
    api: "openai-completions",
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: m.input,
      cost: m.cost,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      compat: m.compat,
      ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
      ...(m.headers ? { headers: m.headers } : {}),
    })),
    oauth: {
      name: "xAI Grok (SuperGrok / X Premium+)",
      login: loginXAIOAuth,
      refreshToken: refreshXAIToken,
      getApiKey: (cred: OAuthCredentials) => cred.access,

      modifyModels(models: unknown, credentials: unknown) {
        const creds = credentials as Record<string, unknown>;
        const effectiveBaseUrl = String(creds.baseUrl ?? XAI_PUBLIC_BASE_URL).replace(/\/+$/, "");

        // Kick off background live-catalog fetch. Cache populates asynchronously;
        // the next /reload picks up new models.
        if (creds.access) {
          triggerDiscovery(String(creds.access), effectiveBaseUrl);
        }

        return rebuildModelsForOAuth(
          models as Array<Record<string, unknown>>,
          "xai-oauth",
          effectiveBaseUrl,
        );
      },
    },
  });
}
