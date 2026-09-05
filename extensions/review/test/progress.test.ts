import { describe, expect, test } from "bun:test";
import {
  describeReviewerTool,
  emitReviewProgress,
  renderProgressLines,
  renderProgressStatus,
  ReviewProgressTracker,
  sanitizeProgressText,
} from "../src/progress.ts";

describe("review progress", () => {
  test("keeps concurrent reviewer activity in one snapshot", () => {
    const tracker = new ReviewProgressTracker(1_000);
    tracker.apply({ type: "phase", phase: "reviewing" }, 1_100);
    tracker.apply(
      {
        type: "reviewer_started",
        reviewer: {
          role: "lead",
          model: "openai-codex/gpt-5.6-sol",
          thinkingLevel: "xhigh",
          fastMode: true,
        },
      },
      1_200,
    );
    tracker.apply(
      {
        type: "reviewer_started",
        reviewer: {
          role: "specialist",
          specialty: "security",
          model: "openai-codex/gpt-5.6-sol",
          thinkingLevel: "max",
          fastMode: false,
        },
      },
      1_300,
    );
    tracker.apply(
      {
        type: "reviewer_activity",
        role: "lead",
        state: "using_tool",
        activity: "reading src/review.ts",
        toolStarted: true,
      },
      1_400,
    );
    tracker.apply(
      {
        type: "reviewer_activity",
        role: "specialist",
        state: "reasoning",
        activity: "reasoning about changes",
      },
      1_500,
    );

    const snapshot = tracker.snapshot(6_000);
    expect(snapshot.elapsedMs).toBe(5_000);
    expect(snapshot.reviewers).toHaveLength(2);
    expect(snapshot.reviewers[0]).toMatchObject({
      role: "lead",
      fastMode: true,
      state: "using_tool",
      toolCalls: 1,
    });
    expect(snapshot.reviewers[1]).toMatchObject({
      role: "specialist",
      specialty: "security",
      thinkingLevel: "max",
      state: "reasoning",
    });
    const rendered = renderProgressLines(snapshot).join("\n");
    expect(rendered).toContain("Review · 00:05 · reviewing");
    expect(rendered).toContain(
      "lead · openai-codex/gpt-5.6-sol · thinking xhigh · fast · reading src/review.ts · 1 tool",
    );
    expect(rendered).toContain(
      "specialist/security · openai-codex/gpt-5.6-sol · thinking max",
    );
    expect(renderProgressStatus(snapshot)).toContain(
      "lead openai-codex/gpt-5.6-sol · thinking xhigh · fast",
    );
    expect(rendered.match(/\bfast\b/g)).toHaveLength(1);
  });

  test("keeps a finished reviewer done while its peer is still running", () => {
    const tracker = new ReviewProgressTracker(0);
    tracker.apply({ type: "phase", phase: "reviewing" });
    tracker.apply({
      type: "reviewer_started",
      reviewer: {
        role: "lead",
        model: "provider/lead",
        thinkingLevel: "high",
      },
    });
    tracker.apply({
      type: "reviewer_started",
      reviewer: {
        role: "specialist",
        specialty: "security",
        model: "provider/specialist",
        thinkingLevel: "high",
      },
    });
    tracker.apply({
      type: "reviewer_activity",
      role: "lead",
      state: "reasoning",
      activity: "finalizing report",
    });
    tracker.apply({
      type: "reviewer_activity",
      role: "specialist",
      state: "reasoning",
      activity: "reasoning about changes",
    });
    tracker.apply({ type: "reviewer_finished", role: "lead" });

    // A final queued session event must not revive a terminal reviewer while
    // its concurrently running peer continues to emit progress.
    tracker.apply({
      type: "reviewer_activity",
      role: "lead",
      state: "reasoning",
      activity: "finalizing report",
    });
    tracker.apply({
      type: "reviewer_failed",
      role: "lead",
      cancelled: true,
    });
    tracker.apply({
      type: "reviewer_activity",
      role: "specialist",
      state: "using_tool",
      activity: "reading src/auth.ts",
      toolStarted: true,
    });

    const snapshot = tracker.snapshot(2_000);
    expect(snapshot.reviewers).toMatchObject([
      { role: "lead", state: "done", activity: "done" },
      {
        role: "specialist",
        specialty: "security",
        state: "using_tool",
        activity: "reading src/auth.ts",
      },
    ]);

    const lines = renderProgressLines(snapshot);
    expect(lines[1]).toStartWith("✓ lead ");
    expect(lines[1]).toContain(" · done");
    expect(lines[2]).toStartWith("● specialist/security ");
    expect(lines[2]).toContain(" · reading src/auth.ts · 1 tool");
    expect(renderProgressStatus(snapshot)).toContain(
      "specialist/security provider/specialist",
    );
  });

  test("moves the lead back to active during adjudication", () => {
    const tracker = new ReviewProgressTracker(0);
    tracker.apply({
      type: "reviewer_started",
      reviewer: {
        role: "lead",
        model: "provider/lead",
        thinkingLevel: "high",
      },
    });
    tracker.apply({ type: "reviewer_finished", role: "lead" });
    tracker.apply({ type: "phase", phase: "adjudicating" });
    tracker.apply({
      type: "reviewer_run_started",
      role: "lead",
      activity: "reconciling findings",
    });
    expect(tracker.snapshot(1_000)).toMatchObject({
      phase: "adjudicating",
      reviewers: [
        {
          role: "lead",
          state: "reasoning",
          activity: "reconciling findings",
        },
      ],
    });
  });

  test("drops reviewer state from a discarded attempt before restarting", () => {
    const tracker = new ReviewProgressTracker(0);
    tracker.apply({
      type: "reviewer_started",
      reviewer: {
        role: "lead",
        model: "provider/lead",
        thinkingLevel: "high",
      },
    });
    tracker.apply({
      type: "reviewer_started",
      reviewer: {
        role: "specialist",
        model: "provider/specialist",
        thinkingLevel: "high",
        specialty: "security",
      },
    });

    tracker.apply({ type: "phase", phase: "refreshing" });
    expect(tracker.snapshot().reviewers).toEqual([]);

    tracker.apply({
      type: "reviewer_started",
      reviewer: {
        role: "lead",
        model: "provider/lead",
        thinkingLevel: "high",
      },
    });
    expect(tracker.snapshot().reviewers.map(({ role }) => role)).toEqual([
      "lead",
    ]);
  });

  test("reports tool activity without exposing search text or controls", () => {
    expect(
      describeReviewerTool("grep", {
        pattern: "API_SECRET_DO_NOT_SHOW",
        path: "src/auth.ts",
      }),
    ).toBe("searching src/auth.ts");
    expect(
      describeReviewerTool("read", {
        path: "src/ok.ts\n\u001b[31mspoofed",
      }),
    ).toBe("reading src/ok.ts spoofed");
    expect(sanitizeProgressText("a\u0000b\n c")).toBe("a b c");
  });

  test("does not let a broken observer interrupt review work", () => {
    expect(() =>
      emitReviewProgress(
        () => {
          throw new Error("renderer failed");
        },
        { type: "phase", phase: "reviewing" },
      ),
    ).not.toThrow();
  });
});
