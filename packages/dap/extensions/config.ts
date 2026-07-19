/**
 * DAP adapter configuration — Node.js port.
 * @source oh-my-pi packages/coding-agent/src/dap/config.ts
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as cp from "node:child_process";
import DEFAULTS from "./defaults.json" with { type: "json" };
import type { DapAdapterConfig, DapResolvedAdapter } from "./types";

const EXTENSIONLESS_DEBUGGER_ORDER = ["gdb", "lldb-dap"] as const;

// ---------------------------------------------------------------------------
// Inline helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
}

function normalizeObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

/** Simple wildcard match for root markers (supports `*` prefix like `*.csproj`). */
function wildcardMatch(pattern: string, filename: string): boolean {
  if (!pattern.includes("*")) return pattern === filename;
  const regex = new RegExp(
    "^" +
      pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
      "$",
  );
  return regex.test(filename);
}

function hasRootMarkers(cwd: string, markers: string[]): boolean {
  let entries: string[] | null = null;
  for (const marker of markers) {
    if (marker.includes("*")) {
      if (entries === null) {
        try {
          entries = fs.readdirSync(cwd);
        } catch {
          entries = [];
        }
      }
      for (const entry of entries) {
        if (wildcardMatch(marker, entry)) return true;
      }
      continue;
    }
    if (fs.existsSync(path.join(cwd, marker))) return true;
  }
  return false;
}

/** Node.js equivalent of Bun.which — finds command on PATH. */
function which(cmd: string): string | null {
  if (path.isAbsolute(cmd) || cmd.startsWith("./") || cmd.startsWith("../")) {
    return fs.existsSync(cmd) ? path.resolve(cmd) : null;
  }
  const PATH = process.env.PATH ?? "";
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT?.split(";") ?? [".exe", ".cmd", ".bat"])
      : [""];
  for (const dir of PATH.split(path.delimiter)) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        if (fs.statSync(candidate).isFile()) {
          /* check exec on unix */
        }
        return candidate;
      } catch {
        /* not found, continue */
      }
    }
  }
  return null;
}

function resolveCommand(command: string, cwd: string): string | null {
  const localBinPaths: Array<{ markers: string[]; binDir: string }> = [
    {
      markers: [
        "package.json",
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
      ],
      binDir: "node_modules/.bin",
    },
    {
      markers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"],
      binDir: ".venv/bin",
    },
    {
      markers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"],
      binDir: "venv/bin",
    },
    {
      markers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"],
      binDir: ".env/bin",
    },
    { markers: [".venv"], binDir: ".venv/bin" },
    { markers: ["Gemfile", "Gemfile.lock"], binDir: "vendor/bundle/bin" },
    { markers: ["Gemfile", "Gemfile.lock"], binDir: "bin" },
    { markers: ["go.mod", "go.sum"], binDir: "bin" },
  ];

  for (const { markers, binDir } of localBinPaths) {
    if (hasRootMarkers(cwd, markers)) {
      const localPath = path.join(cwd, binDir, command);
      if (fs.existsSync(localPath)) return localPath;
      if (process.platform === "win32") {
        for (const ext of [".exe", ".cmd", ".bat"]) {
          if (fs.existsSync(localPath + ext)) return localPath + ext;
        }
      }
    }
  }
  return which(command);
}

// ---------------------------------------------------------------------------
// Adapter normalization
// ---------------------------------------------------------------------------

function normalizeAdapterConfig(config: unknown): DapAdapterConfig | null {
  if (!isRecord(config)) return null;
  if (typeof config.command !== "string" || config.command.length === 0)
    return null;
  const connectMode =
    config.connectMode === "socket" ? ("socket" as const) : undefined;
  return {
    command: config.command,
    args: normalizeStringArray(config.args),
    languages: normalizeStringArray(config.languages),
    fileTypes: normalizeStringArray(config.fileTypes).map((e) =>
      e.toLowerCase(),
    ),
    rootMarkers: normalizeStringArray(config.rootMarkers),
    launchDefaults: normalizeObject(config.launchDefaults),
    attachDefaults: normalizeObject(config.attachDefaults),
    acceptsDirectoryProgram: config.acceptsDirectoryProgram === true,
    ...(connectMode ? { connectMode } : {}),
  };
}

function getDefaults(): Record<string, DapAdapterConfig> {
  const adapters: Record<string, DapAdapterConfig> = {};
  for (const [name, config] of Object.entries(DEFAULTS)) {
    const normalized = normalizeAdapterConfig(config);
    if (normalized) adapters[name] = normalized;
  }
  return adapters;
}

const DEFAULT_ADAPTERS = getDefaults();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getAdapterConfigs(): Record<string, DapAdapterConfig> {
  return { ...DEFAULT_ADAPTERS };
}

export function normalizeCommandForCwd(command: string, cwd: string): string {
  if (path.isAbsolute(command)) return command;
  if (
    command.startsWith("./") ||
    command.startsWith("../") ||
    command.startsWith(".\\") ||
    command.startsWith("..\\")
  ) {
    return path.resolve(cwd, command);
  }
  return command;
}

export function resolveAdapter(
  adapterName: string,
  cwd: string,
): DapResolvedAdapter | null {
  const config = DEFAULT_ADAPTERS[adapterName];
  if (!config) return null;
  const resolvedCommand = resolveCommand(
    normalizeCommandForCwd(config.command, cwd),
    cwd,
  );
  if (!resolvedCommand) return null;
  return {
    name: adapterName,
    command: config.command,
    args: config.args ?? [],
    resolvedCommand,
    languages: config.languages ?? [],
    fileTypes: config.fileTypes ?? [],
    rootMarkers: config.rootMarkers ?? [],
    launchDefaults: config.launchDefaults ?? {},
    attachDefaults: config.attachDefaults ?? {},
    connectMode: config.connectMode ?? "stdio",
    acceptsDirectoryProgram: config.acceptsDirectoryProgram === true,
  };
}

export function getAvailableAdapters(cwd: string): DapResolvedAdapter[] {
  return Object.keys(DEFAULT_ADAPTERS)
    .map((name) => resolveAdapter(name, cwd))
    .filter((adapter): adapter is DapResolvedAdapter => adapter !== null);
}

function getMatchingAdapters(
  program: string,
  cwd: string,
): DapResolvedAdapter[] {
  const extension = path.extname(program).toLowerCase();
  const available = getAvailableAdapters(cwd);
  if (!extension) {
    const nativeDebuggers = new Set(EXTENSIONLESS_DEBUGGER_ORDER);
    return available.filter(
      (adapter) =>
        nativeDebuggers.has(adapter.name) ||
        (adapter.rootMarkers.length > 0 &&
          hasRootMarkers(cwd, adapter.rootMarkers)),
    );
  }
  const exactMatches = available.filter((adapter) =>
    adapter.fileTypes.includes(extension),
  );
  if (exactMatches.length > 0) return exactMatches;
  return available;
}

function sortAdaptersForLaunch(
  program: string,
  cwd: string,
  adapters: DapResolvedAdapter[],
): DapResolvedAdapter[] {
  const extension = path.extname(program).toLowerCase();
  const rootAware = adapters.map((adapter) => ({
    adapter,
    hasExtensionMatch:
      extension.length > 0 && adapter.fileTypes.includes(extension),
    hasRootMatch:
      adapter.rootMarkers.length > 0 &&
      hasRootMarkers(cwd, adapter.rootMarkers),
  }));
  rootAware.sort((left, right) => {
    if (left.hasExtensionMatch !== right.hasExtensionMatch)
      return left.hasExtensionMatch ? -1 : 1;
    if (left.hasRootMatch !== right.hasRootMatch)
      return left.hasRootMatch ? -1 : 1;
    const leftRank = EXTENSIONLESS_DEBUGGER_ORDER.indexOf(
      left.adapter.name as (typeof EXTENSIONLESS_DEBUGGER_ORDER)[number],
    );
    const rightRank = EXTENSIONLESS_DEBUGGER_ORDER.indexOf(
      right.adapter.name as (typeof EXTENSIONLESS_DEBUGGER_ORDER)[number],
    );
    const nl = leftRank === -1 ? Number.MAX_SAFE_INTEGER : leftRank;
    const nr = rightRank === -1 ? Number.MAX_SAFE_INTEGER : rightRank;
    if (nl !== nr) return nl - nr;
    return left.adapter.name.localeCompare(right.adapter.name);
  });
  return rootAware.map((e) => e.adapter);
}

export type LaunchProgramKind = "file" | "directory" | "missing";

export function selectLaunchAdapter(
  program: string,
  cwd: string,
  adapterName?: string,
  programKind: LaunchProgramKind = "file",
): DapResolvedAdapter | null {
  if (adapterName) return resolveAdapter(adapterName, cwd);
  const matches = getMatchingAdapters(program, cwd);
  const candidates =
    programKind === "directory"
      ? matches.filter((a) => a.acceptsDirectoryProgram)
      : matches;
  const sorted = sortAdaptersForLaunch(
    program,
    cwd,
    candidates.length > 0 ? candidates : matches,
  );
  return sorted[0] ?? null;
}

export function selectAttachAdapter(
  cwd: string,
  adapterName?: string,
  port?: number,
): DapResolvedAdapter | null {
  if (adapterName) return resolveAdapter(adapterName, cwd);
  const available = getAvailableAdapters(cwd);
  if (port !== undefined) {
    const debugpy = available.find((a) => a.name === "debugpy");
    if (debugpy) return debugpy;
  }
  for (const preferred of EXTENSIONLESS_DEBUGGER_ORDER) {
    const match = available.find((a) => a.name === preferred);
    if (match) return match;
  }
  return available[0] ?? null;
}

export function resolveLaunchOverrides(
  adapter: DapResolvedAdapter,
  program: string,
  programKind: LaunchProgramKind,
): Record<string, unknown> {
  if (adapter.name === "dlv") {
    const ext = path.extname(program).toLowerCase();
    if (programKind === "directory" || ext === ".go") return { mode: "debug" };
    if (programKind === "file") return { mode: "exec" };
  }
  return {};
}
