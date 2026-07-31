/**
 * Custom footer for the lsp extension.
 *
 * Replicates the built-in footer (pwd / token stats / model) so the whole
 * footer is replaced with a layout that right-aligns the `lsp` status while
 * keeping every other extension status (usage, …) left-aligned, opencode-style.
 *
 * Layout:
 *   line 1: ~/path/to/project (branch) • session
 *   line 2: ↑tokens ↓tokens Rcache Wcache CH% $cost context% …  (model)
 *   line 3: <other statuses> … right-aligned <LSP status>
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";

// ── Minimal shapes (duck-typed against pi-ai / session-manager) ──

interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}

interface FooterEntry {
  type: string;
  message?: { role?: string; usage?: UsageLike };
  usage?: UsageLike;
}

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** Data the footer reads from the extension ctx (captured at session_start). */
export interface FooterDeps {
  cwd: string;
  home?: string;
  sessionName?: string;
  getEntries(): readonly FooterEntry[];
  model?: {
    id: string;
    provider: string;
    reasoning?: boolean;
    contextWindow?: number;
  } | null;
  thinkingLevel?: string;
  getContextUsage():
    { contextWindow?: number; percent?: number | null } | undefined;
  /** Provider count for the `(provider) model` prefix; default 1 hides it. */
  availableProviderCount?: number;
}

/** Read-only slice of FooterDataProvider used by the footer. */
export interface FooterDataLike {
  getGitBranch(): string | null;
  getAvailableProviderCount(): number;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  onBranchChange(cb: () => void): () => void;
}

export interface FooterThemeLike {
  fg(color: string, text: string): string;
  bold?(text: string): string;
}

// ── Copied from pi (dist/modes/interactive/components/footer.js) to stay
//    consistent with the built-in footer without importing internals. ──

function createUsageTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsageToTotals(totals: UsageTotals, usage: UsageLike): void {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.cost += usage.cost.total;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatCwdForFooter(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));
  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

// ── Footer component ────────────────────────────────────────────

export function createFooter(
  deps: FooterDeps,
  footerData: FooterDataLike,
  theme: FooterThemeLike,
): { render(width: number): string[]; invalidate(): void; dispose(): void } {
  return {
    invalidate() {
      /* no cache */
    },
    dispose() {
      /* subscriptions are unsubscribed by the caller */
    },

    render(width: number): string[] {
      const lines: string[] = [];

      // Line 1: pwd (branch) • session
      let pwd = formatCwdForFooter(deps.cwd, deps.home);
      const branch = footerData.getGitBranch();
      if (branch) pwd = `${pwd} (${branch})`;
      if (deps.sessionName) pwd = `${pwd} • ${deps.sessionName}`;
      lines.push(
        truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
      );

      // Line 2: token stats … right-aligned model
      const usageTotals = createUsageTotals();
      let latestCacheHitRate: number | undefined;
      for (const entry of deps.getEntries()) {
        if (entry.type === "message" && entry.message?.role === "assistant") {
          if (entry.message.usage) {
            addUsageToTotals(usageTotals, entry.message.usage);
            const latestPromptTokens =
              entry.message.usage.input +
              entry.message.usage.cacheRead +
              entry.message.usage.cacheWrite;
            latestCacheHitRate =
              latestPromptTokens > 0
                ? (entry.message.usage.cacheRead / latestPromptTokens) * 100
                : undefined;
          }
        } else if (
          entry.type === "message" &&
          entry.message?.role === "toolResult" &&
          entry.message.usage
        ) {
          addUsageToTotals(usageTotals, entry.message.usage);
        } else if (
          (entry.type === "branch_summary" || entry.type === "compaction") &&
          entry.usage
        ) {
          addUsageToTotals(usageTotals, entry.usage);
        }
      }

      const statsParts: string[] = [];
      if (usageTotals.input)
        statsParts.push(`↑${formatTokens(usageTotals.input)}`);
      if (usageTotals.output)
        statsParts.push(`↓${formatTokens(usageTotals.output)}`);
      if (usageTotals.cacheRead)
        statsParts.push(`R${formatTokens(usageTotals.cacheRead)}`);
      if (usageTotals.cacheWrite)
        statsParts.push(`W${formatTokens(usageTotals.cacheWrite)}`);
      if (
        (usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) &&
        latestCacheHitRate !== undefined
      ) {
        statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
      }
      if (usageTotals.cost) {
        statsParts.push(`$${usageTotals.cost.toFixed(3)}`);
      }
      const contextUsage = deps.getContextUsage();
      const contextWindow =
        contextUsage?.contextWindow ?? deps.model?.contextWindow ?? 0;
      const contextPercentValue = contextUsage?.percent ?? 0;
      const contextPercent =
        contextUsage?.percent !== null && contextUsage?.percent !== undefined
          ? contextPercentValue.toFixed(1)
          : "?";
      const contextPercentDisplay = `${contextPercent}%/${formatTokens(contextWindow)}`;
      const contextPercentStr =
        contextPercentValue > 90
          ? theme.fg("error", contextPercentDisplay)
          : contextPercentValue > 70
            ? theme.fg("warning", contextPercentDisplay)
            : contextPercentDisplay;
      statsParts.push(contextPercentStr);

      let statsLeft = statsParts.join(" ");
      let statsLeftWidth = visibleWidth(statsLeft);
      if (statsLeftWidth > width) {
        statsLeft = truncateToWidth(statsLeft, width, "...");
        statsLeftWidth = visibleWidth(statsLeft);
      }

      let rightSide = deps.model?.id ?? "no-model";
      if (deps.model?.reasoning) {
        const thinkingLevel = deps.thinkingLevel ?? "off";
        rightSide =
          thinkingLevel === "off"
            ? `${rightSide} • thinking off`
            : `${rightSide} • ${thinkingLevel}`;
      }
      const providerCount =
        deps.availableProviderCount ?? footerData.getAvailableProviderCount();
      if (providerCount > 1 && deps.model) {
        rightSide = `(${deps.model.provider}) ${rightSide}`;
      }
      const rightSideWidth = visibleWidth(rightSide);
      const minPadding = 2;
      let statsLine: string;
      if (statsLeftWidth + minPadding + rightSideWidth <= width) {
        const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
        statsLine = statsLeft + padding + rightSide;
      } else {
        const availableForRight = width - statsLeftWidth - minPadding;
        if (availableForRight > 0) {
          const truncatedRight = truncateToWidth(
            rightSide,
            availableForRight,
            "",
          );
          const truncatedRightWidth = visibleWidth(truncatedRight);
          const padding = " ".repeat(
            Math.max(0, width - statsLeftWidth - truncatedRightWidth),
          );
          statsLine = statsLeft + padding + truncatedRight;
        } else {
          statsLine = statsLeft;
        }
      }
      // Dim like the built-in footer. statsLeft may contain colored sections
      // (context %) whose resets would clear an outer dim wrapper, so the
      // remainder is dimmed separately (theme.fg resets fg only, dim survives).
      const dimStatsLeft = theme.fg("dim", statsLeft);
      const remainder = statsLine.slice(statsLeft.length);
      lines.push(dimStatsLeft + theme.fg("dim", remainder));

      // Line 3: extension statuses, `lsp` right-aligned, others left-aligned
      const statuses = footerData.getExtensionStatuses();
      if (statuses.size > 0) {
        const sorted = [...statuses.entries()].sort(([a], [b]) =>
          a.localeCompare(b),
        );
        const lspText = sorted.find(([k]) => k === "lsp")?.[1];
        const others = sorted
          .filter(([k]) => k !== "lsp")
          .map(([, t]) => sanitizeStatusText(t))
          .join(" ");
        const lsp = lspText ? sanitizeStatusText(lspText) : undefined;
        if (others && lsp) {
          const pad = " ".repeat(
            Math.max(2, width - visibleWidth(others) - visibleWidth(lsp)),
          );
          lines.push(
            truncateToWidth(others + pad + lsp, width, theme.fg("dim", "...")),
          );
        } else {
          const single = others || lsp || "";
          lines.push(truncateToWidth(single, width, theme.fg("dim", "...")));
        }
      }

      return lines;
    },
  };
}
