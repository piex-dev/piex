import { describe, expect, test } from "bun:test";
import { diffForFile, findingOverlapsDiff, parseDiff } from "../src/diff.ts";

const SOURCE_DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -8,3 +8,4 @@ export function run() {
   start();
+  finish();
 }
diff --git a/package-lock.json b/package-lock.json
index 3333333..4444444 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1 +1 @@
-{"version": 1}
+{"version": 2}
`;

const PREFIX_DIRECTORY_DIFF = `diff --git a/a/app.ts b/a/app.ts
index 1111111..2222222 100644
--- a/a/app.ts
+++ b/a/app.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
diff --git a/b/app.ts b/b/app.ts
index 3333333..4444444 100644
--- a/b/app.ts
+++ b/b/app.ts
@@ -1 +1 @@
-export const value = 3;
+export const value = 4;
`;

describe("parseDiff", () => {
  test("physically excludes noise chunks from reviewer input", () => {
    const summary = parseDiff(SOURCE_DIFF);
    expect(summary.files.map(({ path }) => path)).toEqual(["src/app.ts"]);
    expect(summary.excluded.map(({ path }) => path)).toEqual([
      "package-lock.json",
    ]);
    expect(summary.filteredDiff).toContain("src/app.ts");
    expect(summary.filteredDiff).not.toContain("package-lock.json");
    expect(summary.rawDiff).toContain("package-lock.json");
    expect(summary.totalAdded).toBe(1);
    expect(summary.totalRemoved).toBe(0);
  });

  test("records changed new-file ranges", () => {
    const [file] = parseDiff(SOURCE_DIFF).files;
    expect(file.changedRanges).toEqual([{ start: 9, end: 9 }]);
  });

  test("parses quoted git paths containing spaces", () => {
    const summary = parseDiff(`diff --git "a/src/my app.ts" "b/src/my app.ts"
index 1111111..2222222 100644
--- "a/src/my app.ts"
+++ "b/src/my app.ts"
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`);
    expect(summary.files.map(({ path }) => path)).toEqual(["src/my app.ts"]);
    expect(summary.files[0].changedRanges).toEqual([{ start: 1, end: 1 }]);
  });
});

describe("findingOverlapsDiff", () => {
  test("accepts changed lines and rejects unchanged locations", () => {
    const summary = parseDiff(SOURCE_DIFF);
    expect(
      findingOverlapsDiff(summary, {
        file: "src/app.ts",
        lineStart: 9,
        lineEnd: 9,
      }),
    ).toBe(true);
    expect(
      findingOverlapsDiff(summary, {
        file: "src/app.ts",
        lineStart: 10,
        lineEnd: 10,
      }),
    ).toBe(false);
    expect(
      findingOverlapsDiff(summary, {
        file: "src/app.ts",
        lineStart: 30,
        lineEnd: 30,
      }),
    ).toBe(false);
  });

  test("prefers exact repository paths before accepting Git prefixes", () => {
    const summary = parseDiff(PREFIX_DIRECTORY_DIFF);
    expect(summary.files.map(({ path }) => path)).toEqual([
      "a/app.ts",
      "b/app.ts",
    ]);

    for (const file of ["a/app.ts", "b/app.ts"]) {
      expect(
        findingOverlapsDiff(summary, { file, lineStart: 1, lineEnd: 1 }),
      ).toBe(true);
      expect(diffForFile(summary, file)).toContain(`b/${file}`);
    }

    expect(
      findingOverlapsDiff(summary, {
        file: "b/a/app.ts",
        lineStart: 1,
        lineEnd: 1,
      }),
    ).toBe(true);
    expect(
      findingOverlapsDiff(summary, {
        file: "a/b/app.ts",
        lineStart: 1,
        lineEnd: 1,
      }),
    ).toBe(true);
    expect(diffForFile(summary, "b/a/app.ts")).toContain("b/a/app.ts");
    expect(diffForFile(summary, "a/b/app.ts")).toContain("b/b/app.ts");
  });
});
