---
title: subagent — 把活交给一个隔离的子 agent
date: 2026-07-23
tags: [Subagent, Delegation, Extension]
package: subagent
npm: "@piex-dev/subagent"
type: extension
install: pi install npm:@piex-dev/subagent
source: extensions/subagent
status: implemented
---

> subagent 的价值不是「能跑子进程」，而是给主 agent 一个**可控的委派出口**：合适的活交给合适的子 agent、合适的模型，上下文隔离、结果回流。pi 刻意不做，piex 用 Extension API 补上最小可用版。

## 简介

单 agent 干所有活，常见失败模式：**上下文污染**（侦察阶段读了一堆文件，挤占了实施阶段的上下文窗口）、**模型错配**（用 Opus 做 grep 侦察烧钱、用 Haiku 做代码审查不到位）、**并行受限**（主 agent 串行思考，跑不了「scout 摸代码 + reviewer 审 diff」）、**失败连坐**（一个子任务跑偏，整轮对话被带沟里）。

subagent 解决的是委派问题：主 agent 调一次 `subagent` 工具，spawn 一个**隔离的 pi 子进程**，给它独立的 system prompt、工具集、模型配置和任务，跑完把结果带回来。`@piex-dev/subagent` 把这套做成 pi 扩展：single（单任务）/ parallel（可跨 agent 并行）两种编排，内置 4 个角色 agent，支持 per-agent 模型配置。

**本包定位是委派原语，不是上层工作流。** 不替代 `@piex-dev/review` / `@piex-dev/plan`；它们是未来的上层消费者（例如 review 多 agent 版、plan handoff）。

> **状态：已实现（MVP）。** subprocess transport + single/parallel 编排 + 真模型 inherit + `--system-prompt` 替换 + `--no-extensions` + 可选 context + 深度门禁。in-process/chain/background 见 P1。

## 技术原理

### 子进程隔离，而非同进程 session

subagent 的核心是**进程级隔离**：每次调用 spawn 一个独立 `pi --mode json -p --no-session` 子进程，给它独立的上下文窗口、独立的工具集、独立的模型。主 agent 的上下文不被污染，子 agent 的工具调用不挤占主对话。

为什么不用同进程子 session（opencode 那种 `sessions.create({ parentID })`）？因为 pi 的 Extension API **不暴露 session 嵌套能力**——opencode 那套需要内核原生支持多 session 模型，pi 没有。子进程路线只用 `child_process.spawn` + JSON 事件流，纯 Extension API 可实现，不改内核。这也是 pi 官方推荐的路线（_"Spawn pi instances via tmux, or build your own with extensions"_）。

> **同进程路线其实也可行**：pi 公开 SDK 的 `createAgentSession()` + `SessionManager.inMemory()` 能在当前进程内创建子 AgentSession（见 narumitw pi-subagents 的 in-process transport）。但它有两个硬约束：只能用 7 个内置工具（`noExtensions: true` 不加载扩展），且审批/沙箱/headers 策略无法继承。对重度依赖 piex 扩展（hashline/lsp/dap）的用户不划算，故 MVP 只做 subprocess，in-process 留作 P1。

### 子进程通信：JSON 事件流

子进程跑在 `--mode json`，stdout 输出 NDJSON 事件流。父进程用 `JsonLineDecoder`（bounded line reader，单行上限 16MB）逐行解析：

- `message_update`（assistant text delta）→ 流式进度回调
- `tool_execution_start` → 显示子 agent 在调什么工具
- `agent_end`（携带完整 messages 数组）→ 提取最后一条 assistant 消息作为最终输出

stderr 单独累积（上限 128KB）用于错误诊断。abort 信号触发 `SIGTERM` → 5s 后 `SIGKILL`，按进程组终结。

### 阻塞语义（产品约束）

`subagent` 是 **blocking tool**：工具返回前，主 agent 不能处理 steering，用户也会感觉当前 turn 被占住。

因此 prompt 必须写死：

- **仅当必须等结果才能继续时**才委派
- 简单问答、单文件小改、主 agent 直接能做的事 → **不要**调 subagent
- 探索性/可延后的工作 → MVP 仍走 blocking；后台异步是 P1 高优先级，不是遥远路线图

### 模型配置：真正的三层优先级

subagent 的价值一半在「用合适的模型干合适的事」。

```
1. agent 配置里的 model / thinkingLevel     ← agents.yaml（最高）
2. 全局默认 defaultModel / defaultThinking ← piex-dev/subagent/settings.json
3. inherit 父 session 当前模型             ← 显式读取并传入 --model/--thinking
```

**关键修正：不传 `--model` ≠ inherit。**

- 不传 `--model` 时，子 pi 用的是**用户全局默认模型**，不是父 session 当前选中的模型
- 父 session 可能刚 `/model` 切到 `sonnet:high`，子进程仍会跑默认 haiku

因此 `inherit` 的实现必须是：

1. 父进程从 extension context / session 读取**当前** model 与 thinkingLevel
2. 显式传给子进程：`--model <parent.current>`、`--thinking <parent.thinking>`
3. agent 配置了 model 则覆盖；配置了 `model: "inherit"` 或未配置且无 defaultModel 时走第 3 层

model 与 thinkingLevel **独立配置、不绑死**。典型用法：

| agent    | model          | thinking | 原因                    |
| -------- | -------------- | -------- | ----------------------- |
| reviewer | 强模型         | high     | 对抗性审查要深度        |
| scout    | 便宜快模型     | off      | 侦察不需要重推理        |
| worker   | inherit 父会话 | 父会话   | 实施与主 agent 保持一致 |

### system prompt：替换，不是追加

角色 agent 用 **`--system-prompt`** 替换默认 coding assistant prompt，而不是 `--append-system-prompt`。

原因：append 会保留「你是编码助手，可以改代码」的默认人格，再叠加「不要 edit」——模型会摇摆。scout/reviewer/planner 必须用干净角色提示。

配套策略：

| 开关                                   | MVP 默认                     | 原因                                                                  |
| -------------------------------------- | ---------------------------- | --------------------------------------------------------------------- |
| `--system-prompt <agent.systemPrompt>` | 始终                         | 角色人格干净                                                          |
| `--no-extensions`                      | 始终                         | 避免递归加载 subagent、控制冷启动                                     |
| `--no-context-files`                   | **否**（默认加载 AGENTS.md） | 项目约定对 reviewer/worker 通常有用；若污染大，P1 再做成 agent 级开关 |
| agent 扩展工具（hashline 等）          | MVP **不加载**               | 与 `--no-extensions` 一致；P1 再做 allowlist                          |

> MVP 的 subprocess 因此**不能**使用 piex 扩展工具（hashline/lsp/dap）。这是有意取舍：先保证角色隔离、启动可控、无递归。需要扩展工具的 worker 场景，P1 用 `extensions` allowlist 打开。

### 上下文传递：可选 `context`，不做自动魔法

子进程默认是空 session，只有任务文本。仅靠主 agent 把长文塞进 `task` 会占 tool-call token、易截断。

MVP 钉死策略 **B**：

```ts
context?: string  // 可选；主 agent 显式传入 diff / 计划 / 文件摘要
```

组装子进程用户消息：

```text
<context>
{context}
</context>

Task: {task}
```

不做：

- ❌ 自动注入 git diff
- ❌ 自动注入最近 N turn
- ❌ 隐式共享父 session transcript

这些留给 P1。system prompt / tool description 写明：委派审查或实施时，**应把必要上下文放进 `context`**。

### 嵌套深度限制

子 agent 默认**不能再 spawn 子 agent**（`PIEX_SUBAGENT_DEPTH`，默认 maxDepth=1）。子进程 env 注入 `PIEX_SUBAGENT_DEPTH=<父深度+1>`，执行前检查，超限抛错。可通过 `PIEX_SUBAGENT_MAX_DEPTH` 调高。

另加硬约束：子进程 **`--no-extensions`**，即使 depth 配错也不会再次注册 `subagent` 工具。

### 扩展加载与 env

| 项   | MVP 策略                                                    |
| ---- | ----------------------------------------------------------- |
| 扩展 | `--no-extensions`（不加载任何 extension，含本包）           |
| env  | **继承父进程 env**，仅覆盖/注入 `PIEX_SUBAGENT_DEPTH`       |
| 鉴权 | 依赖父环境已有的 API key / `~/.pi/agent/auth.json`（OAuth） |

**不做激进 env 白名单。** 同 uid 子进程本就能读 `auth.json`；阉割 env 更容易弄坏 Claude Pro / Codex / 各 provider 专用变量，收益很小。安全边界放在：**工具权限、depth、cwd、timeout、abort 回收**。

## 使用说明

### 安装（实现后）

```bash
pi install npm:@piex-dev/subagent
```

> 仓库源码：[`extensions/subagent`](https://github.com/piex-dev/piex/tree/main/extensions/subagent)（尚未创建）

### 内置 agent

| agent      | 角色           | 工具                              | 推荐模型         |
| ---------- | -------------- | --------------------------------- | ---------------- |
| `scout`    | 只读代码侦察   | read/grep/find/ls/bash            | 便宜快模型 + off |
| `planner`  | 只读规划       | read/grep/find/ls                 | 强模型 + high    |
| `reviewer` | 对抗性代码审查 | read/grep/find/ls/bash            | 强模型 + high    |
| `worker`   | 全内置工具实现 | read/bash/edit/write/grep/find/ls | inherit 父会话   |

### 配置唯一真相

| 文件                                    | 内容                                                       |
| --------------------------------------- | ---------------------------------------------------------- |
| `~/.pi/piex-dev/subagent/agents.yaml`   | 用户 agent 定义（按 name **整对象覆盖**同名内置）          |
| `~/.pi/piex-dev/subagent/settings.json` | 包级设置：`defaultModel`、`defaultThinking`、`maxDepth` 等 |

不把 subagent 配置塞进 pi 全局 `settings.json`，避免和 pi 自身字段缠在一起。路径遵循 piex 约定：`join(dirname(getAgentDir()), "piex-dev", "subagent")`。

MVP **不做** project-local agents（`.pi/...`）；需要时 P1 再加，并默认确认。

`agents.yaml` 示例：

```yaml
- name: reviewer
  description: 对抗性审查，挑出主 agent 的盲点
  systemPrompt: |
    You are a reviewer subagent. Review changes adversarially.
    Report PASS/FAIL/PARTIAL with evidence. Do not edit files.
  tools: [read, grep, find, ls, bash]
  model: anthropic/claude-opus-4-1
  thinkingLevel: high

- name: scout
  description: 快速代码侦察
  systemPrompt: |
    You are a scout subagent. Explore the codebase quickly and report grounded findings.
    Do not edit files.
  tools: [read, grep, find, ls, bash]
  model: inherit
  thinkingLevel: off
```

`settings.json` 示例：

```json
{
  "defaultModel": "inherit",
  "defaultThinking": null,
  "maxDepth": 1,
  "timeoutMs": 600000
}
```

### 工具参数

```ts
// single
{ agent: "reviewer", task: "...", context?: string, timeoutMs?, thinkingLevel? }

// parallel（每项自带 agent，可跨角色）
{
  tasks: [
    { agent: "scout", task: "..." },
    { agent: "reviewer", task: "...", context?: string }
  ],
  timeoutMs?,           // 顶层默认，可被 task 覆盖
}
```

约束：

- single：`agent` + `task` 必填
- parallel：`tasks[]` 必填，**每项必须有自己的 `agent` + `task`**，上限 8，并发上限 4
- 不允许「顶层一个 agent + 多个 task 字符串」——那会削弱最常见的跨角色并行

### 用法

```text
use scout to find all entry points in src/
  → subagent({ agent: "scout", task: "..." })

use reviewer to review the current diff
  → subagent({
      agent: "reviewer",
      task: "Review for correctness and tests",
      context: "<diff or file summary>"
    })

run scout on auth flow and reviewer on the diff in parallel
  → subagent({
      tasks: [
        { agent: "scout", task: "Map the auth flow" },
        { agent: "reviewer", task: "Review the diff", context: "..." }
      ]
    })
```

辅助命令：`/subagents` 列出当前可用 agent 及生效 model/thinking。

### 验证（实现后）

```bash
pi -e ./extensions/subagent/src/subagent.ts -p "what is 1+1" --no-session
pi -e ./extensions/subagent/src/subagent.ts -p "use scout to list files in src/" --no-session
```

## 实现方案

包路径：`extensions/subagent`，目标 **~1500–1800 行**（不再用 1240 当硬 KPI），约 7 个源文件。

### 文件结构

```
extensions/subagent/
├── package.json          # @piex-dev/subagent
├── tsconfig.json
├── README.md
├── LICENSE
└── src/
    ├── subagent.ts       # 入口：registerTool + registerCommand + tool_result hook
    ├── types.ts          # AgentConfig / SubagentParams / SingleResult
    ├── agents.ts         # 内置 4 agent + loadAgents + resolveAgent + resolveModel
    ├── subprocess.ts     # buildPiArgs + getPiInvocation + runSingleAgent + terminate + JsonLineDecoder
    ├── execution.ts      # 深度检查 + single/parallel + 并发限制 + status
    └── render.ts         # renderCall / renderResult
```

**MVP 不引入 `transport.ts` / `ManagedAgent` 抽象。** 只有 subprocess 一条路径时，直接函数更清晰；P1 做 in-process 时再抽 `SubagentTransport`。

### 用到的 pi Extension API

| 能力         | API                                                                    |
| ------------ | ---------------------------------------------------------------------- |
| 工具注册     | `registerTool("subagent")`                                             |
| 工具结果处理 | `on("tool_result")` → `isError`                                        |
| 命令         | `registerCommand("subagents")`                                         |
| 流式进度     | `ctx.ui.setStatus` / `ctx.ui.setWidget`                                |
| 自定义渲染   | `renderCall` / `renderResult`                                          |
| 配置目录     | `getAgentDir()` → `~/.pi/piex-dev/subagent/`                           |
| 父模型       | session/context 暴露的当前 model + thinkingLevel（实现时对接实际 API） |

### 子进程 spawn 关键点

**pi bin 定位**（三段式，复刻 narumitw `getPiInvocation`）：

1. `process.argv[1]` 是可执行 .js/.mjs/.cjs → `node <argv1> <args>`（开发态）
2. execPath 是 node/bun → `pi <args>`（全局安装）
3. 否则 → `<execPath> <args>`（编译二进制）

**参数构造**：

```bash
pi --mode json -p --no-session --no-extensions \
  --system-prompt <tmpfile-with-role-prompt> \
  --model <resolvedModel> \          # 始终显式传入（含 inherit 解析后的父模型）
  --thinking <resolvedThinking> \    # 有值才传
  --tools <agent.tools> \            # 空数组用 --no-tools
  "<user message: optional context + Task>"
```

**env**：继承 `process.env`，设置 `PIEX_SUBAGENT_DEPTH=<depth+1>`。

**终止**：`detached: true` 形成进程组；abort 时 `process.kill(-pid, SIGTERM)` → 5s 后 `SIGKILL`。

### 编排：single + parallel

- **single**：`{ agent, task, context? }` → 一次 `runSingleAgent`
- **parallel**：`{ tasks: [{ agent, task, context? }, ...] }` → 有限并发执行，汇总结果

砍掉 chain / fan-in / stateful。主 agent 可串行两次 `subagent` 近似 chain；fan-in 由主 agent 自己汇总。

### 深度检查

```typescript
function assertSubagentDepthAllowed(): void {
  const depth = parseInt(process.env.PIEX_SUBAGENT_DEPTH ?? "0", 10) || 0;
  const maxDepth =
    parseInt(process.env.PIEX_SUBAGENT_MAX_DEPTH ?? "1", 10) || 1;
  if (depth >= maxDepth) {
    throw new Error(`Subagent recursion depth limit reached (${maxDepth})`);
  }
}
```

### promptGuidelines（必须写入工具描述）

1. 仅在委派收益明确时使用；简单任务不要委派（冷启动 + 额外 token 很贵）
2. 必须等结果才能继续时才调用；这是阻塞调用
3. 审查/实施类任务应填充 `context`（diff、计划、相关路径）
4. parallel 仅用于**独立**任务；避免多个 worker 写同一文件
5. scout/planner/reviewer 只读；需要改代码用 worker

## 设计参考

> 四种 subagent 实现的客观能力差异，及 piex 的取舍。

| 项目                        | 形态       | 隔离模型           | 规模     | piex 取舍                                                                           |
| --------------------------- | ---------- | ------------------ | -------- | ----------------------------------------------------------------------------------- |
| **nicobailon pi-subagents** | Extension  | 仅子进程           | 90+ 文件 | 借鉴角色划分；不采纳 chain/worktree/watchdog/acceptance                             |
| **oh-my-pi swarm**          | fork       | 子进程（内核 API） | ~6 文件  | 不 fork；借鉴并行编排思路                                                           |
| **opencode task**           | 独立 agent | 同进程子 session   | 单工具   | 不采纳同进程内核模型；借鉴集中式 agent 配置、depth                                  |
| **narumitw pi-subagents**   | Extension  | 子进程 + 同进程    | 21 文件  | **主要参照**：JSON 流、depth、spawn 细节；**不在 MVP 复制** transport/stateful 全套 |

核心取舍：**借鉴 narumitw 的可运行机制，而不是复制其架构复杂度**。MVP 只做 subprocess + single/parallel；P1 再按需加 in-process / background / chain。

## 与 plan / review 的关系

| 包                   | 职责                       | 与 subagent                                  |
| -------------------- | -------------------------- | -------------------------------------------- |
| `@piex-dev/plan`     | 只读探索 → 计划 → 执行进度 | 未来可把某步委派给 worker；MVP 不耦合        |
| `@piex-dev/review`   | 单 agent 代码评审          | 未来多 agent 评审可消费 subagent；MVP 不耦合 |
| `@piex-dev/subagent` | 委派原语                   | 不内置评审/计划工作流                        |

## 迭代记录

### 路线图

**MVP（当前）**：

1. subprocess 执行 + single / parallel（per-task agent）
2. 内置 4 agent + `agents.yaml` / `settings.json`
3. 真正的 inherit（显式传父 session 当前模型）
4. `--system-prompt` 替换 + `--no-extensions`
5. 可选 `context` 字段
6. 深度限制 + abort 进程组回收
7. 阻塞语义写入 promptGuidelines

**P1（按价值排序）**：

1. **background async**（高优先）：`subagent_spawn` 或等价非阻塞路径，避免 TUI 被占死
2. **extensions allowlist**：子进程可加载指定 piex 扩展（如 hashline）
3. **in-process transport**：公开 SDK 子 session，降冷启动；限 7 内置工具时诚实报错
4. **chain 编排**：`{previous}` 占位符
5. **project-local agents** + 确认
6. **自动 context 策略**（可选 git diff 等）
7. **向 pi 提议 `createChildSession()`**

### 不做清单（明确边界）

- ❌ fan-in aggregator
- ❌ stateful 运行时（ManagedAgent 树、mailbox、follow-up）
- ❌ watchdog / acceptance / worktree
- ❌ MVP 期 background async / in-process / chain（见 P1）
- ❌ MVP 期 transport 抽象层
- ❌ 激进 env 白名单
- ❌ 把配置塞进 pi 全局 settings.json

## 风险与对策

| 风险                  | 对策                                                                  |
| --------------------- | --------------------------------------------------------------------- |
| inherit 传错模型      | 始终显式解析父 session 当前 model/thinking 再传 `--model`             |
| 默认人格污染角色      | `--system-prompt` 替换，不用 append                                   |
| 递归加载 subagent     | 子进程 `--no-extensions` + depth 门禁双保险                           |
| 冷启动贵 / 过度委派   | promptGuidelines 限制使用场景；默认 timeout；P1 background/in-process |
| parallel 同文件写冲突 | 文档 + guidelines；只读 agent 为默认主力                              |
| 子进程鉴权失败        | 继承父 env + 依赖 auth.json；不做 env 阉割                            |
| JSON 流 hang          | bounded decoder + timeout + abort + stderr 上限                       |
| yaml 解析失败         | schema 校验 + notify 警告，降级内置                                   |
| 无 agent_end          | 非 0 退出时用 stderr + 最近输出，标记 error                           |

## 验收标准

### 正例

1. 本地 `pi -e ./extensions/subagent/...` 可加载；`/subagents` 列出 4 个内置 agent
2. single：`use scout to find entry files` 返回侦察结果
3. parallel：跨 agent（scout + reviewer）并发跑通
4. agents.yaml 给 reviewer 配强模型后，子进程实际使用该模型
5. 父 session 切换模型后，inherit agent 跟随父模型（不是全局默认）
6. 带 `context` 的 reviewer 调用能在输出中体现 context 内容

### 负例

7. 未知 agent 名 → 清晰错误，不 spawn
8. timeout → 进程被杀，`timedOut=true`
9. depth 超限 → 抛 "depth limit reached"，无孙子进程
10. 主 agent abort → 子进程组回收，无僵尸进程
11. 冒烟：`pi -e ... -p "what is 1+1" --no-session` 不误触发 subagent、不报错

### 工程

12. `npx prettier --check extensions/subagent` 通过
13. 关键单元测试：resolveModel 三层优先级、depth 门禁、params 校验、buildPiArgs

---

## 附录：pi subagent 生态能力逐项对比

| 能力                       | nicobailon | oh-my-pi | opencode   | narumitw      | piex MVP                |
| -------------------------- | ---------- | -------- | ---------- | ------------- | ----------------------- |
| 形态                       | Extension  | fork     | 独立 agent | Extension     | Extension               |
| 隔离                       | 子进程     | 子进程   | 同进程     | 子进程+同进程 | 子进程                  |
| transport 抽象             | ❌         | ❌       | ❌         | ✅            | ❌（P1）                |
| per-task 多 agent parallel | ✅         | ✅       | ❌         | ✅            | ✅                      |
| 真 inherit 父模型          | ✅         | ✅       | ✅         | ✅            | ✅（显式传）            |
| system prompt 替换         | ✅         | ✅       | ✅         | ✅            | ✅                      |
| 可选 context               | ✅         | 部分     | 任务文本   | ✅            | ✅                      |
| 默认加载扩展               | 可         | 可       | 可         | 可配置        | ❌（`--no-extensions`） |
| background async           | ✅         | ❌       | ✅         | ✅            | ❌（P1 高优先）         |
| chain / fan-in / stateful  | 重         | 中       | 轻         | 中重          | ❌                      |
| 深度限制                   | ✅         | ❌       | ✅         | ✅            | ✅                      |
| 规模                       | 90+ 文件   | ~6 文件  | 单工具     | 21 文件       | ~7 文件                 |

piex subagent 的定位：**可运行的委派原语，不是编排平台**。先把模型继承、角色提示、上下文、跨 agent 并行这四件实事做对；复杂编排留给 P1 或继续让主 agent 编排。
