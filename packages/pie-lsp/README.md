# pie-lsp

LSP（Language Server Protocol）语言服务器扩展，注册 `lsp` 工具。

## 功能

- **lsp 工具**: 内置 LSP 客户端 + JSON-RPC 通信
- **11 个 LSP server 配置**: typescript, rust-analyzer, gopls, pyright, clangd, marksman, yamlls, bashls, cssls, htmlls, jsonls 等
- **诊断**: 文件和项目级诊断
- **代码导航**: definition, references, hover
- **符号**: document_symbols, workspace_symbols
- **格式化**: 文档格式化（format）
- **状态管理**: 按需启动、会话内缓存、关闭清理

## 架构

```
lsp.ts                         # pi 扩展入口（自包含）
├── LspClient 类               # LSP JSON-RPC 客户端
├── LSP Manager                # 服务器发现 + 缓存
├── Config                     # defaults.json (499 行)
├── Diagnostics                # 诊断渲染
├── Symbol rendering           # 符号图标映射
└── Format                     # TextEdit 应用
```

## 支持的 action

```
status, diagnostics, definition, references
hover, symbols, workspace_symbols, format, reload
```

## 安装

```bash
pi install npm:@debugtalk/pie-lsp
pi -e ./extensions/lsp.ts
```

## 前提条件

需要安装对应的语言服务器：

```bash
npm install -g typescript-language-server  # TypeScript
brew install marksman                     # Markdown
rustup component add rust-analyzer        # Rust
pip install pyright                       # Python
```

## 来源

功能特性来自 [oh-my-pi](https://github.com/can1357/oh-my-pi) 的 `packages/coding-agent/src/lsp`。
