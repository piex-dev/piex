# @piex-dev/subagent

Subagent delegation for [pi](https://pi.dev) — delegate focused tasks to isolated child agents via subprocess.

> Status: **MVP implemented.** See [docs/packages/subagent.md](../../docs/packages/subagent.md) for the full design.

## Install

```bash
pi install npm:@piex-dev/subagent
```

Local dev:

```bash
cd extensions/subagent && npm install && cd ../..
pi -e ./extensions/subagent/src/subagent.ts
```

## What it does

The `subagent` tool spawns an isolated `pi --mode json -p --no-session --no-extensions` child process with its own system prompt, tools, and model config, then streams the result back. Two modes:

- **single** — `{ agent, task, context? }`: one child agent.
- **parallel** — `{ tasks: [{ agent, task, context? }, ...] }`: up to 8 concurrent children, each with its own agent role.

This is a **blocking** call: the main agent waits until the child finishes. Use it only when you need the result before continuing.

## Built-in agents

| agent      | role               | tools                  | suggested model          |
| ---------- | ------------------ | ---------------------- | ------------------------ |
| `scout`    | read-only recon    | read/grep/find/ls/bash | cheap+fast, thinking off |
| `planner`  | read-only planning | read/grep/find/ls      | strong, thinking high    |
| `reviewer` | adversarial review | read/grep/find/ls/bash | strong, thinking high    |
| `worker`   | implementation     | default coding tools   | inherit parent           |

## Configuration

Config lives under `~/.pi/piex-dev/subagent/`:

- `agents.yaml` — user agent definitions (override built-ins by name)
- `settings.json` — `defaultModel`, `defaultThinking`, `maxDepth`, `timeoutMs`

`agents.yaml` example:

```yaml
- name: reviewer
  description: Adversarial review
  systemPrompt: |
    You are a reviewer subagent. Report PASS/FAIL/PARTIAL. Do not edit files.
  tools: [read, grep, find, ls, bash]
  model: anthropic/claude-opus-4-1
  thinkingLevel: high

- name: scout
  description: Fast recon
  systemPrompt: Explore the codebase quickly and report grounded findings.
  tools: [read, grep, find, ls, bash]
  model: inherit
  thinkingLevel: off
```

### Model resolution (three-tier)

1. agent `model` / `thinkingLevel`
2. `settings.json` `defaultModel` / `defaultThinking`
3. **inherit** the parent session's current model (read explicitly and passed to the child — _not_ "omit `--model`")

## Commands

- `/subagents` — list available agents and their effective model/thinking.

## Design notes (MVP boundaries)

- Subprocess only (in-process transport is P1).
- Child runs with `--no-extensions` (no piex extension tools, no recursive subagent registration).
- Role prompts use `--system-prompt` (replace), not append.
- Optional `context` field passes diff/plan/summary; no automatic git-diff injection.
- Depth guard via `PIEX_SUBAGENT_DEPTH` (default maxDepth 1).
- Not in MVP: chain, fan-in, stateful mailbox, background async, watchdog. See roadmap in the design doc.

## License

MIT
