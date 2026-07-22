import { currentTokenTotal } from "./accounting.js";
import { validateObjective } from "./command.js";
import type { ActiveGoal } from "./persistence.js";
import {
  buildGoalPrompt,
  buildObjectiveUpdatedPrompt,
  buildResumePrompt,
} from "./prompts.js";
import {
  abortCurrentTurn,
  blocksStaleGoalToolCalls,
  createGoal,
  editedGoalStatus,
  formatBudget,
  formatError,
  type GoalRuntime,
  goalSummary,
  hasPendingMessages,
  isResumableGoalStatus,
  nextGoalInstance,
  STATUS_KEY,
  type StatusContext,
  stoppedStatusLabel,
  transitionGoal,
} from "./runtime.js";

// User-command mutations are kept separate from Pi event wiring. Every controller
// receives exactly one per-factory GoalRuntime, preserving session isolation.
export class GoalCommandController {
  private readonly runtime: GoalRuntime;

  constructor(runtime: GoalRuntime) {
    this.runtime = runtime;
  }

  async startGoal(
    objective: string,
    tokenBudget: number | undefined,
    ctx: StatusContext,
    onActivated?: (goal: ActiveGoal) => void,
  ) {
    const validationError = validateObjective(objective);
    if (validationError) {
      ctx.ui.notify(validationError, "warning");
      return;
    }

    const existingGoal =
      this.runtime.activeGoal?.status !== "complete"
        ? this.runtime.activeGoal
        : undefined;
    if (existingGoal) {
      const shouldReplace = await ctx.ui.confirm(
        "Replace goal?",
        `Current goal: ${existingGoal.text}\n\nNew goal: ${objective}`,
      );
      if (!shouldReplace) {
        ctx.ui.notify(`Goal kept: ${existingGoal.text}`, "info");
        return;
      }
    }

    // Unlock lazy visibility only for a real activation. In always mode, a
    // missing tool means another policy or allowlist intentionally removed it.
    const goalToolVisibilityBeforeActivation =
      this.runtime.snapshotGoalToolVisibility();
    try {
      this.runtime.prepareGoalToolsForActivation(ctx);
    } catch (error) {
      ctx.ui.notify(`Cannot start /goal: ${formatError(error)}`, "error");
      if (existingGoal?.status === "active")
        this.runtime.pauseGoalForUnavailableTools(ctx);
      return;
    }

    this.runtime.cancelContinuationWork();
    this.runtime.clearGoalRecovery();
    this.runtime.clearBudgetWrapUp();
    this.runtime.clearStaleGoalToolCallBlock();
    this.runtime.activeGoal = createGoal(
      objective,
      tokenBudget,
      currentTokenTotal(ctx),
    );
    const startedGoal = this.runtime.activeGoal;
    onActivated?.(startedGoal);
    this.runtime.persistGoal(startedGoal);
    this.runtime.updateStatus(ctx, startedGoal);
    const sent = await this.runtime.sendOwnedGoalPrompt(
      ctx,
      startedGoal.id,
      buildGoalPrompt(startedGoal),
    );
    if (!sent) {
      let rolledBackStartedGoal = false;
      if (this.runtime.activeGoal?.id === startedGoal.id) {
        rolledBackStartedGoal = true;
        if (existingGoal) {
          this.runtime.recordGoalUsage(existingGoal, ctx);
          if (existingGoal.status === "active") {
            abortCurrentTurn(ctx);
            this.runtime.activeGoal = transitionGoal(existingGoal, "paused");
            this.runtime.blockStaleGoalToolCalls();
          } else {
            this.runtime.activeGoal = existingGoal;
            if (blocksStaleGoalToolCalls(this.runtime.activeGoal.status)) {
              this.runtime.blockStaleGoalToolCalls();
            } else {
              this.runtime.clearStaleGoalToolCallBlock();
            }
          }
          this.runtime.persistGoal(this.runtime.activeGoal);
          this.runtime.updateStatus(ctx, this.runtime.activeGoal);
        } else {
          this.runtime.clearActiveGoal(ctx);
        }
      }
      if (rolledBackStartedGoal) {
        this.runtime.restoreGoalToolVisibility(
          goalToolVisibilityBeforeActivation,
        );
      }
      return;
    }
    ctx.ui.notify(
      existingGoal
        ? `Goal replaced: ${objective}`
        : `Goal started: ${objective}`,
      "info",
    );
  }

  pauseGoal(ctx: StatusContext) {
    if (!this.runtime.activeGoal) {
      ctx.ui.notify("No active goal.", "info");
      return;
    }
    if (this.runtime.activeGoal.status !== "active") {
      ctx.ui.notify(
        `Goal is ${this.runtime.activeGoal.status}; only active goals can be paused.`,
        "warning",
      );
      return;
    }
    this.runtime.recordGoalUsage(this.runtime.activeGoal, ctx);
    this.runtime.cancelContinuationWork();
    this.runtime.clearBudgetWrapUp();
    this.runtime.blockStaleGoalToolCalls();
    abortCurrentTurn(ctx);
    this.runtime.activeGoal = transitionGoal(this.runtime.activeGoal, "paused");
    this.runtime.persistGoal(this.runtime.activeGoal);
    this.runtime.updateStatus(ctx, this.runtime.activeGoal);
    ctx.ui.notify(`Goal paused: ${this.runtime.activeGoal.text}`, "info");
  }

  async resumeGoal(ctx: StatusContext) {
    if (!this.runtime.activeGoal) {
      ctx.ui.notify("No active goal.", "info");
      return;
    }
    if (!isResumableGoalStatus(this.runtime.activeGoal.status)) {
      ctx.ui.notify(
        `Goal is ${this.runtime.activeGoal.status}; only paused, blocked, usage-limited, or budget-limited goals can be resumed.`,
        "warning",
      );
      return;
    }
    if (
      this.runtime.activeGoal.tokenBudget !== undefined &&
      this.runtime.activeGoal.tokensUsed >= this.runtime.activeGoal.tokenBudget
    ) {
      ctx.ui.notify(
        `Goal token budget is still reached: ${formatBudget(this.runtime.activeGoal)}`,
        "warning",
      );
      return;
    }
    const goalToolVisibilityBeforeActivation =
      this.runtime.snapshotGoalToolVisibility();
    try {
      this.runtime.prepareGoalToolsForActivation(ctx);
    } catch (error) {
      ctx.ui.notify(`Cannot resume /goal: ${formatError(error)}`, "error");
      return;
    }
    const stoppedGoal = this.runtime.activeGoal;
    const stoppedStatus = stoppedGoal.status;
    this.runtime.cancelContinuationWork();
    this.runtime.clearGoalRecovery();
    this.runtime.clearBudgetWrapUp();
    this.runtime.clearStaleGoalToolCallBlock();
    this.runtime.activeGoal = transitionGoal(
      nextGoalInstance(this.runtime.activeGoal),
      "active",
    );
    this.runtime.persistGoal(this.runtime.activeGoal);
    this.runtime.updateStatus(ctx, this.runtime.activeGoal);
    if (this.runtime.activeGoal.status !== "active") {
      ctx.ui.notify(
        `Goal token budget is still reached: ${formatBudget(this.runtime.activeGoal)}`,
        "warning",
      );
      return;
    }
    const resumedGoal = this.runtime.activeGoal;
    const sent = await this.runtime.sendOwnedGoalPrompt(
      ctx,
      resumedGoal.id,
      buildResumePrompt(resumedGoal, stoppedStatus),
    );
    if (!sent) {
      if (
        this.runtime.activeGoal?.id === resumedGoal.id &&
        this.runtime.activeGoal.status === "active"
      ) {
        this.runtime.activeGoal = stoppedGoal;
        this.runtime.persistGoal(this.runtime.activeGoal);
        this.runtime.updateStatus(ctx, this.runtime.activeGoal);
        if (blocksStaleGoalToolCalls(this.runtime.activeGoal.status)) {
          this.runtime.blockStaleGoalToolCalls();
        }
        this.runtime.restoreGoalToolVisibility(
          goalToolVisibilityBeforeActivation,
        );
      }
      return;
    }
    ctx.ui.notify(
      `Goal resumed from ${stoppedStatusLabel(stoppedStatus)}: ${resumedGoal.text}`,
      "info",
    );
  }

  clearGoal(ctx: StatusContext) {
    if (!this.runtime.activeGoal) {
      ctx.ui.notify("No active goal.", "info");
      this.runtime.cancelContinuationWork();
      this.runtime.clearGoalRecovery();
      this.runtime.clearBudgetWrapUp();
      this.runtime.clearStaleGoalToolCallBlock();
      this.runtime.clearPersistedGoal();
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    const stoppedGoal = this.runtime.activeGoal.text;
    this.runtime.clearActiveGoal(ctx);
    ctx.ui.notify(`Goal cleared: ${stoppedGoal}`, "warning");
  }

  async editGoal(
    objective: string,
    tokenBudget: number | undefined,
    ctx: StatusContext,
  ) {
    const validationError = validateObjective(objective);
    if (validationError) {
      ctx.ui.notify(validationError, "warning");
      return;
    }
    if (!this.runtime.activeGoal) {
      ctx.ui.notify(
        "No active goal. Use /goal <objective> to start one.",
        "warning",
      );
      return;
    }

    this.runtime.recordGoalUsage(this.runtime.activeGoal, ctx);
    const previousGoal = { ...this.runtime.activeGoal };
    this.runtime.cancelContinuationWork();
    this.runtime.clearGoalRecovery();
    this.runtime.clearBudgetWrapUp();
    const previousStatus = this.runtime.activeGoal.status;
    const nextGoal = transitionGoal(
      {
        ...nextGoalInstance(this.runtime.activeGoal),
        text: objective,
        tokenBudget: tokenBudget ?? this.runtime.activeGoal.tokenBudget,
      },
      editedGoalStatus(previousStatus),
    );
    const goalToolVisibilityBeforeActivation =
      nextGoal.status === "active"
        ? this.runtime.snapshotGoalToolVisibility()
        : undefined;
    if (nextGoal.status === "active") {
      try {
        this.runtime.prepareGoalToolsForActivation(ctx);
      } catch (error) {
        ctx.ui.notify(
          `Cannot reactivate /goal: ${formatError(error)}`,
          "error",
        );
        if (this.runtime.activeGoal?.status === "active") {
          this.runtime.pauseGoalForUnavailableTools(ctx);
        }
        return;
      }
    }
    this.runtime.activeGoal = nextGoal;
    this.runtime.persistGoal(this.runtime.activeGoal);
    this.runtime.updateStatus(ctx, this.runtime.activeGoal);
    const editedGoal = this.runtime.activeGoal;
    if (!editedGoal) return;
    if (editedGoal.status === "active") {
      this.runtime.clearStaleGoalToolCallBlock();
      const sent = await this.runtime.sendOwnedGoalPrompt(
        ctx,
        editedGoal.id,
        buildObjectiveUpdatedPrompt(editedGoal),
      );
      if (!sent) {
        if (this.runtime.activeGoal?.id === editedGoal.id) {
          if (previousStatus === "active") {
            abortCurrentTurn(ctx);
            this.runtime.activeGoal = transitionGoal(previousGoal, "paused");
            this.runtime.blockStaleGoalToolCalls();
          } else {
            this.runtime.activeGoal = previousGoal;
            if (blocksStaleGoalToolCalls(this.runtime.activeGoal.status)) {
              this.runtime.blockStaleGoalToolCalls();
            } else {
              this.runtime.clearStaleGoalToolCallBlock();
            }
          }
          this.runtime.persistGoal(this.runtime.activeGoal);
          this.runtime.updateStatus(ctx, this.runtime.activeGoal);
          if (goalToolVisibilityBeforeActivation) {
            this.runtime.restoreGoalToolVisibility(
              goalToolVisibilityBeforeActivation,
            );
          }
        }
        return;
      }
    } else if (blocksStaleGoalToolCalls(editedGoal.status)) {
      this.runtime.blockStaleGoalToolCalls();
    } else {
      this.runtime.clearStaleGoalToolCallBlock();
    }
    ctx.ui.notify(`Goal updated: ${objective}`, "info");
  }

  showGoal(ctx: StatusContext) {
    if (!this.runtime.activeGoal) {
      ctx.ui.notify(
        "Usage: /goal <objective>\nNo goal is currently set.",
        "info",
      );
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    this.runtime.recordGoalUsage(this.runtime.activeGoal, ctx);
    this.runtime.persistGoal(this.runtime.activeGoal);
    this.runtime.updateStatus(ctx, this.runtime.activeGoal);
    ctx.ui.notify(goalSummary(this.runtime.activeGoal), "info");
  }
}
