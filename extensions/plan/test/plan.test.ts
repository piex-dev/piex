/**
 * Unit tests for @piex-dev/plan bash allowlist + plan parsing helpers.
 * Run: bun test extensions/plan/test/plan.test.ts
 */
import { describe, expect, test } from "bun:test";
import { __test__ } from "../src/plan.ts";

const {
  isSafeCommand,
  splitShellSegments,
  extractTodoItems,
  normalizePlanQuestions,
} = __test__;

// ── isSafeCommand: allowlisted read-only commands ───────────────

describe("isSafeCommand — allowed", () => {
  const allowed = [
    "ls",
    "ls -la",
    "cat README.md",
    "grep -r foo src/",
    "find . -name '*.ts'",
    "git status",
    "git log --oneline -10",
    "git diff --no-ext-diff --no-textconv",
    "git diff --check",
    "git show --no-textconv HEAD",
    "git branch",
    "git branch -a",
    "git remote -v",
    "git remote get-url origin",
    "git ls-files",
    "git rev-parse HEAD",
    "git grep pattern",
    "npm ls",
    "npm test",
    "tsc --noEmit",
    "cargo test",
    "rg pattern",
    "fd .ts",
    "jq '.name' package.json",
    "wc -l file.txt",
    "head -n 5 file",
    "tail -n 5 file",
    "stat file",
    "ps aux",
    "echo hello",
    "pwd",
  ];
  for (const cmd of allowed) {
    test(`allows: ${cmd}`, () => {
      expect(isSafeCommand(cmd)).toBe(true);
    });
  }
});

// ── isSafeCommand: blocked destructive commands ─────────────────

describe("isSafeCommand — blocked destructive", () => {
  const blocked = [
    "rm file",
    "rm -rf /",
    "rmdir dir",
    "mv a b",
    "cp a b",
    "mkdir d",
    "touch f",
    "chmod 755 f",
    "chown user f",
    "ln -s a b",
    "tee f",
    "truncate -s 0 f",
    "dd if=/dev/zero of=f",
    "shred f",
    "sudo rm file",
    "su root",
    "kill 1234",
    "pkill node",
    "killall node",
    "reboot",
    "shutdown -h now",
    "vim file",
    "nano file",
    "code .",
  ];
  for (const cmd of blocked) {
    test(`blocks: ${cmd}`, () => {
      expect(isSafeCommand(cmd)).toBe(false);
    });
  }
});

// ── isSafeCommand: bypass vectors rejected ──────────────────────

describe("isSafeCommand — bypass vectors", () => {
  const blocked = [
    // redirection
    "echo x > file",
    "echo x >> file",
    "cat f < input",
    // subshell / command substitution / backtick
    "echo $(rm file)",
    "echo `rm file`",
    "(rm file)",
    "rm file",
    // variable assignment / expansion
    "FOO=x rm file",
    "echo $HOME",
    "echo ${HOME}",
    "rm $FILE",
    // glob
    "rm *",
    "ls ?",
    "echo [abc]",
    "echo {a,b}",
    // pipeline/list with destructive second segment
    "ls; rm file",
    "ls && rm file",
    "ls | rm file",
    "ls || rm file",
    // background operator
    "rm file &",
    // npm/cargo mutating
    "npm install",
    "npm uninstall x",
    "npm publish",
    "cargo build",
    // git mutating
    "git add .",
    "git commit -m x",
    "git push",
    "git reset --hard",
    "git checkout -b branch",
    "git branch -d name",
    "git branch -m newname",
    // find exec/delete
    "find . -exec rm {} ;",
    "find . -delete",
    "find . -execdir rm {} ;",
    // sed in-place
    "sed -i 's/a/b/' f",
    "sed --in-place 's/a/b/' f",
    // sort output
    "sort -o f input",
    "sort --output=f input",
    // date set
    "date -s 'tomorrow'",
    // tsc emit/incremental
    "tsc",
    "tsc --incremental",
    "tsc --generateTrace out",
    // npm audit fix
    "npm audit fix",
    // fd exec
    "fd .ts -x rm",
    "fd .ts --exec rm",
    // rg pre (runs arbitrary command)
    "rg pattern --pre=evil",
    // git textconv / ext-diff / output / pager bypasses
    "git show HEAD",
    "git log -p",
    "git log --patch",
    "git diff --output=f",
    "git grep -O pattern",
    "git log --ext-diff",
    "git show --textconv HEAD",
    "git cat-file --filters HEAD",
  ];
  for (const cmd of blocked) {
    test(`blocks: ${cmd}`, () => {
      expect(isSafeCommand(cmd)).toBe(false);
    });
  }
});

// ── splitShellSegments ──────────────────────────────────────────

describe("splitShellSegments", () => {
  test("single command → one segment", () => {
    expect(splitShellSegments("ls -la")).toEqual(["ls -la"]);
  });
  test("semicolon splits", () => {
    expect(splitShellSegments("ls; pwd")).toEqual(["ls", "pwd"]);
  });
  test("pipe splits", () => {
    expect(splitShellSegments("ls | grep foo")).toEqual(["ls", "grep foo"]);
  });
  test("&& splits", () => {
    expect(splitShellSegments("ls && pwd")).toEqual(["ls", "pwd"]);
  });
  test("|| splits", () => {
    expect(splitShellSegments("ls || pwd")).toEqual(["ls", "pwd"]);
  });
  test("quoted separator is not split", () => {
    expect(splitShellSegments("echo 'a; b'")).toEqual(["echo 'a; b'"]);
  });
  test("escaped separator is not split", () => {
    expect(splitShellSegments("echo a\\;b")).toEqual(["echo a\\;b"]);
  });
  test("newline rejected", () => {
    expect(splitShellSegments("ls\npwd")).toBeUndefined();
  });
  test("backtick rejected", () => {
    expect(splitShellSegments("echo `x`")).toBeUndefined();
  });
  test("unterminated quote rejected", () => {
    expect(splitShellSegments("echo 'unclosed")).toBeUndefined();
  });
  test("trailing escape rejected", () => {
    expect(splitShellSegments("echo x\\")).toBeUndefined();
  });
  test("empty segment rejected (leading ;)", () => {
    expect(splitShellSegments(";ls")).toBeUndefined();
  });
  test("empty input rejected", () => {
    expect(splitShellSegments("   ")).toBeUndefined();
  });
});

// ── extractTodoItems ────────────────────────────────────────────

describe("extractTodoItems", () => {
  test("numbered Plan: list", () => {
    const plan = "Plan:\n1. First step\n2. Second step\n3. Third step";
    const items = extractTodoItems(plan);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      step: 1,
      text: "First step",
      completed: false,
    });
    expect(items[2]).toMatchObject({
      step: 3,
      text: "Third step",
      completed: false,
    });
  });
  test("no Plan: heading → empty", () => {
    expect(extractTodoItems("1. not a plan")).toEqual([]);
  });
  test("short step text (<6 chars) is filtered out", () => {
    // Steps must be descriptive enough (>5 chars) to avoid capturing noise.
    expect(extractTodoItems("Plan:\n1. A\n2. B")).toEqual([]);
  });
});

// ── normalizePlanQuestions ──────────────────────────────────────

describe("normalizePlanQuestions", () => {
  test("valid single question", () => {
    const result = normalizePlanQuestions({
      questions: [
        {
          id: "framework",
          header: "Framework",
          question: "Which framework?",
          options: [
            { label: "React", description: "React app" },
            { label: "Vue", description: "Vue app" },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.questions).toHaveLength(1);
      expect(result.questions[0].options).toHaveLength(2);
    }
  });
  test("valid three questions with four options", () => {
    const result = normalizePlanQuestions({
      questions: [
        {
          id: "a",
          header: "A",
          question: "q1?",
          options: [
            { label: "1", description: "d1" },
            { label: "2", description: "d2" },
            { label: "3", description: "d3" },
            { label: "4", description: "d4" },
          ],
        },
        {
          id: "b",
          header: "B",
          question: "q2?",
          options: [
            { label: "x", description: "dx" },
            { label: "y", description: "dy" },
          ],
        },
        {
          id: "c",
          header: "C",
          question: "q3?",
          options: [
            { label: "p", description: "dp" },
            { label: "q", description: "dq" },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
  });
  test("rejects empty questions array", () => {
    expect(normalizePlanQuestions({ questions: [] }).ok).toBe(false);
  });
  test("rejects more than 3 questions", () => {
    const result = normalizePlanQuestions({
      questions: [1, 2, 3, 4].map((n) => ({
        id: `q${n}`,
        header: `Q${n}`,
        question: "q?",
        options: [
          { label: "a", description: "d" },
          { label: "b", description: "d" },
        ],
      })),
    });
    expect(result.ok).toBe(false);
  });
  test("rejects single-option question", () => {
    const result = normalizePlanQuestions({
      questions: [
        {
          id: "x",
          header: "X",
          question: "q?",
          options: [{ label: "a", description: "d" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });
  test("rejects more than 4 options", () => {
    const result = normalizePlanQuestions({
      questions: [
        {
          id: "x",
          header: "X",
          question: "q?",
          options: [1, 2, 3, 4, 5].map((n) => ({
            label: `${n}`,
            description: "d",
          })),
        },
      ],
    });
    expect(result.ok).toBe(false);
  });
  test("rejects missing id", () => {
    const result = normalizePlanQuestions({
      questions: [
        {
          header: "X",
          question: "q?",
          options: [
            { label: "a", description: "d" },
            { label: "b", description: "d" },
          ],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });
  test("rejects empty string fields", () => {
    const result = normalizePlanQuestions({
      questions: [
        {
          id: "  ",
          header: "X",
          question: "q?",
          options: [
            { label: "a", description: "d" },
            { label: "b", description: "d" },
          ],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });
  test("rejects non-array questions", () => {
    expect(normalizePlanQuestions({ questions: "not array" }).ok).toBe(false);
  });
  test("rejects non-object input", () => {
    expect(normalizePlanQuestions(null).ok).toBe(false);
    expect(normalizePlanQuestions("string").ok).toBe(false);
    expect(normalizePlanQuestions(undefined).ok).toBe(false);
  });
});
