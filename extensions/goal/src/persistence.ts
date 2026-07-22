import {
  isNonNegativeFiniteNumber,
  nonNegativeFiniteNumber,
  normalizeTokenBudget,
} from "./accounting.js";
import type { GoalStatus } from "./prompts.js";

const GOAL_STATE_ENTRY_TYPE = "goal-state";

export interface ActiveGoal {
  id: string;
  text: string;
  status: GoalStatus;
  startedAt: number;
  updatedAt: number;
  iteration: number;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  baselineTokens: number;
  activeStartedAt?: number;
}

export interface GoalStateEntryData {
  goal: ActiveGoal | null;
}

export interface LoadedGoalState {
  goal: ActiveGoal | undefined;
  source: "none" | "canonical";
}

interface SessionEntry {
  type?: string;
  customType?: string;
  data?: unknown;
}

interface SessionContext {
  sessionManager?: {
    getBranch?: () => SessionEntry[];
    getEntries?: () => SessionEntry[];
  };
}

export function serializeGoalState(
  goal: ActiveGoal | undefined,
): GoalStateEntryData {
  return { goal: goal ?? null };
}

export function loadGoalStateFromSession(ctx: SessionContext): LoadedGoalState {
  const entries =
    ctx.sessionManager?.getBranch?.() ??
    ctx.sessionManager?.getEntries?.() ??
    [];
  const canonicalEntry = entries
    .filter(
      (entry) =>
        entry.type === "custom" && entry.customType === GOAL_STATE_ENTRY_TYPE,
    )
    .pop();
  if (canonicalEntry) return loadCanonicalGoalState(canonicalEntry.data);
  return emptyGoalState("none");
}

function loadCanonicalGoalState(data: unknown): LoadedGoalState {
  if (!isRecord(data)) return emptyGoalState("canonical");
  const rawGoal = data.goal;
  if (rawGoal !== null && !isGoal(rawGoal)) return emptyGoalState("canonical");
  let goal = rawGoal === null ? undefined : normalizeLoadedGoal(rawGoal);
  if (goal?.status === "complete") goal = undefined;
  return { goal, source: "canonical" };
}

export function normalizeLoadedGoal(goal: ActiveGoal): ActiveGoal {
  const now = Date.now();
  return {
    ...goal,
    startedAt: isNonNegativeFiniteNumber(goal.startedAt) ? goal.startedAt : now,
    updatedAt: isNonNegativeFiniteNumber(goal.updatedAt) ? goal.updatedAt : now,
    iteration: Math.max(0, Math.floor(nonNegativeFiniteNumber(goal.iteration))),
    tokenBudget: normalizeTokenBudget(goal.tokenBudget),
    tokensUsed: nonNegativeFiniteNumber(goal.tokensUsed),
    timeUsedSeconds: nonNegativeFiniteNumber(goal.timeUsedSeconds),
    baselineTokens: nonNegativeFiniteNumber(goal.baselineTokens),
    activeStartedAt: goal.status === "active" ? now : undefined,
  };
}

function isGoal(value: unknown): value is ActiveGoal {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    Boolean(value.id) &&
    value.id === value.id.trim() &&
    validObjective(value.text) &&
    [
      "active",
      "paused",
      "blocked",
      "usage_limited",
      "budget_limited",
      "complete",
    ].includes(String(value.status)) &&
    typeof value.startedAt === "number" &&
    typeof value.updatedAt === "number" &&
    typeof value.iteration === "number" &&
    typeof value.tokensUsed === "number" &&
    typeof value.timeUsedSeconds === "number" &&
    typeof value.baselineTokens === "number" &&
    (value.activeStartedAt === undefined ||
      typeof value.activeStartedAt === "number")
  );
}

function validObjective(value: unknown): value is string {
  return (
    typeof value === "string" && Boolean(value.trim()) && value.length <= 4_000
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyGoalState(source: LoadedGoalState["source"]): LoadedGoalState {
  return { goal: undefined, source };
}
