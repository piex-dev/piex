/**
 * Cross-session usage status regression test.
 *
 * pi runs multiple sessions in one process (/new, /resume, /fork). usage.ts
 * keeps module-level state (activeAdapter / latestCtx), so a stale adapter
 * from session B must never repaint session A's status bar.
 *
 * Run: bun test extensions/usage/test/usage.test.ts
 */
import { describe, expect, test, beforeEach } from "bun:test";
import usageExtension, { __test__ } from "../src/usage.ts";
import {
  kimiAdapter,
  deepseekAdapter,
  type AdapterSnapshot,
} from "../src/adapters.ts";

const { reset } = __test__;

type StatusMap = Record<string, string | undefined>;

function makePi() {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  return {
    handlers,
    on(event: string, fn: (...args: unknown[]) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    registerCommand() {},
    async emit(event: string, payload: unknown, ctx: unknown) {
      for (const fn of handlers.get(event) ?? []) {
        await fn(payload, ctx);
      }
    },
  };
}

function makeCtx(provider: string | undefined, statuses: StatusMap) {
  return {
    model: provider ? { provider } : undefined,
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        statuses[key] = text;
      },
      notify: () => {},
      theme: { fg: (_c: string, t: string) => t },
    },
  };
}

function snapshot(text: string): AdapterSnapshot {
  return { segments: [{ text }], detail: [text] };
}

describe("usage: cross-session provider tracking", () => {
  beforeEach(() => {
    reset();
    kimiAdapter.fetch = async () => snapshot("KIMI-QUOTA");
    deepseekAdapter.fetch = async () => snapshot("DEEPSEEK-QUOTA");
  });

  test("turn_end re-derives the adapter from the current session's model", async () => {
    const pi = makePi();
    const statuses: StatusMap = {};
    usageExtension(pi as never);

    const kimiCtx = makeCtx("kimi-coding", statuses);
    const deepseekCtx = makeCtx("deepseek", statuses);

    // session A activates with kimi
    await pi.emit("session_start", {}, kimiCtx);
    expect(statuses.usage).toContain("KIMI-QUOTA");

    // session B activates with deepseek (module state moves to deepseek)
    await pi.emit("session_start", {}, deepseekCtx);
    expect(statuses.usage).toContain("DEEPSEEK-QUOTA");

    // back in session A, a turn ends — must repaint kimi, not deepseek
    await pi.emit("turn_end", {}, kimiCtx);
    expect(statuses.usage).toContain("KIMI-QUOTA");
    expect(statuses.usage).not.toContain("DEEPSEEK-QUOTA");
  });

  test("same-provider turn keeps refreshing without churn", async () => {
    const pi = makePi();
    const statuses: StatusMap = {};
    usageExtension(pi as never);

    const kimiCtx = makeCtx("kimi-coding", statuses);
    await pi.emit("session_start", {}, kimiCtx);
    expect(statuses.usage).toContain("KIMI-QUOTA");

    statuses.usage = undefined;
    await pi.emit("turn_end", {}, kimiCtx);
    expect(statuses.usage).toContain("KIMI-QUOTA");
  });

  test("switching to a non-subscription provider clears the bar", async () => {
    const pi = makePi();
    const statuses: StatusMap = {};
    usageExtension(pi as never);

    await pi.emit("session_start", {}, makeCtx("kimi-coding", statuses));
    expect(statuses.usage).toContain("KIMI-QUOTA");

    // switch to a provider with no adapter (e.g. openai-compatible unknown)
    await pi.emit("model_select", { model: { provider: "unknown-provider" } }, makeCtx("unknown-provider", statuses));
    expect(statuses.usage).toBeUndefined();
  });

  test("activateFor updates provider identity even when adapter is unchanged", async () => {
    // Two providers sharing one adapter: activeProvider must follow the latest
    // activation or the refresh payload would carry the wrong provider id.
    const pi = makePi();
    const statuses: StatusMap = {};
    usageExtension(pi as never);

    const originalIds = [...deepseekAdapter.providerIds];
    deepseekAdapter.providerIds.push("deepseek-coding");
    try {
      let captured: string | undefined;
      deepseekAdapter.fetch = async (ctx) => {
        captured = ctx.provider;
        return snapshot("DEEPSEEK-QUOTA");
      };
      await pi.emit("session_start", {}, makeCtx("deepseek", statuses));
      expect(captured).toBe("deepseek");
      await pi.emit("model_select", { model: { provider: "deepseek-coding" } }, makeCtx("deepseek-coding", statuses));
      expect(captured).toBe("deepseek-coding");
    } finally {
      deepseekAdapter.providerIds = originalIds;
      deepseekAdapter.fetch = async () => snapshot("DEEPSEEK-QUOTA");
    }
  });
});
