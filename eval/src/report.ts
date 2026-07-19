import type { EvalReport, AgentSummary, TaskResult } from "./types.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function generateReport(report: EvalReport, outputDir: string): string {
  mkdirSync(outputDir, { recursive: true });

  const md = buildMarkdown(report);
  const filename = join(outputDir, "report.md");
  writeFileSync(filename, md);
  return filename;
}

function buildMarkdown(report: EvalReport): string {
  const lines: string[] = [
    `## ${report.benchmark} — piex 评测报告 (${report.date})`,
    "",
    "### 评测结果",
    "",
  ];

  const headers = [
    "| 角色 | Agent | Resolve Rate | Passed/Failed | Avg Wall Time | Avg Tokens |",
    "|------|-------|-------------|---------------|---------------|------------|",
  ];
  lines.push(headers[0], headers[1]);

  const roleLabels: Record<string, string> = {
    baseline: "基准线",
    test: "**评测对象**",
    reference: "参照系",
  };

  for (const agent of report.agents) {
    const pct = `${agent.resolveRate}%`;
    const tokens =
      agent.avgTokens > 0 ? `${(agent.avgTokens / 1000).toFixed(0)}K` : "N/A";
    lines.push(
      `| ${roleLabels[agent.role] ?? agent.role} | ${agent.agent} | ${pct} | ${agent.passedTasks}/${agent.passedTasks + agent.failedTasks} | ${agent.avgWallTime}s | ${tokens} |`,
    );
  }

  lines.push("");

  const ref = report.agents.find((a: AgentSummary) => a.role === "reference");
  const base = report.agents.find((a: AgentSummary) => a.role === "baseline");
  const test = report.agents.find((a: AgentSummary) => a.role === "test");

  if (base && test) {
    lines.push("### 效果分析", "");
    lines.push("| 指标 | 基准线 | pi + piex | 相对提升 |");
    lines.push("|------|--------|-----------|---------|");

    const baseRate = base.resolveRate;
    const testRate = test.resolveRate;
    const improvement =
      baseRate > 0
        ? `+${Math.round(((testRate - baseRate) / baseRate) * 1000) / 10}%`
        : "N/A";
    lines.push(
      `| resolve_rate | ${baseRate}% | ${testRate}% | **${improvement}** |`,
    );

    const tokenImprovement =
      base.avgTokens > 0
        ? `${Math.round(((test.avgTokens - base.avgTokens) / base.avgTokens) * -1000) / 10}%`
        : "N/A";
    lines.push(
      `| avg_tokens | ${base.avgTokens} | ${test.avgTokens} | ${tokenImprovement} |`,
    );
  }

  if (test && ref) {
    const gap = `-${Math.round((ref.resolveRate - test.resolveRate) * 10) / 10}%`;
    lines.push("", `与参照系差距: resolve_rate ${gap}`);
  }

  lines.push("", "### 每个任务详情", "");
  lines.push("| Task ID | Language | 基准线 | pi + piex | 参照系 |");
  lines.push("|---------|----------|--------|-----------|--------|");

  for (const task of report.tasks) {
    const basePass =
      task.results[
        report.agents.find((a: AgentSummary) => a.role === "baseline")?.agent ??
          ""
      ]?.passed;
    const testPass =
      task.results[
        report.agents.find((a: AgentSummary) => a.role === "test")?.agent ?? ""
      ]?.passed;
    const refPass =
      task.results[
        report.agents.find((a: AgentSummary) => a.role === "reference")
          ?.agent ?? ""
      ]?.passed;

    const icon = (p: boolean | undefined) =>
      p === true ? "✅" : p === false ? "❌" : "—";
    lines.push(
      `| ${task.taskId} | ${task.language} | ${icon(basePass)} | ${icon(testPass)} | ${icon(refPass)} |`,
    );
  }

  lines.push("");
  return lines.join("\n");
}
