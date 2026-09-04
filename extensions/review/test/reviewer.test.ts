import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseDiff } from "../src/diff.ts";
import { __test__ } from "../src/reviewer.ts";
import type { ReviewScope } from "../src/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true });
});

const scope: ReviewScope = {
  kind: "auto",
  scopeKey: "scope",
  diffHash: "diff",
  capture: { cwd: "/work/repo", request: { kind: "auto" } },
  instructions: "Pay special attention to cancellation.",
  repos: [
    {
      repo: "/work/repo",
      label: "repo",
      kind: "auto",
      mode: "Current changes vs main",
      baseOid: "base",
      headOid: "head",
      summary: parseDiff(`diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1,2 @@
 export const value = 1;
+export const changed = true;
`),
    },
  ],
};

describe("reviewer task", () => {
  test("keeps the user-facing command simple while supplying reviewer context", () => {
    const task = __test__.buildReviewerTask(scope, undefined);
    expect(task).toContain("Repository root: /work/repo");
    expect(task).toContain("Pay special attention to cancellation.");
    expect(task).toContain("AGENTS.md or equivalent");
    expect(task).toContain("+export const changed = true;");
  });

  test("parses provider/model specs without truncating nested model ids", () => {
    expect(__test__.parseModelSpec("provider/model/version")).toEqual({
      provider: "provider",
      id: "model/version",
    });
    expect(() => __test__.parseModelSpec("missing-provider")).toThrow();
  });

  test("parses and resolves independent specialist thinking levels", () => {
    const settings = __test__.parseReviewSettings({
      model: "openai-codex/gpt-5.6-sol",
      specialistModel: "openai-codex/gpt-5.6-sol",
      thinkingLevel: "xhigh",
      specialistThinkingLevel: "max",
      maxReviewers: 2,
    });
    expect(settings).toEqual({
      model: "openai-codex/gpt-5.6-sol",
      specialistModel: "openai-codex/gpt-5.6-sol",
      thinkingLevel: "xhigh",
      specialistThinkingLevel: "max",
      maxReviewers: 2,
    });
    expect(__test__.resolveThinkingLevels(settings, "low")).toEqual({
      lead: "xhigh",
      specialist: "max",
    });
  });

  test("lets explicit model settings override the persisted re-review model", () => {
    expect(
      __test__.resolveReviewerModelSpecs(
        {
          model: "openai-codex/gpt-5.6-sol",
          maxReviewers: 2,
        },
        "deepseek/deepseek-v4-flash-vision-exp",
      ),
    ).toEqual({
      lead: "openai-codex/gpt-5.6-sol",
      specialist: "openai-codex/gpt-5.6-sol",
    });

    expect(
      __test__.resolveReviewerModelSpecs(
        { maxReviewers: 2 },
        "deepseek/deepseek-v4-flash-vision-exp",
      ),
    ).toEqual({
      lead: "deepseek/deepseek-v4-flash-vision-exp",
      specialist: "deepseek/deepseek-v4-flash-vision-exp",
    });
  });

  test("rejects ultra and inherits the lead level for the specialist", () => {
    const settings = __test__.parseReviewSettings({
      thinkingLevel: "xhigh",
      specialistThinkingLevel: "ultra",
      maxReviewers: 2,
    });
    expect(settings.specialistThinkingLevel).toBeUndefined();
    expect(__test__.resolveThinkingLevels(settings, "low")).toEqual({
      lead: "xhigh",
      specialist: "xhigh",
    });
  });

  test("includes carried open findings in a later re-review", () => {
    const carried = {
      id: "review-carried",
      title: "Keep the lock balanced",
      priority: "P1" as const,
      confidence: 0.95,
      repo: "repo",
      file: "src/app.ts",
      lineStart: 2,
      lineEnd: 2,
      trigger: "The operation fails.",
      impact: "The lock remains held.",
      evidence: "The changed branch skips unlock.",
      introducedByPatch: true,
    };
    const context = __test__.previousReviewContext({
      verdict: "needs_fix",
      summary: "Awaiting closure",
      findings: [],
      openFindings: [carried],
      previousFindings: [
        {
          id: carried.id,
          status: "still_open",
          reason: "No closure evidence.",
          priority: "P1",
        },
      ],
      rejectedFindings: 0,
      reviewerModel: "provider/reviewer",
      reviewerCount: 1,
    });
    expect(context).toContain("review-carried");
    expect(context).toContain("Keep the lock balanced");
  });

  test("treats non-object settings files as empty defaults", () => {
    for (const raw of [null, 42, "settings", true, []]) {
      expect(__test__.parseReviewSettings(raw)).toEqual({
        model: undefined,
        specialistModel: undefined,
        thinkingLevel: undefined,
        specialistThinkingLevel: undefined,
        maxReviewers: 2,
      });
    }
  });
});

describe("reviewer file confinement", () => {
  test("accepts in-repository paths and rejects host paths and symlink escapes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "piex-review-guard-"));
    tempDirs.push(root);
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "inside.ts"), "export const ok = true;\n");
    fs.writeFileSync(path.join(root, "secret.txt"), "host secret");
    fs.writeFileSync(path.join(repo, "outside-dir.ts"), "not created");
    fs.symlinkSync(
      path.join(root, "secret.txt"),
      path.join(repo, "forged-link.txt"),
    );
    const guardScope = {
      repos: [{ repo, label: "repo" }],
    } as never;
    const guard = __test__.createReviewerFileGuard(guardScope);

    expect(() => guard("inside.ts")).not.toThrow();
    expect(() => guard(path.join(repo, "inside.ts"))).not.toThrow();
    expect(() =>
      guard(path.join(repo, "missing-dir", "future.ts")),
    ).not.toThrow();
    expect(() => guard(path.join(root, "secret.txt"))).toThrow(/outside/);
    expect(() => guard("forged-link.txt")).toThrow(/outside/);
    expect(() => guard(path.join(repo, "forged-link.txt"))).toThrow(/outside/);
    expect(() => guard("~/.ssh/id_rsa")).toThrow(/outside/);
    expect(() => guard("file:///etc/passwd")).toThrow(/outside/);
  });
});
