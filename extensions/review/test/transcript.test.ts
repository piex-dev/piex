import { describe, expect, test } from "bun:test";
import {
  ReviewerTranscriptStore,
  redactTranscriptText,
  sanitizeTranscriptValue,
  serializeTranscriptValue,
  TRANSCRIPT_REASONING_OMITTED,
  TRANSCRIPT_REDACTED,
  TRANSCRIPT_TRUNCATED,
  truncateTranscriptText,
} from "../src/transcript.ts";

const reviewer = {
  id: "lead",
  role: "lead" as const,
  stage: "review" as const,
  model: "openai-codex/gpt-5.6-sol",
  thinkingLevel: "xhigh",
};

function start(store: ReviewerTranscriptStore, runId = "run-1"): string {
  const id = store.startReview(
    {
      runId,
      scopeLabel: "working tree",
      scopeSummary: "2 files, +10/-2",
    },
    1_000,
  );
  store.startReviewer(id, reviewer, 1_010);
  return id;
}

describe("review transcript safety", () => {
  test("redacts nested secret keys, token-shaped text, and reasoning", () => {
    const source = {
      headers: { authorization: "Bearer top-secret" },
      apiKey: "plain-secret",
      nested: {
        refresh_token: "refresh-secret",
        secretKey: "secret-key-value",
        githubToken: "github-token-value",
        apiToken: "api-token-value",
        visible: "use Bearer another-secret and sk-proj-abcdefghijk",
      },
      thinking: "private chain of thought",
      content: { type: "thinking", text: "also private" },
    };
    const text = JSON.stringify(sanitizeTranscriptValue(source));
    for (const secret of [
      "top-secret",
      "plain-secret",
      "refresh-secret",
      "secret-key-value",
      "github-token-value",
      "api-token-value",
      "another-secret",
      "abcdefghijk",
      "private chain of thought",
      "also private",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain(TRANSCRIPT_REDACTED);
    expect(text).toContain(TRANSCRIPT_REASONING_OMITTED);
    expect(source.apiKey).toBe("plain-secret");
  });

  test("redacts quoted source keys and complete authorization values", () => {
    const source = [
      '+  "apiKey": "super-secret-value",',
      "+  'access_token': 'another-secret-value',",
      '+  "openaiApiKey": "prefixed-api-secret",',
      "+  myAccessToken = 'prefixed-token-secret'",
      '+  secretKey: "generic-secret-key",',
      "+  githubToken = 'generic-provider-token'",
      '+  apiToken: "generic-api-token",',
      "+  Authorization: Bearer bearer-secret-value",
      '+  access_key: "opaque-access-secret",',
      '+  aws_access_key_id = "opaque-access-key-id",',
      "+  AccessKeyId: 'opaque-access-key-var',",
      "+  apiCredentials: 'opaque-access-key-var',",
      '+  message: "ordinary visible text",',
    ].join("\n");
    const redacted = redactTranscriptText(source);
    expect(redacted).not.toContain("super-secret-value");
    expect(redacted).not.toContain("another-secret-value");
    expect(redacted).not.toContain("prefixed-api-secret");
    expect(redacted).not.toContain("prefixed-token-secret");
    expect(redacted).not.toContain("generic-secret-key");
    expect(redacted).not.toContain("generic-provider-token");
    expect(redacted).not.toContain("generic-api-token");
    expect(redacted).not.toContain("bearer-secret-value");
    expect(redacted).not.toContain("opaque-access-secret");
    expect(redacted).not.toContain("opaque-access-key-id");
    expect(redacted).not.toContain("opaque-access-key-var");
    expect(redacted).toContain("ordinary visible text");
    expect(redacted.match(/\[REDACTED\]/g)?.length ?? 0).toBeGreaterThanOrEqual(
      8,
    );
  });

  test("redacts opaque provider credential values", () => {
    const redacted = redactTranscriptText(
      "Credential AKIAIOSFODNN7EXAMPLE and ya29.a0AfH6SM8XHQz2Bx5m4Pw9y3R6cF0le8d3L9pQ1vT7nK2s kept local",
    );
    expect(redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(redacted).not.toContain(
      "ya29.a0AfH6SM8XHQz2Bx5m4Pw9y3R6cF0le8d3L9pQ1vT7nK2s",
    );
    expect(redacted).toContain("kept local");
  });

  test("truncates plain and serialized values with an explicit marker", () => {
    const plain = truncateTranscriptText("x".repeat(100), 32);
    const serialized = serializeTranscriptValue(
      { content: "y".repeat(500) },
      48,
    );
    expect(plain).toHaveLength(32);
    expect(plain.endsWith(TRANSCRIPT_TRUNCATED)).toBe(true);
    expect(serialized.length).toBeLessThanOrEqual(48);
    expect(serialized.endsWith(TRANSCRIPT_TRUNCATED)).toBe(true);
  });

  test("handles cycles without retaining raw secret values", () => {
    const value: Record<string, unknown> = {
      password: "never-store-this",
    };
    value.self = value;
    const text = JSON.stringify(sanitizeTranscriptValue(value));
    expect(text).not.toContain("never-store-this");
    expect(text).toContain("[CIRCULAR]");
  });
});

describe("ReviewerTranscriptStore", () => {
  test("captures metadata and publishes isolated live snapshots", () => {
    const store = new ReviewerTranscriptStore();
    const changes: string[] = [];
    const unsubscribe = store.subscribe(({ runId, snapshot }) => {
      changes.push(`${runId}:${snapshot.status}`);
      snapshot.scopeLabel = "listener mutation";
    });
    const runId = start(store);
    store.record(runId, "lead", { kind: "prompt", text: "Review this" }, 1_020);

    const snapshot = store.getLatestSnapshot()!;
    expect(snapshot).toMatchObject({
      runId,
      scopeLabel: "working tree",
      scopeSummary: "2 files, +10/-2",
      status: "running",
      startedAt: 1_000,
      updatedAt: 1_020,
    });
    expect(snapshot.reviewers[0]).toMatchObject({
      descriptor: reviewer,
      status: "running",
      items: [{ kind: "prompt", text: "Review this", stage: "review" }],
    });
    expect(changes).toEqual([
      "run-1:started",
      "run-1:running",
      "run-1:running",
    ]);
    unsubscribe();
  });

  test("merges assistant deltas only within the same reviewer stage", () => {
    const store = new ReviewerTranscriptStore();
    const runId = start(store);
    store.record(runId, "lead", {
      kind: "assistant",
      text: "First ",
      append: true,
    });
    store.record(runId, "lead", {
      kind: "assistant",
      text: "pass",
      append: true,
    });
    store.setReviewerStatus(runId, "lead", "complete");
    store.setReviewerStage(runId, "lead", "adjudication");
    store.record(runId, "lead", {
      kind: "assistant",
      text: "Final",
      append: true,
    });

    const items = store.getLatestSnapshot()!.reviewers[0].items;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "assistant",
      text: "First pass",
      stage: "review",
    });
    expect(items[1]).toMatchObject({
      kind: "assistant",
      text: "Final",
      stage: "adjudication",
    });
    expect(store.getLatestSnapshot()!.reviewers[0].status).toBe("running");
  });

  test("drops raw thinking events at runtime", () => {
    const store = new ReviewerTranscriptStore();
    const runId = start(store);
    expect(
      store.record(runId, "lead", {
        kind: "thinking_delta",
        text: "hidden reasoning",
      } as never),
    ).toBeUndefined();
    expect(store.getLatestSnapshot()!.reviewers[0].items).toEqual([]);
  });

  test("links redacted tool calls and bounded results by tool call id", () => {
    const store = new ReviewerTranscriptStore({ maxValueChars: 96 });
    const runId = start(store);
    store.record(runId, "lead", {
      kind: "tool_call",
      toolName: "read",
      toolCallId: "call-1",
      arguments: { path: "src/auth.ts", apiKey: "do-not-store" },
    });
    store.record(runId, "lead", {
      kind: "tool_result",
      toolName: "read",
      toolCallId: "call-1",
      result: {
        content: [
          {
            type: "text",
            text: `Authorization: Bearer hidden-token\n${"x".repeat(200)}`,
          },
        ],
        details: { token: "also-hidden" },
      },
    });

    const [call, result] = store.getLatestSnapshot()!.reviewers[0].items;
    expect(call).toMatchObject({ kind: "tool_call", toolCallId: "call-1" });
    expect(result).toMatchObject({ kind: "tool_result", toolCallId: "call-1" });
    const stored = JSON.stringify([call, result]);
    expect(stored).not.toContain("do-not-store");
    expect(stored).not.toContain("hidden-token");
    expect(stored).not.toContain("also-hidden");
    expect((result as { summary: string }).summary).toContain(
      TRANSCRIPT_TRUNCATED,
    );
  });

  test("bounds entries, keeps one prior run, and rejects stale events", () => {
    const store = new ReviewerTranscriptStore({
      maxItemsPerReviewer: 2,
      maxRunItems: 1,
    });
    const first = start(store, "run-1");
    for (let index = 0; index < 3; index += 1) {
      store.record(first, "lead", {
        kind: "note",
        text: `reviewer-${index}`,
      });
      store.recordRunItem(first, {
        kind: "status",
        status: `phase-${index}`,
      });
    }
    expect(store.getLatestSnapshot()).toMatchObject({
      droppedItems: 2,
      items: [{ status: "phase-2" }],
      reviewers: [{ droppedItems: 1 }],
    });
    store.setReviewStatus(first, "complete", 1_100);
    start(store, "run-2");
    start(store, "run-3");

    expect(store.listSnapshots().map(({ runId }) => runId)).toEqual([
      "run-2",
      "run-3",
    ]);
    expect(store.getSnapshot("run-1")).toBeUndefined();
    expect(store.getPreviousSnapshot()?.status).toBe("cancelled");
    expect(
      store.record(
        "run-2",
        "lead",
        { kind: "assistant", text: "late old event" },
        2_000,
      ),
    ).toBeUndefined();
    expect(JSON.stringify(store.listSnapshots())).not.toContain(
      "late old event",
    );
  });

  test("stores run status, final review, and safe errors", () => {
    const store = new ReviewerTranscriptStore();
    const runId = start(store);
    store.recordRunItem(runId, {
      kind: "status",
      status: "cached",
      text: "Using cached result",
    });
    store.record(runId, "lead", {
      kind: "final_review",
      review: { summary: "clean", token: "hidden" },
    });
    store.record(runId, "lead", {
      kind: "error",
      error: new Error("failed with api_key=hidden-too"),
    });

    const snapshot = store.getLatestSnapshot()!;
    expect(snapshot.items[0]).toMatchObject({
      kind: "status",
      status: "cached",
      text: "Using cached result",
    });
    const stored = JSON.stringify(snapshot);
    expect(stored).toContain("clean");
    expect(stored).not.toContain('"token":"hidden"');
    expect(stored).not.toContain("hidden-too");
  });

  test("swallows subscriber errors so viewers cannot interrupt reviews", () => {
    const store = new ReviewerTranscriptStore();
    store.subscribe(() => {
      throw new Error("viewer failed");
    });
    expect(() => start(store)).not.toThrow();
  });
});
