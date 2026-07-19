import type {
  AgentConfig,
  AgentRunResult,
  EvalReport,
  Task,
  TaskResult,
} from "./types.ts";
import { Sandbox } from "./sandbox.ts";
import { runPi, piAgentConfig } from "./agents/pi.ts";
import { runOmp, ompAgentConfig } from "./agents/omp.ts";
import { computeSummary } from "./metrics.ts";
import {
  prepareSWERepo,
  applyTestPatch,
  cleanupWorktree,
} from "./benchmarks/swebench.ts";

export interface RunOptions {
  tasks: Task[];
  benchmark: string;
  agents: ("pi-bare" | "pi-piex" | "omp")[];
  model: string;
  concurrency?: number;
}

function collectApiEnvVars(): Record<string, string> {
  const result: Record<string, string> = {};
  const patterns = [
    /API[_-]?KEY$/i,
    /AUTH[_-]?TOKEN$/i,
    /^ANTHROPIC_/i,
    /^OPENAI_/i,
    /^DEEPSEEK_/i,
    /^LANGSMITH_/i,
  ];
  for (const [key, value] of Object.entries(process.env)) {
    if (value && patterns.some((p) => p.test(key))) {
      result[key] = value;
    }
  }
  return result;
}

export async function evaluate(opts: RunOptions): Promise<EvalReport> {
  const sandbox = new Sandbox();
  const apiEnv = collectApiEnvVars();

  const configs: {
    config: AgentConfig;
    handler: typeof runPi | typeof runOmp;
  }[] = [];

  if (opts.agents.includes("pi-bare")) {
    configs.push({ config: piAgentConfig("bare"), handler: runPi });
    ensureImage(sandbox, piAgentConfig("bare"));
  }

  if (opts.agents.includes("pi-piex")) {
    configs.push({ config: piAgentConfig("piex"), handler: runPi });
    ensureImage(sandbox, piAgentConfig("piex"));
  }

  if (opts.agents.includes("omp")) {
    configs.push({ config: ompAgentConfig(), handler: runOmp as typeof runPi });
    ensureImage(sandbox, ompAgentConfig());
  }

  ensureTestRunner(sandbox);
  const allResults: AgentRunResult[] = [];
  const batchSize = Math.max(1, opts.concurrency ?? 3);

  for (let i = 0; i < opts.tasks.length; i += batchSize) {
    const batch = opts.tasks.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (task) => {
        for (const { config, handler } of configs) {
          process.stdout.write(`  [${config.name}] ${task.id}... `);

          const isSWE = !!task.swebench;
          let workDir: string;

          try {
            if (isSWE) {
              workDir = prepareSWERepo(task);
            } else {
              workDir = sandbox.prepareWorkspace(task.files);
            }
          } catch (err) {
            console.log(`SETUP ERROR: ${err}`);
            continue;
          }

          try {
            if (!isSWE && task.prebuild) {
              const pb = sandbox.runTest(workDir, task.prebuild);
              if (pb.exitCode !== 0) {
                console.log(
                  `SKIP(prebuild failed): ${pb.stderr.slice(0, 100)}`,
                );
                if (isSWE) cleanupWorktree(workDir);
                else sandbox.cleanupWorkspace(workDir);
                continue;
              }
            }

            const agentResult = await handler(
              task,
              config,
              sandbox,
              workDir,
              apiEnv,
              opts.model,
            );

            if (isSWE) {
              applyTestPatch(workDir, task.swebench!.test_patch);
            }

            const testResult = sandbox.runTest(workDir, task.test_cmd);
            const passed = testResult.exitCode === 0;

            if (passed) {
              console.log("PASS");
            } else {
              console.log(
                `FAIL(exit=${testResult.exitCode}) stderr=${testResult.stderr.slice(0, 200)}`,
              );
              console.log(`  workspace: ${workDir}`);
            }

            if (isSWE) {
              cleanupWorktree(workDir);
            } else {
              sandbox.cleanupWorkspace(workDir);
            }

            allResults.push({ ...agentResult, passed });
          } catch (err) {
            console.log(`ERROR: ${err}`);
          }
        }
      }),
    );
  }

  const tasks: TaskResult[] = opts.tasks.map((task) => {
    const taskResults = allResults.filter((r) => r.taskId === task.id);
    const passedBy = taskResults.filter((r) => r.passed).map((r) => r.agent);
    const failedBy = taskResults.filter((r) => !r.passed).map((r) => r.agent);
    const results: Record<
      string,
      { passed: boolean; wallTime: number; tokens: number | null }
    > = {};

    for (const r of taskResults) {
      results[r.agent] = {
        passed: r.passed,
        wallTime: r.wallTime,
        tokens: r.tokenUsage?.total ?? null,
      };
    }

    return {
      taskId: task.id,
      language: task.language,
      passedBy,
      failedBy,
      results,
    };
  });

  const agents = configs.map(({ config }) =>
    computeSummary(
      config.name,
      config.role,
      allResults.filter((r) => r.agent === config.name),
    ),
  );

  return {
    benchmark: opts.benchmark,
    date: new Date().toISOString().slice(0, 10),
    totalTasks: opts.tasks.length,
    agents,
    tasks,
  };
}

function ensureImage(sandbox: Sandbox, config: AgentConfig): void {
  if (sandbox.imageExists(config.image)) return;

  const dockerDir = `${import.meta.dirname}/../docker`;
  const dockerfileMap: Record<string, string> = {
    "piex-eval-pi": "pi.Dockerfile",
    "piex-eval-omp": "omp.Dockerfile",
  };
  const dockerfile = dockerfileMap[config.image];
  if (dockerfile) {
    console.log(`Building ${config.image} image...`);
    sandbox.buildImage(`${dockerDir}/${dockerfile}`, config.image);
  } else {
    console.warn(
      `Warning: no Dockerfile mapped for image '${config.image}', assuming pre-built`,
    );
  }
}

function ensureTestRunner(sandbox: Sandbox): void {
  const image = "piex-eval-test-runner";
  if (sandbox.imageExists(image)) return;
  console.log(`Building ${image} image...`);
  sandbox.buildImage(
    `${import.meta.dirname}/../docker/test-runner.Dockerfile`,
    image,
  );
}
