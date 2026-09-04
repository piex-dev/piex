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
      "lead · openai-codex/gpt-5.6-sol · thinking xhigh · reading src/review.ts · 1 tool",
    );
    expect(rendered).toContain(
      "specialist/security · openai-codex/gpt-5.6-sol · thinking max",
    );
    expect(renderProgressStatus(snapshot)).toContain(
      "lead openai-codex/gpt-5.6-sol · thinking xhigh",
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
      type: "reviewer_activity",
      role: "lead",
      state: "reasoning",
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
