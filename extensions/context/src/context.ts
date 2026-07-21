/**
 * context extension — /context command for session usage reports.
 *
 *   pi install npm:@piex-dev/context
 *   pi -e ./extensions/context.ts
 *
 * Analyzes session entries and displays a structured usage report:
 * message distribution, tool call breakdown, and estimated token allocation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface EntryStats {
  total: number;
  userMessages: number;
  userChars: number;
  assistantMessages: number;
  assistantChars: number;
  systemMessages: number;
  toolCalls: number;
  toolResults: number;
  toolResultChars: number;
  customEntries: number;
  estimatedChars: number;
  cjkChars: number;
}

interface RoleBreakdown {
  type: string;
  count: number;
  chars: number;
  pct: number;
  bar: string;
}

// ══════════════════════════════════════════════════════════════════════════
// Entry analysis
// ══════════════════════════════════════════════════════════════════════════

function countChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce((sum: number, block: Record<string, unknown>) => {
      if (block.type === "text" && typeof block.text === "string")
        return sum + block.text.length;
      if (block.type === "thinking" && typeof block.thinking === "string")
        return sum + block.thinking.length;
      return sum;
    }, 0);
  }
  return 0;
}

const CJK_RE = /[一-鿿㐀-䶿豈-﫿]/g;

/** Count CJK characters — they tokenize ~1 token/char, unlike latin text. */
function countCjk(content: unknown): number {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((b: Record<string, unknown>) =>
              b.type === "text" && typeof b.text === "string" ? b.text : "",
            )
            .join("")
        : "";
  return (text.match(CJK_RE) ?? []).length;
}

function analyzeEntries(entries: Array<Record<string, unknown>>): EntryStats {
  const stats: EntryStats = {
    total: entries.length,
    userMessages: 0,
    userChars: 0,
    assistantMessages: 0,
    assistantChars: 0,
    systemMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    toolResultChars: 0,
    customEntries: 0,
    estimatedChars: 0,
    cjkChars: 0,
  };

  const addContent = (content: unknown): number => {
    const chars = countChars(content);
    stats.estimatedChars += chars;
    stats.cjkChars += countCjk(content);
    return chars;
  };

  for (const entry of entries) {
    const type = String(entry.type ?? "");

    if (type === "message") {
      const msg = entry.message as Record<string, unknown> | undefined;
      const role = String(msg?.role ?? "");
      const chars = addContent(msg?.content);

      switch (role) {
        case "user":
          stats.userMessages++;
          stats.userChars += chars;
          break;
        case "assistant": {
          stats.assistantMessages++;
          stats.assistantChars += chars;
          // Tool calls are content blocks inside assistant messages —
          // pi has no standalone tool_call session entry type.
          if (Array.isArray(msg?.content)) {
            for (const block of msg.content as Array<Record<string, unknown>>) {
              if (block.type !== "toolCall") continue;
              stats.toolCalls++;
              stats.estimatedChars += JSON.stringify(
                block.arguments ?? {},
              ).length;
            }
          }
          break;
        }
        case "system":
          stats.systemMessages++;
          break;
        case "toolResult":
          stats.toolResults++;
          stats.toolResultChars += chars;
          break;
      }
    } else if (type === "custom_message") {
      stats.customEntries++;
      addContent(entry.content);
    } else if (type === "custom") {
      stats.customEntries++;
      if (entry.data) stats.estimatedChars += JSON.stringify(entry.data).length;
    }
  }

  return stats;
}

// ══════════════════════════════════════════════════════════════════════════
// Report formatting
// ══════════════════════════════════════════════════════════════════════════

function buildBar(pct: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function estimateTokens(chars: number, cjkChars: number): number {
  // CJK chars tokenize at ~1 token/char; latin/code averages ~3.5 chars/token.
  return Math.round(cjkChars + (chars - cjkChars) / 3.5);
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

function buildReport(stats: EntryStats): string {
  const totalChars = stats.estimatedChars || 1;
  const totalTokens = estimateTokens(totalChars, stats.cjkChars);
  const barWidth = 20;

  const breakdown: RoleBreakdown[] = [
    {
      type: "Assistant",
      count: stats.assistantMessages,
      chars: stats.assistantChars,
      pct: 0,
      bar: "",
    },
    {
      type: "User",
      count: stats.userMessages,
      chars: stats.userChars,
      pct: 0,
      bar: "",
    },
    {
      type: "Tool Results",
      count: stats.toolResults,
      chars: stats.toolResultChars,
      pct: 0,
      bar: "",
    },
  ];

  const totalCategoryChars =
    stats.assistantChars + stats.userChars + stats.toolResultChars;

  if (totalCategoryChars > 0) {
    for (const item of breakdown) {
      item.pct = Math.round((item.chars / totalCategoryChars) * 100);
    }
  }

  for (const item of breakdown) {
    item.bar = buildBar(item.pct, barWidth);
  }

  const customLine =
    stats.customEntries > 0
      ? `| Custom entries | ${stats.customEntries} |\n`
      : "";
  const report = `## Context Usage Report

### Overview

| Metric | Value |
|--------|-------|
| Total entries | ${stats.total} |
| Estimated tokens | ~${formatTokens(totalTokens)} |
| User messages | ${stats.userMessages} |
| Assistant messages | ${stats.assistantMessages} |
| System messages | ${stats.systemMessages} |
| Tool calls | ${stats.toolCalls} |
| Tool results | ${stats.toolResults} |
${customLine}
### Distribution

\`\`\`
${breakdown[0].bar} ${breakdown[0].type.padEnd(14)} ${String(breakdown[0].pct).padStart(3)}%
${breakdown[1].bar} ${breakdown[1].type.padEnd(14)} ${String(breakdown[1].pct).padStart(3)}%
${breakdown[2].bar} ${breakdown[2].type.padEnd(14)} ${String(breakdown[2].pct).padStart(3)}%
\`\`\`

Estimated total: **~${formatTokens(totalTokens)} tokens** (${totalChars.toLocaleString()} chars)`;

  return report;
}

// ══════════════════════════════════════════════════════════════════════════
// Extension
// ══════════════════════════════════════════════════════════════════════════

export default function contextExtension(pi: ExtensionAPI) {
  pi.registerCommand("context", {
    description: "Show session context usage report",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getEntries() as Array<
        Record<string, unknown>
      >;

      if (entries.length === 0) {
        pi.sendMessage(
          {
            customType: "context-report",
            content: "**Context Usage**: no entries yet.",
            display: true,
          },
          { deliverAs: "followUp" },
        );
        return;
      }

      const stats = analyzeEntries(entries);
      const report = buildReport(stats);

      pi.sendMessage(
        { customType: "context-report", content: report, display: true },
        { deliverAs: "followUp" },
      );
    },
  });
}
