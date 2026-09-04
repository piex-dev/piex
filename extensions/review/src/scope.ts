import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { devNull } from "node:os";
import * as path from "node:path";
import { hashText, parseDiff } from "./diff.js";
import type {
  CaptureScopeRequest,
  ExcludedFileDiff,
  RepoReviewSnapshot,
  ReviewScope,
  ReviewScopeKind,
} from "./types.js";

export type { CaptureScopeRequest } from "./types.js";

const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const DEFAULT_BRANCH_NAMES = ["main", "master", "trunk"];

/**
 * Empty tree OID for the repository's object format (sha1 or sha256).
 * Derives the value so root commits and unborn branches review correctly in
 * repositories that use a non-default hash algorithm.
 */
export function emptyTreeOid(repo: string): string {
  try {
    return runGit(
      repo,
      ["hash-object", "-t", "tree", "--stdin"],
      [0],
      "",
    ).trim();
  } catch {
    return EMPTY_TREE_OID;
  }
}

export class GitCommandError extends Error {
  constructor(
    readonly cwd: string,
    readonly args: string[],
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    const detail = stderr.trim() || `exit code ${exitCode ?? "unknown"}`;
    super(`git ${args.join(" ")} failed: ${detail}`);
    this.name = "GitCommandError";
  }
}

export function runGit(
  cwd: string,
  args: string[],
  allowedExitCodes: readonly number[] = [0],
  input?: string,
): string {
  const result = spawnSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    ...(input === undefined ? {} : { input }),
  });
  if (result.error) {
    throw new GitCommandError(cwd, args, result.error.message, result.status);
  }
  if (!allowedExitCodes.includes(result.status ?? -1)) {
    throw new GitCommandError(cwd, args, result.stderr ?? "", result.status);
  }
  return result.stdout ?? "";
}

function tryGit(cwd: string, args: string[]): string | undefined {
  try {
    return runGit(cwd, args).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function parseRepoArgs(args: string): string[] {
  const value = args.trim();
  if (!value) return [];

  const tokens: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /\s/.test(value[index])) index++;
    if (index >= value.length) break;

    const start = index;
    if (value[index] === "@") index++;
    const open = value[index];
    const close =
      open === '"'
        ? '"'
        : open === "'"
          ? "'"
          : open === "\u201c"
            ? "\u201d"
            : open === "\u2018"
              ? "\u2019"
              : undefined;

    if (close) {
      const end = value.indexOf(close, index + 1);
      if (end === -1) {
        tokens.push(value.slice(start));
        break;
      }
      tokens.push(value.slice(start, end + 1));
      index = end + 1;
      continue;
    }

    const rest = value.slice(index).match(/^\S+/);
    if (!rest) break;
    tokens.push(value.slice(start, index + rest[0].length));
    index += rest[0].length;
  }
  return tokens;
}

export function takeFirstPathArg(args: string): string | undefined {
  return parseRepoArgs(args)[0];
}

export function normalizeRepoArg(raw?: string): string | undefined {
  if (raw == null) return undefined;
  let value = raw.trim();
  if (!value) return undefined;
  value = value.replace(/^@+/, "");

  const pairs: [string, string][] = [
    ['"', '"'],
    ["'", "'"],
    ["\u201c", "\u201d"],
    ["\u2018", "\u2019"],
  ];
  for (const [open, close] of pairs) {
    if (!value.startsWith(open)) continue;
    const balanced = value.endsWith(close) && value.length >= 2;
    value = balanced ? value.slice(1, -1) : value.slice(1);
    break;
  }

  value = value.replace(/^@+/, "").trim();
  return value || undefined;
}

export function resolveRepo(
  cwd: string,
  repo?: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const input = normalizeRepoArg(repo);
  const target = input ? path.resolve(cwd, input) : cwd;
  if (!fs.existsSync(target)) {
    return {
      ok: false,
      error: `Path does not exist: ${input ?? cwd}${input ? ` (resolved to ${target})` : ""}`,
    };
  }

  const topLevel = tryGit(target, ["rev-parse", "--show-toplevel"]);
  if (!topLevel) {
    return {
      ok: false,
      error: input
        ? `Not a git repository: ${input} (resolved to ${target})`
        : `Not a git repository: ${cwd}`,
    };
  }
  return { ok: true, path: topLevel };
}

export function resolveRepos(
  cwd: string,
  rawArgs: string[],
): { ok: true; repos: string[] } | { ok: false; errors: string[] } {
  const repos: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawArgs) {
    const input = normalizeRepoArg(raw);
    if (!input) {
      errors.push("Repository entry must not be blank.");
      continue;
    }
    const resolved = resolveRepo(cwd, input);
    if (!resolved.ok) {
      errors.push(resolved.error);
      continue;
    }
    if (!seen.has(resolved.path)) {
      seen.add(resolved.path);
      repos.push(resolved.path);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, repos };
}

export function shortRepo(repo: string, cwd: string): string {
  const relative = path.relative(cwd, repo);
  if (!relative) return path.basename(repo);
  return !relative.startsWith("..") ? relative : repo;
}

interface ResolvedRef {
  name: string;
  ref: string;
  oid: string;
}

function resolveCommitRef(repo: string, ref: string): ResolvedRef | undefined {
  const oid = tryGit(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
  return oid
    ? { name: ref.replace(/^refs\/(?:heads|remotes\/origin)\//, ""), ref, oid }
    : undefined;
}

export function resolveDefaultBase(repo: string): ResolvedRef | undefined {
  const remoteHead = tryGit(repo, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (remoteHead) {
    const resolved = resolveCommitRef(repo, remoteHead);
    if (resolved)
      return { ...resolved, name: remoteHead.replace(/^origin\//, "") };
  }

  const configured = tryGit(repo, ["config", "--get", "init.defaultBranch"]);
  const candidates = [
    ...new Set([configured, ...DEFAULT_BRANCH_NAMES].filter(Boolean)),
  ] as string[];
  for (const name of candidates) {
    const remote = resolveCommitRef(repo, `refs/remotes/origin/${name}`);
    if (remote) return { ...remote, name };
    const local = resolveCommitRef(repo, `refs/heads/${name}`);
    if (local) return { ...local, name };
  }
  return undefined;
}

function getHeadOid(repo: string): string | undefined {
  return tryGit(repo, ["rev-parse", "--verify", "HEAD^{commit}"]);
}

/** Full symbolic ref naming the checked-out branch, if any. */
function getHeadRef(repo: string): string | undefined {
  return tryGit(repo, ["symbolic-ref", "--quiet", "HEAD"]);
}

function listUntracked(repo: string): string[] {
  const output = runGit(repo, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  return output.split("\0").filter(Boolean);
}

/**
 * Untracked files that look like credentials. Their content must never reach
 * a reviewer provider, even though they are unignored (and therefore part of
 * "all current work"). Excluding them beats redacting: no secret bytes are
 * ever read into the diff sent to the model.
 */
const CREDENTIAL_FILE_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /(?:^|\/)\.env(?:\..+)?$/, reason: "credentials" },
  {
    pattern: /(?:^|\/)\.(?:npmrc|pypirc|netrc|gemrc|yarnrc\.yml)$/,
    reason: "credentials",
  },
  { pattern: /(?:^|\/)\.docker\/config\.json$/, reason: "credentials" },
  {
    pattern: /(?:^|\/)\.(?:token|secret|password)$/,
    reason: "credentials",
  },
  {
    pattern:
      /(?:^|\/)[^/]*(?:credential|secret|token|password|passwd|service[-_]?account|api[-_]?key)[^/]*\.(?:json|ya?ml|toml|env|txt|csv)$/i,
    reason: "credentials",
  },
  { pattern: /\.(?:pem|p12|pfx|ppk|key)$/i, reason: "private key" },
  {
    pattern: /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/,
    reason: "private key",
  },
];

function untrackedCredentialReason(file: string): string | undefined {
  return CREDENTIAL_FILE_PATTERNS.find(({ pattern }) => pattern.test(file))
    ?.reason;
}

interface UntrackedDiffResult {
  chunks: string;
  excluded: ExcludedFileDiff[];
}

function appendUntrackedDiff(
  repo: string,
  trackedDiff: string,
  onlyFile?: string,
): UntrackedDiffResult {
  const normalizedOnly = onlyFile
    ? path.relative(repo, path.resolve(repo, onlyFile))
    : undefined;
  const chunks = [trackedDiff.trimEnd()].filter(Boolean);
  const excluded: ExcludedFileDiff[] = [];
  for (const file of listUntracked(repo)) {
    if (normalizedOnly && file !== normalizedOnly) continue;
    const reason = untrackedCredentialReason(file);
    if (reason) {
      excluded.push({ path: file, reason, linesAdded: 0, linesRemoved: 0 });
      continue;
    }
    const chunk = runGit(
      repo,
      ["diff", "--no-index", "--unified=3", "--", devNull, file],
      [0, 1],
    );
    if (chunk.trim()) chunks.push(chunk.trimEnd());
  }
  return { chunks: chunks.join("\n"), excluded };
}

function applyUntrackedExclusions(
  snapshot: RepoReviewSnapshot,
  untracked: UntrackedDiffResult,
): RepoReviewSnapshot {
  snapshot.summary.excluded.push(...untracked.excluded);
  return snapshot;
}

function makeSnapshot(
  cwd: string,
  repo: string,
  kind: ReviewScopeKind,
  mode: string,
  baseOid: string,
  headOid: string,
  diff: string,
  baseRef?: string,
): RepoReviewSnapshot {
  return {
    repo,
    label: shortRepo(repo, cwd),
    kind,
    mode,
    baseRef,
    baseOid,
    headOid,
    summary: parseDiff(diff),
  };
}

function diffFileNames(
  repo: string,
  baseOid: string,
  cached: boolean,
): Set<string> {
  const output = runGit(repo, [
    "diff",
    ...(cached ? ["--cached"] : []),
    "--name-only",
    "-z",
    baseOid,
    "--",
  ]);
  return new Set(output.split("\0").filter(Boolean));
}

/**
 * Combine the base-to-worktree diff with index content the worktree endpoint
 * hides. `git diff <base>` compares base to the working tree, so a staged
 * edit later reverted in the worktree (partial staging, unstaged fix/revert)
 * disappears from it even though `git commit` would commit the index version.
 * Append the `--cached` chunks for every file absent from the worktree diff;
 * files already present carry the complete final content with worktree-relative
 * line numbers, so their staged hunks need no separate appearance.
 */
function captureWithIndexSnapshot(
  repo: string,
  baseOid: string,
  tracked: string,
): string {
  const trackedFiles = diffFileNames(repo, baseOid, false);
  const stagedFiles = diffFileNames(repo, baseOid, true);
  const missing = [...stagedFiles].filter((file) => !trackedFiles.has(file));
  if (missing.length === 0) return tracked;
  const chunks = [tracked.trimEnd()];
  for (const file of missing) {
    const chunk = runGit(repo, [
      "diff",
      "--cached",
      "--find-renames",
      "--unified=3",
      baseOid,
      "--",
      file,
    ]).trimEnd();
    if (chunk) chunks.push(chunk);
  }
  return chunks.join("\n");
}

function captureWorkingTree(cwd: string, repo: string): RepoReviewSnapshot {
  const headOid = getHeadOid(repo) ?? emptyTreeOid(repo);
  const tracked = captureWithIndexSnapshot(
    repo,
    headOid,
    runGit(repo, ["diff", "--find-renames", "--unified=3", headOid, "--"]),
  );
  const untracked = appendUntrackedDiff(repo, tracked);
  return applyUntrackedExclusions(
    makeSnapshot(
      cwd,
      repo,
      "working-tree",
      "Current working tree",
      headOid,
      headOid,
      untracked.chunks,
    ),
    untracked,
  );
}

function captureAuto(cwd: string, repo: string): RepoReviewSnapshot {
  const headOid = getHeadOid(repo);
  const base = resolveDefaultBase(repo);
  if (!base || !headOid) return captureWorkingTree(cwd, repo);

  const mergeBase = runGit(repo, ["merge-base", base.oid, headOid]).trim();
  if (!mergeBase) {
    throw new Error(`No common history between HEAD and ${base.name}`);
  }
  const tracked = captureWithIndexSnapshot(
    repo,
    mergeBase,
    runGit(repo, ["diff", "--find-renames", "--unified=3", mergeBase, "--"]),
  );
  const untracked = appendUntrackedDiff(repo, tracked);
  return applyUntrackedExclusions(
    makeSnapshot(
      cwd,
      repo,
      "auto",
      `Current changes vs ${base.name}`,
      mergeBase,
      headOid,
      untracked.chunks,
      base.ref,
    ),
    untracked,
  );
}

function captureStaged(cwd: string, repo: string): RepoReviewSnapshot {
  const headOid = getHeadOid(repo) ?? emptyTreeOid(repo);
  const diff = runGit(repo, [
    "diff",
    "--cached",
    "--find-renames",
    "--unified=3",
    headOid,
    "--",
  ]);
  return makeSnapshot(
    cwd,
    repo,
    "staged",
    "Staged changes",
    headOid,
    headOid,
    diff,
  );
}

function captureCommit(
  cwd: string,
  repo: string,
  commit: string,
): RepoReviewSnapshot {
  const headOid = runGit(repo, [
    "rev-parse",
    "--verify",
    `${commit}^{commit}`,
  ]).trim();
  const baseOid =
    tryGit(repo, ["rev-parse", "--verify", `${headOid}^1`]) ??
    emptyTreeOid(repo);
  const diff = runGit(repo, [
    "diff",
    "--find-renames",
    "--unified=3",
    baseOid,
    headOid,
    "--",
  ]);
  return makeSnapshot(
    cwd,
    repo,
    "commit",
    `Commit ${headOid.slice(0, 8)}`,
    baseOid,
    headOid,
    diff,
  );
}

function resolveRequestedBase(repo: string, base: string): ResolvedRef {
  const candidates = [
    base,
    `refs/remotes/origin/${base}`,
    `refs/heads/${base}`,
  ];
  for (const candidate of candidates) {
    const resolved = resolveCommitRef(repo, candidate);
    if (resolved) return { ...resolved, name: base };
  }
  throw new Error(`Base branch or commit not found: ${base}`);
}

function captureBranch(
  cwd: string,
  repo: string,
  base: string,
): RepoReviewSnapshot {
  const headOid = getHeadOid(repo) ?? emptyTreeOid(repo);
  const resolved = resolveRequestedBase(repo, base);
  const mergeBase = runGit(repo, ["merge-base", resolved.oid, headOid]).trim();
  if (!mergeBase) throw new Error(`No common history between HEAD and ${base}`);
  const tracked = captureWithIndexSnapshot(
    repo,
    mergeBase,
    runGit(repo, ["diff", "--find-renames", "--unified=3", mergeBase, "--"]),
  );
  const untracked = appendUntrackedDiff(repo, tracked);
  return applyUntrackedExclusions(
    makeSnapshot(
      cwd,
      repo,
      "branch",
      `Current changes vs ${base}`,
      mergeBase,
      headOid,
      untracked.chunks,
      resolved.ref,
    ),
    untracked,
  );
}

function captureFile(
  cwd: string,
  repo: string,
  file: string,
): RepoReviewSnapshot {
  const headOid = getHeadOid(repo) ?? emptyTreeOid(repo);
  const tracked = captureWithIndexSnapshot(
    repo,
    headOid,
    runGit(repo, [
      "diff",
      "--find-renames",
      "--unified=3",
      headOid,
      "--",
      file,
    ]),
  );
  const untracked = appendUntrackedDiff(repo, tracked, file);
  return applyUntrackedExclusions(
    makeSnapshot(
      cwd,
      repo,
      "file",
      `File ${file}`,
      headOid,
      headOid,
      untracked.chunks,
    ),
    untracked,
  );
}

export function captureReviewScope(
  cwd: string,
  repos: readonly string[],
  request: CaptureScopeRequest = {},
): ReviewScope {
  const kind = request.kind ?? "auto";
  const snapshots = repos.map((repo) => {
    switch (kind) {
      case "auto":
        return captureAuto(cwd, repo);
      case "working-tree":
        return captureWorkingTree(cwd, repo);
      case "staged":
        return captureStaged(cwd, repo);
      case "branch":
        if (!request.base)
          throw new Error("'base' is required for branch review");
        return captureBranch(cwd, repo, request.base);
      case "commit":
        if (repos.length !== 1)
          throw new Error("Commit review supports exactly one repository");
        if (!request.commit)
          throw new Error("'commit' is required for commit review");
        return captureCommit(cwd, repo, request.commit);
      case "file":
        if (repos.length !== 1)
          throw new Error("File review supports exactly one repository");
        if (!request.file)
          throw new Error("'file' is required for file review");
        return captureFile(cwd, repo, request.file);
    }
  });

  const scopeIdentity = snapshots.map(
    ({ repo, kind: snapshotKind, baseOid, baseRef, headOid }) => {
      const headRef = snapshotKind === "commit" ? undefined : getHeadRef(repo);
      return {
        repo,
        kind: snapshotKind,
        baseOid,
        baseRef,
        // Auto/branch reviews keep the same identity while the patch
        // evolves, but never across branches or detached heads: the
        // symbolic ref separates branches, the commit OID separates
        // detached work. A commit review must never share history with
        // another commit that happens to have the same parent.
        headRef,
        headOid:
          snapshotKind === "commit" || headRef === undefined
            ? headOid
            : undefined,
      };
    },
  );
  const diffIdentity = snapshots.map(({ repo, summary }) => ({
    repo,
    diff: summary.filteredDiff,
  }));
  return {
    kind,
    repos: snapshots,
    scopeKey: hashText(
      JSON.stringify({
        scopeIdentity,
        file: kind === "file" ? request.file : undefined,
        instructions: request.instructions ?? "",
      }),
    ),
    diffHash: hashText(JSON.stringify(diffIdentity)),
    instructions: request.instructions,
    capture: {
      cwd,
      request: {
        kind,
        base: request.base,
        commit: request.commit,
        file: request.file,
        instructions: request.instructions,
      },
    },
  };
}

export function recaptureReviewScope(scope: ReviewScope): ReviewScope {
  return captureReviewScope(
    scope.capture.cwd,
    scope.repos.map(({ repo }) => repo),
    scope.capture.request,
  );
}

export function canCompareToBase(repo: string, base: string): boolean {
  try {
    resolveRequestedBase(repo, base);
    return true;
  } catch {
    return false;
  }
}

export const __test__ = {
  appendUntrackedDiff,
  getHeadOid,
  listUntracked,
  resolveRequestedBase,
  tryGit,
};
