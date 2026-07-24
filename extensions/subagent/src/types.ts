import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const ThinkingLevelSchema = StringEnum(THINKING_LEVELS, {
  description:
    "Pi thinking level: off, minimal, low, medium, high, xhigh, or max. Overrides the agent default.",
});

/**
 * Agent definition. Built-in agents ship as code constants; user agents are
 * loaded from ~/.pi/piex-dev/subagent/agents.yaml and override built-ins by name.
 */
export interface AgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  /** Tool allowlist for the child process. Undefined = default coding tools. */
  tools?: string[];
  /**
   * Model spec: "inherit" (use parent session model), a provider/id pattern,
   * or undefined (fall back to defaultModel then inherit).
   */
  model?: string;
  thinkingLevel?: ThinkingLevel;
  /** Hard subprocess timeout in ms. Falls back to settings.timeoutMs. */
  timeoutMs?: number;
  source: "built-in" | "user";
}

export interface SubagentSettings {
  /** Resolved when an agent sets no model. Default: "inherit". */
  defaultModel?: string;
  /** Resolved when an agent sets no thinking. Default: null (use parent). */
  defaultThinking?: ThinkingLevel | null;
  /** Max nesting depth. Default 1. */
  maxDepth?: number;
  /** Default subprocess timeout in ms. Default 600000. */
  timeoutMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool parameters
// ─────────────────────────────────────────────────────────────────────────────

const TaskItem = Type.Object({
  agent: Type.String({ description: "Agent name to invoke" }),
  task: Type.String({ description: "Task to delegate to this agent" }),
  context: Type.Optional(
    Type.String({
      description:
        "Optional context to pass to the agent (diff, plan, file summary).",
    }),
  ),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  timeoutMs: Type.Optional(
    Type.Number({ minimum: 1, description: "Per-task hard timeout in ms." }),
  ),
});

export const SubagentParams = Type.Object({
  agent: Type.Optional(
    Type.String({
      description: "Agent name (single mode). Required unless tasks[] is set.",
    }),
  ),
  task: Type.Optional(
    Type.String({ description: "Task to delegate (single mode)." }),
  ),
  context: Type.Optional(
    Type.String({
      description:
        "Optional context (diff, plan, file summary) passed to the agent in single mode.",
    }),
  ),
  tasks: Type.Optional(
    Type.Array(TaskItem, {
      description:
        "Parallel tasks. Each item has its own agent, so different roles can run concurrently. Max 8.",
    }),
  ),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  timeoutMs: Type.Optional(
    Type.Number({
      minimum: 1,
      description: "Hard subprocess timeout in ms (default 600000).",
    }),
  ),
});
export type SubagentParams = Static<typeof SubagentParams>;

// ─────────────────────────────────────────────────────────────────────────────
// Results
// ─────────────────────────────────────────────────────────────────────────────

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  totalTokens: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  task: string;
  exitCode: number;
  output: string;
  stderr: string;
  usage: UsageStats;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  error?: string;
  timedOut?: boolean;
  aborted?: boolean;
  truncated?: boolean;
  durationMs: number;
}

export interface SubagentDetails {
  mode: "single" | "parallel";
  results: SingleResult[];
  isError?: boolean;
}

export interface ResolvedModel {
  /** Concrete model spec to pass as --model, or undefined to let pi use its default. */
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
export const DEFAULT_MAX_STDERR_BYTES = 128 * 1024;
export const MAX_PENDING_LINE_BYTES = 16 * 1024 * 1024;
export const MAX_MESSAGES = 200;
export const KILL_GRACE_MS = 5000;
export const STATUS_KEY = "subagent";
