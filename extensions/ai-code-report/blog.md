---
title: AI Code Report：把 pi 的编码行为接入 TEA 数据管道
date: 2026-07-19
tags: [TeaSDK, Telemetry, Report, TEA]
---

> 装上 `@piex-dev/ai-code-report` 后，pi 的每一次 write、edit、bash 操作都会上报到 TEA 数据平台——不依赖 `@dp/ai-code-report`，直接用 TeaSDK 直连，依赖从 38 个包减到 3 个。

## 问题背景

Bits 使用 `@dp/ai-code-report` 统一采集各 AI 编码工具（Claude Code、OpenCode、Cursor、Codex 等）的使用行为，数据汇入 TEA 平台做分析与度量。

这个插件的工作模型分两层：

1. **Hook 层**（短生命周期）：各工具的 hook 机制触发 Node 脚本，stdin 接收工具事件的 JSON，解析后写入文件队列
2. **Drain 层**（后台进程）：从文件队列取数据，通过 TeaSDK 批量上报

设计的核心假设是「每次 hook 调用就是一个短命进程」——所以它需要文件队列做断点续传、detached drain 进程做异步发送，整个异步上报基础设施接近 500 行。

但 pi 不需要这套：

- pi 扩展运行在长生命周期进程里，**不会随每次事件退出**
- pi 事件（`tool_result`、`turn_end`）直接提供**结构化数据**，不需要从 transcript JSONL 逆解析
- pi 的工具输入输出已经在事件 payload 里，模型名、token 用量、session ID 全有

所以我们有两个选择：装整个 `@dp/ai-code-report`（带 38 个依赖），或者把核心能力抽出来直接集成。选了后者。

```bash
pi install npm:@piex-dev/ai-code-report
```

## 技术原理

### 1. 原始架构 vs pi 架构

```
原始 @dp/ai-code-report（Claude Code）:

  CC hook → stdin JSON → [进程启动]
    ├── Stop: 读 transcript JSONL → parseClaude (~300行) → 逆解析会话结构
    ├── PostToolUse: 取 tool_response.structuredPatch → generateDiff
    └── SubagentStop: 读 subagent JSONL → 聚合 token
         ↓
  asyncCodeReporter → 写文件队列(pending) → spawn detached drain → TeaSDK.HTTP

pi 移植:

  pi event → [进程内]
    ├── tool_result(write/edit): 取 content/edits → diff.createPatch
    ├── tool_result(bash): 取 command → parseBashOps
    └── turn_end: 取 message.usage/toolResults → 聚合上报
         ↓
  TeaSDK.collect() → httpPlugin → TEA Server
```

两条路径的复杂度差在哪？原始需要「解析 transcript 文件来重建会话结构」，pi 直接拿到已经结构化的事件。那个 `parseClaude.ts` 是整个插件最大的单文件（~300 行），在 pi 移植中完全不需要。

### 2. 事件映射

| pi 事件                    | 原始 Hook   | 上报事件                   | 关键数据                      |
| -------------------------- | ----------- | -------------------------- | ----------------------------- |
| `tool_result` (write/edit) | PostToolUse | `dev_agent_tool_call`      | 文件路径 + unified diff patch |
| `tool_result` (bash mv/cp) | PostToolUse | `dev_agent_bash_call`      | 源路径、目标路径、操作类型    |
| `turn_end`（非编辑工具）   | Stop        | `dev_agent_tool_call`      | 工具名、输入输出 JSON、模型名 |
| `turn_end`（MCP 工具）     | Stop        | `dev_agent_mcp_call`       | MCP server 名、工具名         |
| `turn_end`                 | Stop        | `dev_agent_user_ask`       | 轮次 ID、模型名、token 用量   |
| `turn_end`                 | Stop        | `dev_agent_tokens_collect` | input/output/cache tokens     |

注意 `tool_result` 和 `turn_end` 的分工：Write/Edit/Bash 在 `tool_result` 实时上报（因为此时才能拿到代码 diff），其余工具在 `turn_end` 批量上报（此时有模型名和完整上下文）。

### 3. TeaSDK 直连

原始插件的 `reportCodeEvent` / `reportEvent` / `reportTokensEvent` 本质上只是 `TeaSDK.collect()` 的包装：

```typescript
// @dp/ai-code-report 的 teaReporter.js（简化）
const sdk = new TeaSDK({ app_id: 1220 });
sdk.use(httpPlugin({ channel: "cn", retry: 3 }));
sdk.collect(
  "dev_agent_tool_call",
  { ...params, uuid },
  { user: { user_unique_id } },
);
```

就这么多。`flushReports()` 甚至是一个空函数（`Promise.resolve()`）。所以在 pi 扩展里直接初始化 TeaSDK 单例，省掉整个包装层。

### 4. Diff 生成

原始用 `generateNewFileDiff`（对 Write）和 `generateDiff(structuredPatch)`（对 Claude Code 的原生结构化补丁）。pi 的 edit 工具用的是 hashline DSL（`{ path, edits: [{ oldText, newText }] }`），不是 Claude Code 的 structuredPatch 格式。

解决办法：直接用 `diff` 库的 `createPatch` 对每个 edit block 生成标准 unified diff：

```typescript
diff.createPatch(filePath, edit.oldText, edit.newText, "before", "after");
```

Write 同理——`diff.createPatch("file", "", content)`。

## 实现方案

### 模块结构

整个扩展只有**一个文件**（~280 行），无内部模块拆分：

```text
ai-code-report.ts    # 全部逻辑：TeaSDK 单例 + git 工具 + diff + bash 解析 + 事件订阅
```

### TeaSDK 单例

```typescript
let _sdk: TeaSDK | null = null;

function getSdk(): TeaSDK {
  if (!_sdk) {
    _sdk = new TeaSDK({ app_id: Number(TEA_APP_ID) });
    _sdk.use(httpPlugin({ channel: TEA_CHANNEL, retry: 3 }));
  }
  return _sdk;
}
```

所有上报走同一个 `sdk.collect()` 调用，httpPlugin 内部处理批量与重试。不需要文件队列，不需要 detached 进程。

### 事件处理

```typescript
// PostToolUse 等价
pi.on("tool_result", (event, ctx) => {
  // write → newFileDiff → report("dev_agent_tool_call", { patch, ... })
  // edit → editDiff   → report("dev_agent_tool_call", { patch, ... })
  // bash → parseBashOps → report("dev_agent_bash_call", { ... })
});

// Stop 等价
pi.on("turn_end", (event, ctx) => {
  // toolResults 中非 write/edit/bash → report("dev_agent_tool_call", ...)
  // MCP 工具 → report("dev_agent_mcp_call", ...)
  // 用户问询 → report("dev_agent_user_ask", ...)
  // token 用量 → report("dev_agent_tokens_collect", ...)
});
```

### Git 信息提取

`getGitInfo` 和 `getUserId` 从 `@dp/ai-code-report` 迁移时做了减法：

- 去掉了 SSO auth cache 回退逻辑（pi 场景不需要）
- 去掉了 `getRelativeFilePath`（pi 工具路径已经可用）
- 保留了核心：`git rev-parse` + `git remote get-url` + `git config user.email`

共 45 行，原始的 `gitUtils.ts` 是 100+ 行。

### 依赖精简

| 依赖     | 重构前                                   | 重构后                                                       |
| -------- | ---------------------------------------- | ------------------------------------------------------------ |
| 直接依赖 | `@dp/ai-code-report` + `diff` (2)        | `@dp/tea-sdk-node` + `@logsdk/node-plugin-http` + `diff` (3) |
| 总安装包 | 179 个（含 got、keyv、js-tiktoken 等）   | 36 个                                                        |
| 核心原因 | `@dp/ai-code-report` 带了 38 个 npm 依赖 | TeaSDK + httpPlugin 只需要 3 个                              |

砍掉的主要是：cursor/copilot/codex/kiro/opencode 的解析模块、文件队列基础设施（codePending/codeOutbox/tracePending）、SSO 登录流程（auth/login）、token 增量追踪（tokenWatermark）、调试日志系统（reportLogger/tracer）。

## 设计参考

| 项目                   | 机制                                               | piex 取舍                                                                                                                                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **@dp/ai-code-report** | stdin JSON + transcript 逆解析 + 文件队列 → TeaSDK | **采纳**：TeaSDK 直连、事件类型与上报 payload 结构、bash 命令解析（mv/cp）。**不采纳**：transcript 解析（pi 事件已有结构化数据）、文件队列 + detached drain（pi 长生命周期不需要）、SSO 登录、增量 token 追踪。**修改**：diff 生成从 Claude Code structuredPatch 适配为 hashline edit blocks |

对比原则：保留「把数据送到 TEA」的核心链路，砍掉所有为短命进程和 CLaude Code 特有数据结构设计的中间层。

## 优化计划

1. **Bash 操作覆盖偏窄**  
   当前只解析 `mv` 和 `cp`（与原始一致），`mkdir`、`rm`、`git mv` 等文件操作未捕获。原始还解析 `git mv`。  
   → 扩展 parseBashOps 的词法，按需加 `mkdir` / `git mv` / `rm`。
2. **turn_end 中 toolResults 数据不够丰富**  
   pi 的 `turn_end` 事件里 `toolResults` 可能不包含完整的 `input` 字段，当前做 `JSON.stringify` 兜底。  
   → 如果 pi 后续版本增强 `turn_end` payload，直接改用结构化字段。
3. **缺少本地调试日志**  
   原始 @dp/ai-code-report 有 `reportLogger` 将上报事件写到 `~/.ai-code-report/` 本地日志，重构后这块没了。  
   → 可选加一个 `AI_CODE_REPORT_DEBUG=1` 环境变量开关，用 `console.error` 输出。
4. **Subagent 内部工具追踪**  
   pi 的 subagent 是独立 pi 进程，父进程只看得到 subagent 工具调用和返回。子进程内部每个工具的调用不会上报。  
   → 若需要完整追踪，可在子 pi 进程中也安装此扩展。
