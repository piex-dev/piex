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

安装时 postinstall 自动检测并安装默认 language server（typescript-language-server、
bash-language-server、pyright、gopls、rust-analyzer），幂等且失败不中断；
`PI_LSP_SKIP_SETUP=1` 可跳过，之后可用 pi 内命令 `/lsp:setup` 补装。

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
lsp.ts           # 客户端 + 路由 + 工具 + 写后诊断/读取预热 hook + footer 状态
footer.ts        # 自定义 footer（复刻内置布局，lsp 状态右对齐）
defaults.json    # ~50 server（command / fileTypes / rootMarkers / initOptions / settings / isLinter）
scripts/setup-ls.mjs  # postinstall 自动安装默认 language server
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

### 读取预热 + 项目根发现（学 OpenCode）

`tool_call` 钩住 `read`：读取文件时后台 spawn 匹配的 server 并 didOpen（fire-and-forget，
失败静默、不阻塞读取），footer 立即亮绿，后续编辑诊断免冷启动。server 路由默认基于
会话 cwd；cwd 不是项目根时（多仓库集合、monorepo 根），从文件向上查找最近的 marker
目录作为项目根启动 server；footer 在非项目根目录会扫描深度 ≤2 的子项目汇总可用 server，
隐藏 `.git` marker 噪音（bashls 等）。

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

| 项目                                                                      | 机制                                                                                                                                    | piex 取舍                                                                                                                                                          |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **oh-my-pi lsp**                                                          | 完整 LSP 客户端：多 server 路由、didChange、完整 action 面、诊断聚合                                                                    | **采纳**：JSON-RPC client、defaults.json 驱动、按需启动/会话复用、多 server 诊断聚合。**不采纳**：Bun 运行时（改 Node/child_process）、大面铺满 action（按需暴露） |
| **OpenCode 写后诊断**                                                     | `tool_result` hook 拦截 edit/write → 等 publishDiagnostics → 仅 ERROR 附在结果末尾、每文件 cap                                          | **采纳**这一整套模式：sync → wait → only ERROR → cap 20 → 干净文件不附加。`PI_LSP_DIAGNOSTICS_ON_EDIT=0` 可关                                                      |
| **VS Code LSP**                                                           | initialize + settings/didChangeConfiguration + workspace/configuration                                                                  | **借鉴**：initOptions/settings 正确下发路径；full-text didChange 避免 server 读到旧 buffer；`which` 查 node_modules/.bin 和 .venv                                  |
| [**pi-extensions `pi-lsp`**](https://github.com/narumiruna/pi-extensions) | 诊断 settle 静默期、LSP 3.17 pull 诊断、stderr 捕获、`resolveProvider` 门控、重叠 edit 检测、cmd.exe 包装、`PI_<NAME>_LSP_COMMAND` 覆盖 | **采纳**全部协议细节（融入 piex 的常驻进程架构）；**不采纳**：spawn-per-call（piex 会话内复用进程）、仅 diagnostics/fix 两工具（piex 保留 13 action）              |

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

| 版本  | 日期       | 变更                                                                                                                                                                                                                |
| ----- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.2.0 | 2026-07-19 | 早期版本：多 server 路由、didChange、诊断聚合；push 诊断到即返；盲调 `codeAction/resolve`；server 退出只给 exit code，stderr 丢失                                                                                   |
| 0.3.0 | 2026-07-21 | push settle 静默期 + LSP 3.17 pull 诊断双轨；`resolveProvider`/`diagnosticProvider` 声明才调；stderr 捕获进超时/退出错误；`.bat/.cmd` 经 `cmd.exe` 包装；`PI_<NAME>_LSP_COMMAND` 覆盖；重叠 TextEdit 检测防写坏文件 |
| 0.4.0 | 2026-07-31 | footer 状态栏（颜色区分运行/失败/待启动，lsp 右对齐）；项目根发现 + 子项目汇总；读取预热（read 触发 spawn，学 OpenCode）；postinstall 自动安装默认 server + `/lsp:setup`；全局 typescript 自动探测注入 `tsserver.path`；修复并发 spawn race、安装/探测超时 |

0.2.0 的教训：intelephense 这类 server 会先推一批空诊断、再推真诊断，到即返会把有错的文件报成干净；server 崩溃时只有 exit code，排障全靠猜。0.3.0 把协议细节补齐：settle 静默期等推送稳定、pull 诊断让 server 按需算、stderr 进错误消息、`resolveProvider` 门控避免对不支持的 server 发多余请求。

0.4.0 的教训：多仓库/多语言工作区里「按 cwd 匹配 server」的模型会在非项目根目录失效（monorepo 根、repo 集合），需要按文件向上找项目根；`typescript-language-server` 硬性要求 workspace 内有 typescript，全局安装的 6/7 只有 `tsc` 没有 `tsserver.js`，需要自动探测全局 5.x 并注入 `tsserver.path`；读取预热让 footer 即时反映「server 在跑」，而并发 spawn 需要 in-flight 去重防进程泄漏。

---

## 附录：piex / opencode / oh-my-pi 的 LSP 对比

> 三家实现（piex lsp 扩展 / opencode 内置 / OMP 内置）的功能特性与工作原理对比。
> 源码：`piex/extensions/lsp`、`opencode/packages/opencode/src/lsp`、`oh-my-pi/packages/coding-agent/src/lsp`。

### 功能特性

| 维度             | piex lsp（0.4.0）                                                                                                        | opencode                                                                                                  | oh-my-pi（OMP）                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 形态             | pi 扩展，`pi install npm:@piex-dev/lsp`                                                                                 | 内置（`ConfigV2.LSP`）                                                                                    | 内置（`settings.lsp.*`，默认开）                                                                                      |
| 工具面           | 13 action：diagnostics / definition / type_definition / implementation / references / hover / symbols / workspace_symbols / rename / code_actions / format / status / reload | `lsp` 工具 9 个 operation（goToDefinition / findReferences / hover / documentSymbol / workspaceSymbol / goToImplementation / prepareCallHierarchy / incomingCalls / outgoingCalls）；**需 `experimentalLspTool` flag 才注册**，但写后诊断与 read 预热默认生效 | 14 action：多 diagnostics（单文件 / glob / `"*"` workspace）/ definition / type_definition / implementation / references / hover / symbols / rename / **rename_file** / code_actions / status / reload / **capabilities** / **request（裸 JSON-RPC）** |
| 写后诊断         | `tool_result` hook 拦截 edit/write（含 hashline）→ sync → settle → 仅 ERROR、cap 20 附在结果末尾；`PI_LSP_DIAGNOSTICS_ON_EDIT=0` 关 | edit/write 工具内部 `touchFile(file, "document")` → 全量诊断 → 仅 ERROR cap 20 附输出，write 另附其他文件（cap 5 个） | **writethrough**：写后内联等 500ms → 慢 server 转 **deferred 延迟注入**（12s 预算，带 mutation version 防过期）+ ledger 去重 + 批量 edit/write 合并到批尾；`lsp.diagnosticsOnWrite` / `lsp.diagnosticsDeduplicate` 可配 |
| 读预热           | read hook → spawn + didOpen（fire-and-forget，失败静默）                                                                | read 工具 `warm` → touchFile（fork，ignore cause）                                                       | 启动时发现 server（`lsp.lazy` 默认 true，不预热，欢迎屏显示 `available`）                                             |
| 诊断管线         | push 缓存 + **settle 静默期**（默认 800ms，可配）+ **LSP 3.17 pull**（`diagnosticProvider` 声明才拉，单文档）            | push + **pull 双轨**（document / full 两档：textDocument/diagnostic 各 identifier 并行、workspace/diagnostic、relatedDocuments、动态 capability 注册、TS 首推种子 hack） | push 缓存（带 version）+ **version 精确匹配** + 250ms settle + `refreshFile()` 主动刷新（删缓存→didChange→didSave） |
| 项目加载感知     | ❌（冷启动可能假阴性）                                                                                                   | ❌                                                                                                       | ✅ `$/progress` token 跟踪（begin/end → resolveProjectLoaded，15s 兜底）；references 仅命中声明时重试等加载             |
| 服务器发现       | `defaults.json`（53 个）按 rootMarkers 匹配 cwd；cwd 非项目根时从文件向上找最近 marker 项目根；footer 扫描深度 ≤2 子项目汇总 | 内置 server 表（~40 个）：extensions + root 函数（NearestRoot / StrictNearestRoot，从文件向上到 worktree 边界）；Deno 排除 TS、ty/pyright 互斥（experimental flag） | 与 piex 同源 defaults.json（53 个）；rootMarkers 命中 + **二进制可用**双条件；本地 bin 优先（node_modules/.bin、.venv/bin、vendor/bundle/bin、Go bin…）再 PATH |
| 服务器安装       | postinstall 一次性装 5 个默认 server（npm -g / pipx / go install / rustup），幂等；`/lsp:setup` 重跑                  | **运行时按需自动下载/编译**（npm、GitHub release、dotnet tool、eslint 源码编译），`disableLspDownload` flag 可关 | ❌ 不自动安装，需自备                                                                                                 |
| 配置体系         | 仅 defaults.json + `PI_<NAME>_LSP_COMMAND` 环境变量覆盖（项目级 `.lsp.json` 在路线图）                                  | `config.lsp`：true / false / server map（`command` 数组、extensions、env、initialization）；root 逻辑内置不可覆盖 | **7 层 JSON/YAML 合并**（项目根 lsp.* > .omp/.claude/.codex/.gemini 项目目录 > 用户目录 > 插件 marketplace > home），`disabled`、`idleTimeoutMs`、per-server `capabilities`（flycheck/ssr/runnables 等） |
| 导航             | definition / type_definition / implementation / references / hover / symbols / workspace_symbols                        | 同左 + **call hierarchy**（prepareCallHierarchy / incomingCalls / outgoingCalls）                        | 同左 + 上下文行渲染（±1 行）                                                                                          |
| 重构             | rename（**默认 preview**，apply=true 写盘）+ code_actions（`resolveProvider` 门控）                                     | ❌（无 rename / code_actions）                                                                           | rename（**默认 apply**，preview 需显式）+ code_actions（list 时 `context.only` 过滤、apply 时标题/index 选择）+ rename_file（will/didRenameFiles） |
| 格式化           | `format` action：TextEdit 写回磁盘                                                                                      | ❌                                                                                                       | 无独立 action：**write 写穿透自动格式化**（`lsp.formatOnWrite`），FormattingOptions 按 `.editorconfig` → 内容缩进嗅探 → 2 空格 fallback |
| workspace 诊断   | ❌（按文件）                                                                                                             | ❌（仅 edit/write 管道顺带聚合其他文件）                                                                 | ✅ `file:"*"` 时跑子进程：`cargo check` / `tsc --noEmit` / `go build ./...` / `pyright`                                 |
| 裸协议访问       | ❌                                                                                                                      | ❌                                                                                                       | ✅ `request` action（任意 method + payload）+ `capabilities` 转储                                                                 |
| UI 展示          | 自定义 footer：`lsp` 状态右对齐，绿=运行 / 红=失败 / dim=待启动，命令不在 PATH 一律隐藏，非项目根显示子项目汇总；同名 server 跨 root 合并为 `name×N`（如 `typescript-language-server×3`） | footer `• N LSP`（绿色圆点 + 计数）；sidebar LSP 面板（server 名 + root 相对路径 + connected/error）；`lsp.updated` 事件驱动 | welcome 屏 LSP 区块（固定 4 槽位：ready 绿 / available 灰 / connecting / error 红 + 前 3 个扩展名）                     |
| 生命周期         | 会话内复用（per root+server），in-flight spawn 去重，broken 标记；无 idle 回收                                          | 会话内复用（instance 级），broken + spawning 去重；无 idle 回收                                            | 会话内复用（per command:cwd），broken 标记；`idleTimeoutMs` 可选空闲回收（60s 扫描）                                   |
| lspmux           | ❌（暂缓）                                                                                                               | ❌                                                                                                       | ✅（rust-analyzer；`PI_DISABLE_LSPMUX=1` 关）                                                                          |
| 容错细节         | stderr 捕获（16KB cap 进错误）、重叠 TextEdit 拒绝、`resolveProvider`/`diagnosticProvider` 门控、Windows `.bat/.cmd` 经 cmd.exe、全局 typescript 自动探测注入 `tsserver.path` | stderr 仅 resume 防阻塞；进程退出 reject 全部 pending                                                   | framing 乱码 resync、reader 崩溃自愈（下一个请求重 spawn）、`$PID` token、孤儿 TS 项目诊断过滤（文件不在 rootMarkers 内时过滤 tsc 项目级错误码）、`$/cancelRequest` 发送 |
| 测试             | ✅ mock server 单测（bun test，35 用例）                                                                                 | ✅（packages/opencode/test/lsp）                                                                         | —                                                                                                                     |

### 工作原理对比

**发现与项目根**：三家都走「文件类型 → server → 项目根」三层路由，但根判定方式不同。opencode 把 root 逻辑写死在每个 server 的 root 函数里（NearestRoot 从文件向上找 marker，到 worktree 边界为止，找不到就退回 session 目录；Deno/Gradle/Maven 各有特判），配置层无法覆盖。piex 用统一 PROJECT_MARKERS 表向上找根，且 footer 在非项目根 cwd 会额外扫深度 ≤2 的子项目汇总（monorepo 场景）。omp 把「rootMarkers 命中 + 二进制可用」作为加载前提（配置过滤而非启动时判断），本地 bin 解析最细（node_modules/.bin、各种 venv、vendor/bundle、Go bin、Windows 可执行后缀）。

**进程模型**：三家都是会话内复用 + broken 标记 + spawn 去重（piex `pendingServers`、opencode `spawning`、omp 同步锁）。差异在生命周期管理：omp 支持 `idleTimeoutMs` 空闲回收；opencode 按 instance（子代理独立进程池）隔离；piex 按 (server, root) 缓存、`reload` 全清。omp 另可把 server 包进 `lspmux`（多客户端复用同一 server 进程）。

**诊断管线是三家中差异最大的部分**：
- opencode 最「重」：push + pull 双轨。pull 侧支持动态 capability 注册、workspace/diagnostic、relatedDocuments、按 identifier 并行拉取（当前文件有结果即提前返回，慢的继续后台合并）；push 侧用 version + 150ms debounce 判断「新鲜度」，并为 tsserver 做了首推种子 hack（TS 首次 publish 直接入缓存，免等第二次推送）。没有 settle 静默期概念。
- omp 纯 push：缓存带 version 和全局 `diagnosticsVersion` 计数，等待时「版本比开始前新 + 250ms 稳定」或「精确 version 匹配」即接受；`refreshFile()` 主动删缓存 → didChange → didSave 逼 server 重推。用 `$/progress` 跟踪项目加载，等真正 ready 再问导航，冷启动假阴性最少。
- piex 居中：push settle（800ms 静默）+ 简化 pull（仅 `diagnosticProvider` 声明、单文档 `textDocument/diagnostic`，没有 workspace/diagnostic 与动态注册）。

**写后诊断链路**：opencode 是「工具内联」——edit/write 自己 touchFile 并取全量诊断、只留 ERROR（cap 20）拼进输出，write 还顺带报其他文件（cap 5）。piex 学的是同一模式，但做成 `tool_result` hook（不侵入工具本体，含 hashline），并默认只走 ERROR、干净文件不附加。omp 最精细：写穿透（writethrough）内联等 500ms，慢 server 转 deferred 通道在工具结束后延迟注入（12s 预算、mutation version 防过期诊断混入后续编辑），批量 edit/write 合并到批尾只报一次，ledger 按「诊断身份」去重（同一错误不重复骚扰），并支持写后自动格式化（formatOnWrite）。

**工具面哲学**：opencode 把 LSP 定位为「导航 + 写后反馈」——工具只有 9 个导航 operation（还默认不注册），诊断不暴露为 action（写后反馈里才有）。omp 最全：14 action 覆盖导航、重构、运维，还提供 `request` 裸协议逃生口和 workspace 级子进程诊断（cargo/tsc/go build/pyright）。piex 居中：13 action 但去掉裸协议，保留 format action（omp 反而没有独立 format，只有写穿透格式化），rename 默认 preview（omp 默认 apply，piex 更保守）。

**容错与正确性**：piex 从 pi-extensions 移植了最多协议细节（settle、pull 门控、resolveProvider 门控、重叠 TextEdit 拒绝、stderr 捕获、cmd.exe 包装），并加了全局 typescript 自动探测（typescript-language-server 硬依赖 workspace 内 tsserver，全局 6/7 只有 tsc）。omp 的亮点在进程层自愈：framing 乱码 resync、reader 崩溃自动重 spawn、孤儿 TS 项目诊断过滤。opencode 亮点在下载安装：缺 server 时运行时自动从 npm/GitHub/dotnet 拉取编译，piex 只在 postinstall 一次性装 5 个默认。

**结论**：opencode = 写后反馈默认开 + 导航工具实验性 + 自动下载最激进，能力最「编辑器化」；omp = 功能最全（裸协议、workspace 诊断、rename_file、idle 回收、lspmux）、配置体系最完整、延迟诊断机制最精细，代价是内置、体积大；piex = 聚焦「写后 ERROR 闭环 + 协议正确性 + 可安装可测试」，为 pi 生态提供最小可移植实现，缺失项（call hierarchy、workspace 诊断、项目级配置、lspmux）都在路线图上。
