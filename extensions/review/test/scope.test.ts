import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  captureReviewScope,
  emptyTreeOid,
  GitCommandError,
  recaptureReviewScope,
  resolveRepos,
  runGit,
  sanitizeLabel,
} from "../src/scope.ts";

const tempDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function createRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "piex-review-test-"));
  tempDirs.push(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Review Test"]);
  git(repo, ["config", "user.email", "review@example.invalid"]);
  fs.writeFileSync(path.join(repo, "app.ts"), "export const value = 1;\n");
  git(repo, ["add", "app.ts"]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true });
});

describe("captureReviewScope", () => {
  test("uses one coherent HEAD-to-worktree diff and includes untracked files", () => {
    const repo = createRepo();
    fs.writeFileSync(
      path.join(repo, "app.ts"),
      "export const value = 2;\nexport const staged = true;\n",
    );
    git(repo, ["add", "app.ts"]);
    fs.appendFileSync(
      path.join(repo, "app.ts"),
      "export const unstaged = true;\n",
    );
    fs.writeFileSync(path.join(repo, "new.ts"), "export const fresh = true;\n");

    const scope = captureReviewScope(repo, [repo], { kind: "working-tree" });
    const summary = scope.repos[0].summary;
    expect(summary.files.map(({ path: file }) => file).sort()).toEqual([
      "app.ts",
      "new.ts",
    ]);
    expect(summary.filteredDiff.match(/diff --git a\/app\.ts/g)?.length).toBe(
      1,
    );
    expect(summary.filteredDiff).toContain("staged = true");
    expect(summary.filteredDiff).toContain("unstaged = true");
    expect(summary.filteredDiff).toContain("fresh = true");
  });

  test("auto scope covers committed branch work and dirty fixes", () => {
    const repo = createRepo();
    git(repo, ["checkout", "-b", "feature"]);
    fs.writeFileSync(path.join(repo, "app.ts"), "export const value = 2;\n");
    git(repo, ["add", "app.ts"]);
    git(repo, ["commit", "-m", "feature change"]);
    fs.appendFileSync(
      path.join(repo, "app.ts"),
      "export const dirty = true;\n",
    );

    const scope = captureReviewScope(repo, [repo]);
    expect(scope.repos[0].mode).toBe("Current changes vs main");
    expect(scope.repos[0].summary.filteredDiff).toContain("value = 2");
    expect(scope.repos[0].summary.filteredDiff).toContain("dirty = true");
  });

  test("auto scope keeps staged index content when worktree reverts it", () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "app.ts"), "export const value = 2;\n");
    git(repo, ["add", "app.ts"]);
    // Revert the staged edit in the working tree: the index still holds the
    // pending commit content that `git diff <base>` no longer shows.
    fs.writeFileSync(path.join(repo, "app.ts"), "export const value = 1;\n");

    const scope = captureReviewScope(repo, [repo]);
    expect(scope.repos[0].summary.filteredDiff).toContain("value = 2");
  });

  test("auto scope combines staged and unstaged changes on one file once", () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "app.ts"), "export const value = 2;\n");
    git(repo, ["add", "app.ts"]);
    fs.appendFileSync(
      path.join(repo, "app.ts"),
      "export const unstaged = true;\n",
    );

    const scope = captureReviewScope(repo, [repo]);
    const summary = scope.repos[0].summary;
    expect(summary.files.map(({ path: file }) => file)).toEqual(["app.ts"]);
    expect(summary.filteredDiff.match(/diff --git a\/app\.ts/g)?.length).toBe(
      1,
    );
    expect(summary.filteredDiff).toContain("value = 2");
    expect(summary.filteredDiff).toContain("unstaged = true");
  });

  test("never sends untracked credential files to the reviewer", () => {
    const repo = createRepo();
    fs.writeFileSync(
      path.join(repo, ".env"),
      "OPENAI_API_KEY=sk-live-secret\n",
    );
    fs.writeFileSync(
      path.join(repo, "service-account.json"),
      '{"token": "secret"}\n',
    );
    fs.writeFileSync(path.join(repo, "private.pem"), "-----BEGIN KEY-----\n");
    fs.writeFileSync(path.join(repo, "id_rsa"), "ssh key material\n");
    fs.writeFileSync(path.join(repo, "legit.ts"), "export const fresh = 1;\n");

    const scope = captureReviewScope(repo, [repo]);
    const summary = scope.repos[0].summary;
    expect(summary.filteredDiff).not.toContain("sk-live-secret");
    expect(summary.filteredDiff).not.toContain("BEGIN KEY");
    expect(summary.filteredDiff).not.toContain("ssh key material");
    expect(summary.filteredDiff).toContain("fresh = 1");
    expect(summary.excluded.map(({ path }) => path).sort()).toEqual([
      ".env",
      "id_rsa",
      "private.pem",
      "service-account.json",
    ]);
  });

  test("rejects blank repository entries instead of falling back to cwd", () => {
    const repo = createRepo();
    const result = resolveRepos(repo, [""]);
    expect(result.ok).toBeFalse();
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain("blank");
    }
  });

  test("changes the diff hash when the worktree changes", () => {
    const repo = createRepo();
    fs.appendFileSync(path.join(repo, "app.ts"), "export const a = 1;\n");
    const first = captureReviewScope(repo, [repo]);
    fs.appendFileSync(path.join(repo, "app.ts"), "export const b = 2;\n");
    const second = captureReviewScope(repo, [repo]);
    expect(second.scopeKey).toBe(first.scopeKey);
    expect(second.diffHash).not.toBe(first.diffHash);
  });

  test("detects worktree changes made after a scope was frozen", () => {
    const repo = createRepo();
    fs.appendFileSync(path.join(repo, "app.ts"), "export const a = 1;\n");
    const frozen = captureReviewScope(repo, [repo]);
    fs.appendFileSync(path.join(repo, "app.ts"), "export const b = 2;\n");
    expect(recaptureReviewScope(frozen).diffHash).not.toBe(frozen.diffHash);
  });

  test("keeps file reviews in separate re-review histories", () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "other.ts"), "export const other = 1;\n");
    git(repo, ["add", "other.ts"]);
    git(repo, ["commit", "-m", "add other"]);
    fs.appendFileSync(path.join(repo, "app.ts"), "export const a = 1;\n");
    fs.appendFileSync(path.join(repo, "other.ts"), "export const b = 2;\n");

    const app = captureReviewScope(repo, [repo], {
      kind: "file",
      file: "app.ts",
    });
    const other = captureReviewScope(repo, [repo], {
      kind: "file",
      file: "other.ts",
    });
    expect(app.scopeKey).not.toBe(other.scopeKey);
  });

  test("keeps sibling commits in separate review histories", () => {
    const repo = createRepo();
    const parent = git(repo, ["rev-parse", "HEAD"]).trim();
    const tree = git(repo, ["rev-parse", "HEAD^{tree}"]).trim();
    const firstCommit = git(repo, [
      "commit-tree",
      tree,
      "-p",
      parent,
      "-m",
      "first sibling",
    ]).trim();
    const secondCommit = git(repo, [
      "commit-tree",
      tree,
      "-p",
      parent,
      "-m",
      "second sibling",
    ]).trim();

    const first = captureReviewScope(repo, [repo], {
      kind: "commit",
      commit: firstCommit,
    });
    const second = captureReviewScope(repo, [repo], {
      kind: "commit",
      commit: secondCommit,
    });
    expect(first.diffHash).toBe(second.diffHash);
    expect(first.scopeKey).not.toBe(second.scopeKey);
  });

  test("keeps branches sharing a merge base in separate re-review histories", () => {
    const repo = createRepo();
    git(repo, ["checkout", "-b", "feature-a"]);
    fs.writeFileSync(path.join(repo, "app.ts"), "export const value = 2;\n");
    git(repo, ["add", "app.ts"]);
    git(repo, ["commit", "-m", "feature a"]);
    const featureA = captureReviewScope(repo, [repo]);

    git(repo, ["checkout", "-b", "feature-b", "main"]);
    fs.writeFileSync(path.join(repo, "app.ts"), "export const value = 3;\n");
    git(repo, ["add", "app.ts"]);
    git(repo, ["commit", "-m", "feature b"]);
    const featureB = captureReviewScope(repo, [repo]);

    expect(featureA.repos[0].baseOid).toBe(featureB.repos[0].baseOid);
    expect(featureA.scopeKey).not.toBe(featureB.scopeKey);
  });

  test("reviews staged files in a repository without commits", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "piex-review-test-"));
    tempDirs.push(repo);
    git(repo, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(repo, "app.ts"), "export const fresh = 1;\n");
    git(repo, ["add", "app.ts"]);

    const scope = captureReviewScope(repo, [repo], { kind: "working-tree" });
    expect(scope.repos[0].summary.filteredDiff).toContain(
      "export const fresh = 1;",
    );
  });

  test("derives the empty tree from the repository hash format", () => {
    const repo = createRepo();
    expect(emptyTreeOid(repo)).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");

    const sha256Repo = fs.mkdtempSync(
      path.join(os.tmpdir(), "piex-review-test-"),
    );
    tempDirs.push(sha256Repo);
    try {
      git(sha256Repo, ["init", "--object-format=sha256", "-b", "main"]);
    } catch {
      return; // Git without sha256 object support; identity only matters for sha1.
    }
    git(sha256Repo, ["config", "user.name", "Review Test"]);
    git(sha256Repo, ["config", "user.email", "review@example.invalid"]);
    fs.writeFileSync(path.join(sha256Repo, "app.ts"), "export const v = 1;\n");
    git(sha256Repo, ["add", "app.ts"]);
    git(sha256Repo, ["commit", "-m", "initial"]);
    const rootCommit = git(sha256Repo, ["rev-parse", "HEAD"]).trim();

    const scope = captureReviewScope(sha256Repo, [sha256Repo], {
      kind: "commit",
      commit: rootCommit,
    });
    const sha256Empty = emptyTreeOid(sha256Repo);
    expect(sha256Empty).not.toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    expect(scope.repos[0].baseOid).toBe(sha256Empty);
    expect(scope.repos[0].summary.filteredDiff).toContain(
      "export const v = 1;",
    );
  });

  test("captures a merge commit relative to its first parent", () => {
    const repo = createRepo();
    git(repo, ["checkout", "-b", "feature"]);
    fs.writeFileSync(
      path.join(repo, "feature.ts"),
      "export const feature = true;\n",
    );
    git(repo, ["add", "feature.ts"]);
    git(repo, ["commit", "-m", "add feature"]);

    git(repo, ["checkout", "main"]);
    fs.writeFileSync(path.join(repo, "main.ts"), "export const main = true;\n");
    git(repo, ["add", "main.ts"]);
    git(repo, ["commit", "-m", "advance main"]);
    const firstParent = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["merge", "--no-ff", "feature", "-m", "merge feature"]);
    const mergeCommit = git(repo, ["rev-parse", "HEAD"]).trim();

    const scope = captureReviewScope(repo, [repo], {
      kind: "commit",
      commit: mergeCommit,
    });
    expect(scope.repos[0].baseOid).toBe(firstParent);
    expect(scope.repos[0].headOid).toBe(mergeCommit);
    expect(scope.repos[0].summary.files.map(({ path: file }) => file)).toEqual([
      "feature.ts",
    ]);
    expect(scope.repos[0].summary.filteredDiff).toContain(
      "export const feature = true",
    );
  });
});

describe("runGit", () => {
  test("preserves command failures instead of returning an empty diff", () => {
    const repo = createRepo();
    expect(() => runGit(repo, ["show", "missing-review-ref"])).toThrow(
      GitCommandError,
    );
  });
});

describe("sanitizeLabel", () => {
  test("strips terminal escapes, control characters, and line breaks", () => {
    expect(sanitizeLabel("repo\u001b[31mred\u001b[0m")).toBe("repo red");
    expect(sanitizeLabel("a\u0000b\u0007c")).toBe("a b c");
    expect(sanitizeLabel("line1\nline2")).toBe("line1 line2");
    expect(sanitizeLabel("\u001b]0;evil\u0007title")).toBe("title");
  });

  test("applies to repo labels used in UI and transcripts", () => {
    const repo = createRepo();
    // A hostile directory name must never reach the scope menu or the
    // transcript header with its control bytes intact.
    const hostile = fs.mkdirSync(path.join(repo, "evil\u001b[31mrepo"), {
      recursive: true,
    });
    if (!hostile) return;
    const scope = captureReviewScope(repo, [hostile]);
    expect(scope.repos[0].label).toBe("evil repo");
    expect(scope.repos[0].label).not.toContain("\u001b");
  });
});

describe("literalRepoPath", () => {
  test("treats the requested file as a literal path", () => {
    const repo = createRepo();
    fs.writeFileSync(
      path.join(repo, "a*b.ts"),
      "export const globbed = true;\n",
    );
    fs.writeFileSync(path.join(repo, "axb.ts"), "export const other = true;\n");
    git(repo, ["add", "a*b.ts", "axb.ts"]);
    git(repo, ["commit", "-m", "add literal files"]);
    fs.appendFileSync(
      path.join(repo, "a*b.ts"),
      "export const changed = true;\n",
    );
    fs.appendFileSync(
      path.join(repo, "axb.ts"),
      "export const touched = true;\n",
    );

    const scope = captureReviewScope(repo, [repo], {
      kind: "file",
      file: "a*b.ts",
    });
    const files = scope.repos[0].summary.files.map(({ path: file }) => file);
    expect(files).toEqual(["a*b.ts"]);
    expect(scope.repos[0].summary.filteredDiff).toContain("changed = true");
    expect(scope.repos[0].summary.filteredDiff).not.toContain("touched = true");
  });

  test("rejects paths that escape the repository", () => {
    const repo = createRepo();
    expect(() =>
      captureReviewScope(repo, [repo], {
        kind: "file",
        file: "../outside.ts",
      }),
    ).toThrow(/outside the repository/);
    // A pathspec-magic prefix must not widen the review either.
    expect(() =>
      captureReviewScope(repo, [repo], {
        kind: "file",
        file: ":(exclude)*",
      }),
    ).not.toThrow();
  });
});
