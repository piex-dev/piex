# 设计理念

Piex 是 [Pi](https://pi.dev) 的功能拓展集合，从各类优秀 coding agent（oh-my-pi、Claude Code、OpenCode 等）中提取核心功能特性，以独立 piex package 形式分发。本文先讲清楚动机——为什么走这条路，再给出核心设计理念与架构模式。

## 背景与动机

### 为什么选择开源 Agent

**信息安全。** 闭源 coding agent 掌握着开发者的仓库、凭据与上下文，但其行为对用户是黑盒。仅 2026 年 7 月就有两起公开披露的事件：Claude Code 被工信部网络安全威胁和漏洞信息共享平台（NVDB）监测发现内置监控机制，可未经用户同意回传用户地域、身份标识等敏感信息（受影响版本 2.1.91–2.1.196），阿里随后将其列入高风险软件并全员禁用（[人民网报道](http://finance.people.com.cn/BIG5/n1/2026/0708/c1004-40756179.html)、[南方都市报报道](https://new.qq.com/rain/a/20260708A099RH00)）；xAI 的 Grok Build CLI 被安全研究员 cereblab 抓包证实，在未告知的情况下将整个 git 仓库（含未脱敏的 `.env` 凭据与完整提交历史）上传至云端，且 opt-out 开关只管数据留存、不管传输（[复现仓库与证据](https://github.com/cereblab/grok-build-exfil-repro)、[完整抓包分析](https://gist.github.com/cereblab/dc9a40bc26120f4540e4e09b75ffb547)）。开源 agent 的每一行代码、每一次网络请求都可审计，透明本身就是安全保障。

**KnowHow。** Coding agent 推陈出新，在不同工具之间来回切换，耗费大量时间却只停留在功能使用层面。选择一款开源 agent 深度使用，研究其底层工作原理、参与开发迭代，才能把"用工具"变成"懂工具"。

### 为什么选择 Pi

**克制。** Coding agent 的功能越来越丰富，也普遍越来越重，但其中绝大多数功能日常根本用不到——既浪费 token，又带来心智负担：你对塞进上下文的东西毫无掌控感。Pi 的作者把这种克制写进了设计纲领（[What I learned building an opinionated and minimal coding agent](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)）：系统提示词加工具定义合计不到 1000 tokens，默认只给模型 4 个工具（`read` / `write` / `edit` / `bash`）。官方 README 明确列出了 pi 不做的事——No MCP、No sub-agents、No plan mode、No built-in to-dos、No permission popups、No background bash——并且每一条都给出同一条出路：*build it with extensions, or install a package*。

**可扩展。** Pi 的定位是 "a minimal terminal coding harness"，官方原话是 *"aggressively extensible so it doesn't have to dictate your workflow"*。工具、命令、事件钩子、UI、Provider、主题全部开放给扩展，而且开篇即承诺 *"without having to fork and modify pi internals"*。对个人开发者而言，一个克制而完全可读的内核，加上一套几乎无所不能的 Extension API，是深入理解并掌控自己工具链的最佳起点。

### 为什么不直接用 oh-my-pi

[oh-my-pi](https://github.com/can1357/oh-my-pi)（omp）基于 pi 拓展实现了很多优秀的工具，开箱即用，也是 piex 最主要的功能来源。但它选择了一条不同的路线：

- **fork 而非扩展。** omp 是 pi 的 fork 分叉（官方自述 *"fork of pi-mono, batteries included"*），需要维护专门的 [porting playbook](https://github.com/can1357/oh-my-pi/blob/main/docs/porting-from-pi-mono.md) 持续 backport 上游，还得自行维护约 5.5 万行 Rust 内核与 Bun-only 运行时。跟随 fork 意味着把升级节奏和架构决策都交给了分叉方。
- **全量内置。** omp 默认内置 32 个工具和大量功能，其中很多日常用不到——这恰恰回到了"重"的老问题：无谓的 token 成本，以及对上下文失去掌控的心智负担。

### 为什么做 Piex

基于以上思考，Piex 选择第三条路：**不 fork pi，只用官方 Extension API 把主流 agent 验证过的优秀能力逐个做成独立、可选装、可度量的扩展**，在日常工作中深度使用、持续迭代，逐步打造最适合自己的工具链。需要说明的是：开源与信息安全是选择 agent 平台的重要前提，但并非创建 Piex 的核心原因——Piex 的核心设计理念是下面四点。

## 核心设计理念

### 1. 充分拓展 pi，而不是 fork

100% 基于 pi Extension API，不 fork pi，不修改 pi 内部代码。所有功能通过 pi 的标准扩展接口实现：

| 能力 | 实现方式 |
|------|---------|
| 覆盖内置工具 | `pi.registerTool({ name: "edit", ... })` |
| 注册新工具 | `pi.registerTool({ name: "debug", ... })` |
| Hook 工具调用 | `pi.on("tool_call", ...)` |
| Hook 工具结果 | `pi.on("tool_result", ...)` |
| 注册命令 | `pi.registerCommand("review", ...)` |
| 注入上下文 | `pi.on("before_agent_start", ...)` |
| 会话清理 | `pi.on("session_shutdown", ...)` |
| 状态持久化 | `pi.appendEntry("state-key", ...)` |
| Footer/Widget | `ctx.ui.setStatus(...)`, `ctx.ui.setWidget(...)` |
| 交互弹窗 | `ctx.ui.select(...)`, `ctx.ui.editor(...)` |
| 快捷键 | `pi.registerShortcut(Key.shift("p"), ...)` |

这也是与 omp 的理念差别所在：omp 走 fork + batteries included 的路线——把认为优秀的功能全部内置进自己的分叉内核，替用户做好所有选择；piex 不拥有内核、只做扩展，把每个能力的取舍留给用户。正因如此，piex 无需 backport 上游，始终跟随 pi 官方演进。

每个 piex package 是独立的 npm 包，不嵌入 pi；pi 升级时 piex 不受影响（扩展 API 向后兼容），piex 可通过 `pi update` 独立升级，版本号独立管理——随 pi 升级而升级。

### 2. 按需拓展，自由切换

每个扩展相互独立、彼此无依赖，即装即卸、自由组合——只为用到的能力付出 token，克制可控：

```bash
pi install npm:@piex-dev/hashline   # hashline 编辑
pi install npm:@piex-dev/dap        # DAP 调试
pi install npm:@piex-dev/plan       # 计划模式
pi remove npm:@piex-dev/plan        # 随时卸载
```

### 3. 知其所以然，掌控感

取百家之长：从 oh-my-pi、Claude Code、OpenCode 等主流 agent 中借鉴经过验证的优秀设计，搞清楚底层原理，再以 pi 扩展的形式按需引入。每个功能都是自己选择、自己理解、自己掌控的——把"用工具"变成"懂工具"。每个 package 都标注功能与设计的原始来源：

| Package | 功能来源 | 实现方式 |
|---------|---------|---------|
| hashline | oh-my-pi hashline | 依赖 `@oh-my-pi/hashline` + pi 适配层 + Node.js polyfill |
| dap | oh-my-pi DAP | 从 omp 独立移植（Bun → Node.js） |
| lsp | oh-my-pi LSP | 从 omp 精简移植 |
| plan | pi 官方示例 | 基于 plan-mode 示例增强 |
| review | oh-my-pi /review | 从 omp 精简移植 |
| theme-dark-terminal | [opencode-themes](https://github.com/debugtalk/opencode-themes) | pi.themes 静态主题 JSON 分发 |

### 4. 评测优先

若无法度量一个扩展的效果，那就不引入它。对影响 agent 行为的扩展（hashline、dap、lsp、plan、review）：仓库内置 Docker 化评测框架（`eval/`），在 Aider Polyglot 与 SWE-bench Lite 上对比 pi (bare) / pi + piex / omp 三个 agent，指标涵盖 `resolve_rate`、`avg_tokens`、`avg_time`、`est_cost` 及归因指标（`edit_accuracy`、`debug_success`、`plan_follow_rate`），评测数据将持续公开；主题、登录 provider 等不改变 agent 行为的包不适用此原则。方案详见 [评测方案](evaluation.md)。

## 目标

- 基于 Pi 打造最适合自己的 coding agent 工具链——每个功能都是自己选择、自己理解、自己掌控的。
- 深入理解每一个功能特性的底层实现原理，在持续迭代中提升自身的工具产品设计品味。

## 架构模式

### 扩展 Package 模式

每个 package 遵循统一结构：

```
<name>/
├── package.json          # npm 包，含 "pi" manifest
├── README.md             # package 文档
└── extensions/
    └── <name>.ts         # pi 扩展入口，export default function(pi)
    └── ...辅助模块.ts
```

`package.json` 中的 `"pi": { "extensions": ["./extensions"] }` 告诉 pi 自动发现扩展文件。

### 扩展加载流程

```
pi 启动
  ├── 解析 settings.json → 发现 piex package
  ├── 读取 package.json → 找到 extensions/ 目录
  ├── jiti 加载 .ts 文件
  └── 调用 export default function(pi)
      ├── pi.registerTool(...)    ← 注册工具
      ├── pi.registerCommand(...)  ← 注册命令
      └── pi.on("event", ...)     ← 订阅事件
```

### 扩展入口函数签名

```typescript
// 同步（普通扩展）
export default function myExtension(pi: ExtensionAPI) { ... }

// 异步（需要初始化例如 fetch 远程配置）
export default async function myExtension(pi: ExtensionAPI) { ... }
```


### 主题 Package 模式

主题 package 没有 TypeScript 扩展代码，而是通过静态 JSON 文件分发。pi 支持 `themes/` 约定目录或 `pi.themes` 显式文件数组；为兼容 `/settings` 预览与运行时加载，推荐用约定目录形式：

```json
{
  "pi": { "themes": ["./themes"] }
}
```

```
<name>/
├── package.json          # npm 包，"pi": { "themes": ["./themes"] }
├── README.md
└── themes/
    └── <name>.json       # pi theme JSON（51 color tokens）
```

`package.json` 中的 `"pi": { "themes": ["./themes"] }` 告诉 pi 自动发现主题文件。

**安装方式选择：**

- **全局 settings**（`~/.pi/agent/settings.json`）：本地包路径必须传绝对路径，否则 `/reload` 后相对路径会按 settings 文件位置解析导致主题丢失。例：
  ```bash
  pi install /abspath-to-piex/packages/theme-dark-terminal
  ```
- **项目级 settings**（`.pi/settings.json`）：可用相对路径，团队共享。例：
  ```bash
  pi install -l ./packages/theme-dark-terminal
  ```

主题 JSON 包含 `name`（唯一主题名）、`vars`（可选色板变量）和 `colors`（51 个必需 token）。pi 启动时自动加载，`/settings` 切换。
