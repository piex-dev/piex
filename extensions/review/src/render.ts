import type { ReviewReport, ReviewScope } from "./types.js";

export function renderReviewReport(
  scope: ReviewScope,
  report: ReviewReport,
): string {
  const files = scope.repos.reduce(
    (sum, { summary }) => sum + summary.files.length,
    0,
  );
  const blocking = report.findings.filter(
    ({ priority }) => priority === "P0" || priority === "P1",
  );
  const advisory = report.findings.filter(({ priority }) => priority === "P2");
  const resolved = report.previousFindings.filter(
    ({ status }) =>
      status === "resolved" || status === "invalid" || status === "superseded",
  );
  const unanchoredOpen = report.previousFindings.filter(
    ({ id, status }) =>
      status === "still_open" &&
      !report.findings.some(
        ({ previousFindingId }) => previousFindingId === id,
      ),
  );
  const priorBlocking = unanchoredOpen.filter(
    ({ priority }) => priority === "P0" || priority === "P1",
  );
  const title = report.verdict === "pass" ? "PASS" : "NEEDS FIX";
  const cached = report.cached ? " · cached" : "";
  let output = `## Review: ${title}\n\n`;
  output += `${blocking.length + priorBlocking.length} blocking · ${advisory.length} advisory · ${files} files · ${report.reviewerCount} reviewer${report.reviewerCount === 1 ? "" : "s"}${cached}\n\n`;
  if (report.reviewers?.length) {
    const reviewers = report.reviewers
      .map(({ role, model, thinkingLevel, specialty, fastMode }) => {
        const label = specialty ? `${role}/${specialty}` : role;
        return `${label} \`${model}\` (thinking: ${thinkingLevel}${fastMode ? ", fast" : ""})`;
      })
      .join(" · ");
    output += `Reviewers: ${reviewers}\n\n`;
  } else {
    output += `Reviewer: \`${report.reviewerModel}\`\n\n`;
  }
  output += `${report.summary}\n`;

  if (blocking.length > 0) output += `\n### Blocking findings\n`;
  for (const finding of blocking) {
    output += `\n#### [${finding.priority}] ${finding.title}\n\n`;
    output += `\`${finding.repo}/${finding.file}:${finding.lineStart}\` · confidence ${Math.round(finding.confidence * 100)}%\n\n`;
    output += `**Trigger:** ${finding.trigger}\n\n`;
    output += `**Impact:** ${finding.impact}\n\n`;
    output += `**Evidence:** ${finding.evidence}\n`;
  }

  if (advisory.length > 0) output += `\n### Advisory findings\n`;
  for (const finding of advisory) {
    output += `\n- **${finding.title}** at \`${finding.repo}/${finding.file}:${finding.lineStart}\`: ${finding.impact}\n`;
  }

  if (resolved.length > 0) {
    output += `\n### Closed or replaced since the previous review\n\n`;
    for (const item of resolved) {
      output += `- \`${item.id}\` ${item.status}: ${item.reason}\n`;
    }
  }

  if (unanchoredOpen.length > 0) {
    output += `\n### Previous findings awaiting closure\n\n`;
    for (const item of unanchoredOpen) {
      output += `- ${item.priority ? `[${item.priority}] ` : ""}\`${item.id}\` still open: ${item.reason}\n`;
    }
  }

  if (report.rejectedFindings > 0) {
    output += `\n_${report.rejectedFindings} unverified finding${report.rejectedFindings === 1 ? " was" : "s were"} omitted by the evidence gate._\n`;
  }
  return output.trim();
}
