import { describe, expect, test } from "bun:test";
import { buildReviewReport, chooseSpecialist } from "../src/findings.ts";
import { parseDiff } from "../src/diff.ts";
import type {
  ReviewFindingDraft,
  ReviewReport,
  ReviewScope,
} from "../src/types.ts";

const DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -9,2 +9,3 @@
 keep();
+changed();
 done();
`;

const TWO_SPOTS_DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -9,2 +9,3 @@
 keep();
+changed();
 done();
@@ -19,2 +19,3 @@
 keep2();
+another();
 done2();
`;

const BIG_BLOCK_DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,1 +1,14 @@
 export const value = 1;
+export const added1 = 1;
+export const added2 = 2;
+export const added3 = 3;
+export const added4 = 4;
+export const added5 = 5;
+export const added6 = 6;
+export const added7 = 7;
+export const added8 = 8;
+export const added9 = 9;
+export const added10 = 10;
+export const added11 = 11;
+export const added12 = 12;
+export const added13 = 13;
`;

function scope(diff = DIFF): ReviewScope {
  return {
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
        summary: parseDiff(diff),
      },
    ],
  };
}

function finding(
  overrides: Partial<ReviewFindingDraft> = {},
): ReviewFindingDraft {
  return {
    title: "Handle failed request",
    priority: "P1",
    confidence: 0.95,
    repo: "repo",
    file: "src/app.ts",
    lineStart: 10,
    lineEnd: 10,
    trigger: "The request rejects before cleanup runs.",
    impact: "The resource remains locked for all later requests.",
    evidence: "The added call throws before the only unlock statement.",
    introducedByPatch: true,
    ...overrides,
  };
}

describe("buildReviewReport", () => {
  test("keeps only evidence-backed patch-anchored findings", () => {
    const report = buildReviewReport(
      scope(),
      [
        {
          summary: "One blocking bug found.",
          findings: [
            finding(),
            finding({ title: "Unchanged code", lineStart: 50, lineEnd: 50 }),
            finding({ title: "Speculation", confidence: 0.5 }),
            finding({ title: "Pre-existing", introducedByPatch: false }),
          ],
          previousFindings: [],
        },
      ],
      "provider/reviewer",
    );
    expect(report.verdict).toBe("needs_fix");
    expect(report.findings).toHaveLength(1);
    expect(report.rejectedFindings).toBe(3);
    expect(report.findings[0].id).toMatch(/^review-/);
  });

  test("does not repeat a rejected reviewer's contradictory summary", () => {
    const report = buildReviewReport(
      scope(),
      [
        {
          summary: "One blocking bug found.",
          findings: [finding({ confidence: 0.5 })],
          previousFindings: [],
        },
      ],
      "provider/reviewer",
    );
    expect(report.verdict).toBe("pass");
    expect(report.findings).toEqual([]);
    expect(report.summary).toBe(
      "No blocking problems were found in the current changes.",
    );
  });

  test("preserves legitimate top-level a and b directory paths", () => {
    for (const directory of ["a", "b"]) {
      const report = buildReviewReport(
        scope(DIFF.replaceAll("src/app.ts", `${directory}/app.ts`)),
        [
          {
            summary: "One blocking bug found.",
            findings: [finding({ file: `${directory}/app.ts` })],
            previousFindings: [],
          },
        ],
        "provider/reviewer",
      );
      expect(report.findings[0].file).toBe(`${directory}/app.ts`);
    }
  });

  test("retains finding identity and closes resolved findings on re-review", () => {
    const previousFinding = {
      ...finding(),
      id: "review-existing",
    };
    const previous: ReviewReport = {
      verdict: "needs_fix",
      summary: "Previous",
      findings: [previousFinding],
      previousFindings: [],
      rejectedFindings: 0,
      reviewerModel: "provider/reviewer",
      reviewerCount: 1,
    };
    const stillOpen = buildReviewReport(
      scope(),
      [
        {
          summary: "Still open",
          findings: [finding({ previousFindingId: "review-existing" })],
          previousFindings: [],
        },
      ],
      "provider/reviewer",
      previous,
    );
    expect(stillOpen.findings[0].id).toBe("review-existing");
    expect(stillOpen.previousFindings[0].status).toBe("still_open");

    const implicitlyMatched = buildReviewReport(
      scope(),
      [
        {
          summary: "Still open",
          findings: [finding()],
          previousFindings: [],
        },
      ],
      "provider/reviewer",
      previous,
    );
    expect(implicitlyMatched.findings[0].id).toBe("review-existing");

    const resolved = buildReviewReport(
      scope(),
      [
        {
          summary: "Fixed",
          findings: [],
          previousFindings: [
            {
              id: "review-existing",
              status: "resolved",
              reason: "Guard added.",
            },
          ],
        },
      ],
      "provider/reviewer",
      previous,
    );
    expect(resolved.verdict).toBe("pass");
    expect(resolved.previousFindings[0].status).toBe("resolved");
  });

  test("keeps two instances of the same finding at different locations", () => {
    const report = buildReviewReport(
      scope(TWO_SPOTS_DIFF),
      [
        {
          summary: "Two spots",
          findings: [
            finding({ lineStart: 10, lineEnd: 10 }),
            finding({ lineStart: 20, lineEnd: 20 }),
          ],
          previousFindings: [],
        },
      ],
      "provider/reviewer",
    );
    expect(report.findings).toHaveLength(2);
    expect(new Set(report.findings.map(({ id }) => id)).size).toBe(2);
  });

  test("accepts findings that span a large changed block", () => {
    const report = buildReviewReport(
      scope(BIG_BLOCK_DIFF),
      [
        {
          summary: "Wide defect",
          findings: [finding({ lineStart: 3, lineEnd: 13 })],
          previousFindings: [],
        },
      ],
      "provider/reviewer",
    );
    expect(report.verdict).toBe("needs_fix");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].lineStart).toBe(3);
    expect(report.findings[0].lineEnd).toBe(13);
  });

  test("anchors an overly broad range to the changed lines it covers", () => {
    const report = buildReviewReport(
      scope(),
      [
        {
          summary: "Broad range",
          findings: [finding({ lineStart: 1, lineEnd: 50 })],
          previousFindings: [],
        },
      ],
      "provider/reviewer",
    );
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].lineStart).toBe(10);
    expect(report.findings[0].lineEnd).toBe(10);
  });

  test("does not pass while a previous blocking finding lacks closure evidence", () => {
    const previous: ReviewReport = {
      verdict: "needs_fix",
      summary: "Previous",
      findings: [{ ...finding(), id: "review-existing" }],
      previousFindings: [],
      rejectedFindings: 0,
      reviewerModel: "provider/reviewer",
      reviewerCount: 1,
    };
    const report = buildReviewReport(
      scope(),
      [{ summary: "No new findings", findings: [], previousFindings: [] }],
      "provider/reviewer",
      previous,
    );
    expect(report.verdict).toBe("needs_fix");
    expect(report.previousFindings).toEqual([
      {
        id: "review-existing",
        status: "still_open",
        reason:
          "The reviewer did not provide enough evidence to close this finding.",
        priority: "P1",
      },
    ]);

    const emptyClosure = buildReviewReport(
      scope(),
      [
        {
          summary: "Claimed fixed",
          findings: [],
          previousFindings: [
            { id: "review-existing", status: "resolved", reason: "   " },
          ],
        },
      ],
      "provider/reviewer",
      previous,
    );
    expect(emptyClosure.verdict).toBe("needs_fix");
    expect(emptyClosure.previousFindings[0].status).toBe("still_open");
  });

  test("carries an unclosed finding across repeated re-reviews", () => {
    const initial = buildReviewReport(
      scope(),
      [
        {
          summary: "Found a blocker.",
          findings: [finding()],
          previousFindings: [],
        },
      ],
      "provider/reviewer",
    );
    const firstOmission = buildReviewReport(
      scope(),
      [{ summary: "No evidence", findings: [], previousFindings: [] }],
      "provider/reviewer",
      initial,
    );
    const secondOmission = buildReviewReport(
      scope(),
      [{ summary: "No evidence", findings: [], previousFindings: [] }],
      "provider/reviewer",
      firstOmission,
    );

    expect(firstOmission.findings).toEqual([]);
    expect(firstOmission.openFindings).toEqual(initial.findings);
    expect(secondOmission.verdict).toBe("needs_fix");
    expect(secondOmission.openFindings).toEqual(initial.findings);
    expect(secondOmission.previousFindings[0].status).toBe("still_open");

    const resolved = buildReviewReport(
      scope(),
      [
        {
          summary: "Fixed",
          findings: [],
          previousFindings: [
            {
              id: initial.findings[0].id,
              status: "resolved",
              reason: "Guard added.",
            },
          ],
        },
      ],
      "provider/reviewer",
      secondOmission,
    );
    expect(resolved.verdict).toBe("pass");
    expect(resolved.openFindings).toEqual([]);
  });

  test("keeps the strongest candidate when a previous id is reused", () => {
    const previous: ReviewReport = {
      verdict: "needs_fix",
      summary: "Previous",
      findings: [{ ...finding(), id: "review-existing" }],
      previousFindings: [],
      rejectedFindings: 0,
      reviewerModel: "provider/reviewer",
      reviewerCount: 1,
    };
    const report = buildReviewReport(
      scope(),
      [
        {
          summary: "Conflicting candidates",
          findings: [
            finding({
              title: "Blocking form",
              priority: "P1",
              previousFindingId: "review-existing",
            }),
            finding({
              title: "Advisory form",
              priority: "P2",
              previousFindingId: "review-existing",
            }),
          ],
          previousFindings: [],
        },
      ],
      "provider/reviewer",
      previous,
    );

    expect(report.verdict).toBe("needs_fix");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].title).toBe("Blocking form");
    expect(report.openFindings?.[0].priority).toBe("P1");
  });

  test("does not downgrade a still-open blocking finding", () => {
    const previous: ReviewReport = {
      verdict: "needs_fix",
      summary: "Previous",
      findings: [{ ...finding(), id: "review-existing" }],
      previousFindings: [],
      rejectedFindings: 0,
      reviewerModel: "provider/reviewer",
      reviewerCount: 1,
    };
    const report = buildReviewReport(
      scope(),
      [
        {
          summary: "Downgraded without closure",
          findings: [
            finding({
              priority: "P2",
              previousFindingId: "review-existing",
            }),
          ],
          previousFindings: [],
        },
      ],
      "provider/reviewer",
      previous,
    );

    expect(report.verdict).toBe("needs_fix");
    expect(report.findings[0].priority).toBe("P1");
    expect(report.openFindings?.[0].priority).toBe("P1");
    expect(report.summary).toBe(
      "The review found 1 blocking problem in the current changes.",
    );

    const belowBlockingThreshold = buildReviewReport(
      scope(),
      [
        {
          summary: "Low-confidence downgrade",
          findings: [
            finding({
              priority: "P2",
              confidence: 0.75,
              previousFindingId: "review-existing",
            }),
          ],
          previousFindings: [],
        },
      ],
      "provider/reviewer",
      previous,
    );
    expect(belowBlockingThreshold.verdict).toBe("needs_fix");
    expect(belowBlockingThreshold.findings).toEqual([]);
    expect(belowBlockingThreshold.openFindings).toEqual(previous.findings);
    expect(belowBlockingThreshold.rejectedFindings).toBe(1);
  });

  test("canonicalizes duplicate ids restored from legacy reports", () => {
    const previous: ReviewReport = {
      verdict: "needs_fix",
      summary: "Legacy report",
      findings: [
        { ...finding({ title: "Legacy blocker" }), id: "review-duplicate" },
        {
          ...finding({ title: "Legacy advisory", priority: "P2" }),
          id: "review-duplicate",
        },
      ],
      previousFindings: [],
      rejectedFindings: 0,
      reviewerModel: "provider/reviewer",
      reviewerCount: 1,
    };
    const report = buildReviewReport(
      scope(),
      [
        {
          summary: "Still present",
          findings: [
            finding({
              title: "Legacy advisory",
              priority: "P2",
              confidence: 0.8,
              previousFindingId: "review-duplicate",
            }),
          ],
          previousFindings: [],
        },
      ],
      "provider/reviewer",
      previous,
    );

    expect(report.verdict).toBe("needs_fix");
    expect(report.findings[0].priority).toBe("P1");
    expect(report.openFindings).toHaveLength(1);
    expect(report.openFindings?.[0].priority).toBe("P1");
  });
});

describe("chooseSpecialist", () => {
  test("routes security-sensitive patches without exposing a user mode", () => {
    const securityScope = scope(
      DIFF.replaceAll("src/app.ts", "src/auth/token.ts"),
    );
    expect(chooseSpecialist(securityScope)?.name).toBe("security");
  });

  test("does not route generic token or schema vocabulary as high risk", () => {
    const ordinary = scope(
      DIFF.replace(
        "+changed();",
        "+recordTokenBudget();\n+validateResponseSchema();",
      ).replace("+9,3", "+9,4"),
    );
    expect(chooseSpecialist(ordinary)).toBeUndefined();
  });
});
