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
 * - 2.2 块解析回显: "block N → lines start.=end"，让模型核对 tree-sitter 选中范围
 * - 2.3 Diff 回显: update 附带 compact diff preview，"实际改了什么"当场可见
 * - 2.4 HTML 结构校验 (delta): 编辑 .html 后对比前后结构标签平衡，
 *   仅在本次编辑引入新失衡时告警（防 SWAP 范围算错吞掉闭合标签）
 * - 2.5 Markdown fence 校验 (delta): 编辑 .md 后对比 fence 配对奇偶，
 *   本次编辑把平衡文档改失衡时告警（防 boundary repair 误删 fence /
 *   SWAP 范围漏算 fence 行）
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
// P0 — read 输出行号化
// ---------------------------------------------------------------------------

/**
 * pi read content 尾部由 pi 附加的说明行，不是文件内容，不编号。
 * 覆盖 pi read 的全部脚注形态：截断提示（Showing lines/Truncated）、
 * limit 剩余行提示（N more lines in file）、首行超限提示（First line）、
 * 单行超限提示（Line N is …）。
 */
const READ_FOOTNOTE_RE =
  /^\[(?:Showing lines|Truncated|Line \d+ is|First line|\d+ more lines)/;

/**
 * 把 pi read 返回的裸文件文本重写为 hashline 的 `N:TEXT` 行号格式。
 *
 * pi 内置 read 的 tool_result content 是纯文本（行号只在终端渲染层出现），
 * 而 prompt 承诺 read 输出是 LINE:TEXT 行。没有行号时模型只能按内容位置
 * 猜行号——这正是「行号估算错误」的根源；同时 parseSeenLines 提取不到
 * 任何行 → seen-lines guard 静默失效。行号化后两者同时解决：模型看到
 * 真实行号，guard 拿到 seen 集合。
 *
 * `startLine` 是本次 read 的 1-indexed 起始行号（来自 read 的 offset 参数）。
 * 空行也编号并计入 seen：DEL/SWAP 范围可以合法包含空行，漏掉它们会让
 * 合法编辑被 seen-lines guard 误拒。
 */
export function numberizeReadBody(
  body: string,
  startLine: number,
): { text: string; seenLines: number[] } {
  const lines = body.split("\n");

  // 脚注区域 = 第一个脚注行 + 其前连续空行（pi 用 `\n\n` 分隔正文与脚注）。
  // 分隔空行不是文件内容：若编号会顶掉「下一个真实行号」——截断读的边界
  // 行（如 200 行文件读到第 50 行时，分隔空行会被编号成 51 并计入 seen），
  // 模型会以为 51 是空行，在其上盲改真实内容，seen-lines guard 与 Phase 2.6
  // 告警都因 51 已入 seen 而失灵。只有 body 末尾没有脚注时的末尾空行才是
  // 文件真实哨兵行（引擎的 append-past-end 锚点，apply.ts trailingPhantomLine），
  // 需要编号。
  let footnoteStart = lines.findIndex((line) =>
    READ_FOOTNOTE_RE.test(line.trimStart()),
  );
  if (footnoteStart < 0) {
    footnoteStart = lines.length; // 无脚注：不跳过任何行
  } else {
    while (footnoteStart > 0 && lines[footnoteStart - 1] === "") {
      footnoteStart--;
    }
  }

  const numbered: string[] = [];
  const seenLines: number[] = [];
  let lineNo = startLine;
  for (let i = 0; i < lines.length; i++) {
    if (i >= footnoteStart) {
      numbered.push(lines[i]); // 脚注区域：不编号、不进入 seen
      continue;
    }
    numbered.push(`${lineNo}:${lines[i]}`);
    seenLines.push(lineNo);
    lineNo++;
  }
  return { text: numbered.join("\n"), seenLines };
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
 * - 移除 ` ``` ` 代码块包裹（模型偶尔把 DSL 当代码块输出）
 * - 压缩多余空行
 *
 * 换行符不做归一化：@oh-my-pi/hashline 解析层按 `\r?\n` 切分（input.ts），
 * CRLF 由 parser 吸收，此处无需处理。
 *
 * 不修改 DSL 语义——不调整路径、不重写操作符——安全操作。
 */
export function normalizeInput(raw: string): string {
  let input = raw.trim();

  // 移除 markdown 代码块包裹（模型偶尔多发）。条件收紧防误剥：
  // - 首行必须是 fence（可带任意非空白语言标签：``` / ```md / ```c++ / ```c#）
  // - 末行必须是**裸** fence。payload 内部的 fence body 行写作 `+``` `，
  //   以 `+` 开头，旧实现 `endsWith("```")` 会把「payload 最后一行是 +``` 」的
  //   DSL（编辑 markdown fence 块的 SWAP）误判为包裹，剥掉后丢一行 body。
  const allLines = input.split("\n");
  const firstFence = /^```\S*$/.test(allLines[0]?.trim());
  const lastFence = allLines[allLines.length - 1]?.trim() === "```";
  if (firstFence && lastFence && allLines.length > 2) {
    input = allLines.slice(1, -1).join("\n").trim();
  }
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
  // 属性值内的尖括号（如 <div data-x="<section>">）不是标签：先剥引号内容。
  // 已知边界（启发式代价，仅影响 WARN 且为 delta 校验）：正文散文中的引号对
  // （如 don't … that's）若跨越真实标签会被一并吞掉，可能漏报/误报；属性值内
  // 转义引号（\"）会破坏配对。正确区分属性值与正文需要状态机，不值得为 WARN
  // 提示引入。
  const text = stripHtmlNoScanZones(content).replace(/"[^"]*"|'[^']*'/g, "");
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

// ---------------------------------------------------------------------------
// Phase 2.5 — Markdown fenced-code-block balance
// ---------------------------------------------------------------------------

/**
 * A Markdown fenced-code-block marker line: ``` or ~~~ (optional language tag).
 *
 * Intentionally loose: no end anchor, so a single-line triple-backtick span
 * (e.g. ``` `x` ``` on one line) also matches. This is by design on both
 * layers that consume it — the Phase 2.5 [WARN] favors over-reporting over
 * missing a real unclosed block, and the patch-level fence guard errs toward
 * keeping the payload verbatim. A false positive only yields a warning the
 * model can verify; it never silently corrupts the file.
 */
const FENCE_LINE_RE = /^\s*(?:```|~~~)/;

/**
 * Collect the 1-indexed line numbers of every fenced-code-block marker in
 * `content`. Odd count is a cheap heuristic for a possibly-unclosed block
 * (does not model ``` vs ~~~ as independent streams).
 */
export function checkFenceBalance(content: string): {
  fences: number;
  lines: number[];
} {
  const lines: number[] = [];
  content.split("\n").forEach((l, i) => {
    if (FENCE_LINE_RE.test(l)) lines.push(i + 1);
  });
  return { fences: lines.length, lines };
}

/**
 * Delta between two fence-balance reports: true only when the edit turned an
 * even (paired) fence count into an odd one — the imbalance this edit
 * introduced. A pre-existing odd count is not re-reported on every edit, and
 * an edit that repairs it (odd → even) stays silent.
 */
export function worsenedFenceImbalance(
  before: { fences: number },
  after: { fences: number },
): boolean {
  return before.fences % 2 === 0 && after.fences % 2 === 1;
}

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
export function buildEditPreview(
  before: string,
  after: string,
): { preview: string; removedLines: number[] } | null {
  const numbered = buildNumberedLineDiff(before, after);
  if (numbered === null) {
    // 超限降级：没有逐行 diff，但行数变化仍有价值。
    const aLines = before.split("\n").length;
    const bLines = after.split("\n").length;
    const delta = bLines - aLines;
    return {
      preview: `diff (+${Math.max(0, delta)}/-${Math.max(0, -delta)}): ` +
        `file too large for line diff (${aLines} → ${bLines} lines)`,
      removedLines: [],
    };
  }
  const { preview, addedLines, removedLines } =
    buildCompactDiffPreview(numbered);
  if (addedLines + removedLines === 0) return null;
  // removed 行带编辑前行号（`-N|` 前缀），供「删除未 seen 行」告警使用。
  const removedLineNumbers: number[] = [];
  for (const row of numbered.split("\n")) {
    const m = /^-(\d+)\|/.exec(row);
    if (m) removedLineNumbers.push(Number(m[1]));
  }
  const rows = preview.split("\n");
  const capped =
    rows.length > DIFF_PREVIEW_MAX_LINES
      ? [
          ...rows.slice(0, DIFF_PREVIEW_MAX_LINES),
          `… (${rows.length - DIFF_PREVIEW_MAX_LINES} more rows)`,
        ].join("\n")
      : preview;
  return {
    preview: `diff (+${addedLines}/-${removedLines}):\n${capped}`,
    removedLines: removedLineNumbers,
  };
}
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
      // ── Parse the hashline input
      let patch: ReturnType<typeof Patch.parse>;
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

      // ── 每 section 的 payload 指纹（基于 parse 产物） ──
      // PatchSectionResult（apply 产物）没有 diff 字段，apply 后无法重算；
      // 在此一次性计算，检测/记录/计数三处按顺序配对复用，保证 key 一致。
      // 若在 apply 后直接取 section.diff，运行时是 undefined，key 退化为
      // "path\nundefined"——记录 key 与检测 key 不一致 → E_DUPLICATE_EDIT
      // 永不命中；且同一文件的不同 payload 共享同一 key → noop 计数跨
      // payload 误聚合，3 次不同尝试就误抛 E_NOOP_LOOP。
      const sectionKeys = patch.sections.map((section) =>
        computePayloadKey(`${section.path}\n${section.diff}`),
      );

      // ── apply 前捕获各 section 的 seen-lines ──
      // patcher.apply 会更新 store 快照（编辑后内容，无 seen 信息），
      // 「删除未 seen 行」告警需要的 seen 集合必须在 apply 前取。
      // key 用绝对路径，与 read hook 的 recordSnapshot 对齐：
      // read ./a.ts + payload 写 a.ts 时 resolve 后一致，告警不会静默跳过。
      const seenBeforeApply = new Map<string, Set<number>>();
      for (const section of patch.sections) {
        const absPath = path.resolve(cwd, section.path);
        const snap = store.head(canonicalSnapshotKey(absPath));
        if (snap?.seenLines && snap.seenLines.size > 0) {
          seenBeforeApply.set(absPath, snap.seenLines);
        }
      }

      // ── Phase 1.2 Duplicate Edit 检测（逐 section 检查） ──────
      // payloadKey 按 section 分别计算（path + DSL 原文）：多文件 payload
      // 事后重发其中一部分时也能命中检测（旧实现指纹整个输入，partial
      // resend 覆盖不到）。
      for (let i = 0; i < patch.sections.length; i++) {
        const section = patch.sections[i];
        const sectionPath = path.resolve(cwd, section.path);
        if (!editGuard.isDuplicateApplied(sectionPath, sectionKeys[i])) continue;
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

        for (let i = 0; i < result.sections.length; i++) {
          const section = result.sections[i];
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
            if (preview !== null) {
              parts.push(preview.preview);

              // ── Phase 2.6 删除未 seen 行告警 ────────────────────
              // 行号估算错误最常见的形态是「范围终点猜错」：起点 read 过、
              // 终点是没看过的行（或看的是旧快照）。diff 的 removed 行若
              // 不在最近 read 的 seen 集合里，明确提示，让模型停下核对
              // 而不是继续叠加错误。
              const seen = seenBeforeApply.get(path.resolve(cwd, section.path));
              if (seen && seen.size > 0) {
                const unseenRemoved = preview.removedLines.filter(
                  (n) => !seen.has(n),
                );
                if (unseenRemoved.length > 0) {
                  parts.push(
                    `[WARN] This edit deleted line(s) ${unseenRemoved.join(", ")} that were never ` +
                      `displayed by a recent read of ${section.path} — your line numbers may be off. ` +
                      `The diff preview does not show deleted content — re-read the file to verify ` +
                      `the range before proceeding.`,
                  );
                }
              }

              parts.push(
                `Next-edit hint: the diff above lists new line numbers — anchor the next edit on them, ` +
                  `or re-read the file for a fresh snapshot (continuing from pre-edit line numbers is the #1 way to hit a wrong line).`,
              );
            }
            // 对比编辑前后平衡，只报本次编辑引入/加剧的失衡。
            // ── Phase 2.4 HTML 结构校验（delta） ──────────────────
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

            // ── Phase 2.5 Markdown fence 校验（delta） ──────────────
            // 仅 update：编辑 .md 后检查 fence 行数奇偶。本次编辑把偶数变成
            // 奇数 → 告警。覆盖 repair 误删、SWAP 范围漏算等；与 2.4 同层。
            if (
              section.path.endsWith(".md") ||
              section.path.endsWith(".markdown")
            ) {
              const beforeFence = checkFenceBalance(section.before);
              const afterFence = checkFenceBalance(section.after);
              if (worsenedFenceImbalance(beforeFence, afterFence)) {
                parts.push(
                  `[WARN] Markdown fence may be unbalanced in ${section.path}: ` +
                    `${afterFence.lines.length} fence marker(s) at lines ${afterFence.lines.join(", ")} — ` +
                    `an odd count means one \`\`\` / ~~~ block may be left unclosed. ` +
                    `Verify the edit did not drop or duplicate a fence line.`,
                );
              }
            }
          }

          // Record new snapshot after successful edit. 只读一次：同一份
          // normalized 内容同时用于 snapshot 和 Phase 1.2 的 applied 记录。
          const absolutePath = path.resolve(cwd, section.path);
          const sectionKey = sectionKeys[i];
          const normalized = await readNormalized(absolutePath);
          if (normalized !== null) {
            store.record(canonicalSnapshotKey(absolutePath), normalized);
            editGuard.recordApplied(
              absolutePath,
              sectionKey,
              computeFileHash(normalized),
            );
          }
        }

        // ── Phase 1.1 Noop Loop Guard（逐 section 计数） ────────
        if (allNoop && result.sections.length > 0) {
          let maxCount = 0;
          let escalate = false;
          for (let i = 0; i < result.sections.length; i++) {
            const section = result.sections[i];
            const sectionKey = sectionKeys[i];
            const r = editGuard.recordNoop(
              path.resolve(cwd, section.path),
              sectionKey,
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
                  `If you edited this file earlier in this session, anchor on the NEW line numbers from that edit's ` +
                  `diff echo — or re-read the file with \`read\` to get a fresh tag, then re-issue the edit.`,
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

    const input = event.input as { path?: string; offset?: number } | undefined;
    const filePath = input?.path;
    if (!filePath) return;

    // Resolve to absolute. ctx.cwd is the project worktree directory.
    const absolutePath = path.resolve(ctx.cwd, filePath);
    const startLine = input?.offset ?? 1;

    const content = Array.isArray(event.content)
      ? event.content
      : [{ type: "text", text: String(event.content ?? "") }];

    // ── P0: read 输出行号化 ────────────────────────────────────────
    // pi 内置 read 的 content 是裸文件文本（行号只在终端渲染层出现），
    // 而 prompt 承诺 read 输出是 LINE:TEXT 行。没有行号时模型只能按
    // 内容位置猜行号（「行号估算错误」的根源），且 parseSeenLines 提取
    // 不到任何行 → seen-lines guard 静默失效。行号化后两者同时解决。
    // 图片 read 的 text 块是说明文本（"Read image file …"），不是文件
    // 内容，保持原样。
    // 仅重写第一个 text 块：pi 的 read 对文本文件始终返回单个 text 块（图片
    // 读返回 text+image，text 是说明文字不走行号化）。若未来出现多 text 块，
    // 后续块保持原样（其行号也无法从第一块延续，防御性注释）。
    const updated = [...content];
    let seenLines: number[] = [];
    const firstTextIdx = updated.findIndex((c: any) => c.type === "text");
    if (firstTextIdx >= 0) {
      const raw = updated[firstTextIdx].text;
      if (!/^Read image file\b/.test(raw)) {
        const numbered = numberizeReadBody(raw, startLine);
        updated[firstTextIdx] = { ...updated[firstTextIdx], text: numbered.text };
        seenLines = numbered.seenLines;
      }
    }

    // Record snapshot with seen-lines tracking for the patcher's guard
    const tag = await recordSnapshot(
      absolutePath,
      seenLines.length > 0 ? seenLines : undefined,
    );

    // ── Phase 1.1/1.2 模型主动 re-read → 重置该路径的 guard 状态 ──
    // 模型看到最新内容后有意重发同一 payload 是合法的，noop 计数也从头开始。
    editGuard.resetPath(absolutePath);

    if (!tag) return;

    // Prepend [filePath#tag] header to the first text block
    const header = formatHashlineHeader(filePath, tag);
    if (firstTextIdx >= 0) {
      updated[firstTextIdx] = {
        ...updated[firstTextIdx],
        text: `${header}\n${updated[firstTextIdx].text}`,
      };
      return { content: updated };
    }

    return {
      content: [{ type: "text", text: header }, ...updated],
    };
  });
}
