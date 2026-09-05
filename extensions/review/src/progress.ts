import type {
  ReviewProgressEvent,
  ReviewProgressObserver,
  ReviewProgressSnapshot,
  ReviewerProgressEntry,
  ReviewerProgressState,
  ReviewerRole,
} from "./types.js";

const TERMINAL_STATES = new Set<ReviewerProgressState>([
  "done",
  "failed",
  "cancelled",
]);

const PHASE_LABELS: Record<ReviewProgressSnapshot["phase"], string> = {
  preparing: "preparing",
  reviewing: "reviewing",
  adjudicating: "adjudicating",
  validating: "validating",
  refreshing: "changes detected; restarting",
  cached: "cached",
  complete: "complete",
  failed: "failed",
  cancelled: "cancelled",
};

export function sanitizeProgressText(value: unknown, max = 120): string {
  const text = String(value ?? "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function objectString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim()
    ? sanitizeProgressText(candidate, 80)
    : undefined;
}

export function describeReviewerTool(toolName: string, args: unknown): string {
  switch (toolName) {
    case "read":
      return `reading ${objectString(args, "path") ?? "source"}`;
    case "grep":
      return objectString(args, "path")
        ? `searching ${objectString(args, "path")}`
        : "searching source";
    case "find":
      return objectString(args, "path")
        ? `finding files in ${objectString(args, "path")}`
        : "finding files";
    case "ls":
      return `listing ${objectString(args, "path") ?? "repository"}`;
    case "review_diff":
      return objectString(args, "file")
        ? `checking diff for ${objectString(args, "file")}`
        : "checking frozen diff";
    case "submit_review":
      return "submitting report";
    default:
      return `using ${sanitizeProgressText(toolName, 48) || "tool"}`;
  }
}

export function emitReviewProgress(
  observer: ReviewProgressObserver | undefined,
  event: ReviewProgressEvent,
): void {
  try {
    observer?.(event);
  } catch {
    // Progress rendering must never interrupt the review itself.
  }
}

export class ReviewProgressTracker {
  readonly startedAt: number;
  #updatedAt: number;
  #phase: ReviewProgressSnapshot["phase"] = "preparing";
  #reviewers = new Map<ReviewerRole, ReviewerProgressEntry>();

  constructor(startedAt = Date.now()) {
    this.startedAt = startedAt;
    this.#updatedAt = startedAt;
  }

  apply(event: ReviewProgressEvent, now = Date.now()): void {
    this.#updatedAt = now;
    switch (event.type) {
      case "phase":
        this.#phase = event.phase;
        if (event.phase === "refreshing") {
          this.#reviewers.clear();
          return;
        }
        if (event.phase === "failed" || event.phase === "cancelled") {
          for (const reviewer of this.#reviewers.values()) {
            if (TERMINAL_STATES.has(reviewer.state)) continue;
            reviewer.state = event.phase;
            reviewer.activity = event.phase;
          }
        }
        return;
      case "reviewer_started":
        this.#reviewers.set(event.reviewer.role, {
          ...event.reviewer,
          model: sanitizeProgressText(event.reviewer.model),
          thinkingLevel: sanitizeProgressText(event.reviewer.thinkingLevel),
          specialty: event.reviewer.specialty
            ? sanitizeProgressText(event.reviewer.specialty)
            : undefined,
          state: "starting",
          activity: "starting",
          toolCalls: 0,
        });
        return;
      case "reviewer_run_started": {
        const reviewer = this.#reviewers.get(event.role);
        if (!reviewer) return;
        reviewer.state = "reasoning";
        reviewer.activity = sanitizeProgressText(event.activity);
        return;
      }
      case "reviewer_activity": {
        const reviewer = this.#reviewers.get(event.role);
        if (!reviewer || TERMINAL_STATES.has(reviewer.state)) return;
        reviewer.state = event.state;
        reviewer.activity = sanitizeProgressText(event.activity);
        if (event.toolStarted) reviewer.toolCalls++;
        return;
      }
      case "reviewer_finished": {
        const reviewer = this.#reviewers.get(event.role);
        if (!reviewer || TERMINAL_STATES.has(reviewer.state)) return;
        reviewer.state = "done";
        reviewer.activity = "done";
        return;
      }
      case "reviewer_failed": {
        const reviewer = this.#reviewers.get(event.role);
        if (!reviewer || TERMINAL_STATES.has(reviewer.state)) return;
        reviewer.state = event.cancelled ? "cancelled" : "failed";
        reviewer.activity = reviewer.state;
      }
    }
  }

  snapshot(now = Date.now()): ReviewProgressSnapshot {
    const reviewers = [...this.#reviewers.values()]
      .sort((left, right) =>
        left.role === right.role ? 0 : left.role === "lead" ? -1 : 1,
      )
      .map((reviewer) => ({ ...reviewer }));
    return {
      phase: this.#phase,
      startedAt: this.startedAt,
      updatedAt: this.#updatedAt,
      elapsedMs: Math.max(0, now - this.startedAt),
      reviewers,
    };
  }
}

function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${remainder
    .toString()
    .padStart(2, "0")}`;
}

function reviewerLabel(reviewer: ReviewerProgressEntry): string {
  return reviewer.specialty
    ? `${reviewer.role}/${reviewer.specialty}`
    : reviewer.role;
}

function marker(state: ReviewerProgressState): string {
  if (state === "done") return "✓";
  if (state === "failed") return "✗";
  if (state === "cancelled") return "–";
  return "●";
}

export function renderProgressLines(
  snapshot: ReviewProgressSnapshot,
): string[] {
  const lines = [
    `Review · ${formatElapsed(snapshot.elapsedMs)} · ${PHASE_LABELS[snapshot.phase]}`,
  ];
  for (const reviewer of snapshot.reviewers) {
    const fast = reviewer.fastMode ? " · fast" : "";
    const tools =
      reviewer.toolCalls > 0
        ? ` · ${reviewer.toolCalls} tool${reviewer.toolCalls === 1 ? "" : "s"}`
        : "";
    lines.push(
      `${marker(reviewer.state)} ${reviewerLabel(reviewer)} · ${reviewer.model} · thinking ${reviewer.thinkingLevel}${fast} · ${reviewer.activity}${tools}`,
    );
  }
  return lines;
}

export function renderProgressStatus(snapshot: ReviewProgressSnapshot): string {
  const active =
    snapshot.reviewers.find(({ state }) => !TERMINAL_STATES.has(state)) ??
    snapshot.reviewers[0];
  const head = `review ${formatElapsed(snapshot.elapsedMs)} · ${PHASE_LABELS[snapshot.phase]}`;
  if (!active) return head;
  const fast = active.fastMode ? " · fast" : "";
  const extra = snapshot.reviewers.length > 1 ? " · +1 reviewer" : "";
  return `${head} · ${reviewerLabel(active)} ${active.model} · thinking ${active.thinkingLevel}${fast} · ${active.activity}${extra}`;
}

export function renderProgressText(snapshot: ReviewProgressSnapshot): string {
  return renderProgressLines(snapshot).join("\n");
}
