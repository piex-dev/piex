---
title: DAP：让 Coding Agent 真正会调试
date: 2026-07-19
tags: [DAP, Debug, Extension]
---

> 装上 `@piex-dev/dap` 之后，agent 可以像人一样「跑起来看」。它替代不了测试，但会把「猜变量」变成「读变量」。

## 问题背景

多数 coding agent 的「修 bug」路径是这样的：

1. 读代码猜原因  
2. 改几行  
3. 用 bash 再跑一遍测试  
4. 失败就再猜  

这在简单问题上够用，一碰到「只有运行时才暴露」的问题就很脆：空指针发生在第几层调用栈？某个局部变量当时到底是什么？断点打在条件分支上能不能停住？

人用 IDE 时会开调试器；agent 若只会 `console.log` / `print`，等于被剥夺了调试器。

[Debug Adapter Protocol (DAP)](https://microsoft.github.io/debug-adapter-protocol/) 是 VS Code 那一套调试协议：编辑器不直接懂 GDB/LLDB/debugpy，而是和统一的 adapter 说话。`@piex-dev/dap` 把这套能力接到 pi 上：模型调用一个 `debug` 工具，就能 launch、下断点、单步、看变量，而不是只会改代码碰运气。

安装：

```bash
pi install npm:@piex-dev/dap
```

对应语言还要装 adapter 本体，例如 Python 的 `debugpy`、Go 的 `dlv`、本机 `lldb-dap` 等。扩展负责协议与会话，不负责替你装调试器。

---

## 技术原理

### 1. 三层分工

可以把调试想象成三层：

| 层 | 谁 | 干什么 |
|----|----|--------|
| Agent | pi + LLM | 决定「在哪停、看什么、下一步怎么走」 |
| DAP 客户端 | `@piex-dev/dap` | 把意图翻译成标准 DAP 请求/事件 |
| Debug Adapter | debugpy / dlv / lldb-dap … | 真正控制进程、读内存、报告停点 |

Agent 不需要知道 debugpy 的 JSON 长什么样，只要会调 `debug` 工具的 action。

### 2. 会话生命周期（简化）

```
launch / attach
    → spawn adapter（stdio）
    → initialize + configurationDone
    → 程序 running
    → stopped（命中断点 / 步进结束 / 异常）
    → stack_trace / scopes / variables / evaluate
    → continue / step_* / pause
    → terminate
```

关键状态机在会话管理器里：`running` / `stopped` / `terminated`。模型每次调用工具，拿到的是当前会话摘要加格式化文本（断点列表、栈帧、变量），而不是原始 JSON-RPC 帧。

### 3. 适配器怎么选

`defaults.json` 里为每个 adapter 写了：

- 启动命令与参数  
- 语言与文件后缀  
- 项目根标记（如 `Cargo.toml`、`go.mod`、`package.json`）  
- launch / attach 默认参数  

launch 时根据程序路径是文件还是目录、后缀、工作区根标记，自动挑一个可用 adapter。模型也可以显式指定 adapter 名称。

### 4. 为什么是 stdio 而不是远程 TCP

omp 原版支持 stdio + TCP。piex 的 Node 移植**只做 stdio**：adapter 作为子进程，stdin/stdout 上跑 DAP 消息帧。

取舍很直接：

- **够用**：本机调试 Python/Go/JS/C++ 的主路径都是 stdio  
- **简单**：少一套 socket 生命周期与鉴权  
- **代价**：不支持「连到远程机器上已开的 debug port」这类场景  

对多数 agent 工作流（在当前仓库里跑程序、查 bug）stdio 已经覆盖主需求。

---

## 实现方案

包路径：[`packages/dap`](https://github.com/piex-dev/piex/tree/main/packages/dap)。

### 模块结构

```
dap.ts              # 扩展入口：注册 debug 工具，分发 action
client.ts           # DapClient：Content-Length 帧 + JSON-RPC 请求/事件
session.ts          # DapSessionManager：会话、断点队列、输出缓冲、空闲清理
config.ts           # 读 defaults.json，解析/选择 adapter
types.ts            # DAP 类型面
defaults.json       # 14 个 adapter 默认配置
non-interactive-env.ts  # 关掉交互式 pager/提示，避免挂死
```

### 已支持的 14 个 adapter

`gdb`、`lldb-dap`、`codelldb`、`debugpy`、`dlv`、`js-debug-adapter`、`netcoredbg`、`kotlin-debug-adapter`、`rdbg`、`php-debug-adapter`、`bash-debug-adapter`、`dart-debug-adapter`、`flutter-debug-adapter`、`elixir-ls-debugger`。

### 工具 action 面

面向模型的能力大致分四块：

1. **会话**：`launch` / `attach` / `terminate` / `sessions` / `output`  
2. **断点**：`set_breakpoint` / `remove_breakpoint`（文件行断点为主）  
3. **执行**：`continue` / `step_over` / `step_in` / `step_out` / `pause`  
4. **观察**：`stack_trace` / `threads` / `scopes` / `variables` / `evaluate`  
5. **底层**：`disassemble` / `read_memory` / `write_memory` / `modules` / `loaded_sources` / `custom_request`

能力会按 adapter 上报的 `capabilities` 做检查：不支持的操作直接报错，避免 silently no-op。

### 工程上值得注意的细节

- **断点变更串行化**：同一会话的 breakpoint mutation 走队列，避免并发 `setBreakpoints` 互相覆盖。  
- **输出环形缓冲**：stdout/stderr 类 output 事件有字节上限（约 128KB），防止日志把上下文撑爆。  
- **空闲回收**：长时间不用的会话会被清理，避免僵尸 adapter 进程。  
- **超时可夹紧**：等待 stop 的 timeout 有上下界（约 5s–300s，默认 30s），防止模型填离谱数字。  
- **非交互环境变量**：给子进程注入 `PAGER=cat` 一类变量，避免 GDB 等弹 pager 卡住 agent。  
- **Bun → Node**：`Bun.spawn` → `child_process.spawn`，`Bun.sleep` → `setTimeout` Promise。

### 模型侧典型用法（概念）

```
debug(action=launch, program=./main.py)
debug(action=set_breakpoint, path=main.py, line=42)
debug(action=continue)
# 命中后
debug(action=stack_trace)
debug(action=variables, variablesReference=…)
debug(action=evaluate, expression="user.id")
```

和人在 IDE 里点的是同一条协议链路，只是 UI 换成了工具调用。

---

## 优化计划

相对 omp 与完整 DAP，当前仍有明显缺口，也正好标出优先级：

| 现状 | 影响 | 打算怎么补 |
|------|------|------------|
| 仅 stdio，无 TCP/WebSocket | 难远程 attach 已有 debug server | 可选 TCP 作高级能力，默认仍 stdio |
| 数据/指令/异常断点未完整暴露 | 「谁改了这块内存」类问题吃力 | 按 adapter capabilities 逐步挂到工具面 |
| completions、exceptionInfo 等未全部暴露 | adapter 已有能力模型用不上 | 按使用频率补 action，而不是一次铺满 |
| 纯文本输出 | 栈与变量可读性弱于 omp | 先做 stop 后的默认摘要包（top frame + 局部变量），再考虑 TUI |
| 依赖本机已装 adapter | 新环境门槛高 | 文档与 status 说清缺失项；评测镜像预装常用 adapter |
| 多会话策略偏简单 | 复杂多进程调试一般 | 会话管理与空闲回收先稳，再谈并发 UX |

更具体的产品向改进：

1. **停住即给上下文**：一次 stop 自动附带栈顶与关键变量，少让模型空转 tool call。  
2. **launch 可项目化**：读 `.vscode/launch.json` 或项目级配置，少猜参数。  
3. **评测挂钩**：在 `eval/` 用可复现任务量 `debug_success`，避免「能 launch 就算成功」。
