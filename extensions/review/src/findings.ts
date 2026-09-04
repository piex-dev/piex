import { hashText, resolveDiffFile } from "./diff.js";
import type {
  DiffSummary,
  PreviousFindingResolution,
  ReviewFinding,
  ReviewFindingDraft,
  ReviewPriority,
  ReviewReport,
  ReviewScope,
  SubmittedReview,
} from "./types.js";

const PRIORITY_ORDER: Record<ReviewPriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
};

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeTitle(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u0080-\uffff]+/g, " ");
}

function resolveFindingRepo(scope: ReviewScope, value: string) {
  const exact = scope.repos.find(
    ({ repo, label }) => value === repo || value === label,
  );
  if (exact) return exact;
  const suffixMatches = scope.repos.filter(
    ({ repo }) => repo.endsWith(`/${value}`) || repo.endsWith(`\\${value}`),
  );
  return suffixMatches.length === 1 ? suffixMatches[0] : undefined;
}

function findingKey(finding: ReviewFindingDraft): string {
  return [
    finding.repo,
    finding.file.replace(/^\.\//, ""),
    normalizeTitle(finding.title),
  ].join("\0");
}

/**
 * Deduplication identity. Includes the reported location so two findings
 * with the same title at different lines both survive canonicalization.
 */
function findingInstanceKey(finding: ReviewFindingDraft): string {
  return `${findingKey(finding)}\0${finding.lineStart}\0${finding.lineEnd}`;
}

function findingId(finding: ReviewFindingDraft): string {
  return `review-${hashText(findingInstanceKey(finding)).slice(0, 12)}`;
}

function validateFinding(
  scope: ReviewScope,
  draft: ReviewFindingDraft,
  previousById: ReadonlyMap<string, ReviewFinding>,
  previousKeys: ReadonlyMap<string, string>,
): ReviewFinding | undefined {
  const snapshot = resolveFindingRepo(scope, normalizeText(draft.repo));
  if (!snapshot) return undefined;
  const diffFile = resolveDiffFile(snapshot.summary, draft.file);
  if (!diffFile) return undefined;
  if (!draft.introducedByPatch) return undefined;
  if (!normalizeText(draft.title) || !normalizeText(draft.trigger))
    return undefined;
  if (!normalizeText(draft.impact) || !normalizeText(draft.evidence))
    return undefined;
  if (!Number.isFinite(draft.confidence)) return undefined;
  if (!Number.isInteger(draft.lineStart) || !Number.isInteger(draft.lineEnd))
    return undefined;
  if (draft.lineStart < 1 || draft.lineEnd < draft.lineStart) return undefined;
  // Anchor the finding to the changed lines it covers instead of silently
  // rejecting wide ranges: a defect in a large new function body legitimately
  // spans more than ten lines, and dropping it would turn a real blocker
  // into a false PASS.
  const anchor = anchorFindingToChange(snapshot.summary, draft);
  if (!anchor) return undefined;

  const normalized: ReviewFindingDraft = {
    ...draft,
    title: normalizeText(draft.title).slice(0, 120),
    trigger: normalizeText(draft.trigger),
    impact: normalizeText(draft.impact),
    evidence: normalizeText(draft.evidence),
    repo: snapshot.label,
    file: diffFile.path,
    lineStart: anchor.lineStart,
    lineEnd: anchor.lineEnd,
  };
  const explicitPreviousId =
    draft.previousFindingId && previousById.has(draft.previousFindingId)
      ? draft.previousFindingId
      : undefined;
  const previousFindingId =
    explicitPreviousId ?? previousKeys.get(findingKey(normalized));
  const previousFinding = previousFindingId
    ? previousById.get(previousFindingId)
    : undefined;
  const effectivePriority =
    previousFinding &&
    PRIORITY_ORDER[previousFinding.priority] < PRIORITY_ORDER[draft.priority]
      ? previousFinding.priority
      : draft.priority;
  const minimumConfidence = effectivePriority === "P2" ? 0.75 : 0.8;
  if (draft.confidence < minimumConfidence || draft.confidence > 1)
    return undefined;
  normalized.previousFindingId = previousFindingId;
  return {
    ...normalized,
    id: previousFindingId ?? findingId(normalized),
  };
}

function anchorFindingToChange(
  summary: DiffSummary,
  finding: Pick<ReviewFindingDraft, "file" | "lineStart" | "lineEnd">,
): { lineStart: number; lineEnd: number } | undefined {
  const file = resolveDiffFile(summary, finding.file);
  if (!file) return undefined;
  const overlaps = file.changedRanges.filter(
    ({ start, end }) => finding.lineStart <= end && finding.lineEnd >= start,
  );
  if (overlaps.length === 0) return undefined;
  return {
    lineStart: Math.max(finding.lineStart, overlaps[0].start),
    lineEnd: Math.min(finding.lineEnd, overlaps[overlaps.length - 1].end),
  };
}

function dedupeFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const preferred = [...findings].sort(
    (left, right) =>
      PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority] ||
      right.confidence - left.confidence ||
      findingInstanceKey(left).localeCompare(findingInstanceKey(right)),
  );
  const keys = new Set<string>();
  const unique: ReviewFinding[] = [];
  for (const finding of preferred) {
    // Candidates linked to the same previous finding are re-submissions of
    // one defect and must collapse to the strongest candidate. Unlinked
    // findings deduplicate by location, so a defect repeated at a different
    // location is never silently dropped.
    const key = finding.previousFindingId
      ? `previous\0${finding.previousFindingId}`
      : findingInstanceKey(finding);
    if (keys.has(key)) continue;
    keys.add(key);
    unique.push(finding);
  }
  return unique.sort(
    (left, right) =>
      PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority] ||
      left.repo.localeCompare(right.repo) ||
      left.file.localeCompare(right.file) ||
      left.lineStart - right.lineStart,
  );
}

function preservePreviousPriority(
  findings: ReviewFinding[],
  previousOpen: ReviewFinding[],
): ReviewFinding[] {
  const previousById = new Map(
    previousOpen.map((finding) => [finding.id, finding]),
  );
  return findings.map((finding) => {
    const previous = previousById.get(finding.id);
    return previous &&
      PRIORITY_ORDER[previous.priority] < PRIORITY_ORDER[finding.priority]
      ? { ...finding, priority: previous.priority }
      : finding;
  });
}

function normalizePreviousResolutions(
  submitted: SubmittedReview[],
  previousOpen: ReviewFinding[],
  findings: ReviewFinding[],
): PreviousFindingResolution[] {
  const previousById = new Map(
    previousOpen.map((finding) => [finding.id, finding]),
  );
  const previousIds = new Set(previousById.keys());
  const resolutions = new Map<string, PreviousFindingResolution>();
  for (const review of submitted) {
    for (const resolution of review.previousFindings ?? []) {
      if (!previousIds.has(resolution.id) || resolutions.has(resolution.id))
        continue;
      const reason = normalizeText(resolution.reason);
      if (!reason) continue;
      resolutions.set(resolution.id, {
        id: resolution.id,
        status: resolution.status,
        reason,
        priority: previousById.get(resolution.id)?.priority,
      });
    }
  }
  for (const finding of findings) {
    if (!finding.previousFindingId) continue;
    resolutions.set(finding.previousFindingId, {
      id: finding.previousFindingId,
      status: "still_open",
      reason: "The current patch still contains the finding.",
      priority: previousById.get(finding.previousFindingId)?.priority,
    });
  }
  for (const id of previousIds) {
    if (!resolutions.has(id)) {
      resolutions.set(id, {
        id,
        status: "still_open",
        reason:
          "The reviewer did not provide enough evidence to close this finding.",
        priority: previousById.get(id)?.priority,
      });
    }
  }
  return [...resolutions.values()];
}

function openFindingsFrom(previous?: ReviewReport): ReviewFinding[] {
  const deduped = dedupeFindings(
    previous?.openFindings ?? previous?.findings ?? [],
  );
  // Legacy reports can carry several findings under one id. Canonicalize so
  // the strongest candidate represents that id in previous-finding linkage.
  const byId = new Map<string, ReviewFinding>();
  for (const finding of deduped) {
    const current = byId.get(finding.id);
    if (
      !current ||
      PRIORITY_ORDER[finding.priority] < PRIORITY_ORDER[current.priority] ||
      (PRIORITY_ORDER[finding.priority] === PRIORITY_ORDER[current.priority] &&
        finding.confidence > current.confidence)
    ) {
      byId.set(finding.id, finding);
    }
  }
  return [...byId.values()];
}

function collectOpenFindings(
  previousOpen: ReviewFinding[],
  findings: ReviewFinding[],
  resolutions: PreviousFindingResolution[],
): ReviewFinding[] {
  const result = new Map(findings.map((finding) => [finding.id, finding]));
  const resolutionById = new Map(
    resolutions.map((resolution) => [resolution.id, resolution]),
  );
  for (const finding of previousOpen) {
    if (
      resolutionById.get(finding.id)?.status === "still_open" &&
      !result.has(finding.id)
    ) {
      result.set(finding.id, finding);
    }
  }
  return [...result.values()].sort(
    (left, right) =>
      PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority] ||
      left.repo.localeCompare(right.repo) ||
      left.file.localeCompare(right.file) ||
      left.lineStart - right.lineStart,
  );
}

function summarizeReport(
  findings: ReviewFinding[],
  openFindings: ReviewFinding[],
): string {
  const currentBlocking = findings.filter(
    ({ priority }) => priority === "P0" || priority === "P1",
  ).length;
  if (currentBlocking > 0) {
    return `The review found ${currentBlocking} blocking problem${currentBlocking === 1 ? "" : "s"} in the current changes.`;
  }
  const currentIds = new Set(findings.map(({ id }) => id));
  const priorBlocking = openFindings.filter(
    ({ id, priority }) =>
      !currentIds.has(id) && (priority === "P0" || priority === "P1"),
  ).length;
  if (priorBlocking > 0) {
    return `No new blocking problems were found, but ${priorBlocking} previous blocking finding${priorBlocking === 1 ? "" : "s"} still await${priorBlocking === 1 ? "s" : ""} closure.`;
  }
  const advisory = findings.filter(({ priority }) => priority === "P2").length;
  return advisory > 0
    ? `No blocking problems were found; ${advisory} advisory finding${advisory === 1 ? "" : "s"} remain${advisory === 1 ? "s" : ""}.`
    : "No blocking problems were found in the current changes.";
}

export function buildReviewReport(
  scope: ReviewScope,
  submitted: SubmittedReview[],
  reviewerModel: string,
  previous?: ReviewReport,
): ReviewReport {
  const previousOpen = openFindingsFrom(previous);
  const previousById = new Map(
    previousOpen.map((finding) => [finding.id, finding]),
  );
  const previousKeys = new Map(
    previousOpen.map((finding) => [findingKey(finding), finding.id]),
  );
  const candidates = submitted.flatMap((review) => review.findings ?? []);
  const accepted = candidates
    .map((finding) =>
      validateFinding(scope, finding, previousById, previousKeys),
    )
    .filter((finding): finding is ReviewFinding => finding !== undefined);
  const findings = preservePreviousPriority(
    dedupeFindings(accepted),
    previousOpen,
  );
  const previousFindings = normalizePreviousResolutions(
    submitted,
    previousOpen,
    findings,
  );
  const openFindings = collectOpenFindings(
    previousOpen,
    findings,
    previousFindings,
  );
  const blocking = openFindings.some(
    ({ priority }) => priority === "P0" || priority === "P1",
  );

  return {
    verdict: blocking ? "needs_fix" : "pass",
    summary: summarizeReport(findings, openFindings),
    findings,
    openFindings,
    previousFindings,
    rejectedFindings: candidates.length - accepted.length,
    reviewerModel,
    reviewerCount: submitted.length,
  };
}

export interface SpecialistRoute {
  name: string;
  focus: string;
}

export function chooseSpecialist(
  scope: ReviewScope,
): SpecialistRoute | undefined {
  const files = scope.repos.flatMap(({ summary }) =>
    summary.files.map(({ path }) => path.toLowerCase()),
  );
  const diff = scope.repos
    .map(({ summary }) => summary.filteredDiff)
    .join("\n")
    .toLowerCase();
  const totalLines = scope.repos.reduce(
    (sum, { summary }) => sum + summary.totalAdded + summary.totalRemoved,
    0,
  );

  if (
    files.some((file) =>
      /(?:auth|oauth|permission|security|credential|token|crypto|password)/.test(
        file,
      ),
    ) ||
    /(?:authorize|authentication|permission|credential|secret|password|api[_ -]?key|access[_ -]?token)/.test(
      diff,
    )
  ) {
    return {
      name: "security",
      focus:
        "authentication, authorization, trust boundaries, secret handling, and input validation",
    };
  }
  if (
    files.some((file) =>
      /(?:migration|database|datastore|persistence)/.test(file),
    ) ||
    /(?:migration|transaction|rollback|data loss|foreign key)/.test(diff)
  ) {
    return {
      name: "data-integrity",
      focus:
        "schema compatibility, migrations, transactions, rollback behavior, and data integrity",
    };
  }
  if (
    files.some((file) =>
      /(?:queue|worker|concurrent|mutex|semaphore|lock)/.test(file),
    ) ||
    /(?:mutex|semaphore|race|deadlock|concurrent|atomic)/.test(diff)
  ) {
    return {
      name: "concurrency",
      focus:
        "races, ordering, cancellation, retries, locks, queues, and cache consistency",
    };
  }
  if (scope.repos.length > 1) {
    return {
      name: "contracts",
      focus:
        "cross-repository API, type, protocol, and compatibility contracts",
    };
  }
  if (files.length > 10 || totalLines > 800) {
    return {
      name: "coverage",
      focus:
        "large-diff coverage, cross-module behavior, integration boundaries, and missing regression tests",
    };
  }
  return undefined;
}

export const __test__ = {
  dedupeFindings,
  findingId,
  normalizeTitle,
  resolveFindingRepo,
  validateFinding,
};
