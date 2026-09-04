import { describe, expect, test } from "bun:test";
import reviewExtension, { __test__ as reviewTest } from "../src/review-v2.ts";
import { REVIEW_RUN_ENTRY } from "../src/state.ts";
import { ReviewerTranscriptStore } from "../src/transcript.ts";
import {
  openReviewTranscript,
  renderTranscriptDocument,
  renderTranscriptTitle,
} from "../src/transcript-viewer.ts";
import type { ReviewReport, ReviewScope } from "../src/types.ts";

describe("review transcript viewer", () => {
  test("renders one reviewer at a time with run-wide status events", () => {
    const store = new ReviewerTranscriptStore();
    const runId = store.startReview(
      {
        runId: "run",
        scopeLabel: "piex",
        scopeSummary: "2 files · +3/-1 · auto",
      },
      1_000,
    );
    store.startReviewer(
      runId,
      {
        id: "lead",
        role: "lead",
        stage: "review",
        model: "openai-codex/gpt-5.6-sol",
        thinkingLevel: "xhigh",
      },
      1_010,
    );
    store.startReviewer(
      runId,
      {
        id: "specialist",
        role: "specialist",
        stage: "review",
        model: "openai-codex/gpt-5.6-sol",
        thinkingLevel: "max",
        specialty: "security",
      },
      1_020,
    );
    store.recordRunItem(runId, { kind: "status", status: "reviewing" }, 1_030);
    store.record(
      runId,
      "lead",
      { kind: "assistant", text: "lead-only", append: true },
      1_040,
    );
    store.record(
      runId,
      "specialist",
      { kind: "assistant", text: "specialist-only", append: true },
      1_050,
    );

    const document = renderTranscriptDocument(
      store.getLatestSnapshot()!,
      "specialist",
    );
    expect(document).toContain("specialist/security");
    expect(document).toContain("thinking max");
    expect(document).toContain("[00:00] reviewing");
    expect(document).toContain("specialist-only");
    expect(document).not.toContain("lead-only");
  });

  test("reports an empty store without opening custom UI", async () => {
    const notifications: string[] = [];
    let customCalls = 0;
    await openReviewTranscript(
      {
        hasUI: true,
        mode: "tui",
        ui: {
          notify: (message: string) => notifications.push(message),
          custom: async () => {
            customCalls += 1;
          },
        },
      } as never,
      new ReviewerTranscriptStore(),
    );
    expect(notifications).toEqual([
      "No review transcript yet. Run /review first.",
    ]);
    expect(customCalls).toBe(0);
  });

  test("freezes elapsed time when a transcript completes", () => {
    const store = new ReviewerTranscriptStore();
    const runId = store.startReview(
      { runId: "complete", scopeLabel: "repo", scopeSummary: "clean" },
      1_000,
    );
    store.setReviewStatus(runId, "complete", 6_000);
    expect(renderTranscriptTitle(store.getLatestSnapshot()!, 99_000)).toBe(
      "Review transcript · 00:05 · complete",
    );
  });

  test("refreshes an open overlay as live reviewer events arrive", async () => {
    const store = new ReviewerTranscriptStore();
    const runId = store.startReview({
      runId: "live",
      scopeLabel: "repo",
      scopeSummary: "1 file · +1/-0 · auto",
    });
    store.startReviewer(runId, {
      id: "lead",
      role: "lead",
      stage: "review",
      model: "provider/model",
      thinkingLevel: "high",
    });
    let renderRequests = 0;
    let rendered = "";
    let renderedLineCount = 0;

    await openReviewTranscript(
      {
        hasUI: true,
        mode: "tui",
        ui: {
          notify: () => {},
          custom: async (
            factory: (...args: never[]) => unknown,
            options: unknown,
          ) => {
            let closed = false;
            const component = factory(
              {
                terminal: { rows: 40 },
                requestRender: () => {
                  renderRequests += 1;
                },
              },
              {
                fg: (_color: string, text: string) => text,
                bold: (text: string) => text,
              },
              { matches: () => false },
              () => {
                closed = true;
              },
            ) as {
              render(width: number): string[];
              handleInput?(data: string): void;
              dispose?(): void;
            };
            expect(options).toMatchObject({
              overlay: true,
              overlayOptions: {
                anchor: "top-left",
                width: "100%",
                maxHeight: "100%",
                margin: 0,
              },
            });
            component.render(100);
            store.record(runId, "lead", {
              kind: "assistant",
              text: "live-visible-text",
              append: true,
            });
            const lines = component.render(100);
            rendered = lines.join("\n");
            renderedLineCount = lines.length;
            component.handleInput?.("q");
            component.dispose?.();
            expect(closed).toBe(true);
          },
        },
      } as never,
      store,
    );

    expect(renderRequests).toBeGreaterThan(0);
    expect(rendered).toContain("live-visible-text");
    expect(renderedLineCount).toBe(40);
  });

  test("records cached reviews without fabricating a reviewer session", async () => {
    const scope: ReviewScope = {
      kind: "auto",
      scopeKey: "scope",
      diffHash: "diff",
      capture: { cwd: "/repo", request: { kind: "auto" } },
      repos: [
        {
          repo: "/repo",
          label: "repo",
          kind: "auto",
          mode: "current work",
          baseOid: "base",
          headOid: "head",
          summary: {
            files: [
              {
                path: "src/app.ts",
                linesAdded: 1,
                linesRemoved: 0,
                ext: ".ts",
                hunks: "",
                changedRanges: [{ start: 1, end: 1 }],
              },
            ],
            excluded: [],
            totalAdded: 1,
            totalRemoved: 0,
            rawDiff: "",
            filteredDiff: "",
          },
        },
      ],
    };
    const report: ReviewReport = {
      verdict: "pass",
      summary: "No blocking findings.",
      findings: [],
      previousFindings: [],
      rejectedFindings: 0,
      reviewerModel: "provider/model",
      reviewerCount: 1,
    };
    const store = new ReviewerTranscriptStore();
    const execution = await reviewTest.executeReview(
      scope,
      {
        sessionManager: {
          getEntries: () => [],
          getBranch: () => [
            {
              type: "custom",
              customType: REVIEW_RUN_ENTRY,
              data: {
                version: 1,
                createdAt: new Date(0).toISOString(),
                scopeKey: scope.scopeKey,
                diffHash: scope.diffHash,
                reviewerModel: report.reviewerModel,
                report,
              },
            },
          ],
        },
      } as never,
      undefined,
      store,
    );

    expect(execution.report.cached).toBe(true);
    expect(store.getLatestSnapshot()).toMatchObject({
      status: "complete",
      reviewers: [],
      items: [
        { kind: "status", status: "preparing" },
        { kind: "status", status: "cached" },
      ],
    });
  });

  test("registers the live shortcut and post-run command", () => {
    const commands: string[] = [];
    const events: string[] = [];
    const shortcuts: string[] = [];
    const tools: Array<{ name?: string; executionMode?: string }> = [];
    reviewExtension({
      on: (event: string) => events.push(event),
      registerCommand: (name: string) => commands.push(name),
      registerShortcut: (shortcut: string) => shortcuts.push(shortcut),
      registerTool: (tool: { name?: string; executionMode?: string }) =>
        tools.push(tool),
    } as never);

    expect(commands).toContain("review");
    expect(commands).toContain("review-log");
    expect(events).toContain("session_shutdown");
    expect(shortcuts).toContain("ctrl+alt+r");
    expect(tools).toContainEqual(
      expect.objectContaining({ name: "review", executionMode: "sequential" }),
    );
  });

  test("serializes command and tool review entrypoints with one shared gate", () => {
    const gate = reviewTest.createReviewExecutionGate();
    const first = gate.tryAcquire();
    expect(first).toBeFunction();
    expect(gate.tryAcquire()).toBeUndefined();

    first!();
    const second = gate.tryAcquire();
    expect(second).toBeFunction();
    first!();
    expect(gate.tryAcquire()).toBeUndefined();

    second!();
    expect(gate.tryAcquire()).toBeFunction();
  });

  test("runs an interactive review as a cancellable detached task", async () => {
    const parent = new AbortController();
    let started = false;
    let sawAbort = false;
    let settled = false;
    const task = reviewTest.startDetachedReview(async (signal) => {
      started = true;
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          sawAbort = true;
          resolve();
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    }, parent.signal);
    void task.finished.then(() => {
      settled = true;
    });

    expect(started).toBeTrue();
    await Promise.resolve();
    expect(settled).toBeFalse();
    parent.abort();
    await task.finished;
    expect(sawAbort).toBeTrue();
    expect(settled).toBeTrue();
  });
});
