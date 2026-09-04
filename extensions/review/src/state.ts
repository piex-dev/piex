import type { ReviewReport, ReviewRun, ReviewScope } from "./types.js";

export const REVIEW_RUN_ENTRY = "piex-review-run";

interface SessionEntries {
  getEntries(): readonly unknown[];
  getBranch?(): readonly unknown[];
}

function isReviewRun(value: unknown): value is ReviewRun {
  if (!value || typeof value !== "object") return false;
  const run = value as Partial<ReviewRun>;
  return (
    run.version === 1 &&
    typeof run.createdAt === "string" &&
    typeof run.scopeKey === "string" &&
    typeof run.diffHash === "string" &&
    typeof run.reviewerModel === "string" &&
    !!run.report &&
    typeof run.report === "object"
  );
}

export function findPreviousRun(
  sessionManager: SessionEntries,
  scopeKey: string,
): ReviewRun | undefined {
  // A session file can contain abandoned branches. Re-review state follows
  // only the active conversation branch when the Pi API exposes it.
  const entries = sessionManager.getBranch?.() ?? sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index] as {
      type?: unknown;
      customType?: unknown;
      data?: unknown;
    };
    if (entry?.type !== "custom" || entry.customType !== REVIEW_RUN_ENTRY)
      continue;
    if (isReviewRun(entry.data) && entry.data.scopeKey === scopeKey)
      return entry.data;
  }
  return undefined;
}

export function createReviewRun(
  scope: ReviewScope,
  report: ReviewReport,
): ReviewRun {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    scopeKey: scope.scopeKey,
    diffHash: scope.diffHash,
    reviewerModel: report.reviewerModel,
    report,
  };
}

export function cachedReport(run: ReviewRun): ReviewReport {
  return { ...run.report, cached: true };
}

export const __test__ = { isReviewRun };
