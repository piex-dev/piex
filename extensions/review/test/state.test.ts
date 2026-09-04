import { describe, expect, test } from "bun:test";
import {
  cachedReport,
  createReviewRun,
  findPreviousRun,
  REVIEW_RUN_ENTRY,
} from "../src/state.ts";
import type { ReviewReport, ReviewScope } from "../src/types.ts";

const report: ReviewReport = {
  verdict: "pass",
  summary: "Clean",
  findings: [],
  previousFindings: [],
  rejectedFindings: 0,
  reviewerModel: "provider/model",
  reviewerCount: 1,
};

const scope = {
  kind: "auto",
  repos: [],
  scopeKey: "scope-a",
  diffHash: "diff-a",
  capture: { cwd: "/repo", request: { kind: "auto" } },
} satisfies ReviewScope;

describe("review state", () => {
  test("restores the latest run for the same scope", () => {
    const older = createReviewRun(scope, report);
    const newer = { ...older, diffHash: "diff-b" };
    const session = {
      getEntries: () => [
        { type: "custom", customType: REVIEW_RUN_ENTRY, data: older },
        { type: "custom", customType: "other", data: {} },
        { type: "custom", customType: REVIEW_RUN_ENTRY, data: newer },
      ],
    };
    expect(findPreviousRun(session, "scope-a")?.diffHash).toBe("diff-b");
    expect(findPreviousRun(session, "scope-b")).toBeUndefined();
  });

  test("ignores runs on abandoned session branches", () => {
    const active = createReviewRun(scope, report);
    const abandoned = { ...active, diffHash: "abandoned-diff" };
    const session = {
      getEntries: () => [
        { type: "custom", customType: REVIEW_RUN_ENTRY, data: active },
        { type: "custom", customType: REVIEW_RUN_ENTRY, data: abandoned },
      ],
      getBranch: () => [
        { type: "custom", customType: REVIEW_RUN_ENTRY, data: active },
      ],
    };
    expect(findPreviousRun(session, "scope-a")?.diffHash).toBe("diff-a");
  });

  test("marks cached reports without mutating persisted state", () => {
    const run = createReviewRun(scope, report);
    const cached = cachedReport(run);
    expect(cached.cached).toBe(true);
    expect(run.report.cached).toBeUndefined();
  });
});
