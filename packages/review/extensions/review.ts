/**
 * review extension — code review via /review command and review tool.
 *
 *   pi install npm:@piex-dev/review
 *   pi -e ./extensions/review.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";
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
  excluded: { path: string; reason: string; linesAdded: number; linesRemoved: number }[];
  totalAdded: number;
  totalRemoved: number;
  rawDiff: string;
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
    let added = 0, removed = 0;
    for (const line of chunk.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }

    const reason = isExcluded(fp);
    const ext = path.extname(fp) || "(none)";
    if (reason) {
      excluded.push({ path: fp, reason, linesAdded: added, linesRemoved: removed });
    } else {
      files.push({ path: fp, linesAdded: added, linesRemoved: removed, ext });
      totalAdded += added;
      totalRemoved += removed;
    }
    totalAdded += added;
    totalRemoved += removed;
  }
  return { files, excluded, totalAdded, totalRemoved, rawDiff: raw };
}

// ══════════════════════════════════════════════════════════════════════════
// Git helpers
// ══════════════════════════════════════════════════════════════════════════

function git(cwd: string, args: string[]): string {
  try {
    return execSync(`git ${args.join(" ")}`, { cwd, encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });
  } catch {
    return "";
  }
}

function getDefaultBranch(cwd: string): string {
  const result = git(cwd, ["rev-parse", "--abbrev-ref", "origin/HEAD"]).trim();
  if (result) return result.replace(/^origin\//, "");
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim() || "main";
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

async function reviewBaseBranch(cwd: string): Promise<DiffSummary | null> {
  const base = getDefaultBranch(cwd);
  git(cwd, ["fetch", "origin", base]);
  const diff = git(cwd, ["diff", `origin/${base}...HEAD`, "--unified=3"]);
  if (!diff.trim()) return null;
  return parseDiff(diff);
}

async function reviewCommit(cwd: string, sha: string): Promise<DiffSummary | null> {
  const diff = git(cwd, ["show", "--unified=3", sha]);
  if (!diff.trim()) return null;
  return parseDiff(diff);
}

// ══════════════════════════════════════════════════════════════════════════
// Review prompt template
// ══════════════════════════════════════════════════════════════════════════

function buildReviewPrompt(mode: string, summary: DiffSummary, instructions?: string): string {
  const { files, excluded, totalAdded, totalRemoved, rawDiff } = summary;
  const totalLines = totalAdded + totalRemoved;
  const skipDiff = rawDiff.length > 50_000 || files.length > 20;

  let prompt = `## Code Review — ${mode}

### Summary
${files.length} files changed, +${totalAdded}/-${totalRemoved} lines (${totalLines} total)

`;

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

// ══════════════════════════════════════════════════════════════════════════
// Extension
// ══════════════════════════════════════════════════════════════════════════

export default function reviewExtension(pi: ExtensionAPI) {
  // ── /review command ────────────────────────────────

  pi.registerCommand("review", {
    description: "Code review: uncommitted, staged, branch, or commit",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/review requires interactive mode", "error");
        return;
      }

      const cwd = ctx.cwd;
      const defaultBranch = getDefaultBranch(cwd);

      const choice = await ctx.ui.select("Review what?", [
        `Uncommitted changes (working tree)`,
        `Staged changes (ready to commit)`,
        `Changes vs ${defaultBranch} (PR-style)`,
        `Custom instructions (no auto-diff)`,
      ]);

      if (!choice) return;

      let summary: DiffSummary | null = null;
      let mode = "";
      let customInstructions: string | undefined;

      if (choice.startsWith("Uncommitted")) {
        summary = await reviewUncommitted(cwd);
        mode = "Uncommitted Changes";
      } else if (choice.startsWith("Staged")) {
        summary = await reviewStaged(cwd);
        mode = "Staged Changes";
      } else if (choice.startsWith("Changes vs")) {
        summary = await reviewBaseBranch(cwd);
        mode = `Changes vs ${defaultBranch}`;
      } else if (choice.startsWith("Custom")) {
        const instr = await ctx.ui.input("Review instructions:");
        if (!instr?.trim()) return;
        customInstructions = instr.trim();
        mode = "Custom Review";
      }

      if (customInstructions) {
        // Custom review without diff
        const prompt = buildReviewPrompt(mode, {
          files: [], excluded: [], totalAdded: 0, totalRemoved: 0, rawDiff: "",
        }, customInstructions);
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
        return;
      }

      if (!summary || summary.files.length === 0) {
        ctx.ui.notify("No changes to review.", "info");
        return;
      }

      const prompt = buildReviewPrompt(mode, summary);
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
  branch   — Review changes vs a base branch (requires 'base' param)`,
    parameters: Type.Object({
      action: Type.String({ description: "Review action: diff, staged, commit, file, branch" }),
      commit: Type.Optional(Type.String({ description: "Commit SHA to review (for action=commit)" })),
      file: Type.Optional(Type.String({ description: "File path to review (for action=file)" })),
      base: Type.Optional(Type.String({ description: "Base branch to compare against (for action=branch)" })),
      instructions: Type.Optional(Type.String({ description: "Custom review focus or instructions" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const action = String(params.action ?? "").trim();

      try {
        let summary: DiffSummary | null = null;
        let mode = "";

        switch (action) {
          case "diff":
            summary = await reviewUncommitted(cwd);
            mode = "Uncommitted Changes";
            break;
          case "staged":
            summary = await reviewStaged(cwd);
            mode = "Staged Changes";
            break;
          case "commit":
            if (typeof params.commit !== "string" || !params.commit) {
              throw new Error("'commit' parameter required for action=commit");
            }
            summary = await reviewCommit(cwd, params.commit);
            mode = `Commit ${params.commit.slice(0, 8)}`;
            break;
          case "branch":
            if (typeof params.base !== "string" || !params.base) {
              throw new Error("'base' parameter required for action=branch");
            }
            git(cwd, ["fetch", "origin", params.base]);
            const diff = git(cwd, ["diff", `origin/${params.base}...HEAD`, "--unified=3"]);
            summary = diff.trim() ? parseDiff(diff) : null;
            mode = `Changes vs ${params.base}`;
            break;
          case "file":
            if (typeof params.file !== "string" || !params.file) {
              throw new Error("'file' parameter required for action=file");
            }
            const fileDiff = git(cwd, ["diff", "--unified=3", "--", params.file]);
            summary = fileDiff.trim() ? parseDiff(fileDiff) : null;
            mode = `File: ${params.file}`;
            break;
          default:
            throw new Error(`Unknown action: ${action}. Use: diff, staged, commit, file, branch`);
        }

        if (!summary || summary.files.length === 0) {
          return {
            content: [{ type: "text", text: "No changes to review." }],
            details: { action, found: false },
          };
        }

        const prompt = buildReviewPrompt(mode, summary, typeof params.instructions === "string" ? params.instructions : undefined);
        return {
          content: [{ type: "text", text: prompt }],
          details: {
            action,
            mode,
            files: summary.files.length,
            added: summary.totalAdded,
            removed: summary.totalRemoved,
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Review failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: { action, error: true },
        };
      }
    },
  });
}
