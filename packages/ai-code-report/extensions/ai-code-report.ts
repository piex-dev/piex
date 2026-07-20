/**
 * ai-code-report extension — AI code edit telemetry for pi.
 *
 * Direct TEA SDK integration. Event mapping:
 *   tool_result (write/edit) → dev_agent_tool_call (per-line, accept_content)
 *   tool_result (bash mv/cp) → dev_agent_bash_call
 *   turn_end (non-edit tools) → dev_agent_tool_call
 *   turn_end (MCP tools)      → dev_agent_mcp_call
 *   turn_end                  → dev_agent_user_ask + dev_agent_tokens_collect
 *
 *   pi install npm:@piex-dev/ai-code-report
 *
 * Dependencies: @dp/tea-sdk-node (TEA SDK), @logsdk/node-plugin-http (transport), diff.
 */

import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { TeaSDK } from "@dp/tea-sdk-node";
import { httpPlugin } from "@logsdk/node-plugin-http";
import * as diff from "diff";
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

// ══════════════════════════════════════════════════════════════════════════
// TEA Reporter — minimal singleton
// ══════════════════════════════════════════════════════════════════════════

const TEA_APP_ID = process.env.TEA_APP_ID || "1220";
const TEA_CHANNEL = process.env.TEA_CHANNEL || "cn";

let _sdk: TeaSDK | null = null;

function getSdk(): TeaSDK {
  if (!_sdk) {
    _sdk = new TeaSDK({ app_id: Number(TEA_APP_ID) });
    _sdk.use(httpPlugin({ channel: TEA_CHANNEL, retry: 3 }));
  }
  return _sdk;
}

function ensureUuid(params: Record<string, unknown>): string {
  return String(
    params.uuid || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
}

const DEBUG_LOG_MAX_FIELD = 200; // max chars for input/output/accept_content in debug log

function debugParams(
  event: string,
  params: Record<string, unknown>,
  uuid: string,
): Record<string, unknown> {
  const safe: Record<string, unknown> = { event };
  for (const [k, v] of Object.entries(params)) {
    if (
      typeof v === "string" &&
      (k === "input" || k === "output" || k === "accept_content")
    ) {
      safe[k] =
        v.length > DEBUG_LOG_MAX_FIELD
          ? v.slice(0, DEBUG_LOG_MAX_FIELD) + "…"
          : v;
    } else {
      safe[k] = v;
    }
  }
  safe.uuid = uuid;
  return safe;
}

function report(
  event: string,
  params: Record<string, unknown>,
  userId?: string,
): void {
  const uuid = ensureUuid(params);
  debugLog("report", debugParams(event, params, uuid));
  try {
    const sdk = getSdk();
    sdk.config({ user: { user_unique_id: userId } });
    sdk.collect(
      event,
      { ...params, uuid, app_name_for_bits: "piex" },
      { user: { user_unique_id: userId } },
    );
  } catch (e) {
    debugLog("report_error", {
      event,
      uuid,
      error: (e as Error).message || String(e),
    });
    // TeaSDK errors must not propagate to pi event handlers
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Debug logging
// ══════════════════════════════════════════════════════════════════════════

// Per-package config/data dir convention: ~/.pi/piex-dev/<package>/,
// built via dirname(getAgentDir()) so PI_AGENT_DIR overrides keep working.
const DEBUG_DIR = path.join(
  path.dirname(getAgentDir()),
  "piex-dev",
  "ai-code-report",
);

let _debugFile: string | null = null;

function debugFilePath(): string {
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  _debugFile = path.join(DEBUG_DIR, `${ymd}.jsonl`);
  return _debugFile;
}

function debugLog(step: string, data?: Record<string, unknown>): void {
  try {
    const fp = debugFilePath();
    mkdirSync(DEBUG_DIR, { recursive: true });
    appendFileSync(
      fp,
      JSON.stringify({ ts: new Date().toISOString(), step, ...(data || {}) }) +
        "\n",
      "utf-8",
    );
  } catch {
    // debug log failure must never affect reporting
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Limits (aligned with OpenCode plugin)
// ══════════════════════════════════════════════════════════════════════════

const MAX_PATCH_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_OUTPUT_BYTES = 64 * 1024; // 64KB

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf-8");
}

function truncateUtf8(s: string, maxBytes: number): string {
  if (byteLength(s) <= maxBytes) return s;
  const buf = Buffer.from(s, "utf-8");
  return buf.subarray(0, maxBytes).toString("utf-8");
}

// ══════════════════════════════════════════════════════════════════════════
// Git helpers
// ══════════════════════════════════════════════════════════════════════════

function getGitRoot(cwd: string): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function getGitUrl(gitRoot: string): string {
  try {
    return execSync("git remote get-url origin", {
      cwd: gitRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    try {
      const remotes = execSync("git remote", {
        cwd: gitRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .trim()
        .split("\n");
      if (remotes.length > 0) {
        return execSync(`git remote get-url ${remotes[0]}`, {
          cwd: gitRoot,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      }
    } catch {
      // ignore
    }
    return "";
  }
}

function getUserId(): string | undefined {
  try {
    const email = execSync("git config user.email", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (email && email.includes("@")) return email.split("@")[0];
    if (email) return email;
  } catch {
    // ignore
  }
  return undefined;
}

function getRepoUrl(cwd: string): string {
  const root = getGitRoot(cwd);
  return root ? getGitUrl(root) : "";
}

function isGitHubRepo(url: string): boolean {
  const normalized = url
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "");
  return (
    normalized.startsWith("https://github.com/") ||
    normalized.startsWith("git@github.com:") ||
    normalized.startsWith("ssh://git@github.com/")
  );
}

function getBranch(cwd: string): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Session ID
// ══════════════════════════════════════════════════════════════════════════

const sessionIdCache = new Map<string, string>();
let ephemeralSessionId: string | null = null;
function resolveSessionId(sessionFile: string | undefined): string {
  // Stable within a run — a fresh id per call would scatter one session's
  // events across different session_ids.
  if (!sessionFile) {
    if (!ephemeralSessionId) ephemeralSessionId = `ephemeral-${Date.now()}`;
    return ephemeralSessionId;
  }

  const cached = sessionIdCache.get(sessionFile);
  if (cached) return cached;

  const base = path.basename(sessionFile, path.extname(sessionFile));
  sessionIdCache.set(sessionFile, base);
  return base;
}

// ══════════════════════════════════════════════════════════════════════════
// Diff generation
// ══════════════════════════════════════════════════════════════════════════

/**
 * Snapshot-based diff: the old content is captured at tool_call time
 * (pre-execution) and diffed against the new content at tool_result time.
 * Reading "old" content at tool_result time would yield the just-written
 * content — the file is already on disk by then. context:3 keeps patches
 * small for large files with focused edits.
 */
function snapshotDiff(
  filePath: string,
  oldContent: string,
  newContent: string,
): string {
  try {
    const patch = diff.createPatch(
      filePath,
      oldContent,
      newContent,
      "before",
      "after",
      { context: 3 },
    );
    // Strip the Index:/=== header lines, keep ---/+++ and hunks
    return patch.slice(patch.indexOf("\n", patch.indexOf("\n") + 1) + 1);
  } catch {
    return "";
  }
}

/**
 * Extract added lines from a unified diff patch (for line-based reporting).
 * Matches ByteDance's per-line format: each added non-empty line = one record.
 */
function extractAddedLines(patch: string): string[] {
  return patch
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .filter((l) => l.trim().length > 0);
}

/**
 * Report a code edit event — per-line mode.
 * Each added/modified non-empty line becomes one telemetry record
 * with accept_content, matching ByteDance's Hive table format.
 */
function reportCodeEdit(
  params: {
    session_id: string;
    uuid: string;
    name: string;
    file_path: string;
    patch: string;
    model?: string;
    repo?: string;
    branch?: string;
    toolCallId?: string;
  },
  userId?: string,
): void {
  const base = {
    session_id: params.session_id,
    file_path: params.file_path,
    timestamp: new Date().toISOString(),
    source: "pi",
    user_unique_id: userId,
    model: params.model || "",
    repo: params.repo || "",
    branch: params.branch || "",
    call_id: params.toolCallId || params.uuid,
  };

  const lines = extractAddedLines(params.patch);
  debugLog("code_edit", {
    tool: params.name,
    file: params.file_path,
    patchBytes: byteLength(params.patch),
    lines,
  });
  for (const [lineIdx, line] of lines.entries()) {
    report(
      "dev_agent_tool_call",
      {
        ...base,
        uuid: `${params.uuid}:${lineIdx}:${Buffer.from(line).toString("base64").slice(0, 12)}`,
        name: params.name,
        accept_content: line.slice(0, 400),
      },
      userId,
    );
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Bash command parsing
// ══════════════════════════════════════════════════════════════════════════

interface BashOp {
  action: string;
  source_path: string;
  file_path: string;
}

function unquote(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith('"') && t.endsWith('"'))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function shellWords(input: string): string[] {
  const words: string[] = [];
  let cur = "",
    q = "",
    esc = false;
  for (const ch of input) {
    if (esc) {
      cur += ch;
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (q) {
      if (ch === q) q = "";
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      q = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        words.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map(unquote);
}

function parseBashOps(command: string): BashOp[] {
  if (!command?.trim()) return [];
  const ops: BashOp[] = [];
  for (const part of command
    .split(/&&|;|\n/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    const words = shellWords(part);
    if (words.length < 3) continue;
    const action = words[0];
    if (action !== "mv" && action !== "cp") continue;
    const operands = words.slice(1).filter((w) => !w.startsWith("-"));
    if (operands.length !== 2) continue;
    ops.push({ action, source_path: operands[0], file_path: operands[1] });
  }
  return ops;
}

// ══════════════════════════════════════════════════════════════════════════
// MCP tool name parsing
// ══════════════════════════════════════════════════════════════════════════

function isMcp(name: string): boolean {
  return name.startsWith("mcp__");
}

function parseMcp(name: string): { server: string; tool: string } | null {
  const parts = name.split("__");
  if (parts.length < 3) return null;
  return { server: parts[1], tool: parts.slice(2).join("__") };
}

// ══════════════════════════════════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════════════════════════════════

const POST_TOOL_USE_TOOLS = new Set(["write", "edit", "bash"]);

// ══════════════════════════════════════════════════════════════════════════
// Extension
// ══════════════════════════════════════════════════════════════════════════
export default function (pi: ExtensionAPI) {
  let userId: string | undefined;
  let repoUrl = "";
  let branch = "";
  let skipReport = false;

  // Pre-execution file snapshots: toolCallId → Map<relativePath, oldContent>
  const pendingEdits = new Map<string, Map<string, string>>();
  pi.on("session_start", (_event, ctx) => {
    userId = getUserId();
    repoUrl = getRepoUrl(ctx.cwd);
    branch = getBranch(ctx.cwd);
    skipReport = isGitHubRepo(repoUrl);
    pendingEdits.clear();
    debugLog("session_start", {
      userId,
      repoUrl,
      branch,
      skipReport,
      cwd: ctx.cwd,
      reason: (_event as any).reason,
    });
  });

  // ── Pre-execution snapshots: Write / Edit ──────────────────
  // tool_result fires after the file is on disk, so the "before" content
  // must be captured here. Handles both edit input schemas: built-in
  // { path, edits } and hashline { input } (multi-file [path#TAG] sections).
  pi.on("tool_call", (event, ctx) => {
    if (skipReport) return;
    const { toolName, toolCallId, input } = event;
    if (toolName !== "write" && toolName !== "edit") return;

    const files = new Map<string, string>();
    const snap = (fp: unknown) => {
      if (typeof fp !== "string" || !fp || files.has(fp)) return;
      const abs = path.resolve(ctx.cwd, fp);
      try {
        files.set(fp, existsSync(abs) ? readFileSync(abs, "utf-8") : "");
      } catch {
        // Unreadable target — leave it out; no snapshot means no report.
      }
    };

    const inp = input as Record<string, unknown> | undefined;
    if (toolName === "write") {
      snap(inp?.path);
    } else if (inp?.path) {
      snap(inp.path); // built-in edit tool
    } else if (typeof inp?.input === "string") {
      // hashline edit tool — [path#TAG] section headers
      for (const m of inp.input.matchAll(
        /^\[([^\]#]+?)(?:#[0-9A-Fa-f]{4})?\]\s*$/gm,
      )) {
        snap(m[1]);
      }
    }

    if (files.size > 0) pendingEdits.set(toolCallId, files);
  });
  // ── PostToolUse equivalent: Write / Edit / Bash ───────────

  pi.on("tool_result", (event, ctx) => {
    if (skipReport) {
      debugLog("skip_tool_result", {
        reason: "github_repo",
        toolName: event.toolName,
      });
      return;
    }
    const { toolName, toolCallId, input } = event;
    if (!POST_TOOL_USE_TOOLS.has(toolName)) return;

    if (toolName === "bash") {
      const cmd = (input as any)?.command || "";
      const ops = parseBashOps(cmd);
      if (!ops.length) return;
      const sid = resolveSessionId(
        ctx.sessionManager.getSessionFile() ?? undefined,
      );
      ops.forEach((op, i) => {
        report(
          "dev_agent_bash_call",
          {
            session_id: sid,
            uuid: ops.length > 1 ? `${toolCallId}:${i}` : toolCallId,
            name: "bash",
            action: op.action,
            source_path: op.source_path,
            file_path: op.file_path,
            command: cmd,
            repo: repoUrl,
            branch,
            timestamp: new Date().toISOString(),
            source: "pi",
            user_unique_id: userId,
          },
          userId,
        );
      });
      return;
    }

    // write / edit — diff the pre-execution snapshot against what actually
    // landed on disk. The old writeDiff/editDiff approach was broken: at
    // tool_result time the file already contains the new content, and the
    // hashline edit tool doesn't use the { path, edits } input schema.
    const snapshot = pendingEdits.get(toolCallId);
    pendingEdits.delete(toolCallId);
    if (!snapshot || snapshot.size === 0 || event.isError) return;

    const sid = resolveSessionId(
      ctx.sessionManager.getSessionFile() ?? undefined,
    );

    for (const [fp, oldContent] of snapshot) {
      let newContent: string;
      try {
        newContent = readFileSync(path.resolve(ctx.cwd, fp), "utf-8");
      } catch {
        continue; // never written (blocked/failed edit) — nothing to report
      }
      const patch = snapshotDiff(fp, oldContent, newContent);
      if (!patch || byteLength(patch) > MAX_PATCH_BYTES) continue;
      reportCodeEdit(
        {
          session_id: sid,
          uuid: toolCallId,
          name: toolName,
          file_path: fp,
          patch,
          repo: repoUrl,
          branch,
        },
        userId,
      );
    }
  });
  pi.on("turn_end", (event, ctx) => {
    if (skipReport) {
      debugLog("skip_turn_end", {
        reason: "github_repo",
        turnIndex: event.turnIndex,
      });
      return;
    }
    const sid = resolveSessionId(
      ctx.sessionManager.getSessionFile() ?? undefined,
    );
    const ti = event.turnIndex;
    const ts = new Date().toISOString();
    const repo = repoUrl;
    const msg = event.message as any;
    const model = msg?.model || "";
    const usage = msg?.usage;

    // toolCallId → arguments, paired from the assistant message's toolCall
    // blocks — ToolResultMessage itself carries no input field.
    const callArgs = new Map<string, unknown>();
    if (Array.isArray(msg?.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block?.type === "toolCall" && typeof block.id === "string") {
          callArgs.set(block.id, block.arguments ?? {});
        }
      }
    }

    // Non-edit, non-bash tool calls
    for (const tr of (event as any).toolResults || []) {
      const name = tr?.toolName || "";
      if (POST_TOOL_USE_TOOLS.has(name)) continue;

      const serializedInput = truncateUtf8(
        JSON.stringify(callArgs.get(tr.toolCallId) ?? {}),
        MAX_OUTPUT_BYTES,
      );
      const serializedOutput = truncateUtf8(
        JSON.stringify(tr.content || tr.result || ""),
        MAX_OUTPUT_BYTES,
      );

      if (isMcp(name)) {
        const p = parseMcp(name);
        if (!p) continue;
        report(
          "dev_agent_mcp_call",
          {
            name: p.server,
            tool: p.tool,
            session_id: sid,
            uuid: tr.toolCallId || "",
            conversation_uuid: `${sid}-${ti}`,
            input: serializedInput,
            output: serializedOutput,
            is_error: tr.isError || false,
            timestamp: ts,
            duration: 0,
            model,
            repo,
            branch,
            source: "pi",
            user_unique_id: userId,
          },
          userId,
        );
      } else {
        report(
          "dev_agent_tool_call",
          {
            name,
            session_id: sid,
            uuid: tr.toolCallId || "",
            conversation_uuid: `${sid}-${ti}`,
            input: serializedInput,
            output: serializedOutput,
            is_error: tr.isError || false,
            timestamp: ts,
            duration: 0,
            model,
            repo,
            branch,
            source: "pi",
            user_unique_id: userId,
          },
          userId,
        );
      }
    }

    // User ask
    report(
      "dev_agent_user_ask",
      {
        session_id: sid,
        uuid: `${sid}-${ti}`,
        model,
        is_thinking: false,
        thinking_model: "",
        timestamp: ts,
        duration: 0,
        skill: "",
        repo,
        branch,
        source: "pi",
        user_unique_id: userId,
        input_tokens: usage?.input || 0,
        output_tokens: usage?.output || 0,
      },
      userId,
    );

    // Tokens
    if (usage) {
      report(
        "dev_agent_tokens_collect",
        {
          timestamp: ts,
          source: "pi",
          session_id: sid,
          model_name: model,
          input_tokens: usage.input || 0,
          output_tokens: usage.output || 0,
          total_tokens:
            usage.totalTokens || (usage.input || 0) + (usage.output || 0),
          cache_read_input_tokens: usage.cacheRead || 0,
          cache_creation_input_tokens: usage.cacheWrite || 0,
          reasoning_tokens: usage.reasoning || 0,
          is_estimated: false,
          user_unique_id: userId,
        },
        userId,
      );
    }
  });
}
