# lsp

LSP（Language Server Protocol）扩展：注册 `lsp` 工具，并在 `edit`/`write` 成功后自动附加 ERROR 诊断。

## 深度解读

- 介绍：https://piex.dev/zh/packages/lsp/
- 源稿：[`docs/packages/lsp.md`](../../docs/packages/lsp.md)

## 功能

- **lsp 工具**：stdio JSON-RPC 客户端，按项目 rootMarkers 发现 server，会话内复用进程
- **~50 个默认 server**（`defaults.json`）：typescript、rust-analyzer、gopls、pyright、clangd、biome/eslint（linter）等
- **导航**：definition / type_definition / implementation / references / hover / symbols / workspace_symbols
- **诊断**：单文件聚合多 server；relatedInformation；写后自动 ERROR 反馈；push 诊断静默期 settle（慢服务器先推空后推真，不会误报干净，`diagnosticsSettleMs` 可按 server 配置）；server 声明 `diagnosticProvider` 时改用 LSP 3.17 pull 诊断
- **重构**：rename（默认 preview）、code_actions（list / apply；仅 server 声明 `resolveProvider` 时才调 `codeAction/resolve`）
- **格式化**：format（写回磁盘）
- **健壮性**：server stderr 捕获进错误消息；重叠 TextEdit 拒绝应用（防文件损坏）；Windows `.bat/.cmd` 经 `cmd.exe` 包装 spawn
- **运维**：status / reload；broken spawn 缓存；`AbortSignal` 超时取消；`PI_<NAME>_LSP_COMMAND` 环境变量覆盖单 server 命令

## 写后诊断（Phase 1）

`edit` / `write`（含 hashline 覆盖的 edit）成功后，扩展会：

1. 解析改动路径
2. 同步磁盘内容到 language server（didOpen / didChange）
3. 等待诊断（pull 或 push settle）
4. 将 **ERROR** 诊断（每文件最多 20 条）附在 tool 结果末尾

关闭：

```bash
export PI_LSP_DIAGNOSTICS_ON_EDIT=0
```

覆盖单个 server 的启动命令：

```bash
export PI_TYPESCRIPT_LANGUAGE_SERVER_LSP_COMMAND="typescript-language-server --stdio"
```

## 支持的 action

```
status, reload, diagnostics
definition, type_definition, implementation, references, hover
symbols, workspace_symbols
rename, code_actions, format
```

### rename / code_actions

| 参数                  | 说明                                   |
| --------------------- | -------------------------------------- |
| `apply`               | 默认 `false`（preview）；`true` 才写盘 |
| `new_name` / `symbol` | rename 新名称                          |
| `index`               | code_actions 应用时的 1-based 序号     |
| `query`               | code_actions 按 title/kind 过滤        |

写盘后请 **re-read** 再继续 hashline 编辑（tag 会失效）。

## 架构

```
lsp.ts
├── LspClient          # JSON-RPC、open/sync、push settle + pull diagnostics、
│                      # stderr capture、server requests
├── Config             # defaults.json（initOptions + settings + isLinter + diagnosticsSettleMs）
├── Router             # getServersForFile / primary vs linter
├── WorkspaceEdit      # TextEdit + documentChanges apply（限制在 cwd，重叠拒绝）
├── Post-edit hook     # tool_result on edit/write
└── defaults.json
```

## 安装

```bash
pi install npm:@piex-dev/lsp
```

## 前提条件

本机安装对应 language server，例如：

```bash
npm install -g typescript-language-server typescript
pip install pyright
rustup component add rust-analyzer
go install golang.org/x/tools/gopls@latest
```

`which` 会额外查找项目内 `node_modules/.bin`、`.venv/bin`。

## 与 omp / OpenCode / pi-extensions 的差异

| 能力               | omp                     | OpenCode              | pi-extensions `pi-lsp`             | piex lsp                     |
| ------------------ | ----------------------- | --------------------- | ---------------------------------- | ---------------------------- |
| 显式 lsp tool      | 14 action               | 实验 flag             | 2（`lsp_diagnostics` + `lsp_fix`） | 13 action（默认开）          |
| 进程模型           | 会话内复用              | 会话内复用            | spawn-per-call                     | 会话内复用                   |
| 写后诊断           | writethrough + deferred | edit/write 注入 ERROR | ❌（无 hook）                      | tool_result 附 ERROR（可关） |
| rename / format    | ✅                      | ❌                    | ❌（仅 fix）                       | ✅ preview 默认              |
| 多 server 诊断     | ✅                      | ✅                    | ✅（routes）                       | ✅                           |
| push settle / pull | ❌                      | ❌                    | ✅                                 | ✅                           |
| stderr 捕获        | ❌                      | ❌                    | ✅                                 | ✅                           |
| isLinter 分流      | ✅                      | 多 client             | ❌                                 | ✅                           |
| Windows .bat/.cmd  | —                       | —                     | ✅ `cmd.exe` 包装                  | ✅                           |
| TUI 渲染           | ✅                      | 侧栏 status           | ❌                                 | 纯文本                       |
| 项目级 lsp 配置    | 多层                    | config.lsp            | ❌（仅全局 routes）                | 暂仅 defaults（后续）        |
| lspmux / 自动下载  | 有                      | 有                    | ❌                                 | ❌                           |
| 单测               | —                       | —                     | ❌                                 | ✅ mock server（14 用例）    |

功能参考 [oh-my-pi](https://github.com/can1357/oh-my-pi) `packages/coding-agent/src/lsp`、OpenCode 写后诊断闭环与 [pi-extensions](https://github.com/narumiruna/pi-extensions) `pi-lsp` 的协议细节。
