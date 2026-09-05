import {
  DynamicBorder,
  getLanguageFromPath,
  highlightCode,
  truncateToVisualLines,
  type ExtensionContext,
  type Theme,
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

type TranscriptHighlighter = (code: string, language?: string) => string[];

interface TranscriptPalette {
  text(text: string): string;
  muted(text: string): string;
  accent(text: string): string;
  success(text: string): string;
  error(text: string): string;
  heading(text: string): string;
  toolTitle(text: string): string;
  json(code: string): string[];
  diff(code: string): string[];
  source(code: string, language?: string): string[];
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

function reviewerMetadata(reviewer: ReviewerTranscript): string {
  const { model, thinkingLevel, fastMode } = reviewer.descriptor;
  return `${reviewerLabel(reviewer)} · ${model} · thinking ${thinkingLevel}${fastMode ? " · fast" : ""}`;
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

function transcriptHeader(
  snapshot: ReviewTranscriptSnapshot,
  reviewer: ReviewerTranscript | undefined,
): string[] {
  const header = [
    `Scope: ${snapshot.scopeLabel}`,
    snapshot.scopeSummary,
    reviewer
      ? `Reviewer: ${reviewerMetadata(reviewer)} · ${reviewer.status}`
      : "Reviewer: waiting to start",
  ];
  if (reviewer?.droppedItems) {
    header.push(`[${reviewer.droppedItems} earlier reviewer entries omitted]`);
  }
  if (snapshot.droppedItems) {
    header.push(`[${snapshot.droppedItems} earlier run entries omitted]`);
  }
  return header;
}

function highlightJsonValue(theme: Theme, value: string): string {
  const match = value.match(
    /^(\s*)("(?:\\.|[^"\\])*"|-?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|true|false|null)(.*)$/,
  );
  if (!match) return theme.fg("syntaxPunctuation", value);
  const [, padding, token, suffix] = match;
  const color = token.startsWith('"') ? "toolOutput" : "syntaxNumber";
  return (
    padding + theme.fg(color, token) + theme.fg("syntaxPunctuation", suffix)
  );
}

function highlightJson(theme: Theme, code: string): string[] {
  return code.split("\n").map((line) => {
    const key = line.match(/^(\s*)("(?:\\.|[^"\\])*")(\s*:\s*)(.*)$/);
    if (!key) return highlightJsonValue(theme, line);
    return (
      key[1] +
      theme.fg("syntaxVariable", key[2]) +
      theme.fg("syntaxPunctuation", key[3]) +
      highlightJsonValue(theme, key[4])
    );
  });
}

function highlightDiff(theme: Theme, code: string): string[] {
  return code.split("\n").map((line) => {
    if (line.startsWith("+")) return theme.fg("toolDiffAdded", line);
    if (line.startsWith("-")) return theme.fg("toolDiffRemoved", line);
    if (line.startsWith("@@")) return theme.fg("accent", line);
    return theme.fg("toolDiffContext", line);
  });
}

function createDefaultTranscriptPalette(
  highlighter: TranscriptHighlighter,
): TranscriptPalette {
  return {
    text: (text) => text,
    muted: (text) => text,
    accent: (text) => text,
    success: (text) => text,
    error: (text) => text,
    heading: (text) => text,
    toolTitle: (text) => text,
    json: (code) => highlighter(code, "json"),
    diff: (code) => highlighter(code, "diff"),
    source: highlighter,
  };
}

function createTranscriptPalette(theme: Theme): TranscriptPalette {
  return {
    text: (text) => theme.fg("text", text),
    muted: (text) => theme.fg("muted", text),
    accent: (text) => theme.fg("accent", text),
    success: (text) => theme.fg("success", text),
    error: (text) => theme.fg("error", text),
    heading: (text) => theme.fg("mdHeading", theme.bold(text)),
    toolTitle: (text) => theme.fg("toolTitle", theme.bold(text)),
    json: (code) => highlightJson(theme, code),
    diff: (code) => highlightDiff(theme, code),
    source: highlightCode,
  };
}

function highlightLabeledLine(
  line: string,
  palette: TranscriptPalette,
): string {
  const label = line.match(/^([^:]{1,40}:)(.*)$/);
  if (!label) return palette.text(line);
  return palette.toolTitle(label[1]) + palette.text(label[2]);
}

function highlightPromptLine(line: string, palette: TranscriptPalette): string {
  if (/^#{1,6}\s/.test(line)) return palette.heading(line);
  if (/^\s*[-*]\s/.test(line)) {
    const bullet = line.match(/^(\s*[-*]\s)(.*)$/);
    if (bullet) return palette.muted(bullet[1]) + palette.text(bullet[2]);
  }
  if (
    /^(?:Repository label|Repository root|Scope|Base OID|Head OID|Files|Additional user focus):/.test(
      line,
    )
  ) {
    return highlightLabeledLine(line, palette);
  }
  if (line.startsWith("No previous review")) return palette.muted(line);
  return palette.text(line);
}

function highlightPrompt(text: string, palette: TranscriptPalette): string {
  const output: string[] = [];
  let diffLines: string[] = [];
  let inDiff = false;
  const flushDiff = () => {
    if (diffLines.length === 0) return;
    output.push(...palette.diff(diffLines.join("\n")));
    diffLines = [];
  };

  for (const line of text.split("\n")) {
    if (line === "<diff>") {
      flushDiff();
      inDiff = true;
      output.push(palette.muted(line));
    } else if (line === "</diff>") {
      flushDiff();
      inDiff = false;
      output.push(palette.muted(line));
    } else if (inDiff) {
      diffLines.push(line);
    } else {
      output.push(highlightPromptLine(line, palette));
    }
  }
  flushDiff();
  return output.join("\n");
}

function highlightItemHeading(
  snapshot: ReviewTranscriptSnapshot,
  item: ReviewerTranscriptItem | ReviewTranscriptRunItem,
  palette: TranscriptPalette,
): string {
  const heading = itemHeading(snapshot, item);
  const parts = heading.match(/^(\[[^\]]+\])\s(.*)$/);
  if (!parts) return palette.muted(heading);

  let detail: string;
  if (
    item.kind === "error" ||
    (item.kind === "tool_result" && item.isError) ||
    (item.kind === "status" && item.status === "failed")
  ) {
    detail = palette.error(parts[2]);
  } else if (
    item.kind === "final_review" ||
    (item.kind === "status" &&
      ["complete", "completed", "done"].includes(item.status ?? ""))
  ) {
    detail = palette.success(parts[2]);
  } else if (item.kind === "tool_call" || item.kind === "tool_result") {
    detail = palette.toolTitle(parts[2]);
  } else if (item.kind === "note") {
    detail = palette.muted(parts[2]);
  } else {
    detail = palette.accent(parts[2]);
  }
  return `${palette.muted(parts[1])} ${detail}`;
}

function parseSerializedObject(
  value: string,
): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function toolCallPath(
  reviewer: ReviewerTranscript | undefined,
  item: ReviewerTranscriptItem | ReviewTranscriptRunItem,
): string | undefined {
  if (item.kind !== "tool_result") return undefined;
  let call: ReviewerTranscriptItem | undefined;
  for (let index = (reviewer?.items.length ?? 0) - 1; index >= 0; index -= 1) {
    const candidate = reviewer?.items[index];
    if (
      candidate?.kind === "tool_call" &&
      candidate.toolName === item.toolName &&
      (item.toolCallId
        ? candidate.toolCallId === item.toolCallId
        : candidate.id < item.id)
    ) {
      call = candidate;
      break;
    }
  }
  if (!call || call.kind !== "tool_call") return undefined;
  const args = parseSerializedObject(call.arguments);
  return typeof args?.path === "string" ? args.path : undefined;
}

function serializedToolResult(value: string):
  | {
      content: string[];
      metadata?: string;
    }
  | undefined {
  const parsed = parseSerializedObject(value);
  if (!parsed || !Array.isArray(parsed.content)) return undefined;
  const content = parsed.content.filter(
    (entry): entry is string => typeof entry === "string",
  );
  if (content.length === 0) return undefined;
  const metadata = { ...parsed };
  delete metadata.content;
  return {
    content,
    ...(Object.keys(metadata).length > 0
      ? { metadata: JSON.stringify(metadata, null, 2) }
      : {}),
  };
}

function highlightToolResult(
  result: { content: string[]; metadata?: string },
  language: string | undefined,
  palette: TranscriptPalette,
): string {
  const lines = result.content.flatMap((value) =>
    language === "diff" ? palette.diff(value) : palette.source(value, language),
  );
  if (result.metadata) {
    lines.push("", ...palette.json(result.metadata));
  }
  return lines.join("\n");
}

function highlightedItemBody(
  item: ReviewerTranscriptItem | ReviewTranscriptRunItem,
  reviewer: ReviewerTranscript | undefined,
  palette: TranscriptPalette,
): string {
  if (!("stage" in item)) return palette.text(item.text);
  if (item.kind === "prompt") return highlightPrompt(item.text, palette);
  if (item.kind === "tool_call" || item.kind === "final_review") {
    return palette.json(itemBody(item)).join("\n");
  }
  if (item.kind !== "tool_result") return palette.text(itemBody(item));

  const result = serializedToolResult(item.summary);
  if (item.toolName === "review_diff" && result) {
    return highlightToolResult(result, "diff", palette);
  }
  if (item.toolName === "read" && result) {
    const language = getLanguageFromPath(toolCallPath(reviewer, item) ?? "");
    return highlightToolResult(result, language, palette);
  }
  return palette.json(item.summary).join("\n");
}

export function renderHighlightedTranscriptDocument(
  snapshot: ReviewTranscriptSnapshot,
  reviewerId?: string,
  highlighter: TranscriptHighlighter = highlightCode,
  palette: TranscriptPalette = createDefaultTranscriptPalette(highlighter),
): string {
  const reviewer =
    snapshot.reviewers.find(({ descriptor }) => descriptor.id === reviewerId) ??
    snapshot.reviewers[0];
  const header = transcriptHeader(snapshot, reviewer).map((line, index) =>
    index === 1 || line.startsWith("[")
      ? palette.muted(line)
      : highlightLabeledLine(line, palette),
  );
  const entries = timeline(snapshot, reviewer);
  if (entries.length === 0) {
    return [...header, "", "Waiting for reviewer activity…"].join("\n");
  }
  return [
    ...header,
    "",
    ...entries.flatMap(({ item }) => [
      highlightItemHeading(snapshot, item, palette),
      highlightedItemBody(item, reviewer, palette),
      "",
    ]),
  ].join("\n");
}

export function renderTranscriptDocument(
  snapshot: ReviewTranscriptSnapshot,
  reviewerId?: string,
): string {
  const reviewer =
    snapshot.reviewers.find(({ descriptor }) => descriptor.id === reviewerId) ??
    snapshot.reviewers[0];
  const header = transcriptHeader(snapshot, reviewer);

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

interface CachedTranscriptBlock {
  source: string[];
  text: string;
  width?: number;
  wrapped?: ReturnType<typeof truncateToVisualLines>;
}

/** Cache only the selected reviewer's bounded entries, never raw tool data. */
export class TranscriptRenderCache {
  private runId?: string;
  private reviewerId?: string;
  private readonly blocks = new Map<string, CachedTranscriptBlock>();

  constructor(
    highlighter: TranscriptHighlighter = highlightCode,
    private readonly palette: TranscriptPalette = createDefaultTranscriptPalette(
      highlighter,
    ),
    private readonly wrap = truncateToVisualLines,
  ) {}

  clear(): void {
    this.blocks.clear();
  }

  render(
    snapshot: ReviewTranscriptSnapshot,
    reviewerId: string | undefined,
    width: number,
  ): string[] {
    const reviewer =
      snapshot.reviewers.find(
        ({ descriptor }) => descriptor.id === reviewerId,
      ) ?? snapshot.reviewers[0];
    if (
      this.runId !== snapshot.runId ||
      this.reviewerId !== reviewer?.descriptor.id
    ) {
      this.clear();
      this.runId = snapshot.runId;
      this.reviewerId = reviewer?.descriptor.id;
    }
    const used = new Set<string>();
    const block = (key: string, source: string[], render: () => string) => {
      used.add(key);
      let cached = this.blocks.get(key);
      if (
        !cached ||
        cached.source.length !== source.length ||
        source.some((value, index) => value !== cached!.source[index])
      ) {
        cached = { source, text: render() };
        this.blocks.set(key, cached);
      }
      if (!cached.wrapped || cached.width !== width) {
        cached.wrapped = this.wrap(cached.text, MAX_RENDER_LINES, width);
        cached.width = width;
      }
      return cached.wrapped;
    };
    const entries = timeline(snapshot, reviewer);
    const header = transcriptHeader(snapshot, reviewer);
    if (entries.length === 0) header.push("", "Waiting for reviewer activity…");
    else header.push("");
    const wrapped = [
      block("header", header, () =>
        header
          .map((line, index) =>
            index === 1 || line.startsWith("[")
              ? this.palette.muted(line)
              : highlightLabeledLine(line, this.palette),
          )
          .join("\n"),
      ),
      ...entries.map(({ item }) => {
        const heading = itemHeading(snapshot, item);
        // The matching call may have been evicted since the last render.
        const file = toolCallPath(reviewer, item) ?? "";
        return block(
          `${"stage" in item ? "reviewer" : "run"}:${item.id}`,
          [item.kind, heading, itemBody(item), file],
          () =>
            [
              highlightItemHeading(snapshot, item, this.palette),
              highlightedItemBody(item, reviewer, this.palette),
              "",
            ].join("\n"),
        );
      }),
    ];
    // Drop evicted entries (and entries removed by an automatic retry).
    for (const key of this.blocks.keys()) {
      if (!used.has(key)) this.blocks.delete(key);
    }
    const totalLines = wrapped.reduce(
      (count, result) =>
        count + result.visualLines.length + result.skippedCount,
      0,
    );
    let remaining = MAX_RENDER_LINES;
    const tail: string[][] = [];
    for (let index = wrapped.length - 1; index >= 0 && remaining > 0; index--) {
      const lines = wrapped[index].visualLines.slice(-remaining);
      tail.push(lines);
      remaining -= lines.length;
    }
    const lines = tail.reverse().flat();
    const skipped = totalLines - lines.length;
    return skipped > 0
      ? [`[${skipped} earlier visual lines omitted]`, ...lines]
      : lines;
  }
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
      let cachedContent:
        | {
            runId: string;
            reviewerId: string | undefined;
            width: number;
            lines: string[];
          }
        | undefined;
      const renderer = new TranscriptRenderCache(
        highlightCode,
        createTranscriptPalette(theme),
      );
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
      const unsubscribe = store.subscribe(({ runId, reviewerId }) => {
        if (
          cachedContent?.runId !== runId ||
          reviewerId === undefined ||
          reviewerId === selectedReviewerId
        ) {
          cachedContent = undefined;
        }
        requestRender();
      });
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
        renderer.clear();
        done(undefined);
      };

      return {
        render(width: number): string[] {
          const snapshot = latest();
          if (!snapshot) return ["No review transcript available."];
          normalizeSelection(snapshot);
          const renderWidth = Math.max(1, width);
          if (
            !cachedContent ||
            cachedContent.runId !== snapshot.runId ||
            cachedContent.reviewerId !== selectedReviewerId ||
            cachedContent.width !== renderWidth
          ) {
            cachedContent = {
              runId: snapshot.runId,
              reviewerId: selectedReviewerId,
              width: renderWidth,
              lines: renderer.render(snapshot, selectedReviewerId, renderWidth),
            };
          }
          const content = cachedContent.lines;
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
            ? reviewerMetadata(selected)
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
          const visibleContent = content.slice(
            scrollOffset,
            scrollOffset + viewportHeight,
          );
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
          cachedContent = undefined;
          renderer.clear();
          topBorder.invalidate();
          bottomBorder.invalidate();
        },
        dispose(): void {
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          renderer.clear();
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
