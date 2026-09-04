import { createHash } from "node:crypto";
import * as path from "node:path";
import type {
  ChangedRange,
  DiffSummary,
  FileDiff,
  ReviewFindingDraft,
} from "./types.js";

const EXCLUDED_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /(?:^|\/)package-lock\.json$/, reason: "lock file" },
  { pattern: /(?:^|\/)yarn\.lock$/, reason: "lock file" },
  { pattern: /(?:^|\/)pnpm-lock\.yaml$/, reason: "lock file" },
  { pattern: /(?:^|\/)Cargo\.lock$/, reason: "lock file" },
  { pattern: /(?:^|\/)Gemfile\.lock$/, reason: "lock file" },
  { pattern: /\.lock$/, reason: "lock file" },
  { pattern: /\.min\.(js|css)$/, reason: "minified" },
  { pattern: /\.generated\./, reason: "generated" },
  { pattern: /\.snap$/, reason: "snapshot" },
  { pattern: /\.map$/, reason: "source map" },
  { pattern: /(?:^|\/)dist\//, reason: "build output" },
  { pattern: /(?:^|\/)build\//, reason: "build output" },
  { pattern: /(?:^|\/)out\//, reason: "build output" },
  { pattern: /(?:^|\/)node_modules\//, reason: "vendor" },
  { pattern: /(?:^|\/)vendor\//, reason: "vendor" },
  { pattern: /\.(png|jpg|jpeg|gif|ico|webp|avif|svg)$/i, reason: "image" },
  { pattern: /\.(woff|woff2|ttf|eot|otf)$/i, reason: "font" },
  { pattern: /\.(pdf|zip|tar|gz|rar|7z)$/i, reason: "binary" },
];

function exclusionReason(filePath: string): string | undefined {
  return EXCLUDED_PATTERNS.find(({ pattern }) => pattern.test(filePath))
    ?.reason;
}

function parseHeaderTokens(header: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < header.length && tokens.length < 2) {
    while (header[index] === " ") index++;
    if (index >= header.length) break;
    if (header[index] !== '"') {
      const end = header.indexOf(" ", index);
      tokens.push(header.slice(index, end === -1 ? undefined : end));
      index = end === -1 ? header.length : end + 1;
      continue;
    }

    const start = index++;
    let escaped = false;
    while (index < header.length) {
      const character = header[index++];
      if (!escaped && character === '"') break;
      escaped = !escaped && character === "\\";
      if (character !== "\\") escaped = false;
    }
    const quoted = header.slice(start, index);
    try {
      tokens.push(JSON.parse(quoted) as string);
    } catch {
      tokens.push(quoted.slice(1, -1));
    }
  }
  return tokens;
}

function parseNewPath(chunk: string): string | undefined {
  const header = chunk.slice(
    0,
    chunk.indexOf("\n") === -1 ? undefined : chunk.indexOf("\n"),
  );
  const [, newPath] = parseHeaderTokens(header);
  if (!newPath) return undefined;
  return newPath.startsWith("b/") ? newPath.slice(2) : newPath;
}

function parseChangedRanges(chunk: string): ChangedRange[] {
  const changedLines = new Set<number>();
  let newLine = 0;
  let hunkStart = 1;
  let hunkEnd = 1;
  let inHunk = false;

  for (const line of chunk.split("\n")) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      const start = Math.max(1, Number(match[1]));
      const count = match[2] === undefined ? 1 : Number(match[2]);
      newLine = start;
      hunkStart = start;
      hunkEnd = count === 0 ? start : start + count - 1;
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      changedLines.add(newLine);
      newLine++;
    } else if (line.startsWith("-")) {
      // Deleted lines have no new-side location. Anchor them to the nearest
      // surviving line in the hunk so the reviewer can still report a
      // deletion-induced defect without accepting arbitrary context lines.
      changedLines.add(Math.min(Math.max(newLine, hunkStart), hunkEnd));
    } else if (line.startsWith(" ")) {
      newLine++;
    }
  }

  const ranges: ChangedRange[] = [];
  for (const line of [...changedLines].sort((left, right) => left - right)) {
    const previous = ranges[ranges.length - 1];
    if (previous && line === previous.end + 1) previous.end = line;
    else ranges.push({ start: line, end: line });
  }
  return ranges;
}

/** Parse Git unified diff and physically remove excluded chunks. */
export function parseDiff(raw: string): DiffSummary {
  const files: FileDiff[] = [];
  const excluded: DiffSummary["excluded"] = [];
  const includedChunks: string[] = [];
  let totalAdded = 0;
  let totalRemoved = 0;

  for (const chunk of raw.split(/^diff --git /m).filter(Boolean)) {
    const filePath = parseNewPath(chunk);
    if (!filePath) continue;
    let linesAdded = 0;
    let linesRemoved = 0;
    for (const line of chunk.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) linesAdded++;
      else if (line.startsWith("-") && !line.startsWith("---")) linesRemoved++;
    }

    const reason = exclusionReason(filePath);
    if (reason) {
      excluded.push({ path: filePath, reason, linesAdded, linesRemoved });
      continue;
    }

    const hunks = `diff --git ${chunk}`.trimEnd();
    includedChunks.push(hunks);
    files.push({
      path: filePath,
      linesAdded,
      linesRemoved,
      ext: path.extname(filePath) || "(none)",
      hunks,
      changedRanges: parseChangedRanges(chunk),
    });
    totalAdded += linesAdded;
    totalRemoved += linesRemoved;
  }

  return {
    files,
    excluded,
    totalAdded,
    totalRemoved,
    rawDiff: raw,
    filteredDiff: includedChunks.join("\n"),
  };
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function resolveDiffFile(
  summary: DiffSummary,
  filePath: string,
): FileDiff | undefined {
  const relative = filePath.replace(/^\.\//, "");
  const exact = summary.files.find((candidate) => candidate.path === relative);
  if (exact) return exact;

  const withoutGitPrefix = relative.replace(/^[ab]\//, "");
  if (withoutGitPrefix === relative) return undefined;
  return summary.files.find((candidate) => candidate.path === withoutGitPrefix);
}

export function findingOverlapsDiff(
  summary: DiffSummary,
  finding: Pick<ReviewFindingDraft, "file" | "lineStart" | "lineEnd">,
): boolean {
  const file = resolveDiffFile(summary, finding.file);
  if (!file) return false;
  if (file.changedRanges.length === 0) return false;
  return file.changedRanges.some(
    ({ start, end }) => finding.lineStart <= end && finding.lineEnd >= start,
  );
}

export function diffForFile(summary: DiffSummary, filePath?: string): string {
  if (!filePath) return summary.filteredDiff;
  return resolveDiffFile(summary, filePath)?.hunks ?? "";
}

export const __test__ = {
  exclusionReason,
  parseHeaderTokens,
  parseChangedRanges,
  parseNewPath,
};
