import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml } from "yaml";
import {
  type AgentConfig,
  type ResolvedModel,
  type SubagentSettings,
  type ThinkingLevel,
  THINKING_LEVELS,
} from "./types.js";
// ─────────────────────────────────────────────────────────────────────────────
// Built-in agents
// ─────────────────────────────────────────────────────────────────────────────

export const BUILT_IN_AGENTS: AgentConfig[] = [
  {
    name: "scout",
    description:
      "Fast read-only codebase reconnaissance; returns concise findings with paths.",
    tools: ["read", "grep", "find", "ls", "bash"],
    systemPrompt: [
      "You are a scout subagent. Explore the codebase quickly and report grounded findings.",
      "Do not edit files. Prefer read, grep, find, ls, and safe read-only bash inspection.",
      "Return concise bullets with exact file paths, symbols, and open questions.",
    ].join("\n"),
    source: "built-in",
  },
  {
    name: "planner",
    description:
      "Turns reconnaissance into a lean implementation or migration plan.",
    tools: ["read", "grep", "find", "ls"],
    systemPrompt: [
      "You are a planner subagent. Produce executable, verifiable plans only.",
      "Do not modify files. Ground the plan in the repository's actual structure.",
      "Call out assumptions, risks, sequencing, and verification commands.",
    ].join("\n"),
    source: "built-in",
  },
  {
    name: "reviewer",
    description:
      "Adversarial code review; reports PASS/FAIL/PARTIAL with evidence, no edits.",
    tools: ["read", "grep", "find", "ls", "bash"],
    systemPrompt: [
      "You are a reviewer subagent. Review changes adversarially and assess claims against the code.",
      "Do not edit files or run builds, tests, or other long-running commands.",
      "Inspect code, diffs, test definitions, and existing verification evidence.",
      "Report PASS, FAIL, or PARTIAL with evidence and specific follow-ups.",
    ].join("\n"),
    source: "built-in",
  },
  {
    name: "worker",
    description:
      "General-purpose implementation worker with the default Pi tool set.",
    systemPrompt: [
      "You are a worker subagent. Implement the assigned task precisely.",
      "Validate your changes. Escalate unapproved decisions instead of guessing.",
      "Do not expand scope beyond the task and its provided context.",
    ].join("\n"),
    source: "built-in",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Settings & config directory
// ─────────────────────────────────────────────────────────────────────────────

export function getConfigDir(): string {
  return path.join(path.dirname(getAgentDir()), "piex-dev", "subagent");
}

export function getAgentsFilePath(): string {
  return path.join(getConfigDir(), "agents.yaml");
}

export function getSettingsFilePath(): string {
  return path.join(getConfigDir(), "settings.json");
}

let cachedSettings: SubagentSettings | null = null;

export function readSettings(): SubagentSettings {
  if (cachedSettings) return cachedSettings;
  const file = getSettingsFilePath();
  let raw: Partial<SubagentSettings> = {};
  try {
    raw = JSON.parse(
      fs.readFileSync(file, "utf-8"),
    ) as Partial<SubagentSettings>;
  } catch {
    // Missing or invalid settings file: use defaults.
  }
  cachedSettings = {
    defaultModel: raw.defaultModel ?? "inherit",
    defaultThinking: raw.defaultThinking ?? null,
    maxDepth:
      typeof raw.maxDepth === "number" && raw.maxDepth > 0 ? raw.maxDepth : 1,
    timeoutMs:
      typeof raw.timeoutMs === "number" && raw.timeoutMs > 0
        ? raw.timeoutMs
        : undefined,
  };
  return cachedSettings;
}

/** Clear the settings cache. Useful for tests / reload. */
export function clearSettingsCache(): void {
  cachedSettings = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent discovery
// ─────────────────────────────────────────────────────────────────────────────

interface RawAgentFile {
  name?: unknown;
  description?: unknown;
  systemPrompt?: unknown;
  tools?: unknown;
  model?: unknown;
  thinkingLevel?: unknown;
  timeoutMs?: unknown;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function parseUserAgent(raw: RawAgentFile, file: string): AgentConfig | null {
  if (typeof raw.name !== "string" || !raw.name.trim()) return null;
  if (typeof raw.systemPrompt !== "string" || !raw.systemPrompt.trim())
    return null;
  const agent: AgentConfig = {
    name: raw.name.trim(),
    description:
      typeof raw.description === "string" ? raw.description : raw.name.trim(),
    systemPrompt: raw.systemPrompt,
    source: "user",
  };
  if (isStringArray(raw.tools)) agent.tools = raw.tools;
  if (typeof raw.model === "string") agent.model = raw.model;
  if (
    typeof raw.thinkingLevel === "string" &&
    (THINKING_LEVELS as readonly string[]).includes(raw.thinkingLevel)
  ) {
    agent.thinkingLevel = raw.thinkingLevel as ThinkingLevel;
  }
  if (typeof raw.timeoutMs === "number" && raw.timeoutMs > 0)
    agent.timeoutMs = raw.timeoutMs;
  return agent;
}

export interface AgentLoadResult {
  agents: AgentConfig[];
  warning?: string;
}

export function loadAgents(): AgentLoadResult {
  const agents = new Map<string, AgentConfig>();
  for (const a of BUILT_IN_AGENTS) agents.set(a.name, a);

  const file = getAgentsFilePath();
  let content: string;
  try {
    content = fs.readFileSync(file, "utf-8");
  } catch {
    return { agents: [...agents.values()] };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      agents: [...agents.values()],
      warning: `Failed to parse ${file}: ${msg}. Using built-in agents only.`,
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      agents: [...agents.values()],
      warning: `${file}: expected a YAML list of agents. Using built-in agents only.`,
    };
  }

  const warnings: string[] = [];
  for (const [i, item] of parsed.entries()) {
    const agent = parseUserAgent(item as RawAgentFile, file);
    if (!agent) {
      warnings.push(
        `${file}: skipped invalid agent at index ${i} (needs name + systemPrompt).`,
      );
      continue;
    }
    agents.set(agent.name, agent);
  }

  return {
    agents: [...agents.values()],
    warning: warnings.length > 0 ? warnings.join("\n") : undefined,
  };
}

export function resolveAgent(name: string): AgentConfig {
  const { agents } = loadAgents();
  const found = agents.find((a) => a.name === name);
  if (!found) {
    throw new Error(
      `Unknown subagent: ${name}. Available: ${agents.map((a) => a.name).join(", ")}`,
    );
  }
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
// Model resolution (three-tier priority)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the model to pass to the child process.
 *
 * Priority (high → low):
 *   1. agent.model / agent.thinkingLevel
 *   2. settings.defaultModel / settings.defaultThinking
 *   3. inherit parent session model (caller-provided parentModel / parentThinking)
 *
 * "inherit" explicitly means: use the parent session's current model/thinking,
 * which the caller reads from ExtensionContext and passes here.
 */
export function resolveModel(
  agent: AgentConfig,
  settings: SubagentSettings,
  parentModel?: string,
  parentThinking?: ThinkingLevel,
): ResolvedModel {
  let model: string | undefined;
  let thinking: ThinkingLevel | undefined;

  // Tier 2: settings defaults
  if (settings.defaultModel && settings.defaultModel !== "inherit") {
    model = settings.defaultModel;
  }
  if (settings.defaultThinking) thinking = settings.defaultThinking;

  // Tier 1: agent config (overrides settings)
  if (agent.model) model = agent.model;
  if (agent.thinkingLevel) thinking = agent.thinkingLevel;

  // Tier 3: inherit parent
  if (!model || model === "inherit") model = parentModel;
  if (!thinking) thinking = parentThinking;

  return { model, thinkingLevel: thinking };
}
