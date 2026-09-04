import {
  DynamicBorder,
  truncateToVisualLines,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
  ReviewerTranscript,
  ReviewerTranscriptItem,
  ReviewerTranscriptStore,
  ReviewTranscriptRunItem,
  ReviewTranscriptSnapshot,
} from "./transcript.js";

const MAX_RENDER_LINES = 20_000;
const OVERLAY_CHROME_LINES = 5;

type TranscriptViewerContext = Pick<ExtensionContext, "hasUI" | "mode" | "ui">;

interface TimelineEntry {
  at: number;
  order: number;
  item: ReviewerTranscriptItem | ReviewTranscriptRunItem;
}

function formatElapsed(startedAt: number, at: number): string {
  const seconds = Math.max(0, Math.floor((at - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes.toString().padStart(2, "0")}:${(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
}

function reviewerLabel(reviewer: ReviewerTranscript): string {
  const { role, specialty } = reviewer.descriptor;
  return specialty ? `${role}/${specialty}` : role;
}

export function renderTranscriptTitle(
  snapshot: ReviewTranscriptSnapshot,
  now = Date.now(),
): string {
  const elapsed = formatElapsed(
    snapshot.startedAt,
    snapshot.completedAt ?? now,
  );
  return `Review transcript · ${elapsed} · ${snapshot.status}`;
}

function itemHeading(
  snapshot: ReviewTranscriptSnapshot,
  item: ReviewerTranscriptItem | ReviewTranscriptRunItem,
): string {
  const elapsed = formatElapsed(snapshot.startedAt, item.at);
  if ("stage" in item) {
    switch (item.kind) {
      case "prompt":
        return `[${elapsed}] prompt · ${item.stage}`;
      case "assistant":
        return `[${elapsed}] assistant · ${item.stage}`;
      case "tool_call":
        return `[${elapsed}] tool call · ${item.toolName}`;
      case "tool_result":
        return `[${elapsed}] tool result · ${item.toolName} · ${item.isError ? "error" : "ok"}`;
      case "final_review":
        return `[${elapsed}] submitted review · ${item.stage}`;
      case "error":
        return `[${elapsed}] error · ${item.stage}`;
      case "note":
        return `[${elapsed}] note · ${item.stage}`;
      case "status":
        return `[${elapsed}] ${item.status} · ${item.stage}`;
    }
  }
  return item.kind === "status"
    ? `[${elapsed}] ${item.status}`
    : `[${elapsed}] note`;
}

function itemBody(
  item: ReviewerTranscriptItem | ReviewTranscriptRunItem,
): string {
  if (!("stage" in item)) return item.text;
  switch (item.kind) {
    case "prompt":
    case "assistant":
    case "note":
    case "status":
      return item.text;
    case "tool_call":
      return item.arguments;
    case "tool_result":
      return item.summary;
    case "final_review":
      return item.review;
    case "error":
      return item.message;
  }
}

function timeline(
  snapshot: ReviewTranscriptSnapshot,
  reviewer: ReviewerTranscript | undefined,
): TimelineEntry[] {
  return [
    ...snapshot.items.map((item, order) => ({ at: item.at, order, item })),
    ...(reviewer?.items ?? []).map((item, order) => ({
      at: item.at,
      order: snapshot.items.length + order,
      item,
    })),
  ].sort((left, right) => left.at - right.at || left.order - right.order);
}

export function renderTranscriptDocument(
  snapshot: ReviewTranscriptSnapshot,
  reviewerId?: string,
): string {
  const reviewer =
    snapshot.reviewers.find(({ descriptor }) => descriptor.id === reviewerId) ??
    snapshot.reviewers[0];
  const header = [
    `Scope: ${snapshot.scopeLabel}`,
    snapshot.scopeSummary,
    reviewer
      ? `Reviewer: ${reviewerLabel(reviewer)} · ${reviewer.descriptor.model} · thinking ${reviewer.descriptor.thinkingLevel} · ${reviewer.status}`
      : "Reviewer: waiting to start",
  ];
  if (reviewer?.droppedItems) {
    header.push(`[${reviewer.droppedItems} earlier reviewer entries omitted]`);
  }
  if (snapshot.droppedItems) {
    header.push(`[${snapshot.droppedItems} earlier run entries omitted]`);
  }

  const entries = timeline(snapshot, reviewer);
  if (entries.length === 0) {
    return [...header, "", "Waiting for reviewer activity…"].join("\n");
  }
  return [
    ...header,
    "",
    ...entries.flatMap(({ item }) => [
      itemHeading(snapshot, item),
      itemBody(item),
      "",
    ]),
  ].join("\n");
}

export async function openReviewTranscript(
  ctx: TranscriptViewerContext,
  store: ReviewerTranscriptStore,
): Promise<void> {
  if (!store.getLatestSnapshot()) {
    ctx.ui.notify("No review transcript yet. Run /review first.", "info");
    return;
  }
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify(
      "The review transcript viewer requires the interactive TUI.",
      "warning",
    );
    return;
  }

  await ctx.ui.custom(
    (tui, theme, keybindings, done) => {
      let selectedReviewerId: string | undefined;
      let scrollOffset = 0;
      let contentLineCount = 0;
      let viewportHeight = 1;
      let followTail = true;
      let closed = false;
      const topBorder = new DynamicBorder((text) =>
        theme.fg("borderAccent", text),
      );
      const bottomBorder = new DynamicBorder((text) =>
        theme.fg("borderAccent", text),
      );

      const latest = () => store.getLatestSnapshot();
      const reviewerIds = (snapshot: ReviewTranscriptSnapshot) =>
        snapshot.reviewers.map(({ descriptor }) => descriptor.id);
      const normalizeSelection = (snapshot: ReviewTranscriptSnapshot) => {
        const ids = reviewerIds(snapshot);
        if (!selectedReviewerId || !ids.includes(selectedReviewerId)) {
          selectedReviewerId = ids[0];
        }
      };
      const maxScrollOffset = () =>
        Math.max(0, contentLineCount - viewportHeight);
      const requestRender = () => {
        if (!closed) tui.requestRender();
      };
      const unsubscribe = store.subscribe(() => requestRender());
      const heartbeat = setInterval(requestRender, 1000);

      const cycleReviewer = () => {
        const snapshot = latest();
        if (!snapshot) return;
        const ids = reviewerIds(snapshot);
        if (ids.length < 2) return;
        const current = Math.max(0, ids.indexOf(selectedReviewerId ?? ""));
        selectedReviewerId = ids[(current + 1) % ids.length];
        followTail = true;
        requestRender();
      };
      const scrollBy = (delta: number) => {
        followTail = false;
        scrollOffset = Math.max(
          0,
          Math.min(scrollOffset + delta, maxScrollOffset()),
        );
        if (scrollOffset === maxScrollOffset()) followTail = true;
        requestRender();
      };
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        done(undefined);
      };

      return {
        render(width: number): string[] {
          const snapshot = latest();
          if (!snapshot) return ["No review transcript available."];
          normalizeSelection(snapshot);
          const document = renderTranscriptDocument(
            snapshot,
            selectedReviewerId,
          );
          const wrapped = truncateToVisualLines(
            document,
            MAX_RENDER_LINES,
            Math.max(1, width),
          );
          const content =
            wrapped.skippedCount > 0
              ? [
                  `[${wrapped.skippedCount} earlier visual lines omitted]`,
                  ...wrapped.visualLines,
                ]
              : wrapped.visualLines;
          contentLineCount = content.length;
          viewportHeight = Math.max(
            1,
            tui.terminal.rows - OVERLAY_CHROME_LINES,
          );
          if (followTail) scrollOffset = maxScrollOffset();
          else
            scrollOffset = Math.max(
              0,
              Math.min(scrollOffset, maxScrollOffset()),
            );

          const title = renderTranscriptTitle(snapshot);
          const selected = snapshot.reviewers.find(
            ({ descriptor }) => descriptor.id === selectedReviewerId,
          );
          const tab = selected
            ? `${reviewerLabel(selected)} · ${selected.descriptor.model} · thinking ${selected.descriptor.thinkingLevel}`
            : "waiting for reviewer";
          const firstLine =
            contentLineCount === 0
              ? 0
              : Math.min(contentLineCount, scrollOffset + 1);
          const lastLine = Math.min(
            contentLineCount,
            scrollOffset + viewportHeight,
          );
          const followState = ["complete", "failed", "cancelled"].includes(
            snapshot.status,
          )
            ? snapshot.status
            : followTail
              ? "live"
              : "paused";
          const footer = `Tab switch · ↑↓/j/k scroll · PgUp/PgDn page · g/G start/end · q/Esc close · ${followState} · ${firstLine}-${lastLine}/${contentLineCount}`;
          const visibleContent = content
            .slice(scrollOffset, scrollOffset + viewportHeight)
            .map((line) => theme.fg("text", line));
          while (visibleContent.length < viewportHeight) {
            visibleContent.push("");
          }
          return [
            ...topBorder.render(width),
            theme.fg("accent", theme.bold(title)),
            theme.fg("dim", tab),
            ...visibleContent,
            theme.fg("dim", footer),
            ...bottomBorder.render(width),
          ];
        },
        handleInput(data: string): void {
          if (data === "q" || keybindings.matches(data, "tui.select.cancel")) {
            close();
          } else if (keybindings.matches(data, "tui.input.tab")) {
            cycleReviewer();
          } else if (
            data === "k" ||
            keybindings.matches(data, "tui.select.up")
          ) {
            scrollBy(-1);
          } else if (
            data === "j" ||
            keybindings.matches(data, "tui.select.down")
          ) {
            scrollBy(1);
          } else if (keybindings.matches(data, "tui.select.pageUp")) {
            scrollBy(-viewportHeight);
          } else if (keybindings.matches(data, "tui.select.pageDown")) {
            scrollBy(viewportHeight);
          } else if (data === "g") {
            followTail = false;
            scrollOffset = 0;
            requestRender();
          } else if (data === "G") {
            followTail = true;
            scrollOffset = maxScrollOffset();
            requestRender();
          }
        },
        invalidate(): void {
          topBorder.invalidate();
          bottomBorder.invalidate();
        },
        dispose(): void {
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-left",
        width: "100%",
        maxHeight: "100%",
        margin: 0,
      },
    },
  );
}
