/**
 * subagent extension — delegate focused tasks to isolated child agents.
 *
 *   pi install npm:@piex-dev/subagent
 *   pi -e ./extensions/subagent/src/subagent.ts
 *
 * Design: see docs/packages/subagent.md. MVP = subprocess transport, single +
 * parallel (per-task agent), true model inherit, --system-prompt replace,
 * --no-extensions, optional context, depth guard.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SubagentParams, type SubagentDetails } from "./types.js";
import { executeSubagent, loadAgents } from "./execution.js";
import { clearSettingsCache } from "./agents.js";
import { renderSubagentCall, renderSubagentResult } from "./render.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool<typeof SubagentParams, SubagentDetails>({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate a focused task to an isolated child agent (subprocess).",
      "Single: {agent, task, context?}. Parallel: {tasks: [{agent, task, context?}, ...]}.",
      "Each child has its own context window, system prompt, tools, and model config.",
      "This is a blocking call: the main agent waits until the child finishes.",
    ].join(" "),
    promptSnippet:
      "Run an isolated subagent when delegation fits; the main agent decides count from task shape.",
    promptGuidelines: [
      "Use subagent only when delegation fits; the main agent decides how many subagents from task shape.",
      "Use no subagent for simple answers, quick edits, or critical-path work the main agent can do directly. Subprocess cold-start costs real time and tokens.",
      "Use single when one focused worker fits; use parallel only for independent tasks (max 8). Avoid multiple workers writing the same files.",
      "Reviewer/scout/planner are read-only; worker can edit. Pick the agent by role.",
      "For review or implementation tasks, pass the relevant diff, plan, or file summary in `context` rather than letting the child guess.",
    ],
    parameters: SubagentParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeSubagent(toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall(args, theme) {
      return renderSubagentCall(args, theme);
    },
    renderResult(result, options, theme) {
      return renderSubagentResult(result, options, theme);
    },
  });

  // Surface error results to the model.
  pi.on("tool_result", (event) => {
    if (event.toolName !== "subagent") return;
    const details = event.details as
      (SubagentDetails & { isError?: boolean }) | undefined;
    if (details?.isError) return { isError: true };
  });

  // Reload settings + agents on each session start so config edits
  // (agents.yaml / settings.json) take effect without restarting pi.
  pi.on("session_start", () => {
    clearSettingsCache();
  });
  pi.registerCommand("subagents", {
    description: "List available subagents and their effective model/thinking",
    handler: async (_args, ctx) => {
      const { agents, warning } = loadAgents();
      if (warning) ctx.ui.notify(warning, "warning");
      const lines = agents.map((a) => {
        const tools = a.tools ? a.tools.join("/") : "default";
        const model = a.model ?? "inherit";
        const think = a.thinkingLevel ?? "-";
        return `${a.name.padEnd(10)} ${a.description}\n            tools: ${tools} | model: ${model} | thinking: ${think}`;
      });
      ctx.ui.notify(`Available subagents:\n${lines.join("\n")}`, "info");
    },
  });
}
