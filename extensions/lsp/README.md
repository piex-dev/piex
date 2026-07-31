# lsp

LSP（Language Server Protocol）扩展：注册 `lsp` 工具，并在 `edit`/`write` 成功后自动附加 ERROR 诊断。

## 功能

- **lsp 工具**：stdio JSON-RPC 客户端，按项目 rootMarkers 发现 server，会话内复用进程
- **~50 个默认 server**（`defaults.json`）：typescript、rust-analyzer、gopls、pyright、clangd、biome/eslint（linter）等
- **导航**：definition / type_definition / implementation / references / hover / symbols / workspace_symbols
- **诊断**：单文件聚合多 server；relatedInformation；写后自动 ERROR 反馈；push 诊断静默期 settle（慢服务器先推空后推真，不会误报干净）；server 声明 `diagnosticProvider` 时改用 LSP 3.17 pull 诊断
- **重构**：rename（默认 preview）、code_actions（list / apply）
- **格式化**：format（写回磁盘）
- **健壮性**：server stderr 捕获进错误消息；重叠 TextEdit 拒绝应用（防文件损坏）；Windows `.bat/.cmd` 经 `cmd.exe` 包装 spawn
- **运维**：status / reload；`AbortSignal` 超时取消；`PI_<NAME>_LSP_COMMAND` 环境变量覆盖单 server 命令

## 使用说明

```bash
pi install npm:@piex-dev/lsp
```

## 自动安装 language server

安装 `@piex-dev/lsp` 时（postinstall）自动检测并安装默认 language server：
TypeScript/JS（typescript-language-server + typescript@5 + bash-language-server，npm -g）、
Python（pyright，pipx → uv → pip3）、Go（gopls，go install）、Rust（rust-analyzer，rustup → brew）。

- 已安装的会跳过（幂等）；失败不中断安装，只报告
- 跳过自动安装：`PI_LSP_SKIP_SETUP=1 npm install`
- 安装后随时重跑：pi 内 `/lsp:setup`，或 `node scripts/setup-ls.mjs`（`--check` 只检测）
- 注意：typescript-language-server 需要 `tsserver.js`，脚本会装 typescript@5
  （typescript@6/7 是 native 编译器，只有 tsc 没有 tsserver）。扩展启动 server 时
  会自动探测全局 typescript 并注入 `tsserver.path`，workspace 有本地
  `node_modules/typescript` 时优先用本地的。

关闭写后诊断（默认开启）：

```bash
export PI_LSP_DIAGNOSTICS_ON_EDIT=0
```

## Footer 状态

会话启动后，footer 会实时显示 `lsp` 状态（类似 opencode 的 `• N LSP`）：

- `LSP off`（dim）：没有可用的 server（无匹配，或匹配的 server 命令都不在本机）
- `LSP typescript-language-server`（dim）：已匹配且命令可用，尚未启动（懒启动）
- `LSP typescript-language-server`（绿色）：正在运行
- `LSP typescript-language-server`（红色）：启动失败（`lsp reload` 后重试）

状态纯靠颜色区分：绿色=运行中，红色=失败，dim=待启动。

只显示真实可用的 server：匹配但命令不在 PATH 上的（永远不会被启动）一律隐藏。
在**非项目根目录**启动 pi 时（多仓库集合目录、monorepo 根），会自动扫描深度 ≤2
的子目录汇总其中项目的 server（如 `piex` 根显示 `extensions/*` 的
`typescript-language-server`），而不是显示 `.git` marker 匹配的 bashls 等噪音。

状态在 server 启动 / 退出 / 失败 / `lsp reload` 时自动刷新。

## 读取预热（opencode 风格）

`read` 工具读取文件时会**后台预热**对应 language server（spawn + didOpen，
fire-and-forget，失败静默忽略、不阻塞读取）。读取代码文件后 footer 立即亮绿，
后续编辑诊断也更快（server 已就绪）。`edit`/`write` 后的写后诊断、`lsp`
工具显式调用同样会启动 server。

## 项目根发现

server 发现默认基于会话工作目录。当 cwd 不是项目根（多仓库集合目录、
monorepo 根等），会从目标文件所在目录向上查找最近的 marker
（`package.json`/`go.mod`/`pyproject.toml`/`Cargo.toml` 等）作为项目根启动
server。例如在 `coding-agents` 或 `piex` 顶层工作时，编辑
`piex/extensions/lsp/src/lsp.ts` 会自动用 `extensions/lsp` 作为 TS 项目根。
footer 中运行中的 server 不受 cwd 限制，始终显示。

## Footer 布局

LSP 扩展会替换整个 footer（复刻内置的 pwd / token 统计 / 模型显示），第三行
扩展状态做左右分区：`usage` 等其他扩展的状态保持在左侧原位置，`lsp` 状态
右对齐（类似 opencode 的布局）。

覆盖单个 server 的启动命令：

```bash
export PI_TYPESCRIPT_LANGUAGE_SERVER_LSP_COMMAND="typescript-language-server --stdio"
```

冒烟测试：

```bash
cd extensions/lsp && npm install && cd ../..
bun test extensions/lsp
```

## 依赖

- `@earendil-works/pi-coding-agent`（peer）
- `typebox`（peer）

## 延伸阅读

- https://piex.dev/zh/packages/lsp/
