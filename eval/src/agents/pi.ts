import type { AgentConfig, AgentRunResult, Task } from "../types.ts";
import { Sandbox } from "../sandbox.ts";
import { parseTokenUsage } from "../tokens.ts";

export function piAgentConfig(mode: "bare" | "piex"): AgentConfig {
  if (mode === "bare") {
    return {
      name: "pi (bare)",
      image: "piex-eval-pi",
      role: "baseline",
      extensions: [],
      extraArgs: [],
    };
  }

  return {
    name: "pi + piex",
    image: "piex-eval-pi",
    role: "test",
    extensions: [
      "/piex/packages/hashline/extensions/hashline.ts",
      "/piex/packages/dap/extensions/dap.ts",
      "/piex/packages/lsp/extensions/lsp.ts",
      "/piex/packages/plan/extensions/plan.ts",
      "/piex/packages/review/extensions/review.ts",
    ],
    extraArgs: [],
  };
}

function parseModel(model: string): string[] {
  const [provider, ...rest] = model.split(":");
  const modelId = rest.join(":");
  if (modelId) {
    return ["--provider", provider, "--model", modelId];
  }
  return ["--model", model];
}

export function piCommands(
  config: AgentConfig,
  prompt: string,
  model: string,
): string[] {
  const extArgs = config.extensions.flatMap((e: string) => ["-e", e]);
  return [...extArgs, ...parseModel(model), "-p", prompt, "--no-session"];
}

export async function runPi(
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
    extensions: config.extensions,
    command: piCommands(config, task.prompt, model ?? "deepseek-chat"),
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
