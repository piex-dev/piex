import { describe, expect, test } from "bun:test";
import gptFastModeExtension, {
  FAST_SERVICE_TIER,
  SUPPORTED_MODELS,
  getEligibility,
  injectFastServiceTier,
} from "../src/gpt-fast-mode.ts";

const supportedModel = {
  provider: "openai-codex",
  id: "gpt-6-astra",
  api: "openai-codex-responses",
};

function makeCtx(
  model: typeof supportedModel | undefined = supportedModel,
  usingOAuth = true,
) {
  const statuses: Array<string | undefined> = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const auth = { usingOAuth };
  return {
    model,
    auth,
    hasUI: true,
    sessionManager: {},
    statuses,
    notifications,
    modelRegistry: {
      isUsingOAuth: () => auth.usingOAuth,
    },
    ui: {
      theme: { fg: (_tone: string, text: string) => text },
      setStatus: (_key: string, text: string | undefined) =>
        statuses.push(text),
      notify: (message: string, level?: string) =>
        notifications.push({ message, level }),
    },
  };
}

type TestHandler = (event: unknown, ctx: ReturnType<typeof makeCtx>) => unknown;

function makePi(fastFlag = false) {
  const handlers = new Map<string, TestHandler[]>();
  let command:
    | {
        handler: (args: string, ctx: ReturnType<typeof makeCtx>) => unknown;
      }
    | undefined;
  let commandName: string | undefined;

  return {
    handlers,
    get command() {
      return command;
    },
    get commandName() {
      return commandName;
    },
    registerFlag() {},
    getFlag: () => fastFlag,
    registerCommand(
      name: string,
      definition: {
        handler: (args: string, ctx: ReturnType<typeof makeCtx>) => unknown;
      },
    ) {
      commandName = name;
      command = definition;
    },
    on(event: string, handler: TestHandler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    async emit(
      event: string,
      payload: unknown,
      ctx: ReturnType<typeof makeCtx>,
    ) {
      if (event === "before_provider_request") {
        const providerEvent = payload as { payload: unknown };
        let currentPayload = providerEvent.payload;
        for (const handler of handlers.get(event) ?? []) {
          const replacement = await handler(
            { ...providerEvent, payload: currentPayload },
            ctx,
          );
          if (replacement !== undefined) currentPayload = replacement;
        }
        return currentPayload;
      }

      let result: unknown;
      for (const handler of handlers.get(event) ?? []) {
        result = await handler(payload, ctx);
      }
      return result;
    },
  };
}

describe("gpt-fast-mode: eligibility", () => {
  test("allows the supported ChatGPT Codex model family", () => {
    expect([...SUPPORTED_MODELS]).toEqual([
      "gpt-5.4",
      "gpt-5.5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-6-astra",
    ]);
    expect(Object.isFrozen(SUPPORTED_MODELS)).toBe(true);
    for (const id of SUPPORTED_MODELS) {
      expect(
        getEligibility(
          { provider: "openai-codex", id, api: "openai-codex-responses" },
          true,
        ).eligible,
      ).toBe(true);
    }
  });

  test("rejects Codex mini and Spark", () => {
    for (const id of ["gpt-5.4-mini", "gpt-5.3-codex-spark"]) {
      expect(
        getEligibility(
          { provider: "openai-codex", id, api: "openai-codex-responses" },
          true,
        ).eligible,
      ).toBe(false);
    }
  });

  test("rejects wrong provider, API, authentication, and missing model", () => {
    expect(
      getEligibility({ ...supportedModel, provider: "openai" }, true).eligible,
    ).toBe(false);
    expect(
      getEligibility({ ...supportedModel, api: "openai-responses" }, true)
        .eligible,
    ).toBe(false);
    expect(getEligibility(supportedModel, false).eligible).toBe(false);
    expect(getEligibility(undefined, true).eligible).toBe(false);
  });
});

describe("gpt-fast-mode: payload injection", () => {
  test("adds priority tier without mutating the original payload", () => {
    const payload = { model: supportedModel.id, input: "hello" };
    const result = injectFastServiceTier(payload, supportedModel, true);

    expect(result).toEqual({ ...payload, service_tier: FAST_SERVICE_TIER });
    expect(result).not.toBe(payload);
    expect(payload).not.toHaveProperty("service_tier");
  });

  test("does not overwrite an existing service tier", () => {
    expect(
      injectFastServiceTier(
        { model: supportedModel.id, service_tier: "default" },
        supportedModel,
        true,
      ),
    ).toBeUndefined();
  });

  test("fails closed for mismatched or malformed payloads", () => {
    expect(
      injectFastServiceTier({ model: "gpt-5.5" }, supportedModel, true),
    ).toBeUndefined();
    expect(injectFastServiceTier(null, supportedModel, true)).toBeUndefined();
    expect(injectFastServiceTier([], supportedModel, true)).toBeUndefined();
  });

  test("fails closed when any model gate fails", () => {
    expect(
      injectFastServiceTier(
        { model: supportedModel.id },
        supportedModel,
        false,
      ),
    ).toBeUndefined();
    expect(
      injectFastServiceTier(
        { model: "gpt-5.4-mini" },
        { ...supportedModel, id: "gpt-5.4-mini" },
        true,
      ),
    ).toBeUndefined();
  });
});

describe("gpt-fast-mode: extension wiring", () => {
  test("--fast enables status and provider injection", async () => {
    const pi = makePi(true);
    const ctx = makeCtx();
    gptFastModeExtension(pi as never);

    expect(pi.commandName).toBe("gpt-fast");
    await pi.emit("session_start", {}, ctx);
    expect(ctx.statuses.at(-1)).toBe("fast");

    const result = await pi.emit(
      "before_provider_request",
      { payload: { model: supportedModel.id } },
      ctx,
    );
    expect(result).toEqual({
      model: supportedModel.id,
      service_tier: "priority",
    });
  });

  test("/gpt-fast on and off control subsequent requests", async () => {
    const pi = makePi();
    const ctx = makeCtx();
    gptFastModeExtension(pi as never);
    await pi.emit("session_start", {}, ctx);

    await pi.command?.handler("on", ctx);
    expect(ctx.statuses.at(-1)).toBe("fast");
    expect(
      await pi.emit(
        "before_provider_request",
        { payload: { model: supportedModel.id } },
        ctx,
      ),
    ).toHaveProperty("service_tier", "priority");

    await pi.command?.handler("off", ctx);
    expect(ctx.statuses.at(-1)).toBeUndefined();
    expect(
      await pi.emit(
        "before_provider_request",
        { payload: { model: supportedModel.id } },
        ctx,
      ),
    ).toEqual({ model: supportedModel.id });
  });

  test("a non-priority payload tier deactivates the status", async () => {
    const pi = makePi();
    const ctx = makeCtx();
    gptFastModeExtension(pi as never);
    await pi.emit("session_start", {}, ctx);
    await pi.command?.handler("on", ctx);

    expect(
      await pi.emit(
        "before_provider_request",
        {
          payload: { model: supportedModel.id, service_tier: "default" },
        },
        ctx,
      ),
    ).toEqual({ model: supportedModel.id, service_tier: "default" });
    expect(ctx.statuses.at(-1)).toBeUndefined();

    await pi.command?.handler("on", ctx);
    expect(ctx.statuses.at(-1)).toBeUndefined();
    expect(ctx.notifications.at(-1)?.message).toContain(
      "already defines a non-priority service_tier",
    );
    expect(ctx.notifications.at(-1)?.level).toBe("warning");

    await pi.command?.handler("status", ctx);
    expect(ctx.notifications.at(-1)?.message).toContain(
      "already defines a non-priority service_tier",
    );

    expect(
      await pi.emit(
        "before_provider_request",
        {
          payload: { model: supportedModel.id, service_tier: "priority" },
        },
        ctx,
      ),
    ).toEqual({ model: supportedModel.id, service_tier: "priority" });
    expect(ctx.statuses.at(-1)).toBe("fast");

    pi.on("before_provider_request", (event) => ({
      ...(event as { payload: Record<string, unknown> }).payload,
      service_tier: "default",
    }));
    expect(
      await pi.emit(
        "before_provider_request",
        { payload: { model: supportedModel.id } },
        ctx,
      ),
    ).toEqual({ model: supportedModel.id, service_tier: "default" });
    await pi.command?.handler("status", ctx);
    expect(ctx.notifications.at(-1)?.message).toContain(
      "at this extension's hook",
    );
    expect(ctx.notifications.at(-1)?.message).toContain(
      "may still change the final request",
    );
  });

  test("authentication changes deactivate the status before the next turn", async () => {
    const pi = makePi();
    const ctx = makeCtx();
    gptFastModeExtension(pi as never);
    await pi.emit("session_start", {}, ctx);
    await pi.command?.handler("on", ctx);

    ctx.auth.usingOAuth = false;
    await pi.emit("turn_start", {}, ctx);
    expect(ctx.statuses.at(-1)).toBeUndefined();
    expect(
      await pi.emit(
        "before_provider_request",
        { payload: { model: supportedModel.id } },
        ctx,
      ),
    ).toEqual({ model: supportedModel.id });
  });

  test("enabled mode stays inactive on unsupported models", async () => {
    const pi = makePi();
    const ctx = makeCtx({ ...supportedModel, id: "gpt-5.4-mini" });
    gptFastModeExtension(pi as never);
    await pi.emit("session_start", {}, ctx);

    await pi.command?.handler("on", ctx);
    expect(ctx.statuses.at(-1)).toBeUndefined();
    expect(ctx.notifications.at(-1)?.level).toBe("warning");
  });

  test("model selection updates the status without changing mode", async () => {
    const pi = makePi();
    const ctx = makeCtx();
    gptFastModeExtension(pi as never);
    await pi.emit("session_start", {}, ctx);
    await pi.command?.handler("on", ctx);

    ctx.model = { ...supportedModel, id: "gpt-5.4-mini" };
    await pi.emit("model_select", {}, ctx);
    expect(ctx.statuses.at(-1)).toBeUndefined();

    ctx.model = supportedModel;
    await pi.emit("model_select", {}, ctx);
    expect(ctx.statuses.at(-1)).toBe("fast");
  });

  test("keeps Fast-mode state isolated between sessions", async () => {
    const pi = makePi();
    const sessionA = makeCtx();
    const sessionB = makeCtx();
    gptFastModeExtension(pi as never);

    await pi.emit("session_start", {}, sessionA);
    await pi.command?.handler("on", sessionA);
    await pi.emit("session_start", {}, sessionB);

    expect(
      await pi.emit(
        "before_provider_request",
        { payload: { model: supportedModel.id } },
        sessionA,
      ),
    ).toHaveProperty("service_tier", "priority");
    expect(
      await pi.emit(
        "before_provider_request",
        { payload: { model: supportedModel.id } },
        sessionB,
      ),
    ).toEqual({ model: supportedModel.id });
  });

  test("status and invalid command report without changing requests", async () => {
    const pi = makePi();
    const ctx = makeCtx();
    gptFastModeExtension(pi as never);
    await pi.emit("session_start", {}, ctx);

    await pi.command?.handler("status", ctx);
    expect(ctx.notifications.at(-1)?.message).toContain("off");
    await pi.command?.handler("invalid", ctx);
    expect(ctx.notifications.at(-1)).toEqual({
      message: "Usage: /gpt-fast [on|off|status]",
      level: "error",
    });
  });
});
