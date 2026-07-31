/**
 * Unit tests for @piex-dev/hashline Phase 2 helpers (post-edit validation & echo)
 * plus integration tests for the patched @oh-my-pi/hashline boundary-echo repair.
 * Run: bun test extensions/hashline/test/hashline.test.ts
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// Imported first: hashline.ts self-loads the Bun polyfill before @oh-my-pi/hashline.
import {
  buildNumberedLineDiff,
  checkFenceBalance,
  checkTagBalance,
  worsenedFenceImbalance,
  worsenedImbalances,
} from "../src/hashline.ts";
import { PiexNodeFilesystem } from "../src/filesystem.js";

// Dynamic import AFTER the polyfill is in place (see hashline.ts import above).
const { Patcher, Patch, InMemorySnapshotStore } =
  await import("@oh-my-pi/hashline");

describe("checkTagBalance", () => {
  test("balanced document reports nothing", () => {
    const html = `<html><body><main><section><div><pre>x</pre></div></section></main></body></html>`;
    expect(checkTagBalance(html)).toEqual({});
  });

  test("unclosed structural tag is reported", () => {
    const html = `<body><div><section></section></body>`;
    expect(checkTagBalance(html)).toEqual({ div: [1, 0] });
  });

  test("optionally-closed tags (p, li) are ignored", () => {
    const html = `<body><ul><li>one<li>two</ul><p>para<p>another</body>`;
    expect(checkTagBalance(html)).toEqual({});
  });

  test("tags inside comments, script and style are ignored", () => {
    const html = [
      `<body>`,
      `<!-- <div> commented -->`,
      `<script>const s = "<section>";</script>`,
      `<style>div > section { color: red }</style>`,
      `<div></div>`,
      `</body>`,
    ].join("\n");
    expect(checkTagBalance(html)).toEqual({});
  });

  test("void elements and attributes do not confuse the counter", () => {
    const html = `<body><div class="a"><img src="x"><br></div></body>`;
    expect(checkTagBalance(html)).toEqual({});
  });
});

describe("worsenedImbalances", () => {
  test("pre-existing imbalance elsewhere is not re-reported", () => {
    const before = { div: [2, 1] as [number, number] };
    const after = { div: [2, 1] as [number, number] };
    expect(worsenedImbalances(before, after)).toEqual({});
  });

  test("newly introduced imbalance is reported", () => {
    expect(worsenedImbalances({}, { section: [2, 1] })).toEqual({
      section: [2, 1],
    });
  });

  test("worsened imbalance is reported, improved is not", () => {
    const before = { div: [3, 1] as [number, number] };
    expect(worsenedImbalances(before, { div: [4, 1] })).toEqual({
      div: [4, 1],
    });
    expect(worsenedImbalances(before, { div: [3, 2] })).toEqual({});
  });
});

describe("buildNumberedLineDiff", () => {
  test("single-line replacement", () => {
    const diff = buildNumberedLineDiff("a\nb\nc", "a\nB\nc");
    expect(diff).toBe(" 1|a\n-2|b\n+2|B\n 3|c");
  });

  test("pure insertion has no removed rows", () => {
    const diff = buildNumberedLineDiff("a\nc", "a\nb\nc");
    expect(diff).toBe(" 1|a\n+2|b\n 3|c");
  });

  test("pure deletion has no added rows", () => {
    const diff = buildNumberedLineDiff("a\nb\nc", "a\nc");
    expect(diff).toBe(" 1|a\n-2|b\n 2|c");
  });

  test("multi-hunk edit keeps both regions", () => {
    const before = "1\n2\n3\n4\n5";
    const after = "1\nX\n3\n4\nY";
    const diff = buildNumberedLineDiff(before, after);
    expect(diff).toBe(" 1|1\n-2|2\n+2|X\n 3|3\n 4|4\n-5|5\n+5|Y");
  });

  test("identical inputs produce context only", () => {
    const diff = buildNumberedLineDiff("a\nb", "a\nb");
    expect(diff).toBe(" 1|a\n 2|b");
  });
});

// ---------------------------------------------------------------------------
// Boundary-echo repair (patched @oh-my-pi/hashline)
//
// The local patch on @oh-my-pi/hashline tightens restated-boundary detection:
// a payload edge that echoes file lines bordering the edit range is only
// auto-dropped when the echoed lines are ALL non-blank structural edges. An
// edge that merely matches blank lines common in code is treated as
// intentional content and left alone — dropping it would corrupt a larger
// rewrite. These integration tests pin that behavior end-to-end via Patcher.
// ---------------------------------------------------------------------------

interface EchoApplyResult {
  after: string;
  echoRepairWarnings: string[];
}

async function applySwap(
  orig: string,
  spec: string,
  payload: string[],
): Promise<EchoApplyResult> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hashline-echo-"));
  try {
    const fp = path.join(tmp, "f.ts");
    fs.writeFileSync(fp, orig, "utf8");
    const store = new InMemorySnapshotStore();
    const tag = store.record(path.resolve(fp), orig);
    const patcher = new Patcher({
      fs: new PiexNodeFilesystem(tmp),
      snapshots: store,
    });
    const body = payload.map((l) => `+${l}`).join("\n");
    const result = await patcher.apply(
      Patch.parse(`[${fp}#${tag}]\n${spec}\n${body}`, { cwd: tmp }),
    );
    const echoRepairWarnings: string[] = [];
    for (const section of result.sections) {
      for (const warning of section.warnings ?? []) {
        if (
          /boundary echo|duplicated (leading|trailing) payload/i.test(warning)
        ) {
          echoRepairWarnings.push(warning);
        }
      }
    }
    return { after: fs.readFileSync(fp, "utf8"), echoRepairWarnings };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("boundary echo repair (patched @oh-my-pi/hashline)", () => {
  test("still drops a restated NON-BLANK trailing boundary (not over-tightened)", async () => {
    // Multi-line SWAP whose payload retypes the closing `}` just below the
    // range. That `}` is a genuine non-blank restated edge → must still be
    // auto-dropped so it is not duplicated. Guards against the fix being too
    // aggressive and breaking the legitimate repair.
    const { after } = await applySwap(
      "function f() {\n  const a = 1;\n  const b = 2;\n}\nconst z = 0;\n",
      "SWAP 2.=3:",
      ["  const a = 10;", "  const b = 20;", "}"],
    );
    expect(after).toBe(
      "function f() {\n  const a = 10;\n  const b = 20;\n}\nconst z = 0;\n",
    );
  });

  test("does NOT drop a blank-containing trailing boundary (the fix)", async () => {
    // The payload's trailing edge [`const x = 1;`, ``] restates the two lines
    // just below the range and is delimiter-neutral, so only the blank-guard
    // decides. The old `hasContent` rule accepted it (one non-blank line is
    // enough) and stripped both lines — corrupting a payload that meant them
    // as new content. The patched `!hasBlank` rule rejects any edge containing
    // a blank, so the payload is applied verbatim and no repair fires. (Verified
    // to fail when the guard is reverted to `hasContent`.)
    const { after, echoRepairWarnings } = await applySwap(
      "header\n  const a = 1;\n  const b = 2;\nconst x = 1;\n\nconst z = 0;\n",
      "SWAP 2.=3:",
      ["  const a = 10;", "  const b = 20;", "const x = 1;", ""],
    );
    expect(echoRepairWarnings).toEqual([]);
    expect(after).toBe(
      "header\n  const a = 10;\n  const b = 20;\nconst x = 1;\n\nconst x = 1;\n\nconst z = 0;\n",
    );
  });

  test("does NOT drop a blank-containing LEADING boundary (the fix)", async () => {
    // Mirror of the trailing case on countDuplicateLeadingBoundaryLines: the
    // payload's leading edge [`const x = 1;`, ``] restates the two lines just
    // above the range and is delimiter-neutral, so only the blank-guard
    // decides. The old `hasContent` rule accepted it (one non-blank line is
    // enough) and stripped both leading lines; the patched `!hasBlank` rule
    // rejects any edge containing a blank, so the payload is applied verbatim.
    // (Verified to fail when the leading guard is reverted to `hasContent`.)
    const { after, echoRepairWarnings } = await applySwap(
      "const x = 1;\n\n  const a = 1;\n  const b = 2;\nconst z = 0;\n",
      "SWAP 3.=4:",
      ["const x = 1;", "", "  const a = 10;", "  const b = 20;"],
    );
    expect(echoRepairWarnings).toEqual([]);
    expect(after).toBe(
      "const x = 1;\n\nconst x = 1;\n\n  const a = 10;\n  const b = 20;\nconst z = 0;\n",
    );
  });
  test("single-line SWAP adjacent to blank lines replaces cleanly", async () => {
    // The reported off-by-one: a one-line edit surrounded by blank lines must
    // replace exactly that line with no boundary-echo interference.
    const { after, echoRepairWarnings } = await applySwap(
      "const a = 1;\n\nconst target = 'old';\n\nconst b = 2;\n",
      "SWAP 3.=3:",
      ["const target = 'new';"],
    );
    expect(echoRepairWarnings).toEqual([]);
    expect(after).toBe(
      "const a = 1;\n\nconst target = 'new';\n\nconst b = 2;\n",
    );
  });
});

describe("checkFenceBalance / worsenedFenceImbalance", () => {
  test("paired fences report even count and line numbers", () => {
    const r = checkFenceBalance("文本\n```go\ncode\n```\n~~~\nmore\n~~~\n");
    expect(r.fences).toBe(4);
    expect(r.lines).toEqual([2, 4, 5, 7]);
  });

  test("unclosed fence reports odd count", () => {
    const r = checkFenceBalance("文本\n```\ncode\n");
    expect(r.fences).toBe(1);
    expect(r.lines).toEqual([2]);
  });

  test("inline ticks are not fences; indented fence lines count", () => {
    // 行内 ``` 不算；缩进 fence（列表内嵌等）算——宁可多报不可漏报。
    const r = checkFenceBalance("`inline`\n  ```go\nx\n  ```\n");
    expect(r.fences).toBe(2);
    expect(r.lines).toEqual([2, 4]);
  });

  test("worsened only when even → odd", () => {
    expect(worsenedFenceImbalance({ fences: 4 }, { fences: 5 })).toBe(true);
    expect(worsenedFenceImbalance({ fences: 4 }, { fences: 6 })).toBe(false);
    expect(worsenedFenceImbalance({ fences: 5 }, { fences: 5 })).toBe(false);
    expect(worsenedFenceImbalance({ fences: 5 }, { fences: 4 })).toBe(false);
  });
});

describe("markdown fence guard (patched @oh-my-pi/hashline)", () => {
  test("adjacent fenced blocks: correct range + complete payload is NOT repaired", async () => {
    // The reported damage: SWAP covers a whole fenced block (fences included)
    // and the payload legitimately restates both fences, while the surviving
    // line below the range is the NEXT block's opening fence. The old echo
    // logic treated the payload's trailing ``` as a restated boundary and
    // dropped it, leaving the block unclosed and shifting every later fence
    // pair. The fence guard keeps the payload verbatim.
    const { after, echoRepairWarnings } = await applySwap(
      "文本\n```\ncode A\n```\n```\ncode B\n```\n",
      "SWAP 2.=4:",
      ["```", "newA", "newA2", "```"],
    );
    expect(echoRepairWarnings).toEqual([]);
    expect(after).toBe(
      "文本\n```\nnewA\nnewA2\n```\n```\ncode B\n```\n",
    );
  });

  test("adjacent fenced blocks, three in a row: NOT repaired", async () => {
    const { after, echoRepairWarnings } = await applySwap(
      "文本\n```\ncode A\n```\n```\ncode B\n```\n```\ncode C\n```\n",
      "SWAP 2.=4:",
      ["```", "newA", "newA2", "```"],
    );
    expect(echoRepairWarnings).toEqual([]);
    expect(after).toBe(
      "文本\n```\nnewA\nnewA2\n```\n```\ncode B\n```\n```\ncode C\n```\n",
    );
  });

  test("range short of the fence, payload restates it: still repaired", async () => {
    // Model picked only the content line (no fences) but payload carries the
    // full block. Both edges echo the surviving fences → two-sided echo still
    // fires and absorbs the off-by-one (the fence guard only protects the
    // case where the RANGE itself contains fences).
    const { after, echoRepairWarnings } = await applySwap(
      "文本\n```\ncode A\n```\n",
      "SWAP 3.=3:",
      ["```", "newA", "```"],
    );
    expect(echoRepairWarnings).toHaveLength(1);
    expect(after).toBe("文本\n```\nnewA\n```\n");
  });

  test("range missing the closing fence, payload complete: trailing echo still repaired", async () => {
    // Range = opening fence + content (closing fence survives below). The
    // leading edge is guarded (range's first line is a fence) but the trailing
    // edge is not (range's last line is content) → repair drops the payload's
    // duplicated closing fence and the surviving one closes the block.
    const { after, echoRepairWarnings } = await applySwap(
      "文本\n\n```\ncode A\n```\n",
      "SWAP 3.=4:",
      ["```", "newA", "```"],
    );
    expect(echoRepairWarnings).toHaveLength(1);
    expect(after).toBe("文本\n\n```\nnewA\n```\n");
  });

  test("identical bare closers across adjacent tagged blocks: NOT repaired", async () => {
    // Stronger hit: range ends on ```, next surviving line is also ```
    // (the next block is bare-fenced). Guard must keep payload closer.
    const { after, echoRepairWarnings } = await applySwap(
      "文本\n```go\ncode A\n```\n```\ncode B\n```\n",
      "SWAP 2.=4:",
      ["```go", "newA", "newA2", "```"],
    );
    expect(echoRepairWarnings).toEqual([]);
    expect(after).toBe(
      "文本\n```go\nnewA\nnewA2\n```\n```\ncode B\n```\n",
    );
  });
});
