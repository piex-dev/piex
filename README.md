# PieX — Pi Extensions

**Extend Pi without forking.**

A collection of extensions built on the [Pi](https://pi.dev) Extension API — core capabilities extracted from oh-my-pi, Claude Code, OpenCode, and other top coding agents, distributed as independent `@piex-dev/*` npm packages you install on demand.

## Why PieX?

- **Extend, never fork**: oh-my-pi (omp) forks the Pi core and bundles everything; PieX extends via the official Extension API — never touching the core, upgrading with Pi.
- **On demand, switch freely**: independent packages — install & remove at will. Minimal and in control: pay tokens only for what you use.
- **Know how it works**: borrow the best from top agents — understand their designs, then rebuild as extensions you fully control.
- **Eval first**: behavior-changing extensions ship with eval criteria & data (see [Evaluation](docs/evaluation.md)). No measurement, no adoption.

Full rationale: [Design Philosophy](docs/design.md).

## Install

```bash
# All-in-one
curl -fsSL https://piex.dev/scripts/install.sh | bash          # global
curl -fsSL https://piex.dev/scripts/install.sh | bash -s -- -l  # project-level

# Single package
pi install npm:@piex-dev/hashline

# Local dev (from repo root)
cd extensions/hashline && npm install && cd ../..   # hashline runtime dep only
pi install extensions/hashline                       # global
pi install -l extensions/hashline                    # project-level

# Ad-hoc load (does not write settings)
pi -e ./extensions/hashline/src/hashline.ts
```

## Packages

### Extensions

| Package     | npm                  | Description                                                                                |
| ----------- | -------------------- | ------------------------------------------------------------------------------------------ |
| hashline    | `@piex-dev/hashline` | Hashline patch language — compact, line-anchored, tag-verified file edits                  |
| dap         | `@piex-dev/dap`      | Debug Adapter Protocol — debug programs with 14 adapters directly from Pi                  |
| lsp         | `@piex-dev/lsp`      | Language Server Protocol — diagnostics, navigation, rename, code actions, format (50+ servers) |
| plan        | `@piex-dev/plan`     | Plan Mode — read-only exploration, plan creation, and step-by-step execution               |
| review      | `@piex-dev/review`   | Code Review — interactive `/review` command and LLM-callable review tool                   |
| xai-oauth   | `@piex-dev/xai-oauth`| xAI Grok OAuth login — use SuperGrok or X Premium+ instead of API key                      |
| btw         | `@piex-dev/btw`      | By-the-way — ask side questions with session context, answered out-of-band                 |
| context     | `@piex-dev/context`  | Context usage report — `/context` command showing token usage breakdown                    |
| goal        | `@piex-dev/goal`     | Autonomous goal completion — `/goal` command with token-budget wrap-up and impasse channel |

### Prompts

| Package | npm              | Description                                                    |
| ------- | ---------------- | -------------------------------------------------------------- |
| init    | `@piex-dev/init` | Guided AGENTS.md setup — `/init` prompt that creates or improves project agent rules |

### Themes

| Package     | npm                          | Description                                                                 |
| ----------- | ---------------------------- | --------------------------------------------------------------------------- |
| dark-terminal | `@piex-dev/theme-dark-terminal` | High-contrast terminal-inspired dark theme with vivid green, blue, and red accents |

> **ai-code-report** (`@piex-dev/ai-code-report`) is private — AI code edit telemetry with internal dependencies, not published to npm.

## Docs

| Doc                                | Topic                                 |
| ---------------------------------- | ------------------------------------- |
| [Design Philosophy](docs/design.md) | Motivation, design principles, patterns |
| [Architecture](docs/architecture.md) | Project structure, tool registration, API mapping |
| [Roadmap](docs/roadmap.md)          | Completed & planned                    |
| [Evaluation](docs/evaluation.md)    | Benchmark selection, Docker setup, metrics |
| [Testing](docs/testing.md)          | Per-package smoke tests & verification |
| [References](docs/references.md)    | Pi docs, upstream project index        |

## Development

```bash
# Install dependencies (hashline only)
cd extensions/hashline && npm install

# List installed packages
pi list

# Remove a package
pi remove /path/to/piex/extensions/hashline      # global
pi remove -l ./extensions/hashline                # project-level
```

## License

MIT
