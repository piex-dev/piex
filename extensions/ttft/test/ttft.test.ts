/**
 * ttft extension tests.
 *
 * Covers the pure metric logic (formatting, cache-hit rate, turn record
 * derivation) and the event flow: turn_start → message_update → turn_end,
 * persistence via appendEntry, rebuild on session_start, and multi-session
 * isolation (pi runs several sessions in one process).
 *
 * Run: bun test extensions/ttft/test/ttft.test.ts
 */
import { beforeEach, describe, expect, test } from "bun:test";
import ttftExtension, {
  __test__,
  addUsage,
  cacheHitPercent,
  createTotals,
  deriveTurnRecord,
  formatDuration,
  formatRate,
  rebuildFromEntries,
  type TokenTotals,
  type TurnRecord,
} from "../src/ttft.ts";

const { reset, setNow } = __test__;

type StatusMap = Record<string, string | undefined>;

interface FakeUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

function makePi() {
  const handlers = new Map<
    string,
    Array<(event: Record<string, unknown>, ctx: unknown) => unknown>
  >();
  const appended: Array<{ customType: string; data: unknown }> = [];
  return {
    handlers,
    appended,
    on(
      event: string,
      fn: (event: Record<string, unknown>, ctx: unknown) => unknown,
    ) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    registerCommand() {},
    appendEntry(customType: string, data: unknown) {
      appended.push({ customType, data });
    },
    async emit(event: string, payload: Record<string, unknown>, ctx: unknown) {
      for (const fn of handlers.get(event) ?? []) {
        await fn(payload, ctx);
      }
    },
  };
}

function makeCtx(
  sessionId: string,
  statuses: StatusMap,
  entries: Array<Record<string, unknown>> = [],
) {
  return {
    sessionId,
    entries,
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => entries,
    },
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        statuses[key] = text;
      },
      notify: () => {},
      theme: { fg: (_c: string, t: string) => t },
    },
  };
}

function assistantMessageEntry(usage: FakeUsage): Record<string, unknown> {
  return { type: "message", message: { role: "assistant", usage } };
}

function customTtftEntry(record: TurnRecord): Record<string, unknown> {
  return { type: "custom", customType: "ttft", data: record };
}

function usage(u: FakeUsage): FakeUsage {
  return u;
}

describe("pure metrics", () => {
  test("formatDuration", () => {
    expect(formatDuration(843)).toBe("843ms");
    expect(formatDuration(1200)).toBe("1.2s");
    expect(formatDuration(12_400)).toBe("12s");
    expect(formatDuration(83_000)).toBe("1m23s");
    expect(formatDuration(-5)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });

  test("formatRate", () => {
    expect(formatRate(45.26)).toBe("45.3");
    expect(formatRate(123.7)).toBe("124");
    expect(formatRate(0)).toBe("—");
    expect(formatRate(Number.NaN)).toBe("—");
  });

  test("cacheHitPercent: dsh formula over disjoint buckets", () => {
    expect(
      cacheHitPercent({
        input: 100,
        output: 50,
        cacheRead: 400,
        cacheWrite: 0,
      }),
    ).toBe(80);
    // cacheWrite counts as billed prompt, lowering the rate
    expect(
      cacheHitPercent({
        input: 100,
        output: 50,
        cacheRead: 400,
        cacheWrite: 100,
      }),
    ).toBe(67);
    // no billed prompt → undefined, never 0/0
    expect(cacheHitPercent(createTotals())).toBeUndefined();
  });

  test("addUsage folds missing buckets as zero", () => {
    const totals = createTotals();
    addUsage(totals, usage({ input: 10, output: 5 }));
    addUsage(totals, usage({ cacheRead: 30, cacheWrite: 2 }));
    expect(totals).toEqual({
      input: 10,
      output: 5,
      cacheRead: 30,
      cacheWrite: 2,
    });
  });

  test("deriveTurnRecord: timing + usage → ttft/tps/rate", () => {
    const record = deriveTurnRecord(
      {
        turn: 1,
        startTs: 1000,
        firstTokenTs: 2200,
        lastUpdateTs: 7200,
        finalUsage: null,
      },
      usage({ input: 100, output: 500, cacheRead: 400, cacheWrite: 0 }),
    );
    expect(record?.ttftMs).toBe(1200);
    expect(record?.tokensPerSecond).toBeCloseTo(500 / 5, 1);
    expect(record?.cacheRatePercent).toBe(80);
  });

  test("deriveTurnRecord: no first token → undefined (nothing worth showing)", () => {
    expect(
      deriveTurnRecord(
        {
          turn: 1,
          startTs: 1000,
          firstTokenTs: null,
          lastUpdateTs: null,
          finalUsage: null,
        },
        usage({ output: 5 }),
      ),
    ).toBeUndefined();
  });

  test("deriveTurnRecord: zero decode time → no throughput, ttft and output only", () => {
    const record = deriveTurnRecord(
      {
        turn: 1,
        startTs: 1000,
        firstTokenTs: 2000,
        lastUpdateTs: 2000,
        finalUsage: null,
      },
      usage({ output: 100 }),
    );
    expect(record?.ttftMs).toBe(1000);
    expect(record?.tokensPerSecond).toBeUndefined();
    expect(record?.outputTokens).toBe(100);
  });

  test("deriveTurnRecord: burst decode below the floor → tps suppressed (gateway buffering)", () => {
    // 1252 tokens replayed in 97ms is a buffering gateway, not a real rate.
    const record = deriveTurnRecord(
      {
        turn: 1,
        startTs: 1000,
        firstTokenTs: 23_000,
        lastUpdateTs: 23_097,
        finalUsage: null,
      },
      usage({ output: 1252 }),
    );
    expect(record?.ttftMs).toBe(22_000);
    expect(record?.tokensPerSecond).toBeUndefined();
    expect(record?.outputTokens).toBe(1252);
  });

  test("rebuildFromEntries: custom entries drive turns, message usage drives totals", () => {
    const entries = [
      assistantMessageEntry({
        input: 100,
        output: 50,
        cacheRead: 400,
        cacheWrite: 0,
      }),
      customTtftEntry({
        turn: 1,
        ttftMs: 1200,
        tokensPerSecond: 45.3,
        outputTokens: 50,
        cacheRatePercent: 80,
      }),
      // Tool results can carry their own usage (custom tools report it); the
      // rebuild must fold it like pi's built-in footer does.
      {
        type: "message",
        message: { role: "toolResult", usage: { input: 7, output: 3 } },
      },
      { type: "compaction", summary: "x", usage: { input: 20, output: 10 } },
      { type: "model_change", provider: "x", modelId: "y" }, // ignored
    ];
    const { turns, totals } = rebuildFromEntries(entries);
    expect(turns).toHaveLength(1);
    expect(turns[0].ttftMs).toBe(1200);
    expect(totals).toEqual({
      input: 127,
      output: 63,
      cacheRead: 400,
      cacheWrite: 0,
    });
  });
});

describe("event flow", () => {
  beforeEach(() => {
    reset();
  });

  test("warm turn: status shows TTFT and t/s; record persisted", async () => {
    const pi = makePi();
    const statuses: StatusMap = {};
    ttftExtension(pi as never);

    const ctx = makeCtx("s1", statuses);
    await pi.emit("session_start", {}, ctx);

    let now = 10_000;
    setNow(() => now);

    await pi.emit("turn_start", { turnIndex: 0, timestamp: now }, ctx);
    expect(statuses.ttft).toBeUndefined(); // nothing before the first token

    now = 10_800; // first token after 800ms
    await pi.emit("message_update", { message: { role: "assistant" } }, ctx);
    expect(statuses.ttft).toBe("TTFT 800ms");

    now = 13_800; // decode 3s
    await pi.emit("message_update", { message: { role: "assistant" } }, ctx);

    await pi.emit(
      "turn_end",
      {
        message: {
          role: "assistant",
          usage: usage({
            input: 100,
            output: 150,
            cacheRead: 400,
            cacheWrite: 0,
          }),
        },
      },
      ctx,
    );
    expect(statuses.ttft).toBe("TTFT 800ms · 50.0t/s");
    // The bar shows latency/throughput only — cache stays in /ttft detail to
    // avoid colliding with pi's built-in footer CH%.

    expect(pi.appended).toHaveLength(1);
    expect(pi.appended[0]).toEqual({
      customType: "ttft",
      data: {
        turn: 1,
        ttftMs: 800,
        tokensPerSecond: 50,
        outputTokens: 150,
        cacheRatePercent: 80,
      },
    });
  });

  test("message_end paints the exact t/s before tools run", async () => {
    const pi = makePi();
    const statuses: StatusMap = {};
    ttftExtension(pi as never);
    const ctx = makeCtx("s1", statuses);
    await pi.emit("session_start", {}, ctx);
    let now = 10_000;
    setNow(() => now);

    await pi.emit("turn_start", { timestamp: now }, ctx);
    now = 11_300; // first token after 1.3s
    await pi.emit("message_update", { message: { role: "assistant" } }, ctx);
    expect(statuses.ttft).toBe("TTFT 1.3s"); // decode still running: no t/s yet

    now = 15_300; // 4s of decode
    await pi.emit("message_update", { message: { role: "assistant" } }, ctx);

    // Stream completes: usage arrives BEFORE tools run. The bar must show the
    // exact t/s now, not after turn_end.
    await pi.emit(
      "message_end",
      {
        message: {
          role: "assistant",
          usage: usage({ input: 100, output: 160 }),
        },
      },
      ctx,
    );
    expect(statuses.ttft).toBe("TTFT 1.3s · 40.0t/s");

    // Tools run… then the turn settles with the same usage.
    await pi.emit(
      "turn_end",
      {
        message: {
          role: "assistant",
          usage: usage({ input: 100, output: 160 }),
        },
      },
      ctx,
    );
    expect(statuses.ttft).toBe("TTFT 1.3s · 40.0t/s");
    expect((pi.appended[0].data as TurnRecord).tokensPerSecond).toBeCloseTo(
      40,
      5,
    );
  });

  test("burst decode below the floor → settled bar shows TTFT without t/s", async () => {
    const pi = makePi();
    const statuses: StatusMap = {};
    ttftExtension(pi as never);
    const ctx = makeCtx("s1", statuses);
    await pi.emit("session_start", {}, ctx);
    let now = 10_000;
    setNow(() => now);
    await pi.emit("turn_start", { timestamp: now }, ctx);
    now = 11_000;
    await pi.emit("message_update", { message: { role: "assistant" } }, ctx);
    now = 11_050; // 1252 tokens replayed in 50ms: buffering gateway noise
    await pi.emit("message_update", { message: { role: "assistant" } }, ctx);
    await pi.emit(
      "turn_end",
      { message: { role: "assistant", usage: usage({ output: 1252 }) } },
      ctx,
    );
    expect(statuses.ttft).toBe("TTFT 1.0s");
    const record = pi.appended[0].data as TurnRecord;
    expect(record.tokensPerSecond).toBeUndefined();
    expect(record.outputTokens).toBe(1252);
  });

  test("message_end for non-assistant messages is ignored", async () => {
    const pi = makePi();
    const statuses: StatusMap = {};
    ttftExtension(pi as never);
    const ctx = makeCtx("s1", statuses);
    await pi.emit("session_start", {}, ctx);
    let now = 10_000;
    setNow(() => now);
    await pi.emit("turn_start", { timestamp: now }, ctx);
    now = 11_000;
    await pi.emit("message_update", { message: { role: "assistant" } }, ctx);
    await pi.emit("message_end", { message: { role: "toolResult" } }, ctx);
    expect(statuses.ttft).toBe("TTFT 1.0s"); // no t/s from a toolResult message
  });

  test("cold session: no cache buckets → no cache segment, no 0% lie", async () => {
    const pi = makePi();
    const statuses: StatusMap = {};
    ttftExtension(pi as never);
    const ctx = makeCtx("s1", statuses);
    await pi.emit("session_start", {}, ctx);
    let now = 10_000;
    setNow(() => now);
    await pi.emit("turn_start", { timestamp: now }, ctx);
    now = 11_500;
    await pi.emit("message_update", { message: { role: "assistant" } }, ctx);
    now = 12_500; // 1s of decode
    await pi.emit("message_update", { message: { role: "assistant" } }, ctx);
    await pi.emit(
      "turn_end",
      {
        message: {
          role: "assistant",
          usage: usage({ input: 100, output: 60 }),
        },
      },
      ctx,
    );
    expect(statuses.ttft).toBe("TTFT 1.5s · 60.0t/s");
  });

  test("cache totals are session cumulative (for /ttft detail, not the bar)", async () => {
    const pi = makePi();
    const statuses: StatusMap = {};
    ttftExtension(pi as never);
    const ctx = makeCtx("s1", statuses);
    await pi.emit("session_start", {}, ctx);
    let now = 20_000;
    setNow(() => now);

    await pi.emit("turn_start", { timestamp: now }, ctx);
    now += 1000;
    await pi.emit("message_update", { message: { role: "assistant" } }, ctx);
    now += 2000;
    await pi.emit(
      "turn_end",
      {
        message: {
          role: "assistant",
          usage: usage({
            input: 100,
            output: 50,
            cacheRead: 400,
            cacheWrite: 0,
          }),
        },
      },
      ctx,
    );

    await pi.emit("turn_start", { timestamp: now }, ctx);
    now += 1000;
    await pi.emit("message_update", { message: { role: "assistant" } }, ctx);
    now += 2000;
    await pi.emit(
      "turn_end",
      {
        message: {
          role: "assistant",
          usage: usage({
            input: 300,
            output: 40,
            cacheRead: 200,
            cacheWrite: 0,
          }),
        },
      },
      ctx,
    );

    // (400+200) / (100+400+300+200) = 60% — folded for the detail report only.
    const snap = __test__.snapshot();
    expect(cacheHitPercent(snap.totals)).toBe(60);
    expect(snap.totals).toEqual({
      input: 400,
      output: 90,
      cacheRead: 600,
      cacheWrite: 0,
    });
    expect(statuses.ttft).not.toContain("cache");
  });

  test("session_start rebuilds history from persisted entries and keeps numbering", async () => {
    const pi = makePi();
    const statuses: StatusMap = {};
    ttftExtension(pi as never);

    const entries = [
      assistantMessageEntry({
        input: 100,
        output: 50,
        cacheRead: 400,
        cacheWrite: 0,
      }),
      assistantMessageEntry({
        input: 100,
        output: 30,
        cacheRead: 100,
        cacheWrite: 0,
      }),
      customTtftEntry({
        turn: 1,
        ttftMs: 1200,
        tokensPerSecond: 41.7,
        outputTokens: 50,
        cacheRatePercent: 80,
      }),
      customTtftEntry({
        turn: 2,
        ttftMs: 900,
        tokensPerSecond: 60,
        outputTokens: 30,
        cacheRatePercent: 50,
      }),
    ];
    const ctx = makeCtx("s1", statuses, entries);
    await pi.emit("session_start", {}, ctx);
    // Last turn's metrics drive the bar; the cumulative rate (500/700 = 71%)
    // is folded into totals for /ttft, not painted here.
    expect(statuses.ttft).toBe("TTFT 900ms · 60.0t/s");
    expect(cacheHitPercent(__test__.snapshot().totals)).toBe(71);

    // Next live turn must not renumber from 1.
    let now = 30_000;
    setNow(() => now);
    await pi.emit("turn_start", { timestamp: now }, ctx);
    now += 700;
    await pi.emit("message_update", { message: { role: "assistant" } }, ctx);
    await pi.emit(
      "turn_end",
      {
        message: { role: "assistant", usage: usage({ input: 10, output: 5 }) },
      },
      ctx,
    );
    expect((pi.appended[0].data as TurnRecord).turn).toBe(3);
  });

  test("multi-session isolation: stale session events never paint another bar", async () => {
    const pi = makePi();
    const statusesA: StatusMap = {};
    const statusesB: StatusMap = {};
    ttftExtension(pi as never);

    const ctxA = makeCtx("sA", statusesA);
    await pi.emit("session_start", {}, ctxA);
    let now = 10_000;
    setNow(() => now);
    await pi.emit("turn_start", { timestamp: now }, ctxA);
    now += 1000;
    await pi.emit("message_update", { message: { role: "assistant" } }, ctxA);

    // Switch to session B: A's in-flight turn must not leak into B's bar.
    const ctxB = makeCtx("sB", statusesB);
    await pi.emit("session_start", {}, ctxB);
    expect(statusesB.ttft).toBeUndefined();

    // A finishes its turn while B is active — ignored, B's bar stays clean.
    await pi.emit(
      "turn_end",
      {
        message: {
          role: "assistant",
          usage: usage({ input: 100, output: 50, cacheRead: 400 }),
        },
      },
      ctxA,
    );
    expect(statusesB.ttft).toBeUndefined();
  });

  test("message_update from a non-assistant message is ignored", async () => {
    const pi = makePi();
    const statuses: StatusMap = {};
    ttftExtension(pi as never);
    const ctx = makeCtx("s1", statuses);
    await pi.emit("session_start", {}, ctx);
    let now = 10_000;
    setNow(() => now);
    await pi.emit("turn_start", { timestamp: now }, ctx);
    await pi.emit("message_update", { message: { role: "toolResult" } }, ctx);
    expect(statuses.ttft).toBeUndefined();
    await pi.emit("message_update", { message: { role: "assistant" } }, ctx);
    expect(statuses.ttft).toBe("TTFT 0ms");
  });
});
