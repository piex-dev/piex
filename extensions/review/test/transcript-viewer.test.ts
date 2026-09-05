import { describe, expect, spyOn, test } from "bun:test";
import { truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import reviewExtension, { __test__ as reviewTest } from "../src/review-v2.ts";
import { REVIEW_RUN_ENTRY } from "../src/state.ts";
import { ReviewerTranscriptStore } from "../src/transcript.ts";
import {
  openReviewTranscript,
  renderHighlightedTranscriptDocument,
  renderTranscriptDocument,
  renderTranscriptTitle,
  TranscriptRenderCache,
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
        fastMode: true,
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
        fastMode: false,
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
    expect(document).not.toContain(" · fast");
    expect(document).toContain("[00:00] reviewing");
    expect(document).toContain("specialist-only");
    expect(document).not.toContain("lead-only");

    const leadDocument = renderTranscriptDocument(
      store.getLatestSnapshot()!,
      "lead",
    );
    expect(leadDocument).toContain("thinking xhigh · fast · running");
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

  test("highlights structured arguments, source reads, and review diffs", () => {
    const store = new ReviewerTranscriptStore();
    const runId = store.startReview(
      { runId: "highlight", scopeLabel: "repo", scopeSummary: "1 file" },
      1_000,
    );
    store.startReviewer(
      runId,
      {
        id: "lead",
        role: "lead",
        stage: "review",
        model: "provider/model",
        thinkingLevel: "high",
      },
      1_010,
    );
    store.record(
      runId,
      "lead",
      {
        kind: "tool_call",
        toolName: "read",
        toolCallId: "read-1",
        arguments: { path: "src/app.ts" },
      },
      1_020,
    );
    store.record(
      runId,
      "lead",
      {
        kind: "tool_result",
        toolName: "read",
        toolCallId: "read-1",
        result: {
          content: [{ type: "text", text: "const answer = 42;" }],
          details: { truncated: false },
        },
      },
      1_030,
    );
    store.record(
      runId,
      "lead",
      {
        kind: "tool_call",
        toolName: "review_diff",
        toolCallId: "diff-1",
        arguments: { file: "src/app.ts" },
      },
      1_040,
    );
    store.record(
      runId,
      "lead",
      {
        kind: "tool_result",
        toolName: "review_diff",
        toolCallId: "diff-1",
        result: {
          content: [
            {
              type: "text",
              text: "-const answer = 0;\n+const answer = 42;",
            },
          ],
        },
      },
      1_050,
    );

    const languages: Array<string | undefined> = [];
    const document = renderHighlightedTranscriptDocument(
      store.getLatestSnapshot()!,
      "lead",
      (code, language) => {
        languages.push(language);
        return code.split("\n").map((line) => `<${language}>${line}`);
      },
    );

    expect(languages).toEqual(["json", "typescript", "json", "json", "diff"]);
    expect(document).toContain("<typescript>const answer = 42;");
    expect(document).toContain("<diff>-const answer = 0;");
    expect(document).toContain('<json>  "path": "src/app.ts"');
    expect(document).toContain('<json>    "truncated": false');
  });

  test("highlights large read and diff results after bounded serialization", () => {
    for (const toolName of ["read", "review_diff"]) {
      const store = new ReviewerTranscriptStore();
      const runId = store.startReview({
        scopeLabel: "repo",
        scopeSummary: "1 file",
      });
      store.startReviewer(runId, {
        id: "lead",
        role: "lead",
        stage: "review",
        model: "p/m",
        thinkingLevel: "high",
      });
      store.record(runId, "lead", {
        kind: "tool_call",
        toolName,
        toolCallId: "large",
        arguments: { path: "src/app.ts" },
      });
      const source = (
        toolName === "read" ? "const value = 42;\n" : "-old\n+new\n"
      ).repeat(2_000);
      store.record(runId, "lead", {
        kind: "tool_result",
        toolName,
        toolCallId: "large",
        result: { content: [{ type: "text", text: source }] },
      });
      const highlighted: Array<{ code: string; language?: string }> = [];
      renderHighlightedTranscriptDocument(
        store.getLatestSnapshot()!,
        "lead",
        (code, language) => {
          highlighted.push({ code, language });
          return code.split("\n");
        },
      );
      const result = highlighted.find(
        ({ language }) =>
          language === (toolName === "read" ? "typescript" : "diff"),
      );
      expect(result).toBeDefined();
      expect(result!.code).toContain("\n");
      expect(result!.code).not.toContain("\\n");
      expect(result!.code).toContain("[TRUNCATED]");
    }
  });

  test("caches entry highlighting and wrapping across live deltas and resizes", () => {
    const store = new ReviewerTranscriptStore();
    const runId = store.startReview(
      { scopeLabel: "repo", scopeSummary: "25 reads" },
      1_000,
    );
    store.startReviewer(
      runId,
      {
        id: "lead",
        role: "lead",
        stage: "review",
        model: "p/m",
        thinkingLevel: "high",
      },
      1_000,
    );
    for (let index = 0; index < 25; index++) {
      store.record(
        runId,
        "lead",
        {
          kind: "tool_call",
          toolName: "read",
          toolCallId: String(index),
          arguments: { path: "src/app.ts" },
        },
        1_000,
      );
      store.record(
        runId,
        "lead",
        {
          kind: "tool_result",
          toolName: "read",
          toolCallId: String(index),
          result: {
            content: [
              { type: "text", text: "const example = 42;\n".repeat(100) },
            ],
          },
        },
        1_000,
      );
    }
    let sourceCalls = 0;
    let wrapCalls = 0;
    const highlighter = (code: string, language?: string) => {
      if (language === "typescript") sourceCalls++;
      return code.split("\n");
    };
    const renderer = new TranscriptRenderCache(
      highlighter,
      undefined,
      (...args) => {
        wrapCalls++;
        return truncateToVisualLines(...args);
      },
    );
    const render = (width = 100) =>
      renderer.render(store.getLatestSnapshot()!, "lead", width);
    const initial = render();
    expect(sourceCalls).toBe(25);
    const initialWrapCalls = wrapCalls;
    render();
    expect(wrapCalls).toBe(initialWrapCalls);
    expect(initial).toEqual(
      truncateToVisualLines(
        renderHighlightedTranscriptDocument(
          store.getLatestSnapshot()!,
          "lead",
          (code) => code.split("\n"),
        ),
        20_000,
        100,
      ).visualLines,
    );

    store.record(
      runId,
      "lead",
      { kind: "assistant", text: "first", append: true },
      1_000,
    );
    render();
    store.record(
      runId,
      "lead",
      { kind: "assistant", text: " second", append: true },
      1_000,
    );
    expect(render().join("\n")).toContain("first second");
    expect(sourceCalls).toBe(25);
    expect(wrapCalls).toBe(initialWrapCalls + 2);

    store.startReviewer(
      runId,
      {
        id: "specialist",
        role: "specialist",
        stage: "review",
        model: "p/m",
        thinkingLevel: "high",
      },
      1_000,
    );
    store.record(
      runId,
      "specialist",
      { kind: "assistant", text: "other activity" },
      1_000,
    );
    render();
    expect(wrapCalls).toBe(initialWrapCalls + 2);
    render(80);
    expect(wrapCalls).toBeGreaterThan(initialWrapCalls + 2);
    expect(sourceCalls).toBe(25);
    renderer.clear();
    render(80);
    expect(sourceCalls).toBe(50);
  });

  test("invalidates reused item ids on retry and bounds the rendered tail", () => {
    const store = new ReviewerTranscriptStore({ maxItemsPerReviewer: 6 });
    const runId = store.startReview(
      { scopeLabel: "old scope", scopeSummary: "1 file" },
      1_000,
    );
    const descriptor = {
      id: "lead",
      role: "lead" as const,
      stage: "review" as const,
      model: "p/m",
      thinkingLevel: "high",
    };
    store.startReviewer(runId, descriptor, 1_000);
    store.record(runId, "lead", { kind: "assistant", text: "old body" }, 1_000);
    const renderer = new TranscriptRenderCache((code) => code.split("\n"));
    renderer.render(store.getLatestSnapshot()!, "lead", 80);
    store.restartReview(
      runId,
      { scopeLabel: "fresh scope", scopeSummary: "2 files" },
      1_000,
    );
    store.startReviewer(runId, descriptor, 1_000);
    store.record(
      runId,
      "lead",
      { kind: "assistant", text: "fresh body" },
      1_000,
    );
    const refreshed = renderer
      .render(store.getLatestSnapshot()!, "lead", 80)
      .join("\n");
    expect(refreshed).toContain("fresh body");
    expect(refreshed).not.toContain("old body");
    for (let index = 0; index < 7; index++) {
      store.record(
        runId,
        "lead",
        { kind: "note", text: `${index}:\n` + "x\n".repeat(4_100) },
        1_000,
      );
    }
    const snapshot = store.getLatestSnapshot()!;
    const expected = truncateToVisualLines(
      renderHighlightedTranscriptDocument(snapshot, "lead", (code) =>
        code.split("\n"),
      ),
      20_000,
      1,
    );
    const lines = renderer.render(snapshot, "lead", 1);
    expect(expected.skippedCount).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(20_001);
    expect(lines).toEqual(
      expected.skippedCount > 0
        ? [
            `[${expected.skippedCount} earlier visual lines omitted]`,
            ...expected.visualLines,
          ]
        : expected.visualLines,
    );
  });

  test("does not invalidate the selected overlay for another reviewer", async () => {
    const store = new ReviewerTranscriptStore();
    const runId = store.startReview({
      scopeLabel: "repo",
      scopeSummary: "1 file",
    });
    for (const role of ["lead", "specialist"] as const) {
      store.startReviewer(runId, {
        id: role,
        role,
        stage: "review",
        model: "p/m",
        thinkingLevel: "high",
      });
    }
    const renderSpy = spyOn(TranscriptRenderCache.prototype, "render");
    try {
      await openReviewTranscript(
        {
          hasUI: true,
          mode: "tui",
          ui: {
            notify: () => {},
            custom: async (factory: (...args: never[]) => unknown) => {
              const component = factory(
                { terminal: { rows: 40 }, requestRender: () => {} },
                {
                  fg: (_color: string, text: string) => text,
                  bold: (text: string) => text,
                },
                { matches: () => false },
                () => {},
              ) as {
                render(width: number): string[];
                invalidate(): void;
                dispose(): void;
              };
              try {
                component.render(100);
                expect(renderSpy).toHaveBeenCalledTimes(1);
                store.record(runId, "specialist", {
                  kind: "assistant",
                  text: "other",
                });
                component.render(100);
                expect(renderSpy).toHaveBeenCalledTimes(1);
                store.record(runId, "lead", {
                  kind: "assistant",
                  text: "selected",
                });
                expect(component.render(100).join("\n")).toContain("selected");
                expect(renderSpy).toHaveBeenCalledTimes(2);
                component.invalidate();
                component.render(100);
                expect(renderSpy).toHaveBeenCalledTimes(3);
              } finally {
                component.dispose();
              }
            },
          },
        } as never,
        store,
      );
    } finally {
      renderSpy.mockRestore();
    }
  });

  test("uses semantic theme colors without painting long JSON strings red", async () => {
    const store = new ReviewerTranscriptStore();
    const runId = store.startReview(
      { runId: "palette", scopeLabel: "repo", scopeSummary: "1 file" },
      1_000,
    );
    store.startReviewer(
      runId,
      {
        id: "lead",
        role: "lead",
        stage: "review",
        model: "provider/model",
        thinkingLevel: "high",
      },
      1_010,
    );
    store.record(
      runId,
      "lead",
      {
        kind: "prompt",
        text: "Repository label: repo\n### repo\n<diff>\n-old\n+new\n</diff>",
      },
      1_020,
    );
    store.record(
      runId,
      "lead",
      {
        kind: "final_review",
        review: { summary: "A long human-readable review summary" },
      },
      1_030,
    );

    let rendered = "";
    await openReviewTranscript(
      {
        hasUI: true,
        mode: "tui",
        ui: {
          notify: () => {},
          custom: async (factory: (...args: never[]) => unknown) => {
            const component = factory(
              {
                terminal: { rows: 80 },
                requestRender: () => {},
              },
              {
                fg: (color: string, text: string) =>
                  `<${color}>${text}</${color}>`,
                bold: (text: string) => `<bold>${text}</bold>`,
              },
              { matches: () => false },
              () => {},
            ) as {
              render(width: number): string[];
              handleInput?(data: string): void;
              dispose?(): void;
            };
            rendered = component.render(1_000).join("\n");
            component.handleInput?.("q");
            component.dispose?.();
          },
        },
      } as never,
      store,
    );

    expect(rendered).toContain("<toolTitle><bold>Scope:</bold></toolTitle>");
    expect(rendered).toContain("<mdHeading><bold>### repo</bold></mdHeading>");
    expect(rendered).toContain("<toolDiffRemoved>-old</toolDiffRemoved>");
    expect(rendered).toContain("<toolDiffAdded>+new</toolDiffAdded>");
    expect(rendered).toContain(
      '<toolOutput>"A long human-readable review summary"</toolOutput>',
    );
    expect(rendered).not.toContain("syntaxString");
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
      fastMode: true,
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
    expect(rendered).toContain("thinking high · fast");
    expect(renderedLineCount).toBe(40);
  });

  test("redraws same-millisecond updates via the monotonic revision", async () => {
    const store = new ReviewerTranscriptStore();
    const runId = store.startReview(
      { runId: "same-ms", scopeLabel: "repo", scopeSummary: "1 file" },
      1_000,
    );
    store.startReviewer(
      runId,
      {
        id: "lead",
        role: "lead",
        stage: "review",
        model: "provider/model",
        thinkingLevel: "high",
        fastMode: true,
      },
      1_000,
    );
    store.record(
      runId,
      "lead",
      { kind: "assistant", text: "first", append: true },
      1_000,
    );
    let renderedFirst = "";

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
            const component = factory(
              {
                terminal: { rows: 40 },
                requestRender: () => {},
              },
              {
                fg: (_color: string, text: string) => text,
                bold: (text: string) => text,
              },
              { matches: () => false },
              () => {},
            ) as {
              render(width: number): string[];
              handleInput?(data: string): void;
              dispose?(): void;
            };
            void options;
            renderedFirst = component.render(100).join("\n");
            // Same-millisecond mutation: updatedAt repeats, revision does not.
            store.record(
              runId,
              "lead",
              { kind: "assistant", text: " second", append: true },
              1_000,
            );
            component.render(100);
            component.handleInput?.("q");
            component.dispose?.();
          },
        },
      } as never,
      store,
    );

    expect(renderedFirst).toContain("first");
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
