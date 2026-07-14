export interface Task {
  id: string
  prompt: string
  files: Record<string, string>
  test_cmd: string
  language: string
  prebuild?: string
}

export interface AgentConfig {
  name: string
  image: string
  role: 'baseline' | 'test' | 'reference'
  extensions: string[]
  extraArgs: string[]
}

export interface AgentRunResult {
  taskId: string
  agent: string
  role: 'baseline' | 'test' | 'reference'
  passed: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  wallTime: number
  tokenUsage: TokenUsage | null
}

export interface TokenUsage {
  input: number
  output: number
  total: number
}

export interface EvalReport {
  benchmark: string
  date: string
  totalTasks: number
  agents: AgentSummary[]
  tasks: TaskResult[]
}

export interface AgentSummary {
  agent: string
  role: 'baseline' | 'test' | 'reference'
  resolveRate: number
  passedTasks: number
  failedTasks: number
  avgWallTime: number
  avgTokens: number
}

export interface TaskResult {
  taskId: string
  language: string
  passedBy: string[]
  failedBy: string[]
  results: Record<string, { passed: boolean; wallTime: number; tokens: number | null }>
}
