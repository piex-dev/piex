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

  test("excludes credential-like chunks from tracked diffs", () => {
    const summary = parseDiff(`diff --git a/.env b/.env
index 1111111..2222222 100644
--- a/.env
+++ b/.env
@@ -1 +1 @@
-OPENAI_API_KEY=sk-old-secret
+OPENAI_API_KEY=sk-live-secret
diff --git a/id_rsa b/id_rsa
index 3333333..4444444 100644
--- a/id_rsa
+++ b/id_rsa
@@ -1 +1 @@
-old ssh key material
+ssh key material
diff --git a/src/app.ts b/src/app.ts
index 5555555..6666666 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`);
    expect(summary.files.map(({ path }) => path)).toEqual(["src/app.ts"]);
    expect(summary.excluded.map(({ path, reason }) => [path, reason])).toEqual([
      [".env", "credentials"],
      ["id_rsa", "private key"],
    ]);
    expect(summary.filteredDiff).not.toContain("sk-live-secret");
    expect(summary.filteredDiff).not.toContain("ssh key material");
    expect(summary.filteredDiff).toContain("value = 2");
  });

  test("excludes rename chunks when either side is credential-like", () => {
    const summary = parseDiff(`diff --git a/.env b/src/config.ts
similarity index 48%
rename from .env
rename to src/config.ts
--- a/.env
+++ b/src/config.ts
@@ -1,2 +1,2 @@
-OPENAI_API_KEY=sk-old-secret
+OPENAI_API_KEY=sk-renamed-secret
 KEEP=1
`);
    expect(summary.files).toEqual([]);
    expect(summary.excluded).toMatchObject([
      { path: ".env -> src/config.ts", reason: "credentials" },
    ]);
    expect(summary.filteredDiff).not.toContain("sk-renamed-secret");
  });

  test("excludes renames into a credential path", () => {
    const summary = parseDiff(`diff --git a/src/config.ts b/.env
similarity index 90%
rename from src/config.ts
rename to .env
--- a/src/config.ts
+++ b/.env
@@ -1,2 +1,2 @@
-OPENAI_API_KEY=placeholder
+OPENAI_API_KEY=sk-renamed-secret
`);
    expect(summary.files).toEqual([]);
    expect(summary.excluded).toMatchObject([
      { path: "src/config.ts -> .env", reason: "credentials" },
    ]);
    expect(summary.filteredDiff).not.toContain("sk-renamed-secret");
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
