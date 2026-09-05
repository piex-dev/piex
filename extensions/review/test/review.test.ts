/**
 * Unit tests for @piex-dev/review path-arg normalization.
 * Run: bun test extensions/review/test/review.test.ts
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import reviewExtension, { __test__ } from "../src/review-v2.ts";

const {
  takeFirstPathArg,
  parseRepoArgs,
  normalizeRepoArg,
  resolveRepo,
  resolveRepos,
  canCompareToBase,
} = __test__;

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

describe("review progress presenter", () => {
  test("uses the detailed widget without duplicating status in TUI", () => {
    const statuses: Array<[string, string | undefined]> = [];
    const widgets: Array<[string, string[] | undefined]> = [];
    const updates: Array<{
      content?: Array<{ text?: string }>;
      details?: { running?: boolean };
    }> = [];
    const presenter = __test__.createProgressPresenter(
      {
        hasUI: true,
        mode: "tui",
        ui: {
          setStatus: (key: string, text: string | undefined) =>
            statuses.push([key, text]),
          setWidget: (key: string, lines: string[] | undefined) =>
            widgets.push([key, lines]),
        },
      } as never,
      (update) => updates.push(update),
    );

    presenter.report({ type: "phase", phase: "reviewing" });
    presenter.report({
      type: "reviewer_started",
      reviewer: {
        role: "lead",
        model: "openai-codex/gpt-5.6-sol",
        thinkingLevel: "xhigh",
      },
    });
    presenter.report({
      type: "reviewer_activity",
      role: "lead",
      state: "using_tool",
      activity: "reading src/reviewer.ts",
      toolStarted: true,
    });

    expect(statuses).toHaveLength(0);
    expect(widgets.at(-1)?.[1]?.join("\n")).toContain(
      "lead · openai-codex/gpt-5.6-sol · thinking xhigh",
    );
    expect(widgets.at(-1)?.[1]?.join("\n")).toContain("/review-log");
    expect(updates.at(-1)?.content?.[0]?.text).toContain(
      "openai-codex/gpt-5.6-sol",
    );
    presenter.report({ type: "phase", phase: "complete" });
    expect(updates.at(-1)?.details?.running).toBeFalse();

    presenter.dispose();
    expect(statuses).toHaveLength(0);
    expect(widgets.at(-1)?.[1]).toBeUndefined();
  });

  test("uses compact status as the non-TUI fallback", () => {
    const statuses: Array<[string, string | undefined]> = [];
    const widgets: Array<[string, string[] | undefined]> = [];
    const presenter = __test__.createProgressPresenter({
      hasUI: true,
      mode: "rpc",
      ui: {
        setStatus: (key: string, text: string | undefined) =>
          statuses.push([key, text]),
        setWidget: (key: string, lines: string[] | undefined) =>
          widgets.push([key, lines]),
      },
    } as never);

    presenter.report({ type: "phase", phase: "reviewing" });
    presenter.report({
      type: "reviewer_started",
      reviewer: {
        role: "lead",
        model: "openai-codex/gpt-5.6-sol",
        thinkingLevel: "xhigh",
      },
    });

    expect(statuses.at(-1)?.[1]).toContain(
      "lead openai-codex/gpt-5.6-sol · thinking xhigh",
    );
    expect(widgets).toHaveLength(0);
    presenter.dispose();
    expect(statuses.at(-1)?.[1]).toBeUndefined();
  });
});

describe("stable review scope", () => {
  const scope = (diffHash: string) => ({ diffHash }) as never;

  test("restarts once against the latest diff", async () => {
    const attempts: string[] = [];
    const refreshes: string[] = [];
    const recaptures = [scope("changed"), scope("changed")];
    const result = await __test__.runWithStableReviewScope(
      scope("initial"),
      async (current) => {
        attempts.push(current.diffHash);
        return current.diffHash;
      },
      {
        recapture: () => recaptures.shift()!,
        onRefresh: (current, attempt, maxAttempts) =>
          refreshes.push(`${current.diffHash}:${attempt}/${maxAttempts}`),
      },
    );

    expect(attempts).toEqual(["initial", "changed"]);
    expect(refreshes).toEqual(["changed:2/2"]);
    expect(result).toEqual({ scope: scope("changed"), value: "changed" });
  });

  test("fails after the bounded retry if changes keep moving", async () => {
    const attempts: string[] = [];
    const recaptures = [scope("second"), scope("third")];

    await expect(
      __test__.runWithStableReviewScope(
        scope("first"),
        async (current) => {
          attempts.push(current.diffHash);
          return current.diffHash;
        },
        { recapture: () => recaptures.shift()! },
      ),
    ).rejects.toThrow(/automatic retry was already used/);
    expect(attempts).toEqual(["first", "second"]);
  });
});

describe("interactive review scope selection", () => {
  test("maps the direct scope choices", async () => {
    const cases = [
      ["All current work", "auto"],
      ["Uncommitted changes", "working-tree"],
      ["Staged changes", "staged"],
    ] as const;

    for (const [prefix, kind] of cases) {
      const selected = await __test__.selectInteractiveReviewScope(
        {
          cwd: "/workspace",
          ui: {
            select: async (_title: string, choices: string[]) =>
              choices.find((choice) => choice.startsWith(prefix)),
          },
        } as never,
        ["/workspace/repo"],
      );
      expect(selected).toEqual({ kind });
    }
  });

  test("collects parameters for branch, commit, file, and custom focus", async () => {
    const cases = [
      ["Changes vs", "main", { kind: "branch", base: "main" }],
      ["Specific commit", "HEAD~1", { kind: "commit", commit: "HEAD~1" }],
      ["Specific file", "src/app.ts", { kind: "file", file: "src/app.ts" }],
      [
        "All current work with",
        "focus on cancellation",
        { kind: "auto", instructions: "focus on cancellation" },
      ],
    ] as const;

    for (const [prefix, input, expected] of cases) {
      const selected = await __test__.selectInteractiveReviewScope(
        {
          cwd: "/workspace",
          ui: {
            select: async (_title: string, choices: string[]) =>
              choices.find((choice) => choice.startsWith(prefix)),
            input: async () => input,
          },
        } as never,
        ["/workspace/repo"],
      );
      expect(selected).toEqual(expected);
    }
  });

  test("hides commit and file scopes for linked multi-repo review", async () => {
    let offered: string[] = [];
    const selected = await __test__.selectInteractiveReviewScope(
      {
        cwd: "/workspace",
        ui: {
          select: async (_title: string, choices: string[]) => {
            offered = choices;
            return undefined;
          },
        },
      } as never,
      ["/workspace/one", "/workspace/two"],
    );

    expect(selected).toBeUndefined();
    expect(offered.some((choice) => choice.startsWith("Specific commit"))).toBe(
      false,
    );
    expect(offered.some((choice) => choice.startsWith("Specific file"))).toBe(
      false,
    );
  });

  test("releases the execution gate when scope selection is cancelled", async () => {
    let reviewHandler:
      ((args: string, ctx: unknown) => Promise<void>) | undefined;
    reviewExtension({
      on: () => {},
      registerCommand: (
        name: string,
        command: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) => {
        if (name === "review") reviewHandler = command.handler;
      },
      registerShortcut: () => {},
      registerTool: () => {},
    } as never);
    let selections = 0;
    const ctx = {
      cwd: monorepoRoot,
      hasUI: true,
      mode: "tui",
      ui: {
        notify: () => {},
        select: async () => {
          selections += 1;
          return undefined;
        },
      },
    };

    expect(reviewHandler).toBeFunction();
    await reviewHandler!("", ctx);
    await reviewHandler!("", ctx);
    expect(selections).toBe(2);
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

describe("parseRepoArgs", () => {
  test("empty / whitespace", () => {
    expect(parseRepoArgs("")).toEqual([]);
    expect(parseRepoArgs("   ")).toEqual([]);
    expect(parseRepoArgs("  \t\n ")).toEqual([]);
  });

  test("single bare token", () => {
    expect(parseRepoArgs("piex")).toEqual(["piex"]);
    expect(parseRepoArgs("./path/to/repo")).toEqual(["./path/to/repo"]);
  });

  test("multiple bare tokens", () => {
    expect(parseRepoArgs("piex oh-my-pi")).toEqual(["piex", "oh-my-pi"]);
    expect(parseRepoArgs("  piex   oh-my-pi  ")).toEqual(["piex", "oh-my-pi"]);
  });

  test('multiple straight-quoted tokens (the /review "a" "b" form)', () => {
    // Tokens stay RAW (quotes/@ intact) — normalization happens in resolveRepo,
    // mirroring takeFirstPathArg which returns '"piex"' verbatim.
    expect(parseRepoArgs('"piex" "oh-my-pi"')).toEqual([
      '"piex"',
      '"oh-my-pi"',
    ]);
    expect(parseRepoArgs('@"piex" @"oh-my-pi"')).toEqual([
      '@"piex"',
      '@"oh-my-pi"',
    ]);
  });

  test("quoted tokens containing spaces", () => {
    expect(parseRepoArgs('"my repo" "other repo"')).toEqual([
      '"my repo"',
      '"other repo"',
    ]);
    expect(parseRepoArgs('@"my repo" plain')).toEqual(['@"my repo"', "plain"]);
  });

  test("@-prefixed tokens, mixed forms", () => {
    expect(parseRepoArgs("@piex @oh-my-pi")).toEqual(["@piex", "@oh-my-pi"]);
    expect(parseRepoArgs('piex @"oh-my-pi" @extensions/review')).toEqual([
      "piex",
      '@"oh-my-pi"',
      "@extensions/review",
    ]);
  });

  test("curly-quoted tokens", () => {
    expect(parseRepoArgs("\u201cpiex\u201d \u201coh-my-pi\u201d")).toEqual([
      "\u201cpiex\u201d",
      "\u201coh-my-pi\u201d",
    ]);
    expect(parseRepoArgs("@\u201cpiex\u201d @\u201coh-my-pi\u201d")).toEqual([
      "@\u201cpiex\u201d",
      "@\u201coh-my-pi\u201d",
    ]);
  });

  test("unbalanced opening quote swallows rest of string as one token", () => {
    expect(parseRepoArgs('@"piex')).toEqual(['@"piex']);
    expect(parseRepoArgs('piex @"oh-my-pi')).toEqual(["piex", '@"oh-my-pi']);
  });

  test("trailing @-prefix slashes survive (resolved later by resolveRepo)", () => {
    expect(parseRepoArgs("@piex/ @oh-my-pi/")).toEqual([
      "@piex/",
      "@oh-my-pi/",
    ]);
  });

  test("takeFirstPathArg stays consistent with parseRepoArgs[0]", () => {
    const samples = [
      "",
      "piex",
      "piex oh-my-pi",
      '"piex" "oh-my-pi"',
      "@piex more",
      '@"my repo" trailing',
      "\u201cpiex\u201d",
    ];
    for (const s of samples) {
      expect(takeFirstPathArg(s)).toBe(parseRepoArgs(s)[0]);
    }
  });
});

describe("resolveRepos", () => {
  test("resolves multiple subpaths to (deduped) git roots", () => {
    const single = resolveRepo(monorepoRoot, "extensions/review");
    expect(single.ok).toBe(true);
    if (!single.ok) return;

    const got = resolveRepos(monorepoRoot, [
      "extensions/review",
      "extensions/hashline",
    ]);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // Both subpaths are inside the same piex git repo → dedup to one root.
    expect(got.repos.length).toBe(1);
    expect(got.repos[0]).toBe(single.path);
  });

  test('accepts mixed @/quoted/bare forms like /review "a" "b"', () => {
    const forms = [
      "extensions/review",
      "@extensions/review",
      '"extensions/review"',
      '@"extensions/review"',
      "\u201cextensions/review\u201d",
    ];
    const got = resolveRepos(monorepoRoot, forms);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.repos.length).toBe(1); // all resolve to the same root
  });

  test("collects every failure when any path is invalid (abort-all)", () => {
    const got = resolveRepos(monorepoRoot, [
      "extensions/review", // valid
      '@"does-not-exist-aaa"', // invalid
      "also-missing-bbb", // invalid
    ]);
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.errors.length).toBe(2);
    expect(got.errors.join("\n")).toContain("does-not-exist-aaa");
    expect(got.errors.join("\n")).toContain("also-missing-bbb");
    // No literal quotes leak into the error messages.
    expect(got.errors.join("\n")).not.toContain('"does-not-exist');
  });

  test("empty input resolves to zero repos (ok)", () => {
    const got = resolveRepos(monorepoRoot, []);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.repos).toEqual([]);
  });
});

describe("canCompareToBase", () => {
  test("false for a base ref that does not exist", () => {
    // Deterministic: no such remote branch can exist in the monorepo.
    expect(
      canCompareToBase(monorepoRoot, "does-not-exist-review-test-xyz"),
    ).toBe(false);
  });

  test("false for a path that is not a git repo", () => {
    // /tmp is not a git repo → git() fail-softs to "" → not comparable.
    expect(canCompareToBase("/tmp", "main")).toBe(false);
  });

  test("true for origin/HEAD in a clone with a remote", () => {
    // origin/HEAD always resolves in a normal clone with a remote — a
    // deterministic "real ref" to exercise the success path (base="HEAD"
    // → checks `origin/HEAD`).
    const single = resolveRepo(monorepoRoot, "extensions/review");
    expect(single.ok).toBe(true);
    if (!single.ok) return;
    expect(canCompareToBase(single.path, "HEAD")).toBe(true);
  });
});

describe("review tool result details", () => {
  test("describes the reviewed scope, not the pre-refresh request", () => {
    const request = { kind: "auto" as const };
    const execution = {
      scope: {
        scopeKey: "refreshed-scope",
        diffHash: "refreshed-diff",
        repos: [],
      },
      report: {
        verdict: "pass",
        summary: "clean",
        reviewers: [{ role: "lead" }],
      },
    } as never;
    const details = __test__.buildReviewToolDetails(request, execution);
    expect(details.scopeKey).toBe("refreshed-scope");
    expect(details.diffHash).toBe("refreshed-diff");
    expect(details.found).toBe(true);
    expect(details.action).toBe("auto");
  });
});

describe("review result persistence", () => {
  test("keeps a completed report when persistence fails", () => {
    const pi = {
      appendEntry: () => {
        throw new Error("disk full");
      },
    } as never;
    const execution = {
      scope: {},
      report: { verdict: "pass", summary: "clean" },
      run: {
        version: 1,
        createdAt: "now",
        scopeKey: "scope",
        diffHash: "diff",
        reviewerModel: "provider/reviewer",
        report: { verdict: "pass", summary: "clean" },
      },
    };
    const warning = __test__.persistReview(pi, execution as never);
    expect(warning).toMatch(/could not be stored/);
    expect(warning).toMatch(/disk full/);
    expect(
      __test__.persistReview(pi, {
        ...execution,
        run: undefined,
      } as never),
    ).toBe(undefined);
  });
});
