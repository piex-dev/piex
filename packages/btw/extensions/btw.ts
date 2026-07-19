/**
 * btw extension — /btw command for temporary "by-the-way" questions.
 *
 *   pi install npm:@piex-dev/btw
 *   pi -e ./extensions/btw.ts
 *
 * Based on oh-my-pi's /btw concept: ask a side question with full session
 * context, answer displayed but excluded from future conversation history.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BTW_CUSTOM_TYPE = "btw-ephemeral";

export default function btwExtension(pi: ExtensionAPI) {
  let btwActive = false;
  let btwQuestionCount = 0;

  // ── /btw command ───────────────────────────────────

  pi.registerCommand("btw", {
    description: "Ask a by-the-way question (not saved to session context)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/btw requires interactive mode", "error");
        return;
      }

      let question = typeof args === "string" ? args.trim() : "";
      if (!question) {
        question = (await ctx.ui.input("BTW question:"))?.trim() ?? "";
        if (!question) return;
      }

      btwActive = true;
      btwQuestionCount++;

      pi.sendUserMessage(
        `[BTW] ${question}\n\nAnswer concisely. Do NOT use tools — this is a quick side question.`,
        { deliverAs: "followUp" },
      );

      pi.appendEntry("btw-mode", {
        active: true,
        questionCount: btwQuestionCount,
      });
    },
  });

  // ── Context injection: btw instructions ────────────

  pi.on("before_agent_start", async () => {
    if (!btwActive) return;

    return {
      message: {
        customType: BTW_CUSTOM_TYPE,
        content: `[BTW MODE]
You are answering a quick side question. The user needs a short, direct answer.

Rules:
- Answer concisely — a few sentences at most
- Do NOT use any tools (read, edit, write, bash, etc.)
- Do NOT explore the codebase or make changes
- The answer will NOT be saved to session context — be brief

The question is the last user message. Just answer it.`,
        display: false,
      },
    };
  });

  // ── Context filter: exclude btw history ────────────

  pi.on("context", async (event) => {
    if (btwActive) return;

    const filtered: unknown[] = [];
    let skipNextAssistant = false;

    for (const m of event.messages) {
      const msg = m as Record<string, unknown>;

      if (msg.customType === BTW_CUSTOM_TYPE) continue;

      const role = String(msg.role ?? "");
      const content = msg.content;

      if (
        role === "user" &&
        typeof content === "string" &&
        (content as string).startsWith("[BTW]")
      ) {
        skipNextAssistant = true;
        continue;
      }

      if (skipNextAssistant && role === "assistant") {
        skipNextAssistant = false;
        continue;
      }

      skipNextAssistant = false;
      filtered.push(m);
    }

    return { messages: filtered };
  });

  // ── Agent end: clear btw state ─────────────────────

  pi.on("agent_end", async (_event, ctx) => {
    if (!btwActive) return;

    btwActive = false;
    pi.appendEntry("btw-mode", {
      active: false,
      questionCount: btwQuestionCount,
    });
    ctx.ui.setStatus("btw-mode", undefined);
  });

  // ── Session start: restore and clean ───────────────

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();

    const btwEntry = (
      entries as Array<{
        type: string;
        customType?: string;
        data?: { active: boolean; questionCount: number };
      }>
    )
      .filter((e) => e.type === "custom" && e.customType === "btw-mode")
      .pop();

    if (btwEntry?.data) {
      btwQuestionCount = btwEntry.data.questionCount ?? 0;
    }

    btwActive = false;
    ctx.ui.setStatus("btw-mode", undefined);
  });
}
