import { execSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PIE_ROOT = realpathSync(join(import.meta.dirname, "../.."));

export interface SandboxOptions {
  image: string;
  workDir: string;
  extensions: string[];
  command: string[];
  env?: Record<string, string>;
}

export class Sandbox {
  buildImage(dockerfile: string, tag: string): void {
    const context = join(import.meta.dirname, "../docker");
    execSync(`docker build -t ${tag} -f ${dockerfile} ${context}`, {
      stdio: "inherit",
      timeout: 300_000,
    });
  }

  imageExists(tag: string): boolean {
    try {
      execSync(`docker image inspect ${tag}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  prepareWorkspace(files: Record<string, string>): string {
    const dir = mkdtempSync(join("/tmp", "piex-eval-"));
    for (const [filename, content] of Object.entries(files)) {
      writeFileSync(join(dir, filename), content);
    }
    return dir;
  }

  async run(opts: SandboxOptions): Promise<RunResult> {
    const args: string[] = [
      "run",
      "--rm",
      `--volume=${opts.workDir}:/workspace`,
    ];

    if (opts.extensions.length > 0) {
      // Mount the pi type dirs (extensions/ prompts/ themes/) read-only so the
      // in-container extension paths (e.g. /piex/extensions/<name>/src/<name>.ts)
      // resolve. Mirror the repo layout under /piex.
      for (const dir of ["extensions", "prompts", "themes"]) {
        args.push(`--volume=${PIE_ROOT}/${dir}:/piex/${dir}:ro`);
      }
    }

    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        args.push("-e", `${k}=${v}`);
      }
    }

    args.push(opts.image, ...opts.command);

    const startTime = Date.now();
    const result = await runDocker(args);
    const wallTime = (Date.now() - startTime) / 1000;

    return {
      ...result,
      wallTime,
    };
  }

  cleanupWorkspace(dir: string): void {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }

  runCommand(
    cwd: string,
    command: string,
  ): { exitCode: number | null; stdout: string; stderr: string } {
    try {
      const stdout = execSync(command, {
        cwd,
        timeout: 60_000,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { exitCode: 0, stdout, stderr: "" };
    } catch (err: unknown) {
      const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
      return {
        exitCode: e.status ?? 1,
        stdout: e.stdout?.toString() ?? "",
        stderr: e.stderr?.toString() ?? "",
      };
    }
  }
  runTest(
    cwd: string,
    command: string,
  ): { exitCode: number | null; stdout: string; stderr: string } {
    const cmd = `docker run --rm -v "${cwd}":/workspace -w /workspace piex-eval-test-runner /bin/bash -c "${command}"`;
    try {
      const result = execSync(cmd, {
        timeout: 120_000,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { exitCode: 0, stdout: result, stderr: "" };
    } catch (err: unknown) {
      const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
      return {
        exitCode: e.status ?? 1,
        stdout: e.stdout?.toString() ?? "",
        stderr: e.stderr?.toString() ?? "",
      };
    }
  }
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  wallTime: number;
}

async function runDocker(
  args: string[],
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("close", (code) => {
      resolve({ exitCode: code, stdout, stderr });
    });

    child.on("error", (err) => {
      resolve({ exitCode: -1, stdout, stderr: String(err) });
    });
  });
}
