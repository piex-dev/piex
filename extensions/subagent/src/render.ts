import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { SubagentDetails, SubagentParams } from "./types.js";

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

function preview(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

export function renderSubagentCall(args: SubagentParams, theme: Theme) {
  const parts: string[] = [];
  if (args.agent) parts.push(theme.fg("accent", args.agent));
  if (args.task) parts.push(theme.fg("dim", preview(args.task)));
  if (args.tasks?.length) {
    parts.push(theme.fg("accent", `parallel (${args.tasks.length})`));
  }
  const head =
    theme.fg("toolTitle", theme.bold("subagent ")) + parts.join(" · ");
  return new Text(head, 0, 0);
}

export function renderSubagentResult(
  result: AgentToolResult<SubagentDetails>,
  _options: ToolRenderResultOptions,
  theme: Theme,
) {
  const details = result.details;
  if (!details) {
    const text = result.content
      .map((c) => ("text" in c ? c.text : ""))
      .join("");
    return new Text(text, 0, 0);
  }

  const lines: string[] = [];
  for (const r of details.results) {
    const ok = r.exitCode === 0 && !r.timedOut && !r.aborted;
    const marker = ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
    const statusLabel = [
      `exit ${r.exitCode}`,
      r.timedOut ? "timed-out" : "",
      r.aborted ? "aborted" : "",
    ]
      .filter(Boolean)
      .join(" ");

    lines.push(
      `${marker} ${theme.fg("accent", r.agent)} ${theme.fg(
        "muted",
        `· ${formatDuration(
          r.durationMs,
        )} · ${formatTokens(r.usage.totalTokens)} tok · ${statusLabel}`,
      )}`,
    );
    lines.push(
      theme.fg(
        "dim",
        `  ${preview(r.output || r.error || "(no output)", 200)}`,
      ),
    );
    if (details.results.length > 1) lines.push("");
  }

  return new Text(lines.join("\n"), 0, 0);
}
