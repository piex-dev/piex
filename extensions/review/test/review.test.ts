/**
 * Unit tests for @piex-dev/review path-arg normalization.
 * Run: bun test extensions/review/test/review.test.ts
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { __test__ } from "../src/review.ts";

const { takeFirstPathArg, normalizeRepoArg, resolveRepo } = __test__;

const here = path.dirname(fileURLToPath(import.meta.url));
const reviewPkgRoot = path.resolve(here, "..");
const monorepoRoot = path.resolve(reviewPkgRoot, "../..");

describe("takeFirstPathArg", () => {
  test("empty / whitespace", () => {
    expect(takeFirstPathArg("")).toBeUndefined();
    expect(takeFirstPathArg("   ")).toBeUndefined();
  });

  test("bare token", () => {
    expect(takeFirstPathArg("piex")).toBe("piex");
    expect(takeFirstPathArg("piex extra")).toBe("piex");
    expect(takeFirstPathArg("./path/to/repo")).toBe("./path/to/repo");
  });

  test("@ mention without quotes", () => {
    expect(takeFirstPathArg("@piex")).toBe("@piex");
    expect(takeFirstPathArg("@piex/")).toBe("@piex/");
    expect(takeFirstPathArg("@piex more")).toBe("@piex");
  });

  test("straight-quoted forms from pi autocomplete", () => {
    expect(takeFirstPathArg('"piex"')).toBe('"piex"');
    expect(takeFirstPathArg('@"piex"')).toBe('@"piex"');
    expect(takeFirstPathArg('@"piex/"')).toBe('@"piex/"');
    expect(takeFirstPathArg('@"my repo" trailing')).toBe('@"my repo"');
    expect(takeFirstPathArg("'piex'")).toBe("'piex'");
  });

  test("curly-quoted forms", () => {
    expect(takeFirstPathArg("\u201cpiex\u201d")).toBe("\u201cpiex\u201d");
    expect(takeFirstPathArg("@\u201cpiex\u201d")).toBe("@\u201cpiex\u201d");
  });
});

describe("normalizeRepoArg", () => {
  test("undefined / empty", () => {
    expect(normalizeRepoArg(undefined)).toBeUndefined();
    expect(normalizeRepoArg("")).toBeUndefined();
    expect(normalizeRepoArg("   ")).toBeUndefined();
  });

  test("bare path", () => {
    expect(normalizeRepoArg("piex")).toBe("piex");
    expect(normalizeRepoArg("./path/to/repo")).toBe("./path/to/repo");
  });

  test("strips @ prefix", () => {
    expect(normalizeRepoArg("@piex")).toBe("piex");
    expect(normalizeRepoArg("@piex/")).toBe("piex/");
    expect(normalizeRepoArg("@@piex")).toBe("piex");
  });

  test("strips straight quotes left by autocomplete after @ removal", () => {
    // This is the reported bug: /review @"piex" → "@ stripped → "piex"
    expect(normalizeRepoArg('"piex"')).toBe("piex");
    expect(normalizeRepoArg('@"piex"')).toBe("piex");
    expect(normalizeRepoArg('@"piex/"')).toBe("piex/");
    expect(normalizeRepoArg('"my repo"')).toBe("my repo");
    expect(normalizeRepoArg("'piex'")).toBe("piex");
  });

  test("strips curly quotes", () => {
    expect(normalizeRepoArg("\u201cpiex\u201d")).toBe("piex");
    expect(normalizeRepoArg("@\u201cpiex\u201d")).toBe("piex");
  });

  test("strips unbalanced leading quote, leaves bare trailing", () => {
    // Unbalanced opening quote (malformed autocomplete) is stripped so no
    // literal quote leaks into the path/error message.
    expect(normalizeRepoArg('"piex')).toBe("piex");
    expect(normalizeRepoArg('@"piex')).toBe("piex");
    // A bare trailing quote without a matching opener is left as-is (could be
    // a legitimate path character); autocomplete never produces this form.
    expect(normalizeRepoArg('piex"')).toBe('piex"');
  });
});

describe("resolveRepo", () => {
  test("resolves bare / @ / quoted forms to the same git root", () => {
    const expected = resolveRepo(monorepoRoot, "extensions/review");
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;

    const forms = [
      "extensions/review",
      "@extensions/review",
      "@extensions/review/",
      '"extensions/review"',
      '@"extensions/review"',
      '@"extensions/review/"',
      "\u201cextensions/review\u201d",
      "@\u201cextensions/review\u201d",
    ];

    for (const form of forms) {
      const got = resolveRepo(monorepoRoot, form);
      expect(got.ok, `form=${form}`).toBe(true);
      if (got.ok) {
        expect(got.path).toBe(expected.path);
      }
    }
  });

  test("reports a clean error for a missing path without keeping quotes", () => {
    const got = resolveRepo(monorepoRoot, '@"does-not-exist-xyz"');
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.error).toContain("does-not-exist-xyz");
    expect(got.error).not.toContain('"does-not-exist');
    expect(got.error).not.toMatch(/[“”]/);
  });
});
