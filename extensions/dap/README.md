# dap

DAP（Debug Adapter Protocol）调试扩展，注册 `debug` 工具。

## 功能

- **debug 工具**：完整的 DAP 协议客户端
- **14 个 debug adapter**：gdb, lldb-dap, codelldb, debugpy (Python), dlv (Go), js-debug-adapter (JS/TS), netcoredbg (C#), kotlin-debug-adapter, rdbg (Ruby), php-debug-adapter, bash-debug-adapter, dart-debug-adapter, flutter-debug-adapter, elixir-ls-debugger
- **会话管理**：launch/attach/terminate
- **断点**：文件断点、函数断点、指令断点、数据断点
- **执行控制**：continue/step_over/step_in/step_out/pause
- **状态检查**：stack_trace/threads/scopes/variables/evaluate
- **内存操作**：read_memory/write_memory/disassemble
- **自动适配器选择**：根据文件扩展名 + 项目标记自动选择

## 使用说明

```bash
pi install npm:@piex-dev/dap
```

需要安装对应的 debug adapter：

```bash
pip install debugpy                                          # Python
brew install llvm                                             # lldb-dap
go install github.com/go-delve/delve/cmd/dlv@latest           # Go
```

冒烟测试：

```bash
pi -e ./extensions/dap/src/dap.ts -p "what is 1+1" --no-session
```

## 依赖

- `@earendil-works/pi-coding-agent`（peer）
- `typebox`（peer）

## 延伸阅读

- https://piex.dev/zh/packages/dap/
