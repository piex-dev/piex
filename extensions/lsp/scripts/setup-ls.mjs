#!/usr/bin/env node
/**
 * Language server setup for @piex-dev/lsp.
 *
 * Detects and (by default) installs the default language servers:
 *   - TypeScript/JS: typescript-language-server + typescript@5 + bash-language-server (npm -g)
 *   - Python:        pyright (pipx → uv tool → pip3 --user)
 *   - Go:            gopls (go install, symlink into PATH if needed)
 *   - Rust:          rust-analyzer (rustup → brew → download fallback)
 *
 * Best-effort: every step is isolated, failures are reported but never abort.
 * Runs automatically as the package postinstall; set PI_LSP_SKIP_SETUP=1 to skip,
 * or run manually: `node scripts/setup-ls.mjs [--check|--install]`.
 *
 * Environment is scrubbed of npm_config_/npm_lifecycle_ variables so a
 * nested `npm install -g` from within postinstall uses the real global prefix.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const CHECK_ONLY = args.includes("--check");
if (process.env.PI_LSP_SKIP_SETUP === "1" && !CHECK_ONLY) {
  console.log("[lsp] PI_LSP_SKIP_SETUP=1 — skipping language server setup");
  process.exit(0);
}

const results = [];
const report = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✔" : "✘"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// ── helpers ──────────────────────────────────────────────────────

function cleanEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("npm_config_") || key.startsWith("npm_lifecycle_")) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

const DEFAULT_TIMEOUT_MS = 300_000; // 5 min — installs must not hang forever

function run(cmd, cmdArgs, opts = {}) {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const result = spawnSync(cmd, cmdArgs, {
    stdio: opts.silent ? "pipe" : "inherit",
    env: cleanEnv(),
    timeout,
    ...opts,
  });
  if (result.error) {
    const timedOut =
      result.error.code === "ETIMEDOUT" || result.signal === "SIGTERM";
    return {
      code: -1,
      error: timedOut
        ? new Error(`timed out after ${timeout / 1000}s`)
        : result.error,
      timedOut,
    };
  }
  return { code: result.status, stdout: result.stdout?.toString() ?? "" };
}

function which(cmd) {
  const PATH = process.env.PATH ?? "";
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT?.split(";") ?? [".exe", ".cmd", ".bat", ""])
      : [""];
  for (const dir of PATH.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

const has = (cmd) => which(cmd) !== null;

// ── installers ───────────────────────────────────────────────────

async function ensureNpmGroup() {
  // typescript-language-server + typescript@5 + bash-language-server
  const need = [];
  if (!has("typescript-language-server"))
    need.push("typescript-language-server");
  if (!has("bash-language-server")) need.push("bash-language-server");
  if (need.length === 0) {
    report("ts/js/bash servers", true, "already installed");
    return;
  }
  // typescript: check for a version that ships tsserver.js (5.x; 6/7 are native-only)
  const tsDir = run("npm", ["root", "-g"], { silent: true }).stdout.trim();
  const tsPkg = tsDir ? path.join(tsDir, "typescript", "package.json") : "";
  let tsOk = false;
  if (tsPkg && fs.existsSync(tsPkg)) {
    try {
      const v = JSON.parse(fs.readFileSync(tsPkg, "utf8")).version;
      const major = Number(v.split(".")[0]);
      tsOk = major >= 4 && major <= 5; // 5.x has tsserver.js
    } catch {
      /* treat as missing */
    }
  }
  const installArgs = [...need, ...(tsOk ? [] : ["typescript@5"])];
  console.log(`[lsp] installing: npm install -g ${installArgs.join(" ")}`);
  if (CHECK_ONLY) {
    report("ts/js/bash servers", false, `missing: ${installArgs.join(", ")}`);
    return;
  }
  const r = run("npm", ["install", "-g", ...installArgs]);
  if (r.code === 0) {
    report("ts/js/bash servers", true, "installed");
  } else {
    report(
      "ts/js/bash servers",
      false,
      `npm install -g failed (code ${r.code ?? r.error?.message})`,
    );
  }
}

async function ensurePyright() {
  if (has("pyright") && has("pyright-langserver")) {
    report("pyright", true, "already installed");
    return;
  }
  console.log("[lsp] installing pyright …");
  if (CHECK_ONLY) {
    report("pyright", false, "missing");
    return;
  }
  if (has("pipx")) {
    const r = run("pipx", ["install", "pyright"]);
    if (r.code === 0) return report("pyright", true, "via pipx");
  }
  if (has("uv")) {
    const r = run("uv", ["tool", "install", "pyright"]);
    if (r.code === 0) return report("pyright", true, "via uv");
  }
  if (has("pip3")) {
    // Plain --user first; --break-system-packages only when needed (PEP 668),
    // since older pip versions (<23) reject the flag entirely.
    let r = run("pip3", ["install", "--user", "pyright"]);
    if (r.code !== 0) {
      r = run("pip3", [
        "install",
        "--user",
        "--break-system-packages",
        "pyright",
      ]);
    }
    if (r.code === 0) return report("pyright", true, "via pip3 --user");
  }
  report(
    "pyright",
    false,
    "pipx/uv/pip3 unavailable or failed — install manually",
  );
}

async function ensureGopls() {
  if (has("gopls")) {
    report("gopls", true, "already installed");
    return;
  }
  console.log("[lsp] installing gopls …");
  if (CHECK_ONLY) {
    report("gopls", false, "missing");
    return;
  }
  if (!has("go")) {
    report("gopls", false, "go toolchain not found — install Go first");
    return;
  }
  const r = run("go", ["install", "golang.org/x/tools/gopls@latest"], {
    env: { ...cleanEnv(), GOBIN: undefined },
  });
  if (r.code !== 0) {
    report("gopls", false, `go install failed (code ${r.code})`);
    return;
  }
  if (has("gopls")) return report("gopls", true, "installed");
  // GOPATH/bin may not be on PATH; try to expose it via /usr/local/bin
  const gopath = run("go", ["env", "GOPATH"], { silent: true }).stdout.trim();
  const bin = gopath ? path.join(gopath, "bin", "gopls") : "";
  if (bin && fs.existsSync(bin)) {
    if (process.platform !== "win32" && fs.existsSync("/usr/local/bin")) {
      try {
        fs.symlinkSync(bin, "/usr/local/bin/gopls");
        return report(
          "gopls",
          true,
          `installed, symlinked to /usr/local/bin/gopls`,
        );
      } catch {
        /* fall through to hint */
      }
    }
    report(
      "gopls",
      false,
      `installed at ${bin} but it is not on PATH — add it or symlink`,
    );
    return;
  }
  report("gopls", false, "installed but binary not found");
}

async function ensureRustAnalyzer() {
  if (has("rust-analyzer")) {
    report("rust-analyzer", true, "already installed");
    return;
  }
  console.log("[lsp] installing rust-analyzer …");
  if (CHECK_ONLY) {
    report("rust-analyzer", false, "missing");
    return;
  }
  if (has("rustup")) {
    const r = run("rustup", ["component", "add", "rust-analyzer"]);
    if (r.code === 0 && has("rust-analyzer")) {
      return report("rust-analyzer", true, "via rustup");
    }
  }
  if (process.platform === "darwin" && has("brew")) {
    const r = run("brew", ["install", "rust-analyzer"]);
    if (r.code === 0) return report("rust-analyzer", true, "via brew");
  }
  if (process.platform === "linux" && process.arch === "x64") {
    const dest = path.join(os.homedir(), ".cargo", "bin");
    fs.mkdirSync(dest, { recursive: true });
    const url =
      "https://github.com/rust-lang/rust-analyzer/releases/latest/download/" +
      "rust-analyzer-x86_64-unknown-linux-gnu.gz";
    const r = run("bash", [
      "-c",
      `curl -L ${url} | gunzip -c > "${path.join(dest, "rust-analyzer")}" && chmod +x "${path.join(dest, "rust-analyzer")}"`,
    ]);
    if (r.code === 0 && has("rust-analyzer")) {
      return report("rust-analyzer", true, "downloaded to ~/.cargo/bin");
    }
  }
  report(
    "rust-analyzer",
    false,
    "rustup/brew unavailable or failed — see https://rust-analyzer.github.io/",
  );
}

// ── main ─────────────────────────────────────────────────────────

console.log(`[lsp] language server setup${CHECK_ONLY ? " (check only)" : ""}`);
console.log(
  `  platform: ${process.platform}/${process.arch} node ${process.version}`,
);

await ensureNpmGroup();
await ensurePyright();
await ensureGopls();
await ensureRustAnalyzer();

const failed = results.filter((r) => !r.ok);
console.log(
  failed.length === 0
    ? "\n[lsp] all default language servers ready ✔"
    : `\n[lsp] ${failed.length} server(s) need attention — rerun with \`node scripts/setup-ls.mjs\` after fixing`,
);
process.exit(0); // best-effort: never fail the enclosing npm install
