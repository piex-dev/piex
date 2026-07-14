import type { AgentRunResult, AgentSummary } from './types.ts'

export function computeSummary(
  agentName: string,
  role: 'baseline' | 'test' | 'reference',
  results: AgentRunResult[],
): AgentSummary {
  const passed = results.filter((r) => r.passed)
  const tokens = results
    .map((r) => r.tokenUsage?.total ?? 0)
    .filter((t) => t > 0)

  return {
    agent: agentName,
    role,
    resolveRate: results.length > 0 ? Math.round((passed.length / results.length) * 1000) / 10 : 0,
    passedTasks: passed.length,
    failedTasks: results.length - passed.length,
    avgWallTime:
      results.length > 0
        ? Math.round(results.reduce((s, r) => s + r.wallTime, 0) / results.length * 10) / 10
        : 0,
    avgTokens:
      tokens.length > 0
        ? Math.round(tokens.reduce((s, t) => s + t, 0) / tokens.length)
        : 0,
  }
}
