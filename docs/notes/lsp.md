---
title: LSP：给 Agent 一双「语言服务器」的眼睛
date: 2026-07-19
tags: [LSP, Diagnostics, Extension]
---

> `@piex-dev/lsp` 不是让 agent 更会聊天，而是让它在改代码前后能问到和 IDE 同一类问题：有没有错、定义在哪、引用还有谁。

## 问题背景

没有 LSP 时，coding agent 理解代码主要靠：

- `read` 打开文件  
- `grep` / `find` 字符串搜索  
- 模型自己「脑补」类型与引用关系  

这在小仓库能凑合。文件一多、重构一深，就会出现典型翻车：

- 改了函数签名，漏改调用点  
- 类型错误要等你手动跑 `tsc` / `cargo check` 才知道  
- 「这个符号定义在哪」全靠猜路径  

人用编辑器时，这些问题多半交给 **Language Server Protocol (LSP)**：诊断、跳转定义、找引用、Hover 类型、文档符号、格式化。  
`@piex-dev/lsp` 的目标很朴素：把同一套能力做成 pi 的 `lsp` 工具，让模型在改代码前后可以**主动问语言服务器**，而不是只问文件系统。

```bash
pi install npm:@piex-dev/lsp
```

同样，语言服务器本体要本机可执行（如 `typescript-language-server`、`rust-analyzer`、`pyright`、`gopls`）。扩展是客户端，不是 server 分发器。

---

## 技术原理

### 1. 编辑器已经证明过的模式

LSP 把「语言智能」从编辑器内核拆出去：

```
编辑器 / Agent          Language Server
     |                        |
     |  initialize            |
     |  textDocument/*        |
     |  workspace/*           |
     | ---------------------> |
     |  publishDiagnostics    |
     | <--------------------- |
```

对 agent 来说，最值钱的通常不是补全下拉框，而是：

- **diagnostics**：现在文件/项目有哪些 error/warning  
- **definition / references**：改一处会影响哪里  
- **hover**：这个符号到底是什么类型  
- **symbols**：这个文件/仓库的结构大纲  
- **format**：统一风格，少在 diff 里吵空格

### 2. 按需启动，会话内复用

每个语言 server 进程不轻。扩展的策略是：

1. 根据文件后缀 / 语言，在 `defaults.json` 里匹配 server 配置  
2. 用 root markers（`package.json`、`Cargo.toml`、`go.mod`…）找 workspace root  
3. spawn 子进程，stdio 上跑 JSON-RPC（`Content-Length` 帧）  
4. 同一 root + server 在会话内缓存，避免每次 `lsp` 调用都冷启动  
5. session 结束或 `reload` 时清理

### 3. 诊断从哪来

LSP 的诊断主要靠 server 主动推 `textDocument/publishDiagnostics`，不是客户端轮询。  
客户端在内存里按 URI 存最新诊断列表；模型调 `diagnostics` 时，读的是这份缓存（必要时先确保文件已 `didOpen`）。

这对 agent 很重要：可以在 edit 之后立刻问「还有没有红线」，形成 **改 → 验 → 再改** 的闭环，而不必每次都跑完整构建。

---

## 实现方案

包路径：[`packages/lsp`](https://github.com/piex-dev/piex/tree/main/packages/lsp)。

### 结构：单文件自包含 + 数据驱动配置

```
lsp.ts           # LspClient + Manager + 工具注册（约 590 行）
defaults.json    # 大量 server 默认配置（命令、后缀、rootMarkers、settings…）
```

没有拆成很多文件，是有意的：协议面固定、逻辑集中，移植与排错更简单。

### 工具 action

| action | 作用 |
|--------|------|
| `status` | 当前已启动的 server / 能力摘要 |
| `diagnostics` | 文件或项目级诊断 |
| `definition` | 跳转到定义 |
| `references` | 查找引用 |
| `hover` | 类型/文档悬停信息 |
| `symbols` | 文档符号树 |
| `workspace_symbols` | 工作区符号搜索 |
| `format` | 文档格式化并写回（TextEdit 应用） |
| `reload` | 重启相关 server |

共 9 个 action，覆盖「读智能 + 格式化」主路径；omp 里更重的 `codeAction` / `rename` / `completion` 等尚未全部迁入。

### defaults.json 里有什么

配置项按 server 名组织，典型字段：

- `command` / `args`：如何启动  
- `fileTypes` / `languages`：何时选用  
- `rootMarkers`：如何定 workspace root  
- `settings` / `initializationOptions`：初始化参数  

内置条目远不止「11 个」宣传口径：文件里包含 rust-analyzer、gopls、typescript-language-server、pyright/basedpyright、clangd、各类前端 server（html/css/json、vue、svelte、astro…）等，实际是一份偏全的默认表。能否用上，取决于你机器上有没有对应二进制。

### 实现细节

- **JSON-RPC over stdio**：自管 buffer 拆帧，pending request map 做超时/退出拒绝。  
- **诊断存储**：`Map<uri, Diagnostic[]>`，随 notification 更新。  
- **符号渲染**：kind → 可读图标/标签，方便纯文本终端阅读。  
- **format**：拿 `TextEdit[]` 应用到磁盘文件，而不是只把建议吐给模型让它手改。  
- **与 omp 的差距**：无 TUI 内联高亮；relatedInformation 等诊断扩展字段是基础格式；action 集合是子集。

### 和 hashline / dap 怎么配合（产品视角）

推荐心智模型：

1. `lsp` diagnostics / definition：弄清「该不该改、改哪里」  
2. `read` + `edit`（hashline）：做精确修改  
3. 再 `lsp` diagnostics：确认没引入新红线  
4. 运行时问题再上 `debug`（dap）

三者正交：LSP 管静态真相，hashline 管安全编辑，DAP 管动态真相。

---

## 优化计划

当前是「能问语言服务器」的最小完备集，不是 IDE 功能全集。缺口与补法可以对齐看：

| 现状 | 影响 | 打算怎么补 |
|------|------|------------|
| action 子集（无 rename / codeAction / completion 等） | 重构类任务仍偏手搓 | 优先补 rename + codeAction，收益高于再堆 hover 格式 |
| 大项目冷启动慢 | 模型易把「索引中」当成「没问题」 | server 就绪探测；indexing 未完成时显式状态 |
| 长诊断纯文本 | 占上下文、难扫 | 分级摘要：先 error，warning 折叠 |
| monorepo root 推断不稳 | 启错 server / 找错根 | 项目级 overrides（command/args/root） |
| edit 后不自动 diagnostics | 依赖模型记得再调 | 可选：刚改文件附轻量诊断 hint |

和 hashline、dap 的长期方向是闭环：静态真相（lsp）→ 安全编辑（hashline）→ 动态真相（dap），中间少靠模型「想起来要检查」。
