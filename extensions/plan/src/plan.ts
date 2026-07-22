/**
 * plan extension — Plan Mode: read-only exploration → plan → execute.
 *
 *   pi install npm:@piex-dev/plan
 *   pi -e ./extensions/plan.ts
 *
 * Design notes:
 * - Plan-mode instructions are appended to the system prompt (no session
 *   artifacts to filter later).
 * - Bash safety uses a shell lexer: quotes/escapes/segments are parsed, and
 *   only allowlisted read-only commands with validated arguments run.
 * - The agent submits plans through the structured plan_complete tool and
 *   asks clarifying questions through plan_question; "Plan:"-heading text
 *   parsing remains as a fallback.
 * - Execution progress is tracked with todo widgets; the agent marks steps
 *   done via the structured plan_step_complete tool (with [DONE:n] text tags
 *   as a legacy fallback), and execution auto-exits after stalled turns.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import * as path from "node:path";
import { Type } from "typebox";

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
  todosWidgetVisible?: boolean;
}

// ══════════════════════════════════════════════════════════════════════════
// Tool lists
// ══════════════════════════════════════════════════════════════════════════

const PLAN_QUESTION_TOOL = "plan_question";
const PLAN_COMPLETE_TOOL = "plan_complete";
const PLAN_STEP_COMPLETE_TOOL = "plan_step_complete";
const PLAN_MODE_TOOLS = [
  "read",
  "bash",
  "grep",
  "find",
  "ls",
  PLAN_QUESTION_TOOL,
  PLAN_COMPLETE_TOOL,
];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
// Built-in tools disabled in plan mode (mutating file operations).
const PLAN_DISABLED = new Set(["edit", "write"]);
// Plan-mode-only structured tools; excluded from execution mode.
const PLAN_ONLY_TOOLS = new Set([PLAN_QUESTION_TOOL, PLAN_COMPLETE_TOOL]);
const PLAN_MANAGED = new Set([
  ...PLAN_MODE_TOOLS,
  ...NORMAL_MODE_TOOLS,
  PLAN_STEP_COMPLETE_TOOL,
]);

// ══════════════════════════════════════════════════════════════════════════
// Bash safety: shell-lexer allowlist
//
// Commands are split into pipeline/list segments with quote and escape
// handling; redirection, subshells, command substitution, variable
// assignment/expansion and globs are rejected outright. Each segment must
// start with an allowlisted read-only command and pass argument validation.
// ══════════════════════════════════════════════════════════════════════════

const MUTATING_COMMANDS = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "chgrp",
  "ln",
  "tee",
  "truncate",
  "dd",
  "shred",
  "sudo",
  "su",
  "kill",
  "pkill",
  "killall",
  "reboot",
  "shutdown",
  "vim",
  "vi",
  "nano",
  "emacs",
  "code",
  "subl",
]);

const READ_ONLY_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "grep",
  "find",
  "ls",
  "pwd",
  "echo",
  "printf",
  "wc",
  "sort",
  "uniq",
  "diff",
  "file",
  "stat",
  "du",
  "df",
  "tree",
  "which",
  "whereis",
  "type",
  "printenv",
  "uname",
  "whoami",
  "id",
  "date",
  "uptime",
  "ps",
  "jq",
  "rg",
  "fd",
  "bat",
  "eza",
]);

function isSafeCommand(command: string): boolean {
  const segments = splitShellSegments(command);
  return (
    segments !== undefined &&
    segments.length > 0 &&
    segments.every(isSafeSegment)
  );
}

function splitShellSegments(command: string): string[] | undefined {
  const trimmed = command.trim();
  if (!trimmed || /[\n\r`]/.test(trimmed)) return undefined;

  const segments: string[] = [];
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (
      character === ">" ||
      character === "<" ||
      character === "(" ||
      character === ")"
    ) {
      return undefined;
    }
    const next = trimmed[index + 1];
    if (character === "&" && next !== "&") return undefined;
    const separatorLength =
      character === ";" || character === "|"
        ? next === character
          ? 2
          : 1
        : character === "&" && next === "&"
          ? 2
          : 0;
    if (separatorLength === 0) continue;
    const segment = trimmed.slice(start, index).trim();
    if (!segment) return undefined;
    segments.push(segment);
    index += separatorLength - 1;
    start = index + 1;
  }
  if (quote || escaped) return undefined;
  const finalSegment = trimmed.slice(start).trim();
  if (!finalSegment) return undefined;
  segments.push(finalSegment);
  return segments;
}

function isSafeSegment(segment: string): boolean {
  if (
    hasShellExpansion(segment) ||
    /(^|\s)[A-Za-z_][A-Za-z0-9_]*=/.test(segment)
  ) {
    return false;
  }
  const tokens = shellWords(segment);
  if (!tokens || tokens.length === 0) return false;
  const command = tokens[0]?.toLowerCase();
  if (!command || MUTATING_COMMANDS.has(command)) return false;
  const args = tokens.slice(1);
  if (!hasSafeArguments(command, args)) return false;
  if (READ_ONLY_COMMANDS.has(command)) return true;
  return isSafeStructuredCommand(command, args);
}

function hasShellExpansion(segment: string): boolean {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of segment) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else if (character === "$" && quote === '"') return true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (["$", "*", "?", "[", "{"].includes(character)) return true;
  }
  return false;
}

function shellWords(segment: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of segment) {
    if (escaped) {
      word += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else word += character;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (/\s/.test(character)) {
      if (word) words.push(word);
      word = "";
    } else word += character;
  }
  if (quote || escaped) return undefined;
  if (word) words.push(word);
  return words;
}

function hasSafeArguments(command: string, args: string[]): boolean {
  const forbidden = new Set([
    "-i",
    "--in-place",
    "--fix",
    "--write",
    "-delete",
    "--delete",
  ]);
  if (args.some((argument) => forbidden.has(argument))) return false;
  if (
    command === "sed" &&
    args.some(
      (argument) =>
        argument.startsWith("--in-place=") ||
        (/^-[^-]+/.test(argument) && argument.slice(1).includes("i")),
    )
  ) {
    return false;
  }
  if (
    command === "find" &&
    args.some((argument) =>
      [
        "-exec",
        "-execdir",
        "-ok",
        "-okdir",
        "-fprint",
        "-fprint0",
        "-fprintf",
        "-fls",
      ].includes(argument),
    )
  ) {
    return false;
  }
  if (
    command === "date" &&
    args.some((argument) => argument === "-s" || argument.startsWith("--set"))
  ) {
    return false;
  }
  if (
    (command === "sort" || command === "tree") &&
    args.some(
      (argument) =>
        argument === "-o" ||
        (argument.startsWith("-o") && !argument.startsWith("--")) ||
        argument.startsWith("--output"),
    )
  ) {
    return false;
  }
  if (
    command === "sort" &&
    args.some(
      (argument) =>
        argument === "-T" ||
        (argument.startsWith("-T") && argument.length > 2) ||
        argument.startsWith("--temporary-directory") ||
        argument.startsWith("--compress-program"),
    )
  ) {
    return false;
  }
  if (
    command === "diff" &&
    args.some(
      (argument) => argument === "--output" || argument.startsWith("--output="),
    )
  ) {
    return false;
  }
  if (
    command === "uniq" &&
    args.filter((argument) => !argument.startsWith("-")).length > 1
  ) {
    return false;
  }
  if (
    command === "fd" &&
    args.some((argument) =>
      ["-x", "-X", "--exec", "--exec-batch"].some(
        (flag) => argument === flag || argument.startsWith(`${flag}=`),
      ),
    )
  ) {
    return false;
  }
  if (
    command === "rg" &&
    args.some(
      (argument) => argument === "--pre" || argument.startsWith("--pre="),
    )
  ) {
    return false;
  }
  if (
    command === "bat" &&
    args.some(
      (argument) => argument === "--pager" || argument.startsWith("--pager="),
    )
  ) {
    return false;
  }
  return true;
}

type ArgumentValidator = (args: string[]) => boolean;
const allowReadOnlyArguments: ArgumentValidator = () => true;

const GIT_VALIDATORS: Record<string, ArgumentValidator> = {
  status: allowReadOnlyArguments,
  log: isSafeGitLogArguments,
  diff: isSafeGitDiffArguments,
  show: requiresNoTextconv,
  branch: isSafeGitBranchArguments,
  remote: isSafeGitRemoteArguments,
  "ls-files": allowReadOnlyArguments,
  grep: isSafeGitGrepArguments,
  "rev-parse": allowReadOnlyArguments,
  blame: requiresNoTextconv,
  describe: allowReadOnlyArguments,
  "merge-base": allowReadOnlyArguments,
  "ls-tree": allowReadOnlyArguments,
  "cat-file": isSafeGitCatFileArguments,
};

function isSafeStructuredCommand(command: string, args: string[]): boolean {
  if (command === "git") return isSafeGitCommand(args);

  const subcommandIndex = args.findIndex(
    (argument) => !argument.startsWith("-"),
  );
  const subcommand = args[subcommandIndex]?.toLowerCase();
  if (command === "sed") {
    const script = args.find((argument) => !argument.startsWith("-"));
    return (
      Boolean(script) &&
      (args.includes("-n") ||
        args.some((argument) => /^-[^-]*n[^-]*$/.test(argument))) &&
      /^\d+(,\d+)?p$/.test(script ?? "")
    );
  }
  if (
    ["node", "python", "python3", "tsc", "biome", "ruff", "ty"].includes(
      command,
    )
  ) {
    if (args.includes("--version")) return true;
    return (
      command === "tsc" &&
      args.includes("--noEmit") &&
      !args.some(
        (argument) =>
          argument === "--incremental" ||
          argument.startsWith("--incremental=") ||
          argument === "--tsBuildInfoFile" ||
          argument.startsWith("--tsBuildInfoFile=") ||
          argument === "--generateTrace" ||
          argument.startsWith("--generateTrace="),
      )
    );
  }
  if (command === "npm") {
    if (
      subcommand === "audit" &&
      args.slice(subcommandIndex + 1).includes("fix")
    )
      return false;
    if (
      [
        "list",
        "ls",
        "view",
        "info",
        "search",
        "outdated",
        "audit",
        "test",
      ].includes(subcommand ?? "")
    ) {
      return true;
    }
    return (
      subcommand === "run" &&
      ["test", "check", "typecheck", "lint"].includes(
        args[subcommandIndex + 1] ?? "",
      )
    );
  }
  if (["cargo", "go", "pytest", "vitest", "jest"].includes(command)) {
    return (
      ["test", "check"].includes(subcommand ?? "") ||
      ["pytest", "vitest", "jest"].includes(command)
    );
  }
  return false;
}

function isSafeGitCommand(args: string[]): boolean {
  let subcommandIndex = 0;
  while (args[subcommandIndex] === "--no-pager") subcommandIndex += 1;
  const subcommand = args[subcommandIndex]?.toLowerCase();
  if (!subcommand || subcommand.startsWith("-")) return false;
  const subcommandArgs = args.slice(subcommandIndex + 1);
  const validator = GIT_VALIDATORS[subcommand];
  return (
    validator !== undefined &&
    hasSafeGitArguments(subcommand, subcommandArgs) &&
    validator(subcommandArgs)
  );
}

function hasSafeGitArguments(subcommand: string, args: string[]): boolean {
  return !args.some(
    (argument) =>
      argument === "--help" ||
      argument === "--show-signature" ||
      argument.startsWith("--show-signature=") ||
      argument.includes("%G") ||
      argument === "--output" ||
      argument.startsWith("--output=") ||
      argument === "--ext-diff" ||
      argument.startsWith("--ext-diff=") ||
      argument === "--textconv" ||
      argument.startsWith("--textconv=") ||
      argument === "--paginate" ||
      argument === "--open-files-in-pager" ||
      argument.startsWith("--open-files-in-pager=") ||
      (subcommand === "grep" &&
        (argument === "-O" || argument.startsWith("-O"))),
  );
}

function isSafeGitCatFileArguments(args: string[]): boolean {
  return !args.some(
    (argument) =>
      matchesLongOptionPrefix(argument, "--filters", "--fi") ||
      matchesLongOptionPrefix(argument, "--textconv", "--t"),
  );
}

function isSafeGitGrepArguments(args: string[]): boolean {
  return !args.some(
    (argument) =>
      matchesLongOptionPrefix(argument, "--textconv", "--textc") ||
      matchesLongOptionPrefix(argument, "--open-files-in-pager", "--op") ||
      matchesLongOptionPrefix(argument, "--ext-grep", "--ext"),
  );
}

function matchesLongOptionPrefix(
  argument: string,
  option: string,
  shortest: string,
): boolean {
  const optionName = argument.split("=", 1)[0] ?? "";
  return optionName.length >= shortest.length && option.startsWith(optionName);
}

function isSafeGitDiffArguments(args: string[]): boolean {
  return (
    args.includes("--check") ||
    (args.includes("--no-ext-diff") && args.includes("--no-textconv"))
  );
}

function isSafeGitLogArguments(args: string[]): boolean {
  if (args.includes("--no-textconv")) return true;
  return !args.some(requiresTextconvGuardForGitLog);
}

function requiresTextconvGuardForGitLog(argument: string): boolean {
  return (
    argument === "-p" ||
    argument.startsWith("-p") ||
    argument === "-u" ||
    argument.startsWith("-U") ||
    argument === "-c" ||
    argument === "--patch" ||
    argument.startsWith("--patch=") ||
    argument.startsWith("--patch-with-") ||
    argument === "--unified" ||
    argument.startsWith("--unified=") ||
    argument === "--binary" ||
    argument === "--cc" ||
    argument === "--remerge-diff" ||
    argument.startsWith("-S") ||
    argument.startsWith("-G") ||
    argument === "--find-object" ||
    argument.startsWith("--find-object=")
  );
}

function requiresNoTextconv(args: string[]): boolean {
  return args.includes("--no-textconv");
}

function isSafeGitBranchArguments(args: string[]): boolean {
  if (args.some((argument) => !argument.startsWith("-"))) return false;
  return !args.some(
    (argument) =>
      /^-[^-]*[dDmMcCu]/.test(argument) ||
      matchesLongOptionPrefix(argument, "--delete", "--del") ||
      matchesLongOptionPrefix(argument, "--move", "--mov") ||
      matchesLongOptionPrefix(argument, "--copy", "--cop") ||
      matchesLongOptionPrefix(argument, "--edit-description", "--e") ||
      matchesLongOptionPrefix(argument, "--unset-upstream", "--u") ||
      matchesLongOptionPrefix(argument, "--set-upstream-to", "--set-u") ||
      matchesLongOptionPrefix(argument, "--create-reflog", "--creat"),
  );
}

function isSafeGitRemoteArguments(args: string[]): boolean {
  const actionIndex = args.findIndex((argument) => !argument.startsWith("-"));
  if (actionIndex < 0) return true;
  const action = args[actionIndex];
  if (action === "get-url") return true;
  if (action !== "show") return false;

  const showArgs = args.slice(actionIndex + 1);
  if (showArgs.includes("--")) return false;
  const remotes = showArgs.filter((argument) => !argument.startsWith("-"));
  return (
    remotes.length === 0 || (remotes.length === 1 && showArgs.includes("-n"))
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Prompts
// ══════════════════════════════════════════════════════════════════════════

function buildPlanModePrompt(): string {
  return `[PLAN MODE ACTIVE]
# Plan Mode

You are in plan mode: read-only exploration for safe code analysis and implementation planning.

## Mode rules

- Built-in edit and write tools are DISABLED. Bash is restricted to validated read-only commands.
- You CAN read, grep, find, ls, and run safe bash commands.
- Do not perform mutating actions: no edits, no patches, no formatting that rewrites files, no dependency installation, no commits.
- Explore first and ask second: resolve discoverable facts from the repository before asking the user anything.

## Asking questions

- Use ${PLAN_QUESTION_TOOL} for important preferences, tradeoffs, or assumptions that cannot be discovered from read-only exploration. Ask 1-3 concise questions with 2-4 meaningful options each.
- If ${PLAN_QUESTION_TOOL} reports cancellation or unavailable UI, ask one concise plain-text question instead, or proceed with a clearly stated low-risk assumption.

## Completing the plan

- When the plan leaves no implementation decisions unresolved, call ${PLAN_COMPLETE_TOOL} alone as your final action. Do not call other tools in the same batch and do not emit a normal response after it.
- The submitted plan must be Markdown containing a "Plan:" section with numbered implementation steps:

Plan:
1. First step description
2. Second step description

- Keep the plan concise and free of open decisions. Record chosen defaults as explicit assumptions.
- If the user requests revisions, submit a complete replacement plan via ${PLAN_COMPLETE_TOOL}, not a delta.`;
}

function buildExecutionPrompt(
  planFilePath: string,
  remaining: TodoItem[],
): string {
  const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
  return `[EXECUTING PLAN — Full tool access enabled]

Plan file: ${planFilePath}

Remaining steps:
${todoList}

Execute each step in order.

PROGRESS TRACKING: After finishing each step, call the plan_step_complete tool with { steps: [n] } for every step you completed in this turn (e.g. { steps: [1, 2] }). This is the primary, reliable way to mark progress. Do NOT rely on writing [DONE:n] text tags. When every step is done the plan completes automatically; if you have finished all real work, mark every remaining step complete rather than narrating "done".`;
}

function cleanStepText(text: string): string {
  let cleaned = text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(
      /^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length > 0)
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  if (cleaned.length > 50) cleaned = `${cleaned.slice(0, 47)}...`;
  return cleaned;
}

function extractTodoItems(message: string): TodoItem[] {
  const items: TodoItem[] = [];
  const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
  if (!headerMatch) return items;

  const planSection = message.slice(
    message.indexOf(headerMatch[0]) + headerMatch[0].length,
  );
  for (const match of planSection.matchAll(
    /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm,
  )) {
    const text = match[2]
      .trim()
      .replace(/\*{1,2}$/, "")
      .trim();
    if (
      text.length > 5 &&
      !text.startsWith("`") &&
      !text.startsWith("/") &&
      !text.startsWith("-")
    ) {
      const cleaned = cleanStepText(text);
      if (cleaned.length > 3)
        items.push({ step: items.length + 1, text: cleaned, completed: false });
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
// plan_question helpers
// ══════════════════════════════════════════════════════════════════════════

interface PlanQuestionOption {
  label: string;
  description: string;
}

interface PlanQuestion {
  id: string;
  header: string;
  question: string;
  options: PlanQuestionOption[];
}

function normalizePlanQuestions(
  input: unknown,
): { ok: true; questions: PlanQuestion[] } | { ok: false; error: string } {
  if (
    typeof input !== "object" ||
    input === null ||
    !Array.isArray((input as { questions?: unknown }).questions)
  ) {
    return { ok: false, error: "questions must be an array" };
  }
  const raw = (input as { questions: unknown[] }).questions;
  if (raw.length < 1 || raw.length > 3) {
    return { ok: false, error: "questions must contain 1-3 items" };
  }

  const questions: PlanQuestion[] = [];
  for (const [index, value] of raw.entries()) {
    const q = value as Record<string, unknown>;
    const id = typeof q?.id === "string" ? q.id.trim() : "";
    const header = typeof q?.header === "string" ? q.header.trim() : "";
    const question = typeof q?.question === "string" ? q.question.trim() : "";
    if (!id || !header || !question) {
      return {
        ok: false,
        error: `question ${index + 1} requires non-empty id, header, and question`,
      };
    }
    if (
      !Array.isArray(q?.options) ||
      q.options.length < 2 ||
      q.options.length > 4
    ) {
      return {
        ok: false,
        error: `question ${index + 1} options must contain 2-4 items`,
      };
    }
    const options: PlanQuestionOption[] = [];
    for (const [optionIndex, rawOption] of q.options.entries()) {
      const o = rawOption as Record<string, unknown>;
      const label = typeof o?.label === "string" ? o.label.trim() : "";
      const description =
        typeof o?.description === "string" ? o.description.trim() : "";
      if (!label || !description) {
        return {
          ok: false,
          error: `question ${index + 1} option ${optionIndex + 1} requires a label and a description`,
        };
      }
      options.push({ label, description });
    }
    questions.push({ id, header, question, options });
  }
  return { ok: true, questions };
}

async function askPlanQuestions(
  questions: PlanQuestion[],
  ctx: ExtensionContext,
) {
  const answers: Array<{
    id: string;
    question: string;
    answer: string;
    wasCustom: boolean;
  }> = [];
  for (const question of questions) {
    const choices = question.options.map(
      (option, index) =>
        `${index + 1}. ${option.label} — ${option.description}`,
    );
    const otherChoice = `${question.options.length + 1}. Other (free-form)`;
    const choice = await ctx.ui.select(
      `${question.header}: ${question.question}`,
      [...choices, otherChoice],
    );
    if (!choice) return undefined;
    if (choice === otherChoice) {
      const customAnswer = (await ctx.ui.editor(question.question, ""))?.trim();
      if (!customAnswer) return undefined;
      answers.push({
        id: question.id,
        question: question.question,
        answer: customAnswer,
        wasCustom: true,
      });
      continue;
    }
    const option = question.options[choices.indexOf(choice)];
    if (!option) return undefined;
    answers.push({
      id: question.id,
      question: question.question,
      answer: option.label,
      wasCustom: false,
    });
  }
  return answers;
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

function unique(arr: string[]): string[] {
  return [...new Set(arr)];
}

function getPlanTools(active: string[]): string[] {
  return unique([
    ...active.filter((n) => !PLAN_DISABLED.has(n)),
    ...PLAN_MODE_TOOLS,
  ]);
}

function getNormalTools(active: string[]): string[] {
  return unique([
    ...NORMAL_MODE_TOOLS,
    ...active.filter((n) => !PLAN_MANAGED.has(n)),
  ]);
}

function getExecutionTools(active: string[]): string[] {
  return unique([
    ...active.filter((n) => !PLAN_ONLY_TOOLS.has(n)),
    ...NORMAL_MODE_TOOLS,
    PLAN_STEP_COMPLETE_TOOL,
  ]);
}

const PLAN_FILE = "PLAN.md";
const PLAN_MAX_CHARS = 50_000;

// Plan artifact customTypes that are always stripped from context. All of
// them are ephemeral: re-injected (or re-sent) whenever they still apply.
const PLAN_EPHEMERAL_TYPES = new Set([
  "plan-mode-context",
  "plan-execution-context",
  "plan-done-reminder",
  "plan-stalled",
]);

// ══════════════════════════════════════════════════════════════════════════
// Extension
// ══════════════════════════════════════════════════════════════════════════

export default function planExtension(pi: ExtensionAPI) {
  let planModeEnabled = false;
  let executionMode = false;
  let todoItems: TodoItem[] = [];
  let toolsBeforePlanMode: string[] | undefined;
  let planFilePath = "";
  let todosWidgetVisible = false;
  let pendingPlan: string | undefined;

  pi.registerFlag("plan", {
    description: "Start in plan mode (read-only exploration)",
    type: "boolean",
    default: false,
  });

  // ── Structured plan tools ──────────────────────────

  pi.registerTool({
    name: PLAN_QUESTION_TOOL,
    label: "Plan question",
    description:
      "Ask the user one to three plan-mode clarification questions with meaningful options, then wait for the answers. Only available while plan mode is active.",
    promptSnippet: "Ask user decision questions while plan mode is active",
    promptGuidelines: [
      "In plan mode, use plan_question for important preferences, tradeoffs, or assumptions that cannot be discovered from read-only exploration.",
    ],
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          id: Type.String({
            description: "Stable identifier for mapping answers (snake_case).",
          }),
          header: Type.String({
            description:
              "Short header label shown in the UI (12 or fewer chars).",
          }),
          question: Type.String({
            description: "Single-sentence prompt shown to the user.",
          }),
          options: Type.Array(
            Type.Object({
              label: Type.String({
                description: "User-facing label (1-5 words).",
              }),
              description: Type.String({
                description:
                  "One short sentence explaining impact/tradeoff if selected.",
              }),
            }),
            { minItems: 2, maxItems: 4 },
          ),
        }),
        { minItems: 1, maxItems: 3 },
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!planModeEnabled) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                cancelled: true,
                reason: "plan_mode_inactive",
                message:
                  "Error: plan_question is only available while plan mode is active.",
              }),
            },
          ],
          details: { cancelled: true, reason: "plan_mode_inactive" },
        };
      }

      const parsed = normalizePlanQuestions(params);
      if (!parsed.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                cancelled: true,
                reason: "invalid_input",
                message: `Error: ${parsed.error}`,
              }),
            },
          ],
          details: { cancelled: true, reason: "invalid_input" },
        };
      }

      if (!ctx.hasUI) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                cancelled: true,
                reason: "ui_unavailable",
                message:
                  "Unable to ask plan questions because interactive UI is not available. Ask one concise plain-text question instead.",
              }),
            },
          ],
          details: { cancelled: true, reason: "ui_unavailable" },
        };
      }

      const answers = await askPlanQuestions(parsed.questions, ctx);
      if (!answers) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                cancelled: true,
                reason: "cancelled",
                message: "User cancelled the plan question prompt.",
              }),
            },
          ],
          details: { cancelled: true, reason: "cancelled" },
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ cancelled: false, answers }, null, 2),
          },
        ],
        details: { cancelled: false, questions: parsed.questions, answers },
      };
    },
  });

  pi.registerTool({
    name: PLAN_COMPLETE_TOOL,
    label: "Complete plan",
    description:
      "Submit the complete decision-ready implementation plan for user review. Only available while plan mode is active, and must be the final standalone action.",
    promptSnippet: "Submit the final plan-mode implementation plan",
    promptGuidelines: [
      "Call plan_complete alone as the final action only after the implementation plan is decision-complete.",
    ],
    parameters: Type.Object({
      plan: Type.String({
        description:
          'The complete decision-ready implementation plan in Markdown, containing a "Plan:" section with numbered implementation steps.',
        minLength: 1,
        maxLength: PLAN_MAX_CHARS,
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!planModeEnabled) {
        throw new Error(
          "plan_complete is only available while plan mode is active",
        );
      }
      const plan = typeof params?.plan === "string" ? params.plan.trim() : "";
      if (!plan) throw new Error("plan must not be empty");
      if (plan.length > PLAN_MAX_CHARS) {
        throw new Error(`plan must not exceed ${PLAN_MAX_CHARS} characters`);
      }

      pendingPlan = plan;
      return {
        content: [
          { type: "text" as const, text: `**Proposed Plan**\n\n${plan}` },
        ],
        details: { source: PLAN_COMPLETE_TOOL, plan },
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: PLAN_STEP_COMPLETE_TOOL,
    label: "Complete plan step",
    description:
      "Mark one or more plan steps as completed during execution. Call this right after finishing each step; pass every step number completed in the current turn. Do not narrate 'done' instead of calling this tool — only this tool advances progress.",
    promptSnippet:
      "Mark plan steps completed after finishing them during execution",
    promptGuidelines: [
      "During plan execution, after finishing a step call plan_step_complete with the step number(s) you completed this turn.",
      "Do not rely on [DONE:n] text tags; use this tool instead.",
      "When all steps are done, mark every remaining step complete — the plan completes automatically.",
    ],
    parameters: Type.Object({
      steps: Type.Array(Type.Integer({ minimum: 1 }), {
        minItems: 1,
        description: "Step numbers completed in this turn, e.g. [1] or [1, 2].",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!executionMode) {
        return {
          content: [
            {
              type: "text" as const,
              text: "plan_step_complete is only available while a plan is executing.",
            },
          ],
          details: { accepted: false, reason: "not_executing" },
        };
      }
      const requested = Array.isArray(params?.steps)
        ? [...new Set(params.steps)].filter(
            (n) => Number.isInteger(n) && n >= 1,
          )
        : [];
      const accepted: number[] = [];
      for (const step of requested) {
        const item = todoItems.find((t) => t.step === step);
        if (item && !item.completed) {
          item.completed = true;
          accepted.push(step);
        }
      }
      if (accepted.length > 0) {
        progressMarkedThisTurn = true;
        updateStatus(ctx);
        persistState();
      }
      const total = todoItems.length;
      const done = todoItems.filter((t) => t.completed).length;
      const remainingSteps = todoItems
        .filter((t) => !t.completed)
        .map((t) => t.step);
      const allDone = done === total && total > 0;
      return {
        content: [
          {
            type: "text" as const,
            text: allDone
              ? `Steps ${accepted.join(", ")} marked complete. All ${total} steps done — plan completing.`
              : accepted.length > 0
                ? `Steps ${accepted.join(", ")} marked complete (${done}/${total}). Remaining: ${remainingSteps.join(", ") || "none"}.`
                : `No new steps marked (${done}/${total}). Remaining: ${remainingSteps.join(", ") || "none"}.`,
          },
        ],
        details: { accepted, done, total, allDone },
      };
    },
  });

  // ── Status display ─────────────────────────────────

  function buildTodoWidgetLines(): ((ctx: ExtensionContext) => string)[] {
    return todoItems.map((item) =>
      item.completed
        ? (ctx) =>
            ctx.ui.theme.fg("success", "☑ ") +
            ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
        : (ctx) => ctx.ui.theme.fg("muted", "☐ ") + item.text,
    );
  }

  function renderTodoWidget(ctx: ExtensionContext) {
    if (!todosWidgetVisible || todoItems.length === 0) {
      ctx.ui.setWidget("plan-todos", undefined);
      return;
    }
    const lines = buildTodoWidgetLines().map((fn) => fn(ctx));
    ctx.ui.setWidget("plan-todos", lines);
  }

  function updateStatus(ctx: ExtensionContext) {
    if (executionMode && todoItems.length > 0) {
      const completed = todoItems.filter((t) => t.completed).length;
      ctx.ui.setStatus(
        "plan-mode",
        ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`),
      );
    } else if (planModeEnabled) {
      ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
    } else {
      ctx.ui.setStatus("plan-mode", undefined);
    }
    renderTodoWidget(ctx);
  }

  function persistState() {
    planFilePath = planFilePath || path.join(process.cwd(), PLAN_FILE);
    pi.appendEntry("plan-mode", {
      enabled: planModeEnabled,
      todos: todoItems,
      executing: executionMode,
      toolsBeforePlanMode,
      planFilePath,
      todosWidgetVisible,
    });
  }

  // ── Toggle ────────────────────────────────────────

  function togglePlanMode(ctx: ExtensionContext) {
    planModeEnabled = !planModeEnabled;
    executionMode = false;
    todoItems = [];
    todosWidgetVisible = false;
    pendingPlan = undefined;

    if (planModeEnabled) {
      toolsBeforePlanMode ??= pi.getActiveTools();
      pi.setActiveTools(getPlanTools(toolsBeforePlanMode));
      ctx.ui.notify(
        "Plan mode enabled. Built-in write tools disabled; bash restricted to read-only commands.",
      );
    } else {
      pi.setActiveTools(
        toolsBeforePlanMode ?? getNormalTools(pi.getActiveTools()),
      );
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
    description: "Toggle plan todo list visibility",
    handler: async (_args, ctx) => {
      if (todoItems.length === 0) {
        ctx.ui.notify("No todos. Create a plan first with /plan", "info");
        return;
      }
      todosWidgetVisible = !todosWidgetVisible;
      renderTodoWidget(ctx);
      ctx.ui.notify(
        todosWidgetVisible ? "Todos visible" : "Todos hidden",
        "info",
      );
    },
  });

  // ── Bash protection ───────────────────────────────

  pi.on("tool_call", async (event) => {
    if (!planModeEnabled || event.toolName !== "bash") return;
    const input = event.input as { command?: unknown } | undefined;
    const cmd = typeof input?.command === "string" ? input.command : "";
    if (!isSafeCommand(cmd)) {
      return {
        block: true,
        reason: `Plan mode: command blocked (not an allowlisted read-only command). Use /plan to disable plan mode first.\n${cmd}`,
      };
    }
  });

  // ── Context hygiene ───────────────────────────────
  //
  // Plan-mode instructions now ride the system prompt, so nothing new is
  // added to the session. This filter strips ephemeral artifacts from
  // current and legacy sessions: injected context messages (re-injected
  // every turn while active), DONE-tag reminders, and — once execution
  // ends — the execute instruction with its [DONE:n] nagging.

  pi.on("context", async (event) => {
    return {
      messages: event.messages.filter((m) => {
        const msg = m as AgentMessage & { customType?: string };
        if (msg.customType && PLAN_EPHEMERAL_TYPES.has(msg.customType)) {
          return false;
        }
        if (!executionMode && msg.customType === "plan-mode-execute") {
          return false;
        }
        if (msg.role !== "user") return true;
        if (typeof msg.content === "string") {
          return !msg.content.includes("[PLAN MODE ACTIVE]");
        }
        if (Array.isArray(msg.content)) {
          return !msg.content.some(
            (c) =>
              c.type === "text" &&
              (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
          );
        }
        return true;
      }),
    };
  });

  // ── System prompt injection ───────────────────────

  pi.on("before_agent_start", async (event) => {
    if (planModeEnabled) {
      return {
        systemPrompt: `${event.systemPrompt}\n\n${buildPlanModePrompt()}`,
      };
    }

    if (executionMode && todoItems.length > 0) {
      const remaining = todoItems.filter((t) => !t.completed);
      return {
        systemPrompt: `${event.systemPrompt}\n\n${buildExecutionPrompt(planFilePath, remaining)}`,
      };
    }
  });

  // ── Progress tracking ─────────────────────────────

  // Track consecutive turns without DONE tags to inject reminders
  let turnsWithoutProgress = 0;
  // Set by plan_step_complete when it marks steps this turn; prevents turn_end
  // from counting a tool-driven turn as "no progress" and falsely stalling.
  let progressMarkedThisTurn = false;

  pi.on("turn_end", async (event, ctx) => {
    if (!executionMode || todoItems.length === 0) {
      progressMarkedThisTurn = false;
      return;
    }
    if (!isAssistantMessage(event.message)) {
      progressMarkedThisTurn = false;
      return;
    }

    const text = getTextContent(event.message);
    const completed = markCompletedSteps(text, todoItems);
    // Progress counts if the agent emitted [DONE:n] text tags OR called
    // plan_step_complete this turn (the tool sets progressMarkedThisTurn).
    const progressed = completed > 0 || progressMarkedThisTurn;
    progressMarkedThisTurn = false;
    if (progressed) {
      if (completed > 0) updateStatus(ctx);
      turnsWithoutProgress = 0;
    } else {
      turnsWithoutProgress++;
      // Stall guard: the agent neither marked progress nor called tools this
      // turn. It has likely finished real work but failed to mark progress —
      // the classic loop ("done, standby" repeated while the execution prompt
      // keeps nagging). Rather than keep nagging forever, auto-exit execution
      // so control returns to the user.
      const madeToolCalls = event.message.content.some(
        (block) => block.type === "toolCall",
      );
      const remaining = todoItems.filter((t) => !t.completed);
      if (!madeToolCalls && turnsWithoutProgress >= 2) {
        pi.sendMessage(
          {
            customType: "plan-stalled",
            content: `Plan execution appears stalled: no progress markers and no tool calls for ${turnsWithoutProgress} turn(s). Remaining steps: ${remaining.map((t) => t.step).join(", ") || "none"}. Exiting execution mode; review the plan with /plan or mark steps complete manually.`,
            display: true,
          },
          { triggerTurn: false },
        );
        executionMode = false;
        todosWidgetVisible = false;
        turnsWithoutProgress = 0;
        pi.setActiveTools(
          toolsBeforePlanMode ?? getNormalTools(pi.getActiveTools()),
        );
        toolsBeforePlanMode = undefined;
        updateStatus(ctx);
        persistState();
        return;
      }
      if (turnsWithoutProgress >= 2) {
        pi.sendMessage(
          {
            customType: "plan-done-reminder",
            content: `⚠️ No progress markers for ${turnsWithoutProgress} turn(s). Mark completed steps by calling plan_step_complete({ steps: [n] }) (or end your response with [DONE:n]). Remaining: ${remaining.map((t) => t.step).join(", ") || "none"}.`,
            display: false,
          },
          { triggerTurn: false },
        );
      }
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
          {
            customType: "plan-complete",
            content: `**Plan Complete!** ✓\n\n${completedList}`,
            display: true,
          },
          { triggerTurn: false },
        );
        executionMode = false;
        todoItems = [];
        todosWidgetVisible = false;
        pi.setActiveTools(
          toolsBeforePlanMode ?? getNormalTools(pi.getActiveTools()),
        );
        toolsBeforePlanMode = undefined;
        updateStatus(ctx);
        persistState();
      }
      return;
    }

    if (!planModeEnabled || !ctx.hasUI) {
      // No interactive UI to present the plan; drop any pending submission
      // so it isn't surfaced by a later, unrelated turn.
      pendingPlan = undefined;
      return;
    }

    // Extract todos: prefer the structured plan_complete submission, fall
    // back to parsing the last assistant message (legacy "Plan:" heading).
    if (pendingPlan) {
      const extracted = extractTodoItems(pendingPlan);
      if (extracted.length > 0) todoItems = extracted;
      pendingPlan = undefined;
    } else {
      const lastAssistant = [...event.messages]
        .reverse()
        .find(isAssistantMessage);
      if (lastAssistant) {
        const extracted = extractTodoItems(getTextContent(lastAssistant));
        if (extracted.length > 0) todoItems = extracted;
      }
    }

    if (todoItems.length === 0) return;
    persistState();

    // Show plan and ask what next
    const todoListText = todoItems
      .map((t, i) => `${i + 1}. ☐ ${t.text}`)
      .join("\n");
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
      turnsWithoutProgress = 0;
      todosWidgetVisible = true;
      pi.setActiveTools(
        getExecutionTools(toolsBeforePlanMode ?? pi.getActiveTools()),
      );
      toolsBeforePlanMode = undefined;
      updateStatus(ctx);
      persistState();

      const remaining = todoItems.map((t) => `${t.step}. ${t.text}`).join("\n");
      pi.sendMessage(planTodoListMsg, { deliverAs: "followUp" });
      pi.sendMessage(
        {
          customType: "plan-mode-execute",
          content: `Execute the plan.\n\nPlan file: ${planFilePath}\n\nRemaining steps:\n${remaining}\n\nStart with: ${first.text}\n\n[CRITICAL] After finishing each step, call the plan_step_complete tool with { steps: [n] } for every step you completed this turn (e.g. { steps: [1, 2] }). Do NOT rely on [DONE:n] text tags; use the tool instead. When all steps are done, mark every remaining step complete and the plan completes automatically.`,
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
      .filter(
        (e: { type: string; customType?: string }) =>
          e.type === "custom" && e.customType === "plan-mode",
      )
      .pop() as
      { data?: PlanModeState & { planFilePath?: string } } | undefined;

    if (planModeEntry?.data) {
      planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
      todoItems = planModeEntry.data.todos ?? todoItems;
      executionMode = planModeEntry.data.executing ?? executionMode;
      toolsBeforePlanMode =
        planModeEntry.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
      planFilePath = planModeEntry.data.planFilePath ?? planFilePath;
      todosWidgetVisible =
        planModeEntry.data.todosWidgetVisible ?? todosWidgetVisible;
    }

    // On resume: rebuild completion state from messages after last execute
    if (planModeEntry && executionMode && todoItems.length > 0) {
      let executeIndex = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i] as { type: string; customType?: string };
        if (entry.customType === "plan-mode-execute") {
          executeIndex = i;
          break;
        }
      }

      const messages: AssistantMessage[] = [];
      for (let i = executeIndex + 1; i < entries.length; i++) {
        const entry = entries[i];
        if (
          entry.type === "message" &&
          "message" in entry &&
          isAssistantMessage(entry.message as AgentMessage)
        ) {
          messages.push(entry.message as AssistantMessage);
        }
      }
      markCompletedSteps(messages.map(getTextContent).join("\n"), todoItems);
    }

    if (planModeEnabled) {
      pi.setActiveTools(
        getPlanTools(toolsBeforePlanMode ?? pi.getActiveTools()),
      );
    }
    updateStatus(ctx);
  });
}

/** Test-only exports (not part of the public package API). */
export const __test__ = {
  isSafeCommand,
  splitShellSegments,
  extractTodoItems,
  normalizePlanQuestions,
  buildPlanModePrompt,
};
