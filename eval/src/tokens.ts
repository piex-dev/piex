import type { TokenUsage } from './types.ts'

// TODO: pi/omp CLI does not output token counts to stdout.
// Token tracking requires API-level proxy or session log parsing.
// For now, return null — metrics report will show N/A.
export function parseTokenUsage(_output: string): TokenUsage | null {
  return null
}
