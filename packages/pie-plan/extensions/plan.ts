/**
 * pie-plan extension — Plan Mode: read-only exploration → plan → execute.

 *   pi install npm:@debugtalk/pie-plan
 *   pi -e ./extensions/plan.ts
 *
 * Based on pi's plan-mode example, enhanced with plan file writing and
 * compaction protection.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import * as path from "node:path";

// ══════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════

interface TodoItem {
  step: number;
  text: string;
  completed: boolean;
}

interface PlanModeState {
  enabled: boolean;
  todos?: TodoItem[];
  executing?: boolean;
  toolsBeforePlanMode?: string[];
}

// ══════════════════════════════════════════════════════════════════════════
// Tool lists
// ══════════════════════════════════════════════════════════════════════════

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "write"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
const PLAN_DISABLED = new Set(["edit"]);
const PLAN_MANAGED = new Set([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);

// ══════════════════════════════════════════════════════════════════════════
// Bash safety: blocked destructive commands
// ══════════════════════════════════════════════════════════════════════════

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\b/i, /\brmdir\b/i, /\bmv\b/i, /\bcp\b/i, /\bmkdir\b/i,
  /\btouch\b/i, /\bchmod\b/i, /\bchown\b/i, /\bchgrp\b/i, /\bln\b/i,
  /\btee\b/i, /\btruncate\b/i, /\bdd\b/i, /\bshred\b/i,
  /(^|[^<])>(?!>)/, />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bsudo\b/i, /\bsu\b/i, /\bkill\b/i, /\bpkill\b/i, /\bkillall\b/i,
  /\breboot\b/i, /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
];

function isSafeCommand(command: string): boolean {
  return !DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
}

// ══════════════════════════════════════════════════════════════════════════
// Todo parsing
// ══════════════════════════════════════════════════════════════════════════

function cleanStepText(text: string): string {
  let cleaned = text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i, "")
    .replace(/\s+/g, " ").trim();
  if (cleaned.length > 0) cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  if (cleaned.length > 50) cleaned = `${cleaned.slice(0, 47)}...`;
  return cleaned;
}

function extractTodoItems(message: string): TodoItem[] {
  const items: TodoItem[] = [];
  const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
  if (!headerMatch) return items;

  const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
  for (const match of planSection.matchAll(/^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm)) {
    const text = match[2].trim().replace(/\*{1,2}$/, "").trim();
    if (text.length > 5 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-")) {
      const cleaned = cleanStepText(text);
      if (cleaned.length > 3) items.push({ step: items.length + 1, text: cleaned, completed: false });
    }
  }
  return items;
}

function extractDoneSteps(message: string): number[] {
  const steps: number[] = [];
  for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.push(step);
  }
  return steps;
}

function markCompletedSteps(text: string, items: TodoItem[]): number {
  const done = extractDoneSteps(text);
  for (const step of done) {
    const item = items.find((t) => t.step === step);
    if (item) item.completed = true;
  }
  return done.length;
}

// ══════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(msg: AssistantMessage): string {
  return msg.content
    .filter((block): block is TextContent => block.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function unique(arr: string[]): string[] { return [...new Set(arr)]; }

function getPlanTools(active: string[]): string[] {
  return unique([...active.filter((n) => !PLAN_DISABLED.has(n)), ...PLAN_MODE_TOOLS]);
}

function getNormalTools(active: string[]): string[] {
  return unique([...NORMAL_MODE_TOOLS, ...active.filter((n) => !PLAN_MANAGED.has(n))]);
}

const PLAN_FILE = "PLAN.md";

// ══════════════════════════════════════════════════════════════════════════
// Extension
// ══════════════════════════════════════════════════════════════════════════

export default function planExtension(pi: ExtensionAPI) {
  let planModeEnabled = false;
  let executionMode = false;
  let todoItems: TodoItem[] = [];
  let toolsBeforePlanMode: string[] | undefined;
  let planFilePath = "";

  pi.registerFlag("plan", {
    description: "Start in plan mode (read-only exploration)",
    type: "boolean",
    default: false,
  });

  // ── Status display ─────────────────────────────────

  function updateStatus(ctx: ExtensionContext) {
    if (executionMode && todoItems.length > 0) {
      const completed = todoItems.filter((t) => t.completed).length;
      ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
    } else if (planModeEnabled) {
      ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
    } else {
      ctx.ui.setStatus("plan-mode", undefined);
    }

    if (executionMode && todoItems.length > 0) {
      const lines = todoItems.map((item) =>
        item.completed
          ? ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
          : ctx.ui.theme.fg("muted", "☐ ") + item.text,
      );
      ctx.ui.setWidget("plan-todos", lines);
    } else {
      ctx.ui.setWidget("plan-todos", undefined);
    }
  }

  function persistState() {
    planFilePath = planFilePath || path.join(process.cwd(), PLAN_FILE);
    pi.appendEntry("plan-mode", {
      enabled: planModeEnabled,
      todos: todoItems,
      executing: executionMode,
      toolsBeforePlanMode,
      planFilePath,
    });
  }

  // ── Toggle ────────────────────────────────────────

  function togglePlanMode(ctx: ExtensionContext) {
    planModeEnabled = !planModeEnabled;
    executionMode = false;
    todoItems = [];

    if (planModeEnabled) {
      toolsBeforePlanMode ??= pi.getActiveTools();
      pi.setActiveTools(getPlanTools(toolsBeforePlanMode));
      ctx.ui.notify("Plan mode enabled. Built-in write tools disabled.");
    } else {
      pi.setActiveTools(toolsBeforePlanMode ?? getNormalTools(pi.getActiveTools()));
      toolsBeforePlanMode = undefined;
      ctx.ui.notify("Plan mode disabled. Full access restored.");
    }
    updateStatus(ctx);
    persistState();
  }

  // ── Commands ──────────────────────────────────────

  pi.registerCommand("plan", {
    description: "Toggle plan mode (read-only exploration)",
    handler: async (_args, ctx) => togglePlanMode(ctx),
  });

  pi.registerCommand("todos", {
    description: "Show current plan todo list",
    handler: async (_args, ctx) => {
      if (todoItems.length === 0) {
        ctx.ui.notify("No todos. Create a plan first with /plan", "info");
        return;
      }
      const list = todoItems
        .map((t, i) => `${i + 1}. ${t.completed ? "✓" : "○"} ${t.text}`)
        .join("\n");
      ctx.ui.notify(`Plan Progress:\n${list}`, "info");
    },
  });

  pi.registerShortcut(Key.shift("p"), {
    description: "Toggle plan mode",
    handler: async (ctx) => togglePlanMode(ctx),
  });

  // ── Bash protection ───────────────────────────────

  pi.on("tool_call", async (event) => {
    if (!planModeEnabled || event.toolName !== "bash") return;
    const cmd = event.input.command as string;
    if (!isSafeCommand(cmd)) {
      return {
        block: true,
        reason: `Plan mode: command blocked. Use /plan to disable plan mode first.\n${cmd}`,
      };
    }
  });


  // ── Write protection (plan-only gate) ────────────

  pi.on("tool_call", async (event) => {
    if (!planModeEnabled || event.toolName !== "write") return;
    const filePath = (event.input as { path?: string }).path;
    if (!filePath) return;
    const basename = path.basename(filePath);
    if (basename !== PLAN_FILE) {
      return {
        block: true,
        reason: `Plan mode: only writing to ${PLAN_FILE} is allowed. Write your plan there.`,
      };
    }
  });
  // ── Context injection ─────────────────────────────

  pi.on("context", async (event) => {
    if (planModeEnabled) return;
    // Filter stale plan-mode messages when not in plan mode
    return {
      messages: event.messages.filter((m) => {
        const msg = m as AgentMessage & { customType?: string };
        if (msg.customType === "plan-mode-context") return false;
        if (msg.role !== "user") return true;
        if (typeof msg.content === "string") return !msg.content.includes("[PLAN MODE ACTIVE]");
        if (Array.isArray(msg.content)) {
          return !msg.content.some((c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"));
        }
        return true;
      }),
    };
  });

  pi.on("before_agent_start", async () => {
    if (planModeEnabled) {
      return {
        message: {
          customType: "plan-mode-context",
          content: `[PLAN MODE ACTIVE]
You are in plan mode — read-only exploration for safe code analysis.

Restrictions:
- Built-in edit and write tools are DISABLED
- Bash is restricted to read-only commands
- You CAN read, grep, find, ls, and use safe bash commands

Write your plan to ${PLAN_FILE} using the write tool (available in plan mode for plan files).
Create a detailed numbered plan under a "Plan:" heading:

Plan:
1. First step description
2. Second step description
...

Do NOT modify any other files. Just explore and plan.`,
          display: false,
        },
      };
    }

    if (executionMode && todoItems.length > 0) {
      const remaining = todoItems.filter((t) => !t.completed);
      const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
      return {
        message: {
          customType: "plan-execution-context",
          content: `[EXECUTING PLAN — Full tool access enabled]

Plan file: ${planFilePath}

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`,
          display: false,
        },
      };
    }
  });

  // ── Progress tracking ─────────────────────────────

  pi.on("turn_end", async (event, ctx) => {
    if (!executionMode || todoItems.length === 0) return;
    if (!isAssistantMessage(event.message)) return;

    const text = getTextContent(event.message);
    if (markCompletedSteps(text, todoItems) > 0) {
      updateStatus(ctx);
    }
    persistState();
  });

  // ── Plan completion & UI loop ─────────────────────

  pi.on("agent_end", async (event, ctx) => {
    // Check execution complete
    if (executionMode && todoItems.length > 0) {
      if (todoItems.every((t) => t.completed)) {
        const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
        pi.sendMessage(
          { customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
          { triggerTurn: false },
        );
        executionMode = false;
        todoItems = [];
        toolsBeforePlanMode = undefined;
        updateStatus(ctx);
        persistState();
      }
      return;
    }

    if (!planModeEnabled || !ctx.hasUI) return;

    // Extract todos from last assistant message
    const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
    if (lastAssistant) {
      const extracted = extractTodoItems(getTextContent(lastAssistant));
      if (extracted.length > 0) todoItems = extracted;
    }

    if (todoItems.length === 0) return;
    persistState();

    // Show plan and ask what next
    const todoListText = todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
    const planTodoListMsg = {
      customType: "plan-todo-list",
      content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
      display: true,
    };

    const choice = await ctx.ui.select("Plan mode — what next?", [
      "Execute the plan (track progress)",
      "Stay in plan mode",
      "Refine the plan",
    ]);

    if (choice?.startsWith("Execute")) {
      const first = todoItems[0];
      if (!first) return;

      planModeEnabled = false;
      executionMode = true;
      pi.setActiveTools(toolsBeforePlanMode ?? getNormalTools(pi.getActiveTools()));
      toolsBeforePlanMode = undefined;
      updateStatus(ctx);
      persistState();

      const remaining = todoItems.map((t) => `${t.step}. ${t.text}`).join("\n");
      pi.sendMessage(planTodoListMsg, { deliverAs: "followUp" });
      pi.sendMessage(
        {
          customType: "plan-mode-execute",
          content: `Execute the plan.\n\nPlan file: ${planFilePath}\n\nRemaining steps:\n${remaining}\n\nStart with: ${first.text}\nInclude [DONE:n] tags as you complete steps.`,
          display: true,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } else if (choice === "Refine the plan") {
      const refinement = await ctx.ui.editor("Refine the plan:", "");
      if (refinement?.trim()) {
        pi.sendMessage(planTodoListMsg, { deliverAs: "followUp" });
        pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
      }
    }
  });

  // ── Session start / resume ────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("plan") === true) {
      planModeEnabled = true;
    }

    const entries = ctx.sessionManager.getEntries();

    // Restore persisted state
    const planModeEntry = entries
      .filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
      .pop() as { data?: PlanModeState & { planFilePath?: string } } | undefined;

    if (planModeEntry?.data) {
      planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
      todoItems = planModeEntry.data.todos ?? todoItems;
      executionMode = planModeEntry.data.executing ?? executionMode;
      toolsBeforePlanMode = planModeEntry.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
      planFilePath = planModeEntry.data.planFilePath ?? planFilePath;
    }

    // On resume: rebuild completion state from messages after last execute
    if (planModeEntry && executionMode && todoItems.length > 0) {
      let executeIndex = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i] as { type: string; customType?: string };
        if (entry.customType === "plan-mode-execute") { executeIndex = i; break; }
      }

      const messages: AssistantMessage[] = [];
      for (let i = executeIndex + 1; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
          messages.push(entry.message as AssistantMessage);
        }
      }
      markCompletedSteps(messages.map(getTextContent).join("\n"), todoItems);
    }

    if (planModeEnabled) {
      pi.setActiveTools(getPlanTools(toolsBeforePlanMode ?? pi.getActiveTools()));
    }
    updateStatus(ctx);
  });
}
