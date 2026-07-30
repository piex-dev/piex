/**
 * review extension — code review via /review command and review tool.
 *
 *   pi install npm:@piex-dev/review
 *   pi -e ./extensions/review.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ══════════════════════════════════════════════════════════════════════════
// Noise file filtering
// ══════════════════════════════════════════════════════════════════════════

const EXCLUDED_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\.lock$/, reason: "lock file" },
  { pattern: /package-lock\.json$/, reason: "lock file" },
  { pattern: /yarn\.lock$/, reason: "lock file" },
  { pattern: /pnpm-lock\.yaml$/, reason: "lock file" },
  { pattern: /Cargo\.lock$/, reason: "lock file" },
  { pattern: /Gemfile\.lock$/, reason: "lock file" },
  { pattern: /\.min\.(js|css)$/, reason: "minified" },
  { pattern: /\.generated\./, reason: "generated" },
  { pattern: /\.snap$/, reason: "snapshot" },
  { pattern: /\.map$/, reason: "source map" },
  { pattern: /^dist\//, reason: "build output" },
  { pattern: /^build\//, reason: "build output" },
  { pattern: /^out\//, reason: "build output" },
  { pattern: /node_modules\//, reason: "vendor" },
  { pattern: /vendor\//, reason: "vendor" },
  { pattern: /\.(png|jpg|jpeg|gif|ico|webp|avif|svg)$/i, reason: "image" },
  { pattern: /\.(woff|woff2|ttf|eot|otf)$/i, reason: "font" },
  { pattern: /\.(pdf|zip|tar|gz|rar|7z)$/i, reason: "binary" },
];

function isExcluded(fp: string): string | undefined {
  for (const { pattern, reason } of EXCLUDED_PATTERNS) {
    if (pattern.test(fp)) return reason;
  }
  return undefined;
}

// ══════════════════════════════════════════════════════════════════════════
// Diff parsing
// ══════════════════════════════════════════════════════════════════════════

interface FileDiff {
  path: string;
  linesAdded: number;
  linesRemoved: number;
  ext: string;
}

interface DiffSummary {
  files: FileDiff[];
  excluded: {
    path: string;
    reason: string;
    linesAdded: number;
    linesRemoved: number;
  }[];
  totalAdded: number;
  totalRemoved: number;
  rawDiff: string;
}

/**
 * Per-repository result for a linked multi-repo review.
 *
 * `summary` is the parsed diff, or `null` when the repo has no changes OR the
 * comparison could not run. `error` distinguishes the failure case: set when
 * the diff could not be computed (e.g. the base ref is unfetchable in a
 * "vs default branch" review), so the prompt can flag the repo as *unverified*
 * instead of falsely reporting "no changes".
 */
interface RepoReviewResult {
  repo: string;
  summary: DiffSummary | null;
  error?: string;
}

function parseDiff(raw: string): DiffSummary {
  const files: FileDiff[] = [];
  const excluded: DiffSummary["excluded"] = [];
  let totalAdded = 0;
  let totalRemoved = 0;

  const chunks = raw.split(/^diff --git /m).filter(Boolean);
  for (const chunk of chunks) {
    const headerMatch = chunk.match(/^a\/(.+?) b\/(.+?)(?:\n|$)/);
    if (!headerMatch) continue;
    const fp = headerMatch[2];
    let added = 0,
      removed = 0;
    for (const line of chunk.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }

    const reason = isExcluded(fp);
    const ext = path.extname(fp) || "(none)";
    if (reason) {
      excluded.push({
        path: fp,
        reason,
        linesAdded: added,
        linesRemoved: removed,
      });
    } else {
      files.push({ path: fp, linesAdded: added, linesRemoved: removed, ext });
      totalAdded += added;
      totalRemoved += removed;
    }
  }
  return { files, excluded, totalAdded, totalRemoved, rawDiff: raw };
}

// ══════════════════════════════════════════════════════════════════════════
// Git helpers
// ══════════════════════════════════════════════════════════════════════════

function git(cwd: string, args: string[]): string {
  try {
    // execFileSync bypasses the shell so LLM-supplied refs (base/commit/file)
    // are passed as literal argv — no shell interpolation.
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

function getDefaultBranch(cwd: string): string {
  const result = git(cwd, ["rev-parse", "--abbrev-ref", "origin/HEAD"]).trim();
  if (result) return result.replace(/^origin\//, "");
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim() || "main";
}

/**
 * Take the first path-like argument from a slash-command arg string.
 * Supports bare tokens, `@path`, and quoted forms used by pi autocomplete
 * (`@"path with spaces"`, `"path"`, `'path'`, and common curly quotes).
 */
/**
 * Tokenize a slash-command arg string into path-like tokens.
 *
 * Handles every form pi autocomplete / @-mention can produce, across one or
 * many tokens: bare (`piex oh-my-pi`), straight-quoted (`"piex" "oh-my-pi"`),
 * `@`-prefixed (`@piex @oh-my-pi`), `@"quoted"`, curly quotes, and any mix.
 * Each returned token keeps its leading `@` and quotes intact — normalization
 * (`normalizeRepoArg`) happens later in `resolveRepo`, exactly like the
 * single-arg path. Whitespace separates tokens; quotes may contain spaces.
 */
function parseRepoArgs(args: string): string[] {
  const s = args.trim();
  if (!s) return [];

  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    // Skip whitespace between tokens.
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;

    const start = i;
    // Optional leading @ (pi path-mention syntax).
    if (s[i] === "@") i++;

    const open = s[i];
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
      const end = s.indexOf(close, i + 1);
      // Include the leading @ (if any) and the closing quote when present;
      // an unbalanced opener swallows the rest of the string for that token.
      if (end === -1) {
        out.push(s.slice(start));
        i = s.length;
      } else {
        out.push(s.slice(start, end + 1));
        i = end + 1;
      }
      continue;
    }

    const rest = s.slice(i).match(/^\S+/);
    if (!rest) break;
    out.push(s.slice(start, i + rest[0].length));
    i += rest[0].length;
  }
  return out;
}

/**
 * Take the first path-like argument from a slash-command arg string.
 * Thin wrapper over {@link parseRepoArgs}; kept for backward compatibility
 * and single-arg callers. Supports bare tokens, `@path`, and quoted forms used
 * by pi autocomplete (`@"path with spaces"`, `"path"`, `'path'`, curly quotes).
 */
function takeFirstPathArg(args: string): string | undefined {
  return parseRepoArgs(args)[0];
}

/**
 * Normalize a repo path argument from `/review` or the review tool.
 *
 * pi path-mention / autocomplete may produce forms like `@piex/`, `@"piex"`,
 * or `"piex"`. Strip leading `@` and one matching quote layer so the path
 * resolves like a normal relative/absolute path.
 */
function normalizeRepoArg(raw?: string): string | undefined {
  if (raw == null) return undefined;
  let s = raw.trim();
  if (!s) return undefined;

  // pi path-mention syntax ("@piex/") enters command args verbatim.
  s = s.replace(/^@+/, "");

  // Autocomplete wraps paths that need quoting: @"piex" / "my repo".
  // Also accept curly quotes that some input methods insert.
  const pairs: [string, string][] = [
    ['"', '"'],
    ["'", "'"],
    ["\u201c", "\u201d"],
    ["\u2018", "\u2019"],
  ];
  for (const [open, close] of pairs) {
    if (s.startsWith(open)) {
      // Strip the opening quote always; strip the matching trailing close
      // quote too when balanced. Tolerates unbalanced forms (@"piex) so no
      // literal quote leaks into the resolved path or error message.
      const balanced =
        s.endsWith(close) && s.length >= open.length + close.length;
      s = balanced
        ? s.slice(open.length, s.length - close.length)
        : s.slice(open.length);
      break;
    }
  }

  // Handle quoted-then-@ forms like "@piex" after the outer quotes were stripped.
  s = s.replace(/^@+/, "").trim();
  return s || undefined;
}

/**
 * Resolve a git repository path.
 *
 * - With no `repo`, validates that `cwd` itself is a git repository.
 * - With `repo` (relative or absolute), resolves it against `cwd` and
 *   validates it is a git repository, returning the repository root.
 *
 * Returns `{ ok: true, path }` on success or `{ ok: false, error }` with a
 * user-facing message otherwise.
 */
function resolveRepo(
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
  const toplevel = git(target, ["rev-parse", "--show-toplevel"]).trim();
  if (!toplevel) {
    return {
      ok: false,
      error: input
        ? `Not a git repository: ${input} (resolved to ${target})`
        : `Not a git repository: ${cwd}`,
    };
  }
  return { ok: true, path: toplevel };
}

/** Display the repo path relative to cwd when it is inside cwd. */
function shortRepo(repo: string, cwd: string): string {
  const rel = path.relative(cwd, repo);
  return rel && !rel.startsWith("..") ? rel : repo;
}

/**
 * Resolve multiple git repository paths at once.
 *
 * Each raw token is normalized + validated via {@link resolveRepo}. Duplicate
 * roots (e.g. two subpaths of the same repo) collapse to one. Returns
 * `{ ok: true, repos }` only when every token resolves; otherwise returns
 * `{ ok: false, errors }` listing every failure so the caller can report all
 * bad paths at once instead of failing on the first.
 */
function resolveRepos(
  cwd: string,
  rawArgs: string[],
): { ok: true; repos: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const repos: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawArgs) {
    const r = resolveRepo(cwd, raw);
    if (!r.ok) {
      errors.push(r.error);
      continue;
    }
    if (!seen.has(r.path)) {
      seen.add(r.path);
      repos.push(r.path);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, repos };
}

// ══════════════════════════════════════════════════════════════════════════
// Review modes
// ══════════════════════════════════════════════════════════════════════════

async function reviewUncommitted(cwd: string): Promise<DiffSummary | null> {
  const diff = git(cwd, ["diff", "--unified=3"]);
  const staged = git(cwd, ["diff", "--cached", "--unified=3"]);
  const combined = [diff, staged].filter(Boolean).join("\n");
  if (!combined.trim()) return null;
  return parseDiff(combined);
}

async function reviewStaged(cwd: string): Promise<DiffSummary | null> {
  const diff = git(cwd, ["diff", "--cached", "--unified=3"]);
  if (!diff.trim()) return null;
  return parseDiff(diff);
}

/**
 * Whether the "vs default branch" comparison is possible for `repo`: does
 * `origin/${base}` resolve to a real ref? Uses `rev-parse --verify --quiet`
 * (empty via git()'s fail-soft path when the ref is missing — no remote,
 * branch never fetched, or a wrong default-branch name). Lets callers tell
 * "comparison failed" apart from "genuinely no changes".
 */
function canCompareToBase(repo: string, base: string): boolean {
  return (
    git(repo, ["rev-parse", "--verify", "--quiet", `origin/${base}`]).trim() !==
    ""
  );
}

async function reviewBaseBranch(cwd: string): Promise<DiffSummary | null> {
  const base = getDefaultBranch(cwd);
  git(cwd, ["fetch", "origin", base]);
  const diff = git(cwd, ["diff", `origin/${base}...HEAD`, "--unified=3"]);
  if (!diff.trim()) return null;
  return parseDiff(diff);
}

async function reviewCommit(
  cwd: string,
  sha: string,
): Promise<DiffSummary | null> {
  const diff = git(cwd, ["show", "--unified=3", sha]);
  if (!diff.trim()) return null;
  return parseDiff(diff);
}

// ══════════════════════════════════════════════════════════════════════════
// Review prompt template
// ══════════════════════════════════════════════════════════════════════════

function buildReviewPrompt(
  mode: string,
  summary: DiffSummary,
  instructions?: string,
  repo?: string,
): string {
  const { files, excluded, totalAdded, totalRemoved, rawDiff } = summary;
  const totalLines = totalAdded + totalRemoved;
  const skipDiff = rawDiff.length > 50_000 || files.length > 20;
  const repoLabel = repo ? ` — repo: ${repo}` : "";

  let prompt = `## Code Review — ${mode}${repoLabel}

### Summary
${files.length} files changed, +${totalAdded}/-${totalRemoved} lines (${totalLines} total)

`;

  if (repo) {
    prompt += `> File paths in the diff are relative to the repository root: \`${repo}\`\n\n`;
  }

  if (files.length > 0) {
    prompt += `### Changed Files\n\n`;
    prompt += `| File | +/− | Type |\n|------|-----|------|\n`;
    for (const f of files) {
      prompt += `| ${f.path} | +${f.linesAdded}/-${f.linesRemoved} | ${f.ext} |\n`;
    }
  }

  if (excluded.length > 0) {
    prompt += `\n### Excluded Files (${excluded.length})\n`;
    for (const e of excluded) {
      prompt += `- \`${e.path}\` (+${e.linesAdded}/-${e.linesRemoved}) — ${e.reason}\n`;
    }
  }

  if (instructions) {
    prompt += `\n### Custom Instructions\n${instructions}\n`;
  }

  if (skipDiff) {
    prompt += `\n### Diff\n_Diff too large (${rawDiff.length} chars, ${files.length} files). Use \`read\` to inspect files._\n`;
  } else {
    prompt += `\n### Diff\n\n\`\`\`diff\n${rawDiff}\n\`\`\`\n`;
  }

  prompt += `\n### Instructions
1. Review each changed file for bugs, security issues, performance problems, and style issues
2. Focus on the actual changes (the diff), not the entire file
3. Categorize findings by severity: **critical**, **warning**, **info**
4. For each finding, specify the file, line range, and a clear explanation
5. End with an overall assessment`;

  return prompt;
}

/**
 * Build a single combined review prompt spanning multiple repositories.
 *
 * The value of a linked (联动) review over plain concatenation: the prompt
 * explicitly asks the model to hunt for cross-repository issues — shared
 * interfaces/type contracts, import paths, API-surface changes, and duplicated
 * or divergent logic — not just per-file bugs. Each repo gets its own section
 * (so file paths stay unambiguous), with the large-diff skip applied per repo
 * so one huge repo cannot blow up the whole context.
 */
function buildMultiRepoPrompt(
  mode: string,
  perRepo: RepoReviewResult[],
  cwd: string,
  instructions?: string,
): string {
  const reposWithLabel = perRepo.map((p) => ({
    repo: p.repo,
    label: shortRepo(p.repo, cwd),
    summary: p.summary,
    error: p.error,
  }));
  let totalFiles = 0;
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const { summary } of reposWithLabel) {
    if (!summary) continue;
    totalFiles += summary.files.length;
    totalAdded += summary.totalAdded;
    totalRemoved += summary.totalRemoved;
  }

  let prompt = `## Code Review — ${mode} — ${reposWithLabel.length} repositories\n\n`;
  prompt += `> Linked review across ${reposWithLabel.length} repositories. Beyond per-file issues, scrutinize cross-repository consistency: shared interfaces and type/API contracts, import paths, coordinated changes, and duplicated or divergent logic.\n\n`;

  prompt += `### Repositories\n`;
  for (const { label, summary, error } of reposWithLabel) {
    if (error) {
      prompt += `- \`${label}\` — ⚠️ comparison failed (see below)\n`;
    } else if (summary && summary.files.length > 0) {
      prompt += `- \`${label}\` — ${summary.files.length} files, +${summary.totalAdded}/-${summary.totalRemoved}\n`;
    } else {
      prompt += `- \`${label}\` — no changes\n`;
    }
  }

  prompt += `\n### Overall Summary\n${totalFiles} files changed across ${reposWithLabel.length} repositories, +${totalAdded}/-${totalRemoved} lines\n`;

  for (const { repo, label, summary, error } of reposWithLabel) {
    prompt += `\n### Repository: \`${label}\`\n\n`;
    prompt += `> File paths in this section are relative to the repository root: \`${repo}\`\n\n`;

    if (error) {
      prompt += `> ⚠️ **Comparison failed — do NOT treat this repository as clean.** ${error}\n\n`;
      prompt += `_The diff for this repository could not be computed, so its changes are unknown and unverified._\n`;
      continue;
    }

    if (!summary || summary.files.length === 0) {
      prompt += `_No changes in this repository._\n`;
      continue;
    }

    prompt += `#### Changed Files\n\n`;
    prompt += `| File | +/− | Type |\n|------|-----|------|\n`;
    for (const f of summary.files) {
      prompt += `| ${f.path} | +${f.linesAdded}/-${f.linesRemoved} | ${f.ext} |\n`;
    }

    if (summary.excluded.length > 0) {
      prompt += `\n#### Excluded Files (${summary.excluded.length})\n`;
      for (const e of summary.excluded) {
        prompt += `- \`${e.path}\` (+${e.linesAdded}/-${e.linesRemoved}) — ${e.reason}\n`;
      }
    }

    const skipDiff =
      summary.rawDiff.length > 50_000 || summary.files.length > 20;
    if (skipDiff) {
      prompt += `\n#### Diff\n_Diff too large (${summary.rawDiff.length} chars, ${summary.files.length} files). Use \`read\` to inspect files in \`${repo}\`._\n`;
    } else {
      prompt += `\n#### Diff\n\n\`\`\`diff\n${summary.rawDiff}\n\`\`\`\n`;
    }
  }

  if (instructions) {
    prompt += `\n### Custom Instructions\n${instructions}\n`;
  }

  prompt += `\n### Instructions
1. Review each changed file for bugs, security issues, performance problems, and style issues
2. Focus on the actual changes (the diff), not the entire file
3. **Cross-repository linkage**: check shared interfaces, type/API contracts, import paths, and coordinated changes — does a change in one repository break consumers or assumptions in another? Flag duplicated or divergent logic introduced across repositories
4. Categorize findings by severity: **critical**, **warning**, **info**
5. For each finding, specify the repository, file, line range, and a clear explanation
6. End with an overall assessment covering both per-repo and cross-repository findings`;

  // Surface comparison failures explicitly so the reviewer does not mistake
  // an unverifiable repo for a clean one.
  if (reposWithLabel.some((r) => r.error)) {
    prompt += `\n\n**⚠️ Unverified repositories**: one or more repositories could not be compared (marked ⚠️ above). Their changes are unknown — do NOT assume they have no changes, and call this out in the overall assessment as needing a re-check (e.g. fetch the remote or fix the base branch).`;
  }

  return prompt;
}

// ══════════════════════════════════════════════════════════════════════════
// Extension
// ══════════════════════════════════════════════════════════════════════════

export default function reviewExtension(pi: ExtensionAPI) {
  // ── /review command ────────────────────────────────

  pi.registerCommand("review", {
    description:
      'Code review: uncommitted, staged, branch, or commit. Optional repo path(s): /review [path] | /review "repo-a" "repo-b" (linked multi-repo review)',
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/review requires interactive mode", "error");
        return;
      }

      const cwd = ctx.cwd;
      // Repo path(s) from argument tokens: /review piex  |  /review "piex" "oh-my-pi"
      // Accepts pi @-mention / autocomplete forms: /review @piex/, /review @"piex"
      const argTokens = parseRepoArgs(args);

      // Multi-repo linked review (>=2 repos): one unified mode applied to all
      // repos, producing a single combined prompt with cross-repo analysis.
      if (argTokens.length >= 2) {
        const resolved = resolveRepos(cwd, argTokens);
        if (!resolved.ok) {
          ctx.ui.notify(
            `Cannot resolve repositories:\n${resolved.errors.map((e) => `  • ${e}`).join("\n")}`,
            "error",
          );
          return;
        }
        let repos = resolved.repos;

        let mode = "";
        let customInstructions: string | undefined;
        const perRepo: RepoReviewResult[] = [];

        while (true) {
          const repoList = repos.map((r) => shortRepo(r, cwd)).join(", ");
          const choice = await ctx.ui.select(
            `Review what? (repos: ${repoList})`,
            [
              `Uncommitted changes (working tree)`,
              `Staged changes (ready to commit)`,
              `Changes vs default branch (PR-style, per repo)`,
              `Custom instructions (no auto-diff)`,
              `Edit repository list…`,
            ],
          );

          if (!choice) return;

          if (choice.startsWith("Edit repository")) {
            const inputList = await ctx.ui.input(
              "Repositories (space or comma separated):",
              repoList,
            );
            if (!inputList?.trim()) continue;
            const nextTokens = parseRepoArgs(inputList.replace(/,/g, " "));
            if (nextTokens.length === 0) continue;
            const next = resolveRepos(cwd, nextTokens);
            if (!next.ok) {
              ctx.ui.notify(
                `Cannot resolve repositories:\n${next.errors.map((e) => `  • ${e}`).join("\n")}`,
                "error",
              );
              continue;
            }
            repos = next.repos;
            continue;
          }

          if (choice.startsWith("Uncommitted")) {
            mode = "Uncommitted Changes";
          } else if (choice.startsWith("Staged")) {
            mode = "Staged Changes";
          } else if (choice.startsWith("Changes vs")) {
            mode = "Changes vs default branch";
          } else if (choice.startsWith("Custom")) {
            const instr = await ctx.ui.input("Review instructions:");
            if (!instr?.trim()) return;
            customInstructions = instr.trim();
            mode = "Custom Review";
          }
          break;
        }

        if (customInstructions) {
          const prompt = buildMultiRepoPrompt(
            mode,
            repos.map((r) => ({ repo: r, summary: null })),
            cwd,
            customInstructions,
          );
          pi.sendUserMessage(prompt, { deliverAs: "followUp" });
          return;
        }

        for (const repo of repos) {
          let summary: DiffSummary | null = null;
          let error: string | undefined;
          if (mode === "Uncommitted Changes") {
            summary = await reviewUncommitted(repo);
          } else if (mode === "Staged Changes") {
            summary = await reviewStaged(repo);
          } else if (mode === "Changes vs default branch") {
            const base = getDefaultBranch(repo);
            git(repo, ["fetch", "origin", base]);
            if (canCompareToBase(repo, base)) {
              const diff = git(repo, [
                "diff",
                `origin/${base}...HEAD`,
                "--unified=3",
              ]);
              summary = diff.trim() ? parseDiff(diff) : null;
            } else {
              error = `cannot compare against \`origin/${base}\` (ref not found — no remote, branch never fetched, or a wrong default-branch name)`;
            }
          }
          perRepo.push({ repo, summary, error });
        }

        const hasChanges = perRepo.some(
          (p) => p.summary && p.summary.files.length > 0,
        );
        const hasErrors = perRepo.some((p) => p.error);
        if (!hasChanges && !hasErrors) {
          ctx.ui.notify("No changes to review.", "info");
          return;
        }

        const prompt = buildMultiRepoPrompt(mode, perRepo, cwd);
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
        return;
      }

      // Single-repo flow (0 or 1 path token) — unchanged behavior.
      const argRepo = argTokens[0];
      const initial = resolveRepo(cwd, argRepo);
      if (!initial.ok) {
        ctx.ui.notify(initial.error, "error");
        return;
      }

      let repo = initial.path;
      let defaultBranch = getDefaultBranch(repo);

      let summary: DiffSummary | null = null;
      let mode = "";
      let customInstructions: string | undefined;

      while (true) {
        const choice = await ctx.ui.select(
          `Review what? (repo: ${shortRepo(repo, cwd)})`,
          [
            `Uncommitted changes (working tree)`,
            `Staged changes (ready to commit)`,
            `Changes vs ${defaultBranch} (PR-style)`,
            `Custom instructions (no auto-diff)`,
            `Switch repository path…`,
          ],
        );

        if (!choice) return;

        if (choice.startsWith("Switch repository")) {
          const inputRepo = await ctx.ui.input("Repository path:", cwd);
          if (!inputRepo?.trim()) continue;
          const next = resolveRepo(cwd, inputRepo.trim());
          if (!next.ok) {
            ctx.ui.notify(next.error, "error");
            continue;
          }
          repo = next.path;
          defaultBranch = getDefaultBranch(repo);
          continue;
        }

        if (choice.startsWith("Uncommitted")) {
          summary = await reviewUncommitted(repo);
          mode = "Uncommitted Changes";
        } else if (choice.startsWith("Staged")) {
          summary = await reviewStaged(repo);
          mode = "Staged Changes";
        } else if (choice.startsWith("Changes vs")) {
          summary = await reviewBaseBranch(repo);
          mode = `Changes vs ${defaultBranch}`;
        } else if (choice.startsWith("Custom")) {
          const instr = await ctx.ui.input("Review instructions:");
          if (!instr?.trim()) return;
          customInstructions = instr.trim();
          mode = "Custom Review";
        }
        break;
      }

      if (customInstructions) {
        // Custom review without diff
        const prompt = buildReviewPrompt(
          mode,
          {
            files: [],
            excluded: [],
            totalAdded: 0,
            totalRemoved: 0,
            rawDiff: "",
          },
          customInstructions,
          repo,
        );
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
        return;
      }

      if (!summary || summary.files.length === 0) {
        ctx.ui.notify("No changes to review.", "info");
        return;
      }

      const prompt = buildReviewPrompt(mode, summary, undefined, repo);
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    },
  });

  // ── review tool (LLM-callable) ─────────────────────

  pi.registerTool({
    name: "review",
    label: "Review",
    description: `Review code changes. Can review uncommitted changes, staged changes, a specific commit, or a file.
Use this when the user asks for a code review or when you want to review your own changes before committing.

Actions:
  diff     — Review current uncommitted + staged changes
  staged   — Review staged changes only
  commit   — Review a specific commit (requires 'commit' param)
  file     — Review a specific file (requires 'file' param)
  branch   — Review changes vs a base branch (requires 'base' param)

Single repo: pass 'repo' (defaults to cwd; relative paths resolve against cwd).
Multiple repos (linked review): pass 'repos' (array of paths) instead — runs the
action across every repo and returns one combined prompt with cross-repository
analysis. 'repos' takes precedence over 'repo'. For 'repos' only diff/staged/
branch are supported (commit/file are repo-specific); 'base' applies to all.`,
    parameters: Type.Object({
      action: Type.String({
        description: "Review action: diff, staged, commit, file, branch",
      }),
      commit: Type.Optional(
        Type.String({
          description: "Commit SHA to review (for action=commit)",
        }),
      ),
      file: Type.Optional(
        Type.String({ description: "File path to review (for action=file)" }),
      ),
      base: Type.Optional(
        Type.String({
          description: "Base branch to compare against (for action=branch)",
        }),
      ),
      instructions: Type.Optional(
        Type.String({ description: "Custom review focus or instructions" }),
      ),
      repo: Type.Optional(
        Type.String({
          description:
            "Path to the git repository to review. Defaults to the current working directory. Relative paths resolve against cwd.",
        }),
      ),
      repos: Type.Optional(
        Type.Array(
          Type.String({
            description:
              "Multiple repository paths for a linked (cross-repo) review. When provided, runs the action across all repos and returns one combined prompt. Takes precedence over 'repo'. Only diff/staged/branch supported; 'base' applies to every repo.",
          }),
        ),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const action = String(params.action ?? "").trim();

      // Multi-repo linked review: 'repos' array → one combined cross-repo prompt.
      const reposParam: string[] =
        Array.isArray(params.repos) && params.repos.length > 0
          ? params.repos.filter(
              (r): r is string => typeof r === "string" && r.trim().length > 0,
            )
          : [];
      if (reposParam.length > 0) {
        try {
          if (action !== "diff" && action !== "staged" && action !== "branch") {
            throw new Error(
              `action '${action}' is repo-specific and not supported with 'repos'. Use diff, staged, or branch (commit/file need a single 'repo').`,
            );
          }
          const resolved = resolveRepos(cwd, reposParam);
          if (!resolved.ok) {
            return {
              content: [
                {
                  type: "text",
                  text: `Review failed: cannot resolve repositories:\n${resolved.errors.map((e) => `  • ${e}`).join("\n")}`,
                },
              ],
              details: { action, error: true },
            };
          }
          const instructions =
            typeof params.instructions === "string"
              ? params.instructions
              : undefined;
          const perRepo: RepoReviewResult[] = [];
          for (const repo of resolved.repos) {
            let summary: DiffSummary | null = null;
            let error: string | undefined;
            if (action === "diff") {
              summary = await reviewUncommitted(repo);
            } else if (action === "staged") {
              summary = await reviewStaged(repo);
            } else {
              const base = typeof params.base === "string" ? params.base : "";
              if (!base) {
                throw new Error("'base' parameter required for action=branch");
              }
              git(repo, ["fetch", "origin", base]);
              if (canCompareToBase(repo, base)) {
                const diff = git(repo, [
                  "diff",
                  `origin/${base}...HEAD`,
                  "--unified=3",
                ]);
                summary = diff.trim() ? parseDiff(diff) : null;
              } else {
                error = `cannot compare against \`origin/${base}\` (ref not found — no remote, branch never fetched, or a wrong branch name)`;
              }
            }
            perRepo.push({ repo, summary, error });
          }
          const hasChanges = perRepo.some(
            (p) => p.summary && p.summary.files.length > 0,
          );
          const hasErrors = perRepo.some((p) => p.error);
          if (!hasChanges && !hasErrors) {
            return {
              content: [{ type: "text", text: "No changes to review." }],
              details: { action, found: false, repos: resolved.repos },
            };
          }
          const mode =
            action === "diff"
              ? "Uncommitted Changes"
              : action === "staged"
                ? "Staged Changes"
                : `Changes vs ${params.base}`;
          const prompt = buildMultiRepoPrompt(mode, perRepo, cwd, instructions);
          let totalFiles = 0,
            totalAdded = 0,
            totalRemoved = 0;
          for (const p of perRepo) {
            if (!p.summary) continue;
            totalFiles += p.summary.files.length;
            totalAdded += p.summary.totalAdded;
            totalRemoved += p.summary.totalRemoved;
          }
          return {
            content: [{ type: "text", text: prompt }],
            details: {
              action,
              mode,
              repos: resolved.repos,
              files: totalFiles,
              added: totalAdded,
              removed: totalRemoved,
            },
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Review failed: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            details: { action, error: true },
          };
        }
      }

      const resolved = resolveRepo(
        cwd,
        typeof params.repo === "string" ? params.repo : undefined,
      );
      if (!resolved.ok) {
        return {
          content: [{ type: "text", text: `Review failed: ${resolved.error}` }],
          details: { action, error: true },
        };
      }
      const repo = resolved.path;

      try {
        let summary: DiffSummary | null = null;
        let mode = "";

        switch (action) {
          case "diff":
            summary = await reviewUncommitted(repo);
            mode = "Uncommitted Changes";
            break;
          case "staged":
            summary = await reviewStaged(repo);
            mode = "Staged Changes";
            break;
          case "commit":
            if (typeof params.commit !== "string" || !params.commit) {
              throw new Error("'commit' parameter required for action=commit");
            }
            summary = await reviewCommit(repo, params.commit);
            mode = `Commit ${params.commit.slice(0, 8)}`;
            break;
          case "branch":
            if (typeof params.base !== "string" || !params.base) {
              throw new Error("'base' parameter required for action=branch");
            }
            git(repo, ["fetch", "origin", params.base]);
            const diff = git(repo, [
              "diff",
              `origin/${params.base}...HEAD`,
              "--unified=3",
            ]);
            summary = diff.trim() ? parseDiff(diff) : null;
            mode = `Changes vs ${params.base}`;
            break;
          case "file":
            if (typeof params.file !== "string" || !params.file) {
              throw new Error("'file' parameter required for action=file");
            }
            const fileDiff = git(repo, [
              "diff",
              "--unified=3",
              "--",
              params.file,
            ]);
            summary = fileDiff.trim() ? parseDiff(fileDiff) : null;
            mode = `File: ${params.file}`;
            break;
          default:
            throw new Error(
              `Unknown action: ${action}. Use: diff, staged, commit, file, branch`,
            );
        }

        if (!summary || summary.files.length === 0) {
          return {
            content: [{ type: "text", text: "No changes to review." }],
            details: { action, found: false },
          };
        }

        const prompt = buildReviewPrompt(
          mode,
          summary,
          typeof params.instructions === "string"
            ? params.instructions
            : undefined,
          repo,
        );
        return {
          content: [{ type: "text", text: prompt }],
          details: {
            action,
            mode,
            repo,
            files: summary.files.length,
            added: summary.totalAdded,
            removed: summary.totalRemoved,
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Review failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: { action, error: true },
        };
      }
    },
  });
}

/** Test-only exports for path-arg normalization helpers. */
export const __test__ = {
  takeFirstPathArg,
  parseRepoArgs,
  normalizeRepoArg,
  resolveRepo,
  resolveRepos,
  canCompareToBase,
};
