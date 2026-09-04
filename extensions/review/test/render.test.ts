import { describe, expect, test } from "bun:test";
import { parseDiff } from "../src/diff.ts";
import { renderReviewReport } from "../src/render.ts";
import type { ReviewReport, ReviewScope } from "../src/types.ts";

describe("renderReviewReport", () => {
  test("keeps the actual reviewer models and thinking levels in the result", () => {
    const scope: ReviewScope = {
      kind: "auto",
      scopeKey: "scope",
      diffHash: "diff",
      capture: { cwd: "/repo", request: { kind: "auto" } },
      repos: [
        {
          repo: "/repo",
          label: "repo",
          kind: "auto",
          mode: "Current changes vs main",
          baseOid: "base",
          headOid: "head",
          summary: parseDiff(`diff --git a/app.ts b/app.ts
index 1111111..2222222 100644
--- a/app.ts
+++ b/app.ts
@@ -1 +1,2 @@
 export const oldValue = true;
+export const newValue = true;
`),
        },
      ],
    };
    const report: ReviewReport = {
      verdict: "pass",
      summary: "No blocking problems were found in the current changes.",
      findings: [],
      previousFindings: [],
      rejectedFindings: 0,
      reviewerModel: "openai-codex/gpt-5.6-sol",
      reviewerCount: 2,
      reviewers: [
        {
          role: "lead",
          model: "openai-codex/gpt-5.6-sol",
          thinkingLevel: "xhigh",
        },
        {
          role: "specialist",
          specialty: "security",
          model: "openai-codex/gpt-5.6-sol",
          thinkingLevel: "max",
        },
      ],
    };

    const rendered = renderReviewReport(scope, report);
    expect(rendered).toContain(
      "lead `openai-codex/gpt-5.6-sol` (thinking: xhigh)",
    );
    expect(rendered).toContain(
      "specialist/security `openai-codex/gpt-5.6-sol` (thinking: max)",
    );
  });
});
