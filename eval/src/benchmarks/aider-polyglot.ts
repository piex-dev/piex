import type { Task } from "../types.ts";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const SAMPLE_TASKS: Task[] = [
  {
    id: "hello-world",
    prompt:
      'Write a Python function `greet(name)` in hello.py that returns "Hello, {name}!". Use an f-string.',
    files: { "hello.py": "# implement greet here\n" },
    test_cmd:
      "python3 -c \"import hello; assert hello.greet('World') == 'Hello, World!'\"",
    language: "python",
  },
  {
    id: "fibonacci",
    prompt:
      "Implement a Python function `fib(n)` in fib.py that returns the nth Fibonacci number (0-indexed, fib(0)=0, fib(1)=1, fib(2)=1).",
    files: { "fib.py": "# implement fib here\n" },
    test_cmd:
      'python3 -c "import fib; assert fib.fib(0) == 0; assert fib.fib(1) == 1; assert fib.fib(10) == 55"',
    language: "python",
  },
  {
    id: "word-count",
    prompt:
      "Write a Python function `count_words(text)` in wc.py that returns the number of words in the input string. Words are separated by whitespace.",
    files: { "wc.py": "# implement count_words here\n" },
    test_cmd:
      "python3 -c \"import wc; assert wc.count_words('hello world') == 2; assert wc.count_words('one') == 1; assert wc.count_words('') == 0\"",
    language: "python",
  },
  {
    id: "palindrome",
    prompt:
      'Write a Python function `is_palindrome(s)` in palindrome.py that returns True if the string is a palindrome (case-insensitive, ignore spaces). Example: "A man a plan a canal Panama" should return True.',
    files: { "palindrome.py": "# implement is_palindrome here\n" },
    test_cmd:
      "python3 -c \"import palindrome; assert palindrome.is_palindrome('racecar') == True; assert palindrome.is_palindrome('hello') == False; assert palindrome.is_palindrome('A man a plan a canal Panama') == True\"",
    language: "python",
  },
  {
    id: "fizzbuzz",
    prompt:
      'Write a Python function `fizzbuzz(n)` in fizzbuzz.py that returns a list of strings. For each number from 1 to n: if divisible by 3 use "Fizz", by 5 use "Buzz", by both use "FizzBuzz", otherwise use the number as string.',
    files: { "fizzbuzz.py": "# implement fizzbuzz here\n" },
    test_cmd:
      "python3 -c \"import fizzbuzz; assert fizzbuzz.fizzbuzz(5) == ['1', '2', 'Fizz', '4', 'Buzz']\"",
    language: "python",
  },
  {
    id: "grep-js",
    prompt:
      "Write a JavaScript function `grep(lines, pattern)` in grep.js. It takes an array of strings and a pattern, and returns a new array containing only the lines that include the pattern (case-insensitive). Export using module.exports = grep.",
    files: { "grep.js": "// implement grep here\n" },
    test_cmd:
      "node -e \"const g = require('./grep.js'); const r = g(['hello', 'HELLO world', 'hi'], 'hello'); console.assert(r.length === 2, 'expected 2'); console.log('ok')\"",
    language: "javascript",
  },
];

export function loadAiderPolyglot(source?: string): Task[] {
  if (source && existsSync(source)) {
    const tasks: Task[] = [];
    const content = readFileSync(source, "utf-8");
    for (let i = 0; i < content.split("\n").length; i++) {
      const line = content.split("\n")[i];
      if (!line.trim()) continue;
      try {
        tasks.push(JSON.parse(line) as Task);
      } catch {
        console.error(
          `  Warning: skipping invalid JSONL line ${i + 1} in ${source}`,
        );
      }
    }
    return tasks;
  }

  const fixturePath = resolve(
    import.meta.dirname,
    "../../fixtures/tasks/polyglot.jsonl",
  );
  if (existsSync(fixturePath)) {
    return loadAiderPolyglot(fixturePath);
  }

  return SAMPLE_TASKS;
}
