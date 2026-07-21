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

本机安装对应 language server，例如：

```bash
npm install -g typescript-language-server typescript
pip install pyright
rustup component add rust-analyzer
go install golang.org/x/tools/gopls@latest
```

关闭写后诊断（默认开启）：

```bash
export PI_LSP_DIAGNOSTICS_ON_EDIT=0
```

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
