import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const COMMAND = "gpt-fast";
const FLAG = "fast";
const STATUS_KEY = "gpt-fast-mode";
const CODEX_PROVIDER = "openai-codex";
const CODEX_API = "openai-codex-responses";
export const FAST_SERVICE_TIER = "priority";

/**
 * OpenAI currently exposes Fast mode for these ChatGPT-auth Codex models.
 * Keep this allowlist explicit: unsupported models can reject priority tier or
 * consume quota under different semantics.
 */
export const SUPPORTED_MODELS = Object.freeze([
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6-astra",
] as const);

const SUPPORTED_MODEL_SET: ReadonlySet<string> = new Set(SUPPORTED_MODELS);

const COMMAND_ARGS = ["on", "off", "status"] as const;

type PayloadRecord = Record<string, unknown>;

export interface FastModel {
  provider: string;
  id: string;
  api?: string;
}

export interface Eligibility {
  eligible: boolean;
  modelKey: string;
  reason?: string;
}

function isPayloadRecord(payload: unknown): payload is PayloadRecord {
  return (
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
  );
}

export function getEligibility(
  model: FastModel | undefined,
  usingOAuth: boolean,
): Eligibility {
  if (!model) {
    return {
      eligible: false,
      modelKey: "no model",
      reason: "no model is selected",
    };
  }

  const modelKey = `${model.provider}/${model.id}`;
  if (model.provider !== CODEX_PROVIDER) {
    return {
      eligible: false,
      modelKey,
      reason: `provider ${model.provider} is not ${CODEX_PROVIDER}`,
    };
  }
  if (model.api !== CODEX_API) {
    return {
      eligible: false,
      modelKey,
      reason: `API ${model.api ?? "unknown"} is not ${CODEX_API}`,
    };
  }
  if (!SUPPORTED_MODEL_SET.has(model.id)) {
    return {
      eligible: false,
      modelKey,
      reason: `${model.id} does not support Codex Fast mode`,
    };
  }
  if (!usingOAuth) {
    return {
      eligible: false,
      modelKey,
      reason: "ChatGPT OAuth authentication is required",
    };
  }

  return { eligible: true, modelKey };
}

interface FastRequestState {
  priorityAtHook: boolean;
  reason?: string;
}

interface FastState {
  enabled: boolean;
  lastRequest?: FastRequestState;
}

interface FastTierDecision extends FastRequestState {
  replacement?: PayloadRecord;
}

function getFastTierDecision(
  payload: unknown,
  model: FastModel | undefined,
  usingOAuth: boolean,
): FastTierDecision {
  const eligibility = getEligibility(model, usingOAuth);
  if (!eligibility.eligible) {
    return {
      priorityAtHook: false,
      reason: eligibility.reason ?? "the current model is not eligible",
    };
  }
  if (!isPayloadRecord(payload)) {
    return {
      priorityAtHook: false,
      reason: "provider payload is not an object",
    };
  }
  if (payload.model !== model?.id) {
    return {
      priorityAtHook: false,
      reason: "provider payload model does not match the selected model",
    };
  }
  if ("service_tier" in payload) {
    if (payload.service_tier === FAST_SERVICE_TIER) {
      return { priorityAtHook: true };
    }
    return {
      priorityAtHook: false,
      reason: "provider payload already defines a non-priority service_tier",
    };
  }

  return {
    priorityAtHook: true,
    replacement: {
      ...payload,
      service_tier: FAST_SERVICE_TIER,
    },
  };
}

/**
 * Return a replacement provider payload only when every Fast-mode gate passes.
 * Existing service_tier values from earlier hooks are left untouched.
 */
export function injectFastServiceTier(
  payload: unknown,
  model: FastModel | undefined,
  usingOAuth: boolean,
): PayloadRecord | undefined {
  return getFastTierDecision(payload, model, usingOAuth).replacement;
}

function isUsingOAuth(ctx: ExtensionContext): boolean {
  return Boolean(ctx.model && ctx.modelRegistry.isUsingOAuth(ctx.model));
}

function eligibilityFor(ctx: ExtensionContext): Eligibility {
  return getEligibility(ctx.model, isUsingOAuth(ctx));
}

function updateStatus(ctx: ExtensionContext, state: FastState): void {
  if (!ctx.hasUI) return;
  const active =
    state.enabled &&
    eligibilityFor(ctx).eligible &&
    state.lastRequest?.priorityAtHook !== false;
  ctx.ui.setStatus(
    STATUS_KEY,
    active ? ctx.ui.theme.fg("accent", "fast") : undefined,
  );
}

function describeState(
  ctx: ExtensionContext,
  state: FastState,
): {
  message: string;
  level: "info" | "warning";
} {
  const eligibility = eligibilityFor(ctx);
  if (!state.enabled) {
    return {
      message: `GPT Fast mode is off. Current model: ${eligibility.modelKey}.`,
      level: "info",
    };
  }
  if (!eligibility.eligible) {
    return {
      message: `GPT Fast mode is on but inactive for ${eligibility.modelKey}: ${eligibility.reason}.`,
      level: "warning",
    };
  }
  if (state.lastRequest?.priorityAtHook === false) {
    return {
      message: `GPT Fast mode is on but inactive at this extension's hook for the last ${eligibility.modelKey} request: ${state.lastRequest.reason}.`,
      level: "warning",
    };
  }
  if (state.lastRequest?.priorityAtHook === true) {
    return {
      message: `GPT Fast mode is on for ${eligibility.modelKey}; at this extension's hook, the last request payload had service_tier=${FAST_SERVICE_TIER}. Later payload hooks may still change the final request.`,
      level: "info",
    };
  }
  return {
    message: `GPT Fast mode is on and ready for ${eligibility.modelKey}; eligible request payloads get service_tier=${FAST_SERVICE_TIER} unless a tier is already set when this extension's hook runs.`,
    level: "info",
  };
}

function notifyState(
  ctx: ExtensionContext,
  state: FastState,
  forceInfo = false,
): void {
  const { message, level } = describeState(ctx, state);
  ctx.ui.notify(message, forceInfo ? "info" : level);
}

export default function gptFastModeExtension(pi: ExtensionAPI): void {
  const states = new WeakMap<object, FastState>();

  function getState(ctx: ExtensionContext): FastState {
    let state = states.get(ctx.sessionManager);
    if (!state) {
      state = { enabled: false };
      states.set(ctx.sessionManager, state);
    }
    return state;
  }

  function setEnabled(ctx: ExtensionContext, next: boolean): void {
    const state = getState(ctx);
    const changed = state.enabled !== next;
    state.enabled = next;
    if (changed) state.lastRequest = undefined;
    updateStatus(ctx, state);
    notifyState(ctx, state);
  }

  pi.registerFlag(FLAG, {
    description: "Start with GPT Fast mode enabled",
    type: "boolean",
    default: false,
  });

  pi.registerCommand(COMMAND, {
    description: "Toggle GPT Fast mode for supported OpenAI Codex models",
    getArgumentCompletions: (prefix) => {
      const items = COMMAND_ARGS.filter((value) =>
        value.startsWith(prefix),
      ).map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      const state = getState(ctx);
      if (!action) {
        setEnabled(ctx, !state.enabled);
        return;
      }

      switch (action) {
        case "on":
          setEnabled(ctx, true);
          return;
        case "off":
          setEnabled(ctx, false);
          return;
        case "status":
          updateStatus(ctx, state);
          notifyState(ctx, state, true);
          return;
        default:
          ctx.ui.notify("Usage: /gpt-fast [on|off|status]", "error");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const state: FastState = { enabled: pi.getFlag(FLAG) === true };
    states.set(ctx.sessionManager, state);
    updateStatus(ctx, state);
  });

  pi.on("model_select", (_event, ctx) => {
    const state = getState(ctx);
    state.lastRequest = undefined;
    updateStatus(ctx, state);
  });

  pi.on("turn_start", (_event, ctx) => {
    updateStatus(ctx, getState(ctx));
  });

  pi.on("before_provider_request", (event, ctx) => {
    const state = getState(ctx);
    if (!state.enabled) return undefined;

    const decision = getFastTierDecision(
      event.payload,
      ctx.model,
      isUsingOAuth(ctx),
    );
    state.lastRequest = {
      priorityAtHook: decision.priorityAtHook,
      reason: decision.reason,
    };
    updateStatus(ctx, state);

    // This public hook changes the serialized body, not the provider's separate
    // serviceTier option. See the package docs for the cost-estimate limitation.
    return decision.replacement;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    states.delete(ctx.sessionManager);
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}

export const __test__ = {
  COMMAND,
  FLAG,
  STATUS_KEY,
  CODEX_PROVIDER,
  CODEX_API,
  COMMAND_ARGS,
  describeState,
};
