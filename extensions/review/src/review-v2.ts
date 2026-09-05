/**
 * review extension: one /review command backed by isolated, read-only reviewers.
 */

import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildReviewReport } from "./findings.js";
import {
  emitReviewProgress,
  renderProgressLines,
  renderProgressStatus,
  renderProgressText,
  ReviewProgressTracker,
} from "./progress.js";
import { renderReviewReport } from "./render.js";
import { ReviewCancelledError, runReviewerWorkflow } from "./reviewer.js";
import { ReviewerTranscriptStore } from "./transcript.js";
import { openReviewTranscript } from "./transcript-viewer.js";
import {
  canCompareToBase,
  captureReviewScope,
  normalizeRepoArg,
  parseRepoArgs,
  recaptureReviewScope,
  resolveRepo,
  resolveRepos,
  sanitizeLabel,
  shortRepo,
  takeFirstPathArg,
  type CaptureScopeRequest,
} from "./scope.js";
import {
  cachedReport,
  createReviewRun,
  findPreviousRun,
  REVIEW_RUN_ENTRY,
} from "./state.js";
import type {
  ReviewProgressEvent,
  ReviewProgressObserver,
  ReviewProgressSnapshot,
  ReviewReport,
  ReviewRun,
  ReviewScope,
  ReviewScopeKind,
} from "./types.js";

const REVIEW_MESSAGE_TYPE = "piex-review-result";
const STATUS_KEY_PREFIX = "piex-review";
const MAX_REVIEW_ATTEMPTS = 2;
const AUTO_SCOPE_CHOICE = "All current work vs default branch (PR-style)";
const WORKING_TREE_SCOPE_CHOICE = "Uncommitted changes (working tree vs HEAD)";
const STAGED_SCOPE_CHOICE = "Staged changes only";
const BRANCH_SCOPE_CHOICE = "Changes vs a base branch or commit…";
const COMMIT_SCOPE_CHOICE = "Specific commit…";
const FILE_SCOPE_CHOICE = "Specific file…";
const CUSTOM_SCOPE_CHOICE = "All current work with custom review focus…";
let progressRunSequence = 0;

type RuntimeContext = Pick<
  ExtensionContext,
  "model" | "modelRegistry" | "thinkingLevel" | "signal" | "sessionManager"
>;
type ProgressContext = Pick<ExtensionContext, "hasUI" | "mode" | "ui">;

interface ReviewProgressPresenter {
  report: ReviewProgressObserver;
  snapshot(): ReviewProgressSnapshot;
  dispose(): void;
}

interface ReviewExecutionGate {
  tryAcquire(): (() => void) | undefined;
}

interface DetachedReviewTask {
  abort(): void;
  finished: Promise<void>;
}

function createReviewExecutionGate(): ReviewExecutionGate {
  let activeToken: symbol | undefined;
  return {
    tryAcquire() {
      if (activeToken) return undefined;
      const token = Symbol("review-execution");
      activeToken = token;
      return () => {
        if (activeToken === token) activeToken = undefined;
      };
    },
  };
}

function startDetachedReview(
  run: (signal: AbortSignal) => Promise<void>,
  parentSignal?: AbortSignal,
): DetachedReviewTask {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener("abort", forwardAbort, { once: true });

  const finished = run(controller.signal).finally(() => {
    parentSignal?.removeEventListener("abort", forwardAbort);
  });
  return {
    abort: () => controller.abort(),
    finished,
  };
}

function createProgressPresenter(
  ctx: ProgressContext,
  onUpdate?: AgentToolUpdateCallback,
): ReviewProgressPresenter {
  const tracker = new ReviewProgressTracker();
  const key = `${STATUS_KEY_PREFIX}-${++progressRunSequence}`;
  let disposed = false;

  const publish = () => {
    if (disposed) return;
    const snapshot = tracker.snapshot();
    const running = !["cached", "complete", "failed", "cancelled"].includes(
      snapshot.phase,
    );
    if (ctx.hasUI) {
      try {
        if (ctx.mode === "tui") {
          ctx.ui.setWidget(
            key,
            [
              ...renderProgressLines(snapshot),
              "Open transcript: /review-log · Ctrl+Alt+R",
            ],
            { placement: "aboveEditor" },
          );
        } else {
          ctx.ui.setStatus(key, renderProgressStatus(snapshot));
        }
      } catch {
        // A UI adapter must not be able to stop the review.
      }
    }
    try {
      onUpdate?.({
        content: [{ type: "text", text: renderProgressText(snapshot) }],
        details: { running, progress: snapshot },
      });
    } catch {
      // Tool progress is advisory; the final result remains authoritative.
    }
  };

  const report = (event: ReviewProgressEvent) => {
    if (disposed) return;
    tracker.apply(event);
    publish();
  };
  publish();
  const heartbeat = setInterval(publish, 1000);

  return {
    report,
    snapshot: () => tracker.snapshot(),
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(heartbeat);
      if (!ctx.hasUI) return;
      try {
        if (ctx.mode === "tui") ctx.ui.setWidget(key, undefined);
        else ctx.ui.setStatus(key, undefined);
      } catch {
        // Best-effort cleanup for alternate UI adapters.
      }
    },
  };
}

interface ReviewExecution {
  scope: ReviewScope;
  report: ReviewReport;
  run?: ReviewRun;
}

interface StableScopeOptions {
  recapture?: (scope: ReviewScope) => ReviewScope;
  onRefresh?: (
    refreshed: ReviewScope,
    nextAttempt: number,
    maxAttempts: number,
  ) => void;
}

async function runWithStableReviewScope<T>(
  initialScope: ReviewScope,
  runAttempt: (scope: ReviewScope) => Promise<T>,
  options: StableScopeOptions = {},
): Promise<{ scope: ReviewScope; value: T }> {
  const recapture = options.recapture ?? recaptureReviewScope;
  let scope = initialScope;
  for (let attempt = 1; attempt <= MAX_REVIEW_ATTEMPTS; attempt++) {
    const value = await runAttempt(scope);
    const refreshed = recapture(scope);
    if (refreshed.diffHash === scope.diffHash) return { scope, value };
    if (attempt === MAX_REVIEW_ATTEMPTS) {
      throw new Error(
        "The reviewed changes kept changing during review. An automatic retry was already used; wait for edits to settle, then run /review again.",
      );
    }
    scope = refreshed;
    options.onRefresh?.(scope, attempt + 1, MAX_REVIEW_ATTEMPTS);
  }
  throw new Error("Review ended without a stable change snapshot");
}

async function selectInteractiveReviewScope(
  ctx: Pick<ExtensionContext, "cwd" | "ui">,
  repos: readonly string[],
): Promise<CaptureScopeRequest | undefined> {
  const repoList = repos
    .map((repo) => sanitizeLabel(shortRepo(repo, ctx.cwd)))
    .join(", ");
  const choices = [
    AUTO_SCOPE_CHOICE,
    WORKING_TREE_SCOPE_CHOICE,
    STAGED_SCOPE_CHOICE,
    BRANCH_SCOPE_CHOICE,
    ...(repos.length === 1 ? [COMMIT_SCOPE_CHOICE, FILE_SCOPE_CHOICE] : []),
    CUSTOM_SCOPE_CHOICE,
  ];
  const choice = await ctx.ui.select(
    `Review what? (${repos.length === 1 ? "repo" : "repos"}: ${repoList})`,
    choices,
  );
  switch (choice) {
    case AUTO_SCOPE_CHOICE:
      return { kind: "auto" };
    case WORKING_TREE_SCOPE_CHOICE:
      return { kind: "working-tree" };
    case STAGED_SCOPE_CHOICE:
      return { kind: "staged" };
    case BRANCH_SCOPE_CHOICE: {
      const base = await ctx.ui.input("Base branch or commit:");
      return base?.trim() ? { kind: "branch", base: base.trim() } : undefined;
    }
    case COMMIT_SCOPE_CHOICE: {
      const commit = await ctx.ui.input("Commit SHA or ref:");
      return commit?.trim()
        ? { kind: "commit", commit: commit.trim() }
        : undefined;
    }
    case FILE_SCOPE_CHOICE: {
      const file = await ctx.ui.input("File path (relative to repository):");
      return file?.trim() ? { kind: "file", file: file.trim() } : undefined;
    }
    case CUSTOM_SCOPE_CHOICE: {
      const instructions = await ctx.ui.input("Review focus or instructions:");
      return instructions?.trim()
        ? { kind: "auto", instructions: instructions.trim() }
        : undefined;
    }
    default:
      return undefined;
  }
}

function transcriptScopeSummary(scope: ReviewScope): {
  scopeLabel: string;
  scopeSummary: string;
} {
  const files = reviewableFileCount(scope);
  const added = scope.repos.reduce(
    (sum, { summary }) => sum + summary.totalAdded,
    0,
  );
  const removed = scope.repos.reduce(
    (sum, { summary }) => sum + summary.totalRemoved,
    0,
  );
  return {
    scopeLabel: scope.repos.map(({ label }) => label).join(", "),
    scopeSummary: `${files} file${files === 1 ? "" : "s"} · +${added}/-${removed} · ${scope.kind}`,
  };
}

function tryTranscript<T>(operation: () => T): T | undefined {
  try {
    return operation();
  } catch {
    // Transcript telemetry must never interrupt the review.
    return undefined;
  }
}

function reviewableFileCount(scope: ReviewScope): number {
  return scope.repos.reduce(
    (sum, { summary }) => sum + summary.files.length,
    0,
  );
}

function excludedFileCount(scope: ReviewScope): number {
  return scope.repos.reduce(
    (sum, { summary }) => sum + summary.excluded.length,
    0,
  );
}

async function executeReview(
  scope: ReviewScope,
  ctx: RuntimeContext,
  reportProgress?: ReviewProgressObserver,
  transcriptStore?: ReviewerTranscriptStore,
): Promise<ReviewExecution> {
  const runId = transcriptStore
    ? tryTranscript(() =>
        transcriptStore.startReview(transcriptScopeSummary(scope)),
      )
    : undefined;
  const transcript =
    transcriptStore && runId ? { store: transcriptStore, runId } : undefined;
  if (transcript) {
    tryTranscript(() =>
      transcript.store.recordRunItem(transcript.runId, {
        kind: "status",
        status: "preparing",
      }),
    );
  }

  try {
    const previous = findPreviousRun(ctx.sessionManager, scope.scopeKey);
    if (previous?.diffHash === scope.diffHash) {
      const report = cachedReport(previous);
      emitReviewProgress(reportProgress, { type: "phase", phase: "cached" });
      if (transcript) {
        tryTranscript(() => {
          transcript.store.recordRunItem(transcript.runId, {
            kind: "status",
            status: "cached",
            text: "Reused the previous result; no reviewer session was started.",
          });
          transcript.store.setReviewStatus(transcript.runId, "complete");
        });
      }
      const reviewers = report.reviewers ?? [
        {
          role: "lead" as const,
          model: report.reviewerModel,
          thinkingLevel: "unknown",
        },
      ];
      for (const reviewer of reviewers) {
        emitReviewProgress(reportProgress, {
          type: "reviewer_started",
          reviewer,
        });
        emitReviewProgress(reportProgress, {
          type: "reviewer_finished",
          role: reviewer.role,
        });
      }
      return { scope, report };
    }

    const stable = await runWithStableReviewScope(
      scope,
      async (attemptScope) => {
        const attemptPrevious = findPreviousRun(
          ctx.sessionManager,
          attemptScope.scopeKey,
        );
        const workflow = await runReviewerWorkflow(
          attemptScope,
          ctx,
          attemptPrevious?.report,
          attemptPrevious?.reviewerModel,
          reportProgress,
          transcript,
        );
        emitReviewProgress(reportProgress, {
          type: "phase",
          phase: "validating",
        });
        if (transcript) {
          tryTranscript(() =>
            transcript.store.recordRunItem(transcript.runId, {
              kind: "status",
              status: "validating",
            }),
          );
        }
        return { workflow, previous: attemptPrevious };
      },
      {
        onRefresh(refreshed, nextAttempt, maxAttempts) {
          emitReviewProgress(reportProgress, {
            type: "phase",
            phase: "refreshing",
          });
          if (transcript) {
            tryTranscript(() => {
              transcript.store.restartReview(
                transcript.runId,
                transcriptScopeSummary(refreshed),
              );
              transcript.store.recordRunItem(transcript.runId, {
                kind: "status",
                status: "refreshing",
                text: `Changes detected; restarting automatically with the latest diff (attempt ${nextAttempt}/${maxAttempts}).`,
              });
            });
          }
        },
      },
    );
    const reviewedScope = stable.scope;
    const { workflow, previous: stablePrevious } = stable.value;
    const report = buildReviewReport(
      reviewedScope,
      workflow.submissions,
      workflow.reviewerModel,
      stablePrevious?.report,
    );
    report.reviewerCount = workflow.reviewerCount;
    report.reviewers = workflow.reviewers;
    emitReviewProgress(reportProgress, { type: "phase", phase: "complete" });
    if (transcript) {
      tryTranscript(() => {
        transcript.store.recordRunItem(transcript.runId, {
          kind: "status",
          status: "complete",
        });
        transcript.store.setReviewStatus(transcript.runId, "complete");
      });
    }
    const run = createReviewRun(reviewedScope, report);
    return { scope: reviewedScope, report, run };
  } catch (error) {
    if (transcript) {
      const cancelled =
        error instanceof ReviewCancelledError || ctx.signal?.aborted === true;
      tryTranscript(() => {
        transcript.store.recordRunItem(transcript.runId, {
          kind: "status",
          status: cancelled ? "cancelled" : "failed",
          text: cancelled
            ? "Review cancelled."
            : `Review failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        transcript.store.setReviewStatus(
          transcript.runId,
          cancelled ? "cancelled" : "failed",
        );
      });
    }
    throw error;
  }
}

function resolveRequestedRepos(
  cwd: string,
  repo: unknown,
  repos: unknown,
): { ok: true; repos: string[] } | { ok: false; error: string } {
  if (Array.isArray(repos) && repos.length > 0) {
    // All-or-nothing: blank entries are rejected without falling back to the
    // cwd, so an invalid target never silently narrows the review.
    const values = repos.filter(
      (value): value is string => typeof value === "string",
    );
    const resolved = resolveRepos(cwd, values);
    return resolved.ok
      ? resolved
      : { ok: false, error: resolved.errors.join("\n") };
  }
  const resolved = resolveRepo(
    cwd,
    typeof repo === "string" ? repo : undefined,
  );
  return resolved.ok
    ? { ok: true, repos: [resolved.path] }
    : { ok: false, error: resolved.error };
}

function actionToScopeKind(action: string): ReviewScopeKind {
  switch (action) {
    case "":
    case "auto":
      return "auto";
    case "diff":
    case "working-tree":
      return "working-tree";
    case "staged":
    case "branch":
    case "commit":
    case "file":
      return action;
    default:
      throw new Error(
        `Unknown review action '${action}'. Use auto, diff, staged, branch, commit, or file.`,
      );
  }
}

function buildCaptureRequest(
  params: Record<string, unknown>,
): CaptureScopeRequest {
  const action =
    typeof params.action === "string" ? params.action.trim() : "auto";
  return {
    kind: actionToScopeKind(action),
    base: typeof params.base === "string" ? params.base.trim() : undefined,
    commit:
      typeof params.commit === "string" ? params.commit.trim() : undefined,
    file: typeof params.file === "string" ? params.file.trim() : undefined,
    instructions:
      typeof params.instructions === "string"
        ? params.instructions.trim() || undefined
        : undefined,
  };
}

function persistReview(
  pi: ExtensionAPI,
  execution: ReviewExecution,
): string | undefined {
  if (!execution.run) return undefined;
  try {
    pi.appendEntry(REVIEW_RUN_ENTRY, execution.run);
    return undefined;
  } catch (error) {
    // A completed review must never be discarded because re-review state
    // could not be stored; the report stays available to the user.
    return `The review report could not be stored for re-review: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function buildReviewToolDetails(
  request: CaptureScopeRequest,
  execution: ReviewExecution,
) {
  // Always describe the scope that was actually reviewed: executeReview may
  // have recaptured a refreshed patch, and automation must not cache or
  // attest a report against stale (pre-refresh) identifiers.
  return {
    found: true,
    action: request.kind,
    scopeKey: execution.scope.scopeKey,
    diffHash: execution.scope.diffHash,
    report: execution.report,
    reviewers: execution.report.reviewers,
  };
}

function displayReview(pi: ExtensionAPI, execution: ReviewExecution): void {
  pi.sendMessage({
    customType: REVIEW_MESSAGE_TYPE,
    content: renderReviewReport(execution.scope, execution.report),
    display: true,
    details: {
      scopeKey: execution.scope.scopeKey,
      diffHash: execution.scope.diffHash,
      report: execution.report,
    },
  });
}

async function runInteractiveReview(
  pi: ExtensionAPI,
  ctx: RuntimeContext & ProgressContext & Pick<ExtensionContext, "cwd">,
  transcriptStore: ReviewerTranscriptStore,
  repos: readonly string[],
  request: CaptureScopeRequest,
  releaseReview: () => void,
): Promise<void> {
  let progress: ReviewProgressPresenter | undefined;
  try {
    progress = createProgressPresenter(ctx);
    const scope = captureReviewScope(ctx.cwd, repos, request);
    if (reviewableFileCount(scope) === 0) {
      const excluded = excludedFileCount(scope);
      ctx.ui.notify(
        excluded > 0
          ? `No reviewable changes (${excluded} generated, vendor, or credential file${excluded === 1 ? "" : "s"} excluded).`
          : "No changes to review.",
        "info",
      );
      return;
    }

    const execution = await executeReview(
      scope,
      ctx,
      progress?.report,
      transcriptStore,
    );
    const persistWarning = persistReview(pi, execution);
    displayReview(pi, execution);
    if (persistWarning) {
      try {
        ctx.ui.notify(persistWarning, "warning");
      } catch {
        // Session shutdown may remove the UI before the review settles.
      }
    }
  } catch (error) {
    const cancelled =
      error instanceof ReviewCancelledError || ctx.signal?.aborted === true;
    progress?.report({
      type: "phase",
      phase: cancelled ? "cancelled" : "failed",
    });
    try {
      ctx.ui.notify(
        cancelled
          ? "Review cancelled."
          : `Review failed: ${error instanceof Error ? error.message : String(error)}`,
        cancelled ? "info" : "error",
      );
    } catch {
      // Session shutdown may remove the UI before cancellation settles.
    }
  } finally {
    progress?.dispose();
    releaseReview();
  }
}

export default function reviewExtension(pi: ExtensionAPI) {
  const transcriptStore = new ReviewerTranscriptStore();
  const reviewGate = createReviewExecutionGate();
  let backgroundReview: DetachedReviewTask | undefined;

  pi.on("session_shutdown", async () => {
    const task = backgroundReview;
    if (!task) return;
    task.abort();
    try {
      await task.finished;
    } catch {
      // The review reports its own failure; shutdown only guarantees cleanup.
    }
    if (backgroundReview === task) backgroundReview = undefined;
  });

  pi.registerCommand("review-log", {
    description: "Open the latest live reviewer transcript",
    handler: async (_args, ctx) => {
      await openReviewTranscript(ctx, transcriptStore);
    },
  });

  pi.registerShortcut("ctrl+alt+r", {
    description: "Open the latest live reviewer transcript",
    handler: async (ctx) => {
      await openReviewTranscript(ctx, transcriptStore);
    },
  });

  pi.registerCommand("review", {
    description:
      "Select a scope and review it with an isolated reviewer. Optional repository path(s): /review [repo ...]",
    handler: async (args, ctx) => {
      const releaseReview = reviewGate.tryAcquire();
      if (!releaseReview) {
        ctx.ui.notify(
          "A review is already running. Open it with /review-log or Ctrl+Alt+R.",
          "info",
        );
        return;
      }

      let repos: readonly string[];
      let request: CaptureScopeRequest | undefined;
      try {
        if (!ctx.hasUI) {
          ctx.ui.notify("/review requires interactive mode", "error");
          releaseReview();
          return;
        }
        const tokens = parseRepoArgs(args);
        const resolved =
          tokens.length > 0
            ? resolveRepos(ctx.cwd, tokens)
            : (() => {
                const one = resolveRepo(ctx.cwd);
                return one.ok
                  ? ({ ok: true, repos: [one.path] } as const)
                  : ({ ok: false, errors: [one.error] } as const);
              })();
        if (!resolved.ok) {
          ctx.ui.notify(
            `Cannot resolve review repositories:\n${resolved.errors.join("\n")}`,
            "error",
          );
          releaseReview();
          return;
        }
        repos = resolved.repos;
        request = await selectInteractiveReviewScope(ctx, repos);
      } catch (error) {
        releaseReview();
        ctx.ui.notify(
          `Cannot prepare review: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return;
      }
      if (!request) {
        releaseReview();
        return;
      }

      const run = (signal: AbortSignal | undefined) =>
        runInteractiveReview(
          pi,
          {
            cwd: ctx.cwd,
            hasUI: ctx.hasUI,
            mode: ctx.mode,
            model: ctx.model,
            modelRegistry: ctx.modelRegistry,
            sessionManager: ctx.sessionManager,
            signal,
            thinkingLevel: ctx.thinkingLevel,
            ui: ctx.ui,
          },
          transcriptStore,
          repos,
          request,
          releaseReview,
        );
      if (ctx.mode !== "tui") {
        await run(ctx.signal);
        return;
      }

      const task = startDetachedReview((signal) => run(signal), ctx.signal);
      backgroundReview = task;
      const clearTask = () => {
        if (backgroundReview === task) backgroundReview = undefined;
      };
      void task.finished.then(clearTask, clearTask);
    },
  });

  pi.registerTool({
    name: "review",
    label: "Review",
    executionMode: "sequential",
    description: `Run an independent, read-only code review and return a validated report.

The default action is 'auto': review all current work against the repository's default branch, including committed branch changes, staged changes, unstaged changes, and untracked files (credential-like untracked files such as .env, .npmrc, or private keys are excluded and never sent to reviewers). Use repo or repos to target other repositories. Advanced actions remain available for staged, branch, commit, and file-specific reviews.`,
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          description: "auto (default), diff, staged, branch, commit, or file",
        }),
      ),
      repo: Type.Optional(Type.String()),
      repos: Type.Optional(Type.Array(Type.String())),
      base: Type.Optional(Type.String()),
      commit: Type.Optional(Type.String()),
      file: Type.Optional(Type.String()),
      instructions: Type.Optional(
        Type.String({ description: "Optional review focus" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const releaseReview = reviewGate.tryAcquire();
      if (!releaseReview) {
        return {
          content: [
            {
              type: "text",
              text: "A review is already running. Open its live transcript with /review-log or Ctrl+Alt+R.",
            },
          ],
          details: { found: false, busy: true },
        };
      }
      const progress = createProgressPresenter(ctx, onUpdate);
      try {
        const resolved = resolveRequestedRepos(
          ctx.cwd,
          params.repo,
          params.repos,
        );
        if (!resolved.ok) throw new Error(resolved.error);
        const request = buildCaptureRequest(params as Record<string, unknown>);
        const scope = captureReviewScope(ctx.cwd, resolved.repos, request);
        if (reviewableFileCount(scope) === 0) {
          return {
            content: [{ type: "text", text: "No reviewable changes." }],
            details: {
              found: false,
              excluded: excludedFileCount(scope),
              action: request.kind,
            },
          };
        }
        const execution = await executeReview(
          scope,
          {
            model: ctx.model,
            modelRegistry: ctx.modelRegistry,
            thinkingLevel: ctx.thinkingLevel,
            signal: _signal ?? ctx.signal,
            sessionManager: ctx.sessionManager,
          },
          progress.report,
          transcriptStore,
        );
        const persistWarning = persistReview(pi, execution);
        return {
          content: [
            {
              type: "text",
              text:
                renderReviewReport(execution.scope, execution.report) +
                (persistWarning ? `\n\n${persistWarning}` : ""),
            },
          ],
          details: buildReviewToolDetails(request, execution),
        };
      } catch (error) {
        const cancelled =
          error instanceof ReviewCancelledError ||
          _signal?.aborted === true ||
          ctx.signal?.aborted === true;
        progress.report({
          type: "phase",
          phase: cancelled ? "cancelled" : "failed",
        });
        return {
          content: [
            {
              type: "text",
              text: cancelled
                ? "Review cancelled."
                : `Review failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          details: { error: true, cancelled },
          isError: true,
        };
      } finally {
        progress.dispose();
        releaseReview();
      }
    },
  });
}

export const __test__ = {
  actionToScopeKind,
  buildCaptureRequest,
  buildReviewToolDetails,
  canCompareToBase,
  createReviewExecutionGate,
  createProgressPresenter,
  excludedFileCount,
  executeReview,
  normalizeRepoArg,
  parseRepoArgs,
  persistReview,
  resolveRepo,
  resolveRepos,
  resolveRequestedRepos,
  reviewableFileCount,
  runWithStableReviewScope,
  selectInteractiveReviewScope,
  startDetachedReview,
  takeFirstPathArg,
  transcriptScopeSummary,
};
