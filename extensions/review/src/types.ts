export type ReviewPriority = "P0" | "P1" | "P2";

export interface ChangedRange {
  start: number;
  end: number;
}

export interface FileDiff {
  path: string;
  linesAdded: number;
  linesRemoved: number;
  ext: string;
  hunks: string;
  changedRanges: ChangedRange[];
}

export interface ExcludedFileDiff {
  path: string;
  reason: string;
  linesAdded: number;
  linesRemoved: number;
}

export interface DiffSummary {
  files: FileDiff[];
  excluded: ExcludedFileDiff[];
  totalAdded: number;
  totalRemoved: number;
  /** Original Git output, retained for diagnostics only. */
  rawDiff: string;
  /** Reviewable chunks only. This is the only diff sent to reviewers. */
  filteredDiff: string;
}

export type ReviewScopeKind =
  "auto" | "working-tree" | "staged" | "branch" | "commit" | "file";

export interface RepoReviewSnapshot {
  repo: string;
  label: string;
  kind: ReviewScopeKind;
  mode: string;
  baseRef?: string;
  baseOid: string;
  headOid: string;
  summary: DiffSummary;
}

export interface CaptureScopeRequest {
  kind?: ReviewScopeKind;
  base?: string;
  commit?: string;
  file?: string;
  instructions?: string;
}

export interface ReviewScope {
  kind: ReviewScopeKind;
  repos: RepoReviewSnapshot[];
  scopeKey: string;
  diffHash: string;
  instructions?: string;
  capture: {
    cwd: string;
    request: CaptureScopeRequest;
  };
}

export interface ReviewFindingDraft {
  title: string;
  priority: ReviewPriority;
  confidence: number;
  repo: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  trigger: string;
  impact: string;
  evidence: string;
  introducedByPatch: boolean;
  previousFindingId?: string;
}

export interface ReviewFinding extends ReviewFindingDraft {
  id: string;
}

export type PreviousFindingStatus =
  "resolved" | "still_open" | "invalid" | "superseded";

export interface PreviousFindingResolution {
  id: string;
  status: PreviousFindingStatus;
  reason: string;
  /** Filled by the evidence gate from the prior report, not by the model. */
  priority?: ReviewPriority;
}

export interface SubmittedReview {
  summary: string;
  findings: ReviewFindingDraft[];
  previousFindings: PreviousFindingResolution[];
}

export type ReviewerRole = "lead" | "specialist";

export interface ReviewerDescriptor {
  role: ReviewerRole;
  model: string;
  thinkingLevel: string;
  fastMode?: boolean;
  specialty?: string;
}

export type ReviewProgressPhase =
  | "preparing"
  | "reviewing"
  | "adjudicating"
  | "validating"
  | "refreshing"
  | "cached"
  | "complete"
  | "failed"
  | "cancelled";

export type ReviewerProgressState =
  | "starting"
  | "reasoning"
  | "using_tool"
  | "submitting"
  | "retrying"
  | "done"
  | "failed"
  | "cancelled";

export interface ReviewerProgressEntry extends ReviewerDescriptor {
  state: ReviewerProgressState;
  activity: string;
  toolCalls: number;
}

export interface ReviewProgressSnapshot {
  phase: ReviewProgressPhase;
  startedAt: number;
  updatedAt: number;
  elapsedMs: number;
  reviewers: ReviewerProgressEntry[];
}

export type ReviewProgressEvent =
  | { type: "phase"; phase: ReviewProgressPhase }
  | { type: "reviewer_started"; reviewer: ReviewerDescriptor }
  | {
      type: "reviewer_run_started";
      role: ReviewerRole;
      activity: string;
    }
  | {
      type: "reviewer_activity";
      role: ReviewerRole;
      state: ReviewerProgressState;
      activity: string;
      toolStarted?: boolean;
    }
  | { type: "reviewer_finished"; role: ReviewerRole }
  | { type: "reviewer_failed"; role: ReviewerRole; cancelled: boolean };

export type ReviewProgressObserver = (event: ReviewProgressEvent) => void;

export interface ReviewReport {
  verdict: "pass" | "needs_fix";
  summary: string;
  findings: ReviewFinding[];
  /** Full findings that remain open, including unanchored carry-over items. */
  openFindings?: ReviewFinding[];
  previousFindings: PreviousFindingResolution[];
  rejectedFindings: number;
  reviewerModel: string;
  reviewerCount: number;
  reviewers?: ReviewerDescriptor[];
  cached?: boolean;
}

export interface ReviewRun {
  version: 1;
  createdAt: string;
  scopeKey: string;
  diffHash: string;
  reviewerModel: string;
  report: ReviewReport;
}

export interface ReviewSettings {
  model?: string;
  specialistModel?: string;
  thinkingLevel?: string;
  specialistThinkingLevel?: string;
  fastMode?: boolean;
  specialistFastMode?: boolean;
  maxReviewers: 1 | 2;
}
