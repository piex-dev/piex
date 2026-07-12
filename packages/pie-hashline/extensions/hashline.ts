/**
 * pie-hashline extension — overrides the built-in `edit` tool with hashline
 * patch language editing, and hooks `read` tool results to inject snapshot
 * headers for tag-verified edits.
 *
 * Install:
 *   pi install npm:@debugtalk/pie-hashline
 * Try:
 *   pi -e ./extensions/hashline.ts
 *
 * Works on both Node.js (via polyfill) and Bun (native).
 */

// Load Bun polyfill BEFORE @oh-my-pi/hashline imports (for Node.js compatibility)
import "./bun-polyfill.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Dynamic import to ensure polyfill is loaded first (ES module hoisting workaround)
const hashline = await import("@oh-my-pi/hashline");
const {
  InMemorySnapshotStore,
  NodeFilesystem,
  Patcher,
  Patch,
  MismatchError,
  formatHashlineHeader,
  normalizeToLF,
  stripBom,
} = hashline;
import { Type } from "typebox";
import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Snapshot store singleton — shared between edit and read hook
// ---------------------------------------------------------------------------

const store = new InMemorySnapshotStore();

// ---------------------------------------------------------------------------
// Prompt — read from @oh-my-pi/hashline package at load time
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);
const promptPath = _require.resolve("@oh-my-pi/hashline/prompt.md");
const HASHLINE_PROMPT = readFileSync(promptPath, "utf-8");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function recordFileSnapshot(
  filePath: string,
  worktree: string,
): Promise<string | null> {
  const absolutePath = path.resolve(worktree, filePath);
  try {
    const raw = await fs.readFile(absolutePath, "utf-8");
    const { text } = stripBom(raw);
    const normalized = normalizeToLF(text);
    return store.record(absolutePath, normalized);
  } catch {
    return null;
  }
}

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
      const fsys = new NodeFilesystem();
      const worktree = ctx.cwd;

      let patch: Patch;
      try {
        patch = Patch.parse(params.input, { cwd: worktree });
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

      const patcher = new Patcher({ fs: fsys, snapshots: store });

      try {
        const result = await patcher.apply(patch);
        const parts: string[] = [];

        for (const section of result.sections) {
          if (section.op === "noop") {
            parts.push(`No changes to ${section.path}. Re-read the file and try again.`);
            continue;
          }

          parts.push(section.header);
          parts.push(
            `${section.op === "create" ? "created" : "updated"}: ${section.path}`,
          );
          // Record new snapshot after successful edit
          await recordFileSnapshot(section.path, worktree);
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
                text: `Tag mismatch on ${err.path}: the file has changed since you last read it (expected #${err.expectedFileHash}, got #${err.actualFileHash}). Re-read the file and try again.`,
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

    // Extract file path from read tool input
    const input = event.input as { path?: string } | undefined;
    const filePath = input?.path;
    if (!filePath) return;

    const tag = await recordFileSnapshot(filePath, ctx.cwd);
    if (!tag) return;

    // Prepend hashline header to existing content
    const header = formatHashlineHeader(filePath, tag);
    const existingContent = Array.isArray(event.content)
      ? event.content
      : [{ type: "text", text: String(event.content ?? "") }];

    // Find the first text content block and prepend header
    const firstTextIdx = existingContent.findIndex(
      (c: any) => c.type === "text",
    );
    if (firstTextIdx >= 0) {
      const updated = [...existingContent];
      updated[firstTextIdx] = {
        ...updated[firstTextIdx],
        text: `${header}\n${updated[firstTextIdx].text}`,
      };
      return { content: updated };
    }

    // No text block — prepend a new one
    return {
      content: [{ type: "text", text: header }, ...existingContent],
    };
  });
}
