/**
 * hashline extension — overrides the built-in `edit` tool with hashline
 * patch language editing, and hooks `read` tool results to inject snapshot
 * headers for tag-verified edits.
 *
 * Phase 1 — 容错层 (2026-07-16):
 * - 1.1 Noop Loop Guard: 连续 3 次 byte-identical noop → 抛 [E_NOOP_LOOP]
 * - 1.2 Duplicate Edit 检测: 成功编辑后重发相同 payload → 抛 [E_DUPLICATE_EDIT]
 * - 1.3 方言归一化: 预处理 DSL 输入，吸收 CRLF/代码块包裹/多余空行
 * 1.1 + 1.2 的状态由 patches.ts 的 EditGuard 统一管理。
 *
 * Phase 2 — 编辑后校验与回显 (2026-07-19):
 * - 2.1 Warnings 透出: patcher 的 parser/applier warnings 原样回给模型
 * - 2.2 Diff 回显: update 附带 compact diff preview，"实际改了什么"当场可见
 * - 2.3 Tag balance (delta): 编辑 .html 后对比前后结构标签平衡，
 *   仅在本次编辑引入新失衡时告警（防 SWAP 范围算错吞掉闭合标签）
 *
 * Install:
 *   pi install npm:@piex-dev/hashline
 * Try:
 *   pi -e ./extensions/hashline.ts
 *
 * Works on Node.js. The bundled Bun polyfill (bun-polyfill.js) provides
 * Bun.hash.xxHash32 used internally by @oh-my-pi/hashline's computeFileHash.
 * File I/O goes through PiexNodeFilesystem which uses `node:fs` directly.
 */

// Load Bun polyfill BEFORE @oh-my-pi/hashline imports (provides Bun.hash.xxHash32)
import "./bun-polyfill.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fsp from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

// Dynamic import to ensure polyfill is loaded first (ES module hoisting workaround)
const hashline = await import("@oh-my-pi/hashline");
const {
  InMemorySnapshotStore,
  Patcher,
  Patch,
  MismatchError,
  buildCompactDiffPreview,
  formatHashlineHeader,
  normalizeToLF,
  stripBom,
} = hashline;
import { PiexNodeFilesystem, canonicalSnapshotKey } from "./filesystem.js";
import { EditGuard, computePayloadKey, computeFileHash } from "./patches.js";

// ---------------------------------------------------------------------------
// Phase 1 — 容错层单例
// ---------------------------------------------------------------------------

const editGuard = new EditGuard();

// ---------------------------------------------------------------------------
// Snapshot store singleton — shared between edit tool and read hook
// ---------------------------------------------------------------------------

const store = new InMemorySnapshotStore();

// ---------------------------------------------------------------------------
// Prompt — read from @oh-my-pi/hashline package at load time
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);
const promptPath = _require.resolve("@oh-my-pi/hashline/prompt.md");
const HASHLINE_PROMPT = readFileSync(promptPath, "utf-8");

// ---------------------------------------------------------------------------
// Line-number prefix pattern for seen-lines extraction
// Matches ` 123:` or `  456-460:` (collapsed summary row).
// ---------------------------------------------------------------------------

const LINE_PREFIX_RE = /^[ *]?(\d+)(?:-(\d+))?:[\t ]/;

/**
 * Extract the set of 1-indexed line numbers that were actually displayed to
 * the model in a hashline-formatted read body. Summary rows (`NN-MM:`) only
 * count their boundary lines — the elided interior was never shown.
 */
function parseSeenLines(body: string): number[] {
  const seen: number[] = [];
  for (const row of body.split("\n")) {
    const match = LINE_PREFIX_RE.exec(row);
    if (!match) continue;
    seen.push(Number(match[1]));
    if (match[2] !== undefined) seen.push(Number(match[2]));
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Snapshot recording
// ---------------------------------------------------------------------------

/**
 * Read `absolutePath`, strip BOM and normalize to LF.
 * Returns null on any read error.
 */
async function readNormalized(absolutePath: string): Promise<string | null> {
  try {
    const raw = await fsp.readFile(absolutePath, "utf-8");
    const { text } = stripBom(raw);
    return normalizeToLF(text);
  } catch {
    return null;
  }
}

/**
 * Read `absolutePath` and record a full-content snapshot in the store.
 * Returns the 4-hex content-hash tag, or null on error.
 *
 * Uses `canonicalSnapshotKey` (realpath) so the key matches between the
 * read hook and the edit tool's PiexNodeFilesystem on macOS / symlinked dirs.
 */
async function recordSnapshot(
  absolutePath: string,
  seenLines?: number[],
): Promise<string | null> {
  const normalized = await readNormalized(absolutePath);
  if (normalized === null) return null;
  const key = canonicalSnapshotKey(absolutePath);
  if (seenLines && seenLines.length > 0) {
    return store.record(key, normalized, seenLines);
  }
  return store.record(key, normalized);
}

// ---------------------------------------------------------------------------
// Phase 1.3 — 方言归一化
// ---------------------------------------------------------------------------

/**
 * 预处理 hashline DSL 输入，吸收模型常见格式偏差。
 *
 * - 去除首尾空白
 * - 统一换行符（CRLF → LF）
 * - 移除 ` ``` ` 代码块包裹（模型偶尔把 DSL 当代码块输出）
 * - 压缩多余空行
 *
 * 不修改 DSL 语义——不调整路径、不重写操作符——安全操作。
 */
function normalizeInput(raw: string): string {
  let input = raw.trim();

  // 移除 markdown 代码块包裹（模型偶尔多发）。语言标识在围栏行上，
  // 逐行剥掉首尾两行即可，同时兼容 ```lang 与裸 ``` 两种写法——
  // 不能用正则删“首行无空白的行”，那会误删 [PATH#TAG] 节头。
  if (input.startsWith("```") && input.endsWith("```")) {
    const lines = input.split("\n");
    if (lines.length > 1) {
      input = lines.slice(1, -1).join("\n").trim();
    }
  }

  // 统一换行符
  input = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // 压缩多余空行（模型可能在 section 之间插入多个空行）。
  // 安全：DSL 的 body 行一律带 `+` 前缀（空行写作单独的 `+`），
  // 合法 payload 中不存在真正的空行内容。
  input = input.replace(/\n{3,}/g, "\n\n");

  return input;
}

// ---------------------------------------------------------------------------
// Phase 2 — 编辑后校验与回显
// ---------------------------------------------------------------------------

/**
 * Structural tags whose open/close counts are compared after editing .html
 * files. Optionally-closed tags (`<p>`, `<li>`, `<tr>` …) are excluded —
 * they are legal unclosed and would false-positive on valid documents.
 */
const HTML_STRUCTURE_TAGS = new Set([
  "html",
  "head",
  "body",
  "main",
  "header",
  "footer",
  "aside",
  "nav",
  "section",
  "article",
  "div",
  "pre",
  "ul",
  "ol",
  "table",
  "thead",
  "tbody",
]);

/** Strip regions whose contents must not be scanned for tags. */
function stripHtmlNoScanZones(content: string): string {
  return content
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
}

/**
 * Count opening vs closing occurrences of structural HTML tags in `content`.
 * Returns only tags whose counts differ, as { tag: [openCount, closeCount] }.
 */
export function checkTagBalance(
  content: string,
): Record<string, [number, number]> {
  const text = stripHtmlNoScanZones(content);
  const openCounts: Record<string, number> = {};
  const closeCounts: Record<string, number> = {};
  for (const m of text.matchAll(/<(\w+)[\s>]/g)) {
    const tag = m[1].toLowerCase();
    if (HTML_STRUCTURE_TAGS.has(tag))
      openCounts[tag] = (openCounts[tag] || 0) + 1;
  }
  for (const m of text.matchAll(/<\/(\w+)>/g)) {
    const tag = m[1].toLowerCase();
    if (HTML_STRUCTURE_TAGS.has(tag))
      closeCounts[tag] = (closeCounts[tag] || 0) + 1;
  }
  const unbalanced: Record<string, [number, number]> = {};
  for (const tag of HTML_STRUCTURE_TAGS) {
    const open = openCounts[tag] || 0;
    const close = closeCounts[tag] || 0;
    if (open !== close) unbalanced[tag] = [open, close];
  }
  return unbalanced;
}

/**
 * Delta between two balance reports: keep only tags whose imbalance was
 * introduced or worsened between `before` and `after`. A pre-existing
 * imbalance elsewhere in the file must not re-warn on every edit.
 */
export function worsenedImbalances(
  before: Record<string, [number, number]>,
  after: Record<string, [number, number]>,
): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const [tag, [open, close]] of Object.entries(after)) {
    const [beforeOpen, beforeClose] = before[tag] ?? [0, 0];
    if (Math.abs(open - close) > Math.abs(beforeOpen - beforeClose)) {
      out[tag] = [open, close];
    }
  }
  return out;
}

/** Skip the LCS matrix when inputs are huge (cells = aLines × bLines). */
const DIFF_MAX_CELLS = 4_000_000;

/** Hard cap on preview rows echoed back to the model. */
const DIFF_PREVIEW_MAX_LINES = 60;

/**
 * Line-based LCS diff in the numbered `±<line>|<text>` format consumed by
 * buildCompactDiffPreview: removed rows carry pre-edit line numbers,
 * added/context rows carry post-edit line numbers. Returns null when the
 * inputs are too large for an in-memory matrix.
 */
export function buildNumberedLineDiff(
  before: string,
  after: string,
): string | null {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > DIFF_MAX_CELLS) return null;

  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = new Int32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * cols + j] =
        a[i] === b[j]
          ? dp[(i + 1) * cols + (j + 1)] + 1
          : Math.max(dp[(i + 1) * cols + j], dp[i * cols + (j + 1)]);
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(` ${j + 1}|${b[j]}`);
      i++;
      j++;
    } else if (dp[(i + 1) * cols + j] >= dp[i * cols + (j + 1)]) {
      out.push(`-${i + 1}|${a[i]}`);
      i++;
    } else {
      out.push(`+${j + 1}|${b[j]}`);
      j++;
    }
  }
  while (i < a.length) {
    out.push(`-${i + 1}|${a[i]}`);
    i++;
  }
  while (j < b.length) {
    out.push(`+${j + 1}|${b[j]}`);
    j++;
  }
  return out.join("\n");
}

/**
 * Compact "what actually changed" echo for an updated section. Removed rows
 * make accidental neighbor deletion visible; the numbered after-rows double
 * as fresh anchors for the next edit. Returns null when no diff is available.
 */
function buildEditPreview(before: string, after: string): string | null {
  const numbered = buildNumberedLineDiff(before, after);
  if (numbered === null) return null;
  const { preview, addedLines, removedLines } =
    buildCompactDiffPreview(numbered);
  if (addedLines + removedLines === 0) return null;
  const rows = preview.split("\n");
  const capped =
    rows.length > DIFF_PREVIEW_MAX_LINES
      ? [
          ...rows.slice(0, DIFF_PREVIEW_MAX_LINES),
          `… (${rows.length - DIFF_PREVIEW_MAX_LINES} more rows)`,
        ].join("\n")
      : preview;
  return `diff (+${addedLines}/-${removedLines}):\n${capped}`;
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function hashlineExtension(pi: ExtensionAPI) {
  // ── Override built-in edit tool ──────────────────────────────────────

  pi.registerTool({
    name: "edit",
    label: "Edit (hashline)",
    description: HASHLINE_PROMPT,
    parameters: Type.Object({
      input: Type.String({
        description: "Hashline patch input in the format described above",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const rawInput: string = params.input;

      // ── Phase 1.3 方言归一化 ──────────────────────────────────
      const input = normalizeInput(rawInput);

      // ── 计算 payload 指纹（用于 noop loop guard + duplicate 检测）
      // 已知局限：指纹针对整个输入；多文件 payload 事后只重发其中一部分
      // 文件时指纹不同，duplicate 检测覆盖不到这种 partial resend。
      const payloadKey = computePayloadKey(input);

      // Parse the hashline input
      let patch: Patch;
      try {
        patch = Patch.parse(input, { cwd });
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error parsing hashline input: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: {},
        };
      }

      // ── Phase 1.2 Duplicate Edit 检测（逐 section 检查） ──────
      for (const section of patch.sections) {
        const sectionPath = path.resolve(cwd, section.path);
        if (!editGuard.isDuplicateApplied(sectionPath, payloadKey)) continue;

        // 同一 payload 曾成功应用 → 检查文件是否在两次调用间被修改
        try {
          const raw = await fsp.readFile(sectionPath, "utf-8");
          const { text: content } = stripBom(raw);
          const normalized = normalizeToLF(content);
          const currentHash = computeFileHash(normalized);
          const lastHash = editGuard.getLastFileHash(sectionPath);
          if (lastHash !== null && currentHash === lastHash) {
            // 文件未变 + 相同 payload → 该编辑已生效，拒绝重复
            throw new Error(
              `[E_DUPLICATE_EDIT] This exact edit was already applied to ${section.path} ` +
                `by your previous edit call — the file already contains this change. ` +
                `Do NOT resend the same payload: that would duplicate the inserted lines. ` +
                `Re-read the file to see the current state before editing again.`,
            );
          }
        } catch (err) {
          // 如果是我们抛的 E_DUPLICATE_EDIT，返回给模型
          if (
            err instanceof Error &&
            err.message.startsWith("[E_DUPLICATE_EDIT]")
          ) {
            return {
              content: [{ type: "text", text: err.message }],
              details: {},
            };
          }
          // 文件不存在（新增文件）或读取失败 → 按正常流程继续
        }
      }

      // Use PiexNodeFilesystem: node:fs I/O, symlink-resolving canonicalPath
      const patcher = new Patcher({
        fs: new PiexNodeFilesystem(cwd),
        snapshots: store,
      });

      try {
        const result = await patcher.apply(patch);
        const parts: string[] = [];
        let allNoop = true;

        for (const section of result.sections) {
          if (section.op === "noop") {
            parts.push(
              `No changes to ${section.path}. ` +
                `The body rows are byte-identical to the file at the target lines — ` +
                `re-read the file with \`read\` to verify line numbers and latest content, then try again.`,
            );
            continue;
          }

          allNoop = false;
          parts.push(section.header);
          const verb =
            section.op === "create"
              ? "created"
              : section.op === "delete"
                ? "deleted"
                : "updated";
          parts.push(`${verb}: ${section.path}`);

          // ── Phase 2.1 Warnings 透出 ─────────────────────────────
          // parser/applier 已检测出的模型失误（keeper 复述修复、drift 等）
          // 必须回给模型，否则静默损坏无从自纠。
          for (const warning of section.warnings ?? []) {
            parts.push(`[WARN] ${warning}`);
          }

          // ── Phase 2.2 块解析回显 ────────────────────────────────
          // "block N → lines start.=end"，让模型核对 tree-sitter 选中的范围。
          for (const br of section.blockResolutions ?? []) {
            parts.push(
              `block ${br.anchorLine} → lines ${br.start}.=${br.end} (${br.op})`,
            );
          }

          // ── Phase 2.3 Diff 回显 ─────────────────────────────────
          // create/delete 不附 diff：新建文件全量是噪音，删除无内容可显示。
          if (section.op === "update") {
            const preview = buildEditPreview(section.before, section.after);
            if (preview !== null) parts.push(preview);

            // ── Phase 2.4 HTML 结构校验（delta） ──────────────────
            // 对比编辑前后平衡，只报本次编辑引入/加剧的失衡。
            if (section.path.endsWith(".html")) {
              const worsened = worsenedImbalances(
                checkTagBalance(section.before),
                checkTagBalance(section.after),
              );
              const entries = Object.entries(worsened);
              if (entries.length > 0) {
                const detail = entries
                  .map(([tag, [o, c]]) => `<${tag}> ${o} open / ${c} close`)
                  .join(", ");
                parts.push(
                  `[WARN] HTML structure may be broken in ${section.path}: ${detail}. ` +
                    `This edit introduced the imbalance — verify no closing tag was dropped or element duplicated.`,
                );
              }
            }
          }

          // Record new snapshot after successful edit. 只读一次：同一份
          // normalized 内容同时用于 snapshot 和 Phase 1.2 的 applied 记录。
          const absolutePath = path.resolve(cwd, section.path);
          const normalized = await readNormalized(absolutePath);
          if (normalized !== null) {
            store.record(canonicalSnapshotKey(absolutePath), normalized);
            editGuard.recordApplied(
              absolutePath,
              payloadKey,
              computeFileHash(normalized),
            );
          }
        }

        // ── Phase 1.1 Noop Loop Guard（逐 section 计数） ────────
        if (allNoop && result.sections.length > 0) {
          let maxCount = 0;
          let escalate = false;
          for (const section of result.sections) {
            const r = editGuard.recordNoop(
              path.resolve(cwd, section.path),
              payloadKey,
            );
            if (r.count > maxCount) maxCount = r.count;
            if (r.escalate) escalate = true;
          }
          if (escalate) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `[E_NOOP_LOOP] Edit was a byte-identical no-op ${maxCount} times in a row. ` +
                    `STOP re-sending this payload. Re-read the file — the content you are ` +
                    `trying to write already exists, or your anchors point at the wrong lines.`,
                },
              ],
              details: {},
            };
          }
        }

        return {
          content: [{ type: "text", text: parts.join("\n") }],
          details: { sections: result.sections.length },
        };
      } catch (err: unknown) {
        if (err instanceof MismatchError) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Tag mismatch on ${err.path}: the file has changed since you last read it. ` +
                  `Expected tag #${err.expectedFileHash}, got #${err.actualFileHash}. ` +
                  `Re-read the file with \`read\` to get a fresh tag, then re-issue the edit.`,
              },
            ],
            details: {},
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Error applying edit: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: {},
        };
      }
    },
  });

  // ── Hook read tool to inject snapshot headers ────────────────────────

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "read") return;

    const input = event.input as { path?: string } | undefined;
    const filePath = input?.path;
    if (!filePath) return;

    // Resolve to absolute. ctx.cwd is the project worktree directory.
    const absolutePath = path.resolve(ctx.cwd, filePath);

    // Extract seen lines from the read body (lines the model actually saw)
    const content = Array.isArray(event.content)
      ? event.content
      : [{ type: "text", text: String(event.content ?? "") }];
    const textBlocks = content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const seenLines = parseSeenLines(textBlocks);

    // Record snapshot with seen-lines tracking for the patcher's guard
    const tag = await recordSnapshot(absolutePath, seenLines);

    // ── Phase 1.1/1.2 模型主动 re-read → 重置该路径的 guard 状态 ──
    // 模型看到最新内容后有意重发同一 payload 是合法的，noop 计数也从头开始。
    editGuard.resetPath(absolutePath);

    if (!tag) return;

    // Prepend [filePath#tag] header to the first text block
    const header = formatHashlineHeader(filePath, tag);
    const firstTextIdx = content.findIndex((c: any) => c.type === "text");
    if (firstTextIdx >= 0) {
      const updated = [...content];
      updated[firstTextIdx] = {
        ...updated[firstTextIdx],
        text: `${header}\n${updated[firstTextIdx].text}`,
      };
      return { content: updated };
    }

    return {
      content: [{ type: "text", text: header }, ...content],
    };
  });
}
