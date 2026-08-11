/**
 * Gateway Extension — gpt-5.6-sol provider for pi.
 *
 * Routes pi requests to an internal OpenAI-compatible model gateway,
 * exposing the `gpt-5.6-sol` model as a normal pi provider.
 *
 * The gateway is OpenAI Chat Completions compatible (SSE streaming, tool
 * calls, usage in the final chunk), but differs from stock OpenAI in two ways:
 * - The endpoint path is fixed at `/crawl` — no `/chat/completions` suffix.
 * - Auth is a `?ak=<key>` query parameter instead of `Authorization: Bearer`.
 * - Every request needs an `X-TT-LOGID` header (link-tracing id, any value).
 *
 * The gateway endpoint is internal and not hardcoded: provide it via the
 * `AIDP_BASE_URL` env var (e.g. `https://<internal-host>/.../v2/crawl`).
 * When `AIDP_BASE_URL` is unset, the provider is not registered and a warning
 * is shown instead of failing at request time.
 *
 * Instead of reimplementing SSE parsing, we reuse pi-ai's `openai-completions`
 * `stream` and inject a wrapper `fetch` (an officially supported
 * `ProviderRequestOptions` hook) that rewrites the URL/auth/headers on the
 * wire. All streaming semantics (tool calls, thinking, usage, retries) come
 * from pi-ai unchanged.
 *
 * Usage:
 *   pi install /path/to/piex/extensions/aidp
 *   export AIDP_BASE_URL=<gateway endpoint>
 *   export AIDP_API_KEY=<your ak>
 *   pi -m aidp/gpt-5.6-sol "hello"
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import {
  modelDisplayName,
  parseJsonModelIds,
  parseModelIds,
} from "./models.ts";
import { wrapGatewayFetch } from "./request.ts";

// Lazy wrapper that loads pi-ai's openai-completions implementation on first
// call and forwards options (including the injected fetch) unchanged.
// NOTE: `@earendil-works/pi-ai/compat` is a temporary compatibility entrypoint
// (the current npm release does not export openAICompletionsApi from the main
// entry). If a pi upgrade breaks this import, migrate to the main entry.
const openaiCompletions = openAICompletionsApi();

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

// No public pricing for the internal gateway; keep usage tracking at zero.
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// Model parameters are estimates (no official docs). Which ids are registered
// is decided in this order:
// 1. models.json `providers.aidp.models` — full control from the user config
//    (the extension then declares no models, pi keeps the models.json list).
// 2. AIDP_MODELS env var (comma-separated), defaulting to gpt-5.6-sol.
// models.json `modelOverrides` can tweak per-model parameters in both modes.
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;

// ═══════════════════════════════════════════════════════════════════════════════
// Stream
// ═══════════════════════════════════════════════════════════════════════════════

/** Error stream with a clear message, used when no API key is configured. */
function missingKeyStream(
  model: Model<"openai-completions">,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage:
      "Provider aidp requires an API key: set the AIDP_API_KEY env var, " +
      "or configure an apiKey for this provider in models.json.",
    timestamp: Date.now(),
  };
  stream.push({ type: "error", reason: "error", error: output });
  stream.end();
  return stream;
}

function streamGateway(
  model: Model<"openai-completions">,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const apiKey = options?.apiKey?.trim();
  if (!apiKey) {
    return missingKeyStream(model);
  }
  return openaiCompletions.streamSimple(model, context, {
    ...options,
    fetch: wrapGatewayFetch(apiKey),
  });
}

/**
 * Model ids declared in `~/.pi/agent/models.json` under `providers.aidp.models`,
 * or undefined when absent/unreadable (fall back to AIDP_MODELS env).
 */
function readJsonModelIds(): string[] | undefined {
  try {
    return parseJsonModelIds(
      readFileSync(join(getAgentDir(), "models.json"), "utf8"),
    );
  } catch {
    return undefined;
  }
}

/** Build the provider model list from env var (not used in models.json mode). */
function envModelList(): ProviderModelConfig[] {
  return parseModelIds(process.env.AIDP_MODELS).map((id) => ({
    id,
    name: modelDisplayName(id),
    reasoning: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: {
      // curl examples use max_tokens; keep parity with the gateway.
      maxTokensField: "max_tokens",
      // gpt-5.6-sol rejects reasoning_effort with tools on /chat/completions;
      // the model thinks on its own and streams thoughts into the reply body.
      supportsReasoningEffort: false,
    },
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Extension entry point
// ═══════════════════════════════════════════════════════════════════════════════

export default function gatewayExtension(pi: ExtensionAPI) {
  const baseUrl = process.env.AIDP_BASE_URL?.trim();
  const jsonModelIds = readJsonModelIds();
  if (!baseUrl && !jsonModelIds) {
    pi.ui.notify(
      'Provider "aidp" not registered: set the AIDP_BASE_URL env var to the internal gateway endpoint, ' +
        "or define providers.aidp in models.json.",
      "warning",
    );
    return;
  }
  pi.registerProvider("aidp", {
    name: "AIDP",
    // models.json mode: leave baseUrl unset so pi keeps the models.json baseUrl
    // for each model (passing AIDP_BASE_URL here would override it in pi's
    // composition); env mode: AIDP_BASE_URL applies to all registered models.
    baseUrl: jsonModelIds ? undefined : baseUrl,
    apiKey: "$AIDP_API_KEY",
    api: "openai-completions",
    streamSimple: streamGateway,
    // models.json mode: declare no models — pi's composition keeps the
    // providers.aidp.models list from the user config (models must carry
    // `api: "openai-completions"` and `baseUrl` to satisfy pi's validation).
    ...(jsonModelIds ? {} : { models: envModelList() }),
  });
}
