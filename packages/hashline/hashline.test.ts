/**
 * Unit tests for @piex-dev/hashline Phase 2 helpers (post-edit validation & echo).
 * Run: bun test packages/hashline/hashline.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  buildNumberedLineDiff,
  checkTagBalance,
  worsenedImbalances,
} from "./extensions/hashline.ts";

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
