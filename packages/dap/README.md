# dap

DAP（Debug Adapter Protocol）调试扩展，注册 `debug` 工具。

## 深度解读

- 博客：https://piex.dev/zh/blogs/dap/
- 源稿：[`docs/notes/dap.md`](../../docs/notes/dap.md)

## 功能

- **debug 工具**: 完整的 DAP 协议客户端
- **14 个 debug adapter**: gdb, lldb-dap, codelldb, debugpy (Python), dlv (Go), js-debug-adapter (JS/TS), netcoredbg (C#), kotlin-debug-adapter, rdbg (Ruby), php-debug-adapter, bash-debug-adapter, dart-debug-adapter, flutter-debug-adapter, elixir-ls-debugger
- **会话管理**: launch/attach/terminate
- **断点**: 文件断点、函数断点、指令断点、数据断点
- **执行控制**: continue/step_over/step_in/step_out/pause
- **状态检查**: stack_trace/threads/scopes/variables/evaluate
- **内存操作**: read_memory/write_memory/disassemble
- **自动适配器选择**: 根据文件扩展名 + 项目标记自动选择

## 架构

```
dap.ts                         # pi 扩展入口
├── client.ts                  # DapClient — JSON-RPC over DAP
├── session.ts                 # DapSessionManager — 会话管理
├── config.ts                  # 适配器配置 + 发现
├── types.ts                   # 完整 DAP 类型 (~370 行)
├── defaults.json              # 14 个适配器默认配置
├── non-interactive-env.ts     # 非交互环境变量
└── utils.ts                   # 工具函数
```

## 支持的 action

```
launch, attach, terminate, sessions, output
set_breakpoint, remove_breakpoint
continue, step_over, step_in, step_out, pause
- `Node.js 移植仅支持 stdio transport，不支持 TCP/WebSocket 远程调试`
evaluate, stack_trace, threads, scopes, variables
disassemble, read_memory, write_memory
modules, loaded_sources, custom_request
```

## Node.js 移植说明

从 omp（Bun）移植到 Node.js 的主要变更：

| Bun API | Node.js 替代 |
|---------|-------------|
| `Bun.spawn()` | `child_process.spawn()` |
| `Bun.sleep(ms)` | `new Promise(r => setTimeout(r, ms))` |
| `Bun.env` | `process.env` |

## 安装

```bash
pi install npm:@piex-dev/dap
```

## 前提条件

需要安装对应的 debug adapter：

```bash
pip install debugpy        # Python
brew install llvm           # lldb-dap
go install github.com/go-delve/delve/cmd/dlv@latest  # Go
```

## 来源

## 与 omp 实现差异

| omp | dap |
|-----|---------|
| 双传输层（stdio + TCP） | 仅 stdio（不支持 TCP/WebSocket 远程调试） |
| 数据断点、指令断点、异常断点 | 未实现（需手动补全） |
| completions、exceptionInfo | 未实现（session 层已支持，工具未暴露） |
| TUI inline rendering | 纯文本输出 |

功能特性来自 [oh-my-pi](https://github.com/can1357/oh-my-pi) 的 `packages/coding-agent/src/dap`。
