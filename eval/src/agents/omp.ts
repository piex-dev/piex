import type { AgentConfig, AgentRunResult, Task } from "../types.ts";
import { Sandbox } from "../sandbox.ts";
import { parseTokenUsage } from "../tokens.ts";

export function ompAgentConfig(): AgentConfig {
  return {
    name: "omp",
    image: "piex-eval-omp",
    role: "reference",
    extensions: [],
    extraArgs: [],
  };
}

export async function runOmp(
  task: Task,
  config: AgentConfig,
  sandbox: Sandbox,
  workDir: string,
  env?: Record<string, string>,
  model?: string,
): Promise<AgentRunResult> {
  const result = await sandbox.run({
    image: config.image,
    workDir,
    extensions: [],
    command: [
      "--model",
      (model ?? "deepseek:deepseek-v4-flash").replace(":", "/"),
      "-p",
      task.prompt,
      "--no-session",
      "--yolo",
    ],
    env,
  });

  return {
    taskId: task.id,
    agent: config.name,
    role: config.role,
    passed: false,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    wallTime: result.wallTime,
    tokenUsage: parseTokenUsage(result.stdout),
  };
}
