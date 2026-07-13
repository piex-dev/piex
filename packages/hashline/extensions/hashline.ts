/**
 * hashline extension — overrides the built-in `edit` tool with hashline
 * patch language editing, and hooks `read` tool results to inject snapshot
 * headers for tag-verified edits.
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
  formatHashlineHeader,
  normalizeToLF,
  stripBom,
} = hashline;
import { PiexNodeFilesystem, canonicalSnapshotKey } from "./filesystem.js";

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
  try {
    const raw = await fsp.readFile(absolutePath, "utf-8");
    const { text } = stripBom(raw);
    const normalized = normalizeToLF(text);
    const key = canonicalSnapshotKey(absolutePath);
    if (seenLines && seenLines.length > 0) {
      return store.record(key, normalized, seenLines);
    }
    return store.record(key, normalized);
  } catch {
    return null;
  }
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

      // Parse the hashline input
      let patch: Patch;
      try {
        patch = Patch.parse(params.input, { cwd });
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

      // Use PiexNodeFilesystem: node:fs I/O, symlink-resolving canonicalPath
      const patcher = new Patcher({
        fs: new PiexNodeFilesystem(cwd),
        snapshots: store,
      });

      try {
        const result = await patcher.apply(patch);
        const parts: string[] = [];

        for (const section of result.sections) {
          if (section.op === "noop") {
            parts.push(
              `No changes to ${section.path}. ` +
              `The body rows are byte-identical to the file at the target lines — ` +
              `re-read the file with \`read\` to verify line numbers and latest content, then try again.`,
            );
            continue;
          }

          parts.push(section.header);
          const verb =
            section.op === "create" ? "created" :
            section.op === "delete" ? "deleted" :
            "updated";
          parts.push(`${verb}: ${section.path}`);

          // Record new snapshot after successful edit.
          // section.path may be relative to cwd — resolve it.
          await recordSnapshot(path.resolve(cwd, section.path));
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
