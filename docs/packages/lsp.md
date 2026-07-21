---
title: lsp — 给 Agent 一双「语言服务器」的眼睛
date: 2026-07-19
tags: [LSP, Diagnostics, Extension]
package: lsp
npm: "@piex-dev/lsp"
type: extension
install: pi install npm:@piex-dev/lsp
source: extensions/lsp
---

> `@piex-dev/lsp` 让 agent 能问 IDE 同一类问题；更关键的是 **edit 之后自动看到 ERROR**，不必靠模型记得再调诊断。

## 简介

没有 LSP 时，coding agent 理解代码主要靠 `read` 打开文件、`grep`/`find` 字符串搜索、模型自己「脑补」类型与引用关系。文件一多、重构一深就翻车：改了函数签名漏改调用点、类型错误要手动跑 `tsc`/`cargo check` 才知道、「这个符号定义在哪」全靠猜路径。

人用编辑器时这些问题交给 **Language Server Protocol (LSP)**：诊断、跳转定义、找引用、Hover 类型、文档符号、格式化。`@piex-dev/lsp` 把同一套能力做成 pi 的 `lsp` 工具，让模型在改代码前后可以**主动问语言服务器**，而不是只问文件系统。

## 技术原理

### 编辑器已经证明过的模式

LSP 把「语言智能」从编辑器内核拆出去。对 agent 来说，最值钱的不是补全下拉框，而是：**diagnostics**（现在有哪些 error/warning）、**definition/references**（改一处影响哪里）、**hover**（符号类型）、**symbols**（文件/仓库结构大纲）、**format**（统一风格）。

### 按需启动，会话内复用

1. 根据文件后缀 / 语言，在 `defaults.json` 里匹配 server 配置
2. 用 root markers（`package.json`、`Cargo.toml`、`go.mod`…）找 workspace root
3. spawn 子进程，stdio 上跑 JSON-RPC（`Content-Length` 帧）
4. 同一 root + server 在会话内缓存，避免每次 `lsp` 调用都冷启动
5. session 结束或 `reload` 时清理

### 诊断从哪来

LSP 诊断主要靠 server 主动推 `textDocument/publishDiagnostics`，不是客户端轮询。客户端在内存里按 URI 存最新诊断列表；模型调 `diagnostics` 时读这份缓存。这对 agent 很重要：可以在 edit 之后立刻问「还有没有红线」，形成 **改 → 验 → 再改** 的闭环。

## 使用说明

### 安装

```bash
pi install npm:@piex-dev/lsp
```

> 仓库源码：[`extensions/lsp`](https://github.com/piex-dev/piex/tree/main/extensions/lsp)

### 前提条件

扩展是客户端，不是 server 分发器。语言服务器本体要本机可执行（如 `typescript-language-server`、`rust-analyzer`、`pyright`、`gopls`）。`defaults.json` 已为约 50 个 server 写好启动命令与参数。

### 配置

- 默认配置在 `extensions/lsp/defaults.json`，每个 server 含 `command` / `fileTypes` / `rootMarkers` / `initOptions` / `settings` / `isLinter`
- 单 server 命令可用环境变量 `PI_<NAME>_LSP_COMMAND` 覆盖（如 `PI_PYRIGHT_LSP_COMMAND`）
- 写后诊断可用 `PI_LSP_DIAGNOSTICS_ON_EDIT=0` 关闭

### 验证

mock server 单测：

```bash
cd extensions/lsp && npm install && bun test
```

冒烟测试：

```bash
pi -e ./extensions/lsp/src/lsp.ts -p "what is 1+1" --no-session
```

## 实现方案

### 结构

```text
lsp.ts           # 客户端 + 路由 + 工具 + 写后诊断 hook
defaults.json    # ~50 server（command / fileTypes / rootMarkers / initOptions / settings / isLinter）
```

### 工具 action

| action                                                   | 作用                            |
| -------------------------------------------------------- | ------------------------------- |
| `diagnostics`                                            | 匹配多 server，聚合诊断         |
| `definition` / `type_definition` / `implementation`      | 导航                            |
| `references` / `hover` / `symbols` / `workspace_symbols` | 读智能                          |
| `rename`                                                 | 默认 preview；`apply=true` 写盘 |
| `code_actions`                                           | 列表或按 index apply            |
| `format`                                                 | TextEdit 写回                   |
| `status` / `reload`                                      | 运维                            |

### 写后诊断（学 OpenCode）

`tool_result` 钩住 `edit`/`write`（含 hashline）：sync 磁盘 → 等 publishDiagnostics → 仅 ERROR、每文件 cap 20，附在结果末尾。形成「edit（hashline）→ 自动 ERROR 诊断 → 需要导航时显式 lsp → 运行时问题用 dap」的链路。

### 正确性要点

- `initOptions` 与 `initializationOptions` 兼容，放进 initialize 正确字段
- `settings` 经 `didChangeConfiguration` 下发；响应 `workspace/configuration`
- 文档 version + full-text `didChange`，避免 server 读到旧 buffer
- **诊断 settle**：push 诊断等「最后一条 publishDiagnostics 之后静默 N ms」才算稳定（默认 800ms，`diagnosticsSettleMs` 可按 server 配）
- **pull 诊断**：server 声明 `diagnosticProvider`（LSP 3.17）时改用 `textDocument/diagnostic` 主动拉取
- **能力门控**：仅 server 声明 `resolveProvider` 时才调 `codeAction/resolve`
- **重叠 edit 拒绝**：应用 WorkspaceEdit 前检测 TextEdit 区间相交，直接抛错
- **stderr 捕获**：server 进程 stderr 附在超时/退出错误后（cap 16KB）
- `which` 含 `node_modules/.bin`、`.venv/bin`；spawn 失败记 broken；Windows `.bat/.cmd` 经 `cmd.exe /d /s /c` 包装

## 设计参考

| 项目                                                                      | 机制                                                                                                                                    | piex 取舍                                                                                                                                                                 |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **oh-my-pi lsp**                                                          | 完整 LSP 客户端：多 server 路由、didChange、完整 action 面、诊断聚合                                                                    | **采纳**：JSON-RPC client、defaults.json 驱动、按需启动/会话复用、多 server 诊断聚合。**不采纳**：Bun 运行时（改 Node/child_process）、大面铺满 action（按需暴露）        |
| **OpenCode 写后诊断**                                                     | `tool_result` hook 拦截 edit/write → 等 publishDiagnostics → 仅 ERROR 附在结果末尾、每文件 cap                                          | **采纳**这一整套模式：sync → wait → only ERROR → cap 20 → 干净文件不附加。`PI_LSP_DIAGNOSTICS_ON_EDIT=0` 可关                                                             |
| **VS Code LSP**                                                           | initialize + settings/didChangeConfiguration + workspace/configuration                                                                  | **借鉴**：initOptions/settings 正确下发路径；full-text didChange 避免 server 读到旧 buffer；`which` 查 node_modules/.bin 和 .venv                                         |
| [**pi-extensions `pi-lsp`**](https://github.com/narumiruna/pi-extensions) | 诊断 settle 静默期、LSP 3.17 pull 诊断、stderr 捕获、`resolveProvider` 门控、重叠 edit 检测、cmd.exe 包装、`PI_<NAME>_LSP_COMMAND` 覆盖 | **采纳**全部协议细节（融入 piex 的常驻进程架构）；**不采纳**：spawn-per-call（piex 会话内复用进程）、仅 diagnostics/fix 两工具（piex 保留 13 action） |

核心取舍：优先写后 ERROR 闭环（学 OpenCode），诊断优于导航暴露；linter 不抢 primary server 的导航角色。

## 迭代记录

### 路线图

| 状态   | 项                                                                        |
| ------ | ------------------------------------------------------------------------- |
| ✅     | init/settings、didChange、多 server、写后 ERROR、rename/code_actions      |
| ✅     | 诊断 settle、pull 诊断、resolveProvider 门控、重叠 edit 防护、stderr 捕获 |
| ✅     | mock server 单测（`bun test extensions/lsp/test`）                        |
| 下一步 | 项目级 `.lsp.json` 覆盖；模块拆分（client/config/edits）                  |
| 下一步 | indexing/ready 状态，避免冷启动假阴性；目录级批量诊断                     |
| 暂缓   | lspmux、自动下载 LS、completion、TUI、整仓 CLI diagnostics                |

### 版本记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| 0.2.0 | 2026-07-19 | 早期版本：多 server 路由、didChange、诊断聚合；push 诊断到即返；盲调 `codeAction/resolve`；server 退出只给 exit code，stderr 丢失 |
| 0.3.0 | 2026-07-19 | push settle 静默期 + LSP 3.17 pull 诊断双轨；`resolveProvider`/`diagnosticProvider` 声明才调；stderr 捕获进超时/退出错误；`.bat/.cmd` 经 `cmd.exe` 包装；`PI_<NAME>_LSP_COMMAND` 覆盖；重叠 TextEdit 检测防写坏文件 |

0.2.0 的教训：intelephense 这类 server 会先推一批空诊断、再推真诊断，到即返会把有错的文件报成干净；server 崩溃时只有 exit code，排障全靠猜。0.3.0 把协议细节补齐——settle 静默期等推送稳定、pull 诊断让 server 按需算、stderr 进错误消息、`resolveProvider` 门控避免对不支持的 server 发多余请求。

---

## 附录：pi LSP 生态能力逐项对比

> 四个项目（omp / OpenCode / pi-extensions `pi-lsp` / piex lsp）的客观能力差异。

| 能力                   | omp lsp                     | OpenCode              | pi-extensions `pi-lsp`              | piex lsp                                |
| ---------------------- | --------------------------- | --------------------- | ----------------------------------- | --------------------------------------- |
| 工具面                 | 14 action（导航+重构+诊断） | 实验性，默认关        | 2（`lsp_diagnostics` + `lsp_fix`）  | 13 action（导航+重构+诊断+格式化）      |
| 进程模型               | 会话内复用                  | 会话内复用            | spawn-per-call（每次冷启动）        | 会话内复用                              |
| 诊断来源               | push 缓存                   | push 缓存             | push settle + pull 双轨             | push settle + pull 双轨                 |
| push settle 静默期     | ❌                          | ❌                    | ✅（publish 后静默 N ms）           | ✅（默认 800ms，`diagnosticsSettleMs`） |
| LSP 3.17 pull 诊断     | ❌                          | ❌                    | ✅（`diagnosticProvider` 声明才拉） | ✅（同上，移植）                        |
| 写后诊断               | writethrough + deferred     | edit/write 注入 ERROR | ❌（无 hook）                       | `tool_result` 附 ERROR（可关）          |
| stderr 捕获            | ❌                          | ❌                    | ✅ 进错误消息                       | ✅（同上，移植；cap 16KB）              |
| `resolveProvider` 门控 | —                           | —                     | ✅ 声明才调 `codeAction/resolve`    | ✅（同上，移植）                        |
| 重叠 TextEdit 防护     | ❌                          | ❌                    | ✅ 区间相交拒绝                     | ✅（同上，移植；限 cwd 内）             |
| Windows .bat/.cmd      | —                           | —                     | ✅ `cmd.exe /d /s /c` 包装          | ✅（同上，移植）                        |
| 命令覆盖               | 多层配置                    | config.lsp            | ✅ `PI_<NAME>_LSP_COMMAND`          | ✅（同上，移植）                        |
| `isLinter` 分流        | ✅                          | 多 client             | ❌                                  | ✅                                      |
| rename / format        | ✅                          | ❌                    | ❌（仅 fix）                        | ✅（preview 默认）                      |
| TUI 渲染               | ✅                          | 侧栏 status           | ❌                                  | ❌（纯文本）                            |
| lspmux / 自动下载      | ✅                          | ✅                    | ❌                                  | ❌                                      |
| 项目级配置             | 多层                        | config.lsp            | ❌（仅全局 routes）                 | 暂仅 defaults（后续 `.lsp.json`）       |
| 单测                   | —                           | —                     | ❌                                  | ✅（mock server，14 用例）              |
