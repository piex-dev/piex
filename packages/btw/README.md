# btw

旁路提问扩展 — `/btw` 命令，利用当前会话上下文回答临时问题，答案不进入后续对话历史。

## 深度解读

- 博客：https://piex.dev/zh/blogs/btw/
- 源稿：[`docs/notes/btw.md`](../../docs/notes/btw.md)

## 功能

- **/btw 命令**: 临时提问，答案不污染后续对话上下文
- **上下文注入**: 自动向 agent 注入简洁回答指令
- **上下文过滤**: 通过 `context` 钩子自动排除 btw 历史消息
- **会话恢复**: 确保中断后 btw 状态干净恢复
- **免工具约束**: btw 模式下禁止 agent 使用工具，只回答

```
btw.ts                          # pi 扩展入口 (~110 行)
├── /btw 命令                   #   交互式输入或参数传递
├── before_agent_start 钩子     #   注入简洁回答指令
├── context 钩子                #   过滤 btw 历史消息
├── agent_end 钩子              #   清除 btw 状态
└── session_start 钩子          #   会话恢复与清理
```

## 安装

```bash
pi install npm:@piex-dev/btw
```

## 使用

```bash
# 带参数
/btw git status 能显示 untracked 文件吗

# 交互式输入
/btw
> BTW question: ...
```

## 工作原理

1. `/btw` 设置 `btwActive` 标记
2. `before_agent_start` 注入简洁回答指令（不用工具、不长篇大论）
3. Agent 基于当前会话上下文回答问题
4. `agent_end` 清除 `btwActive`
5. 后续 `context` 钩子过滤所有 `[BTW]` 标记的消息，agent 感知不到 btw 发生过

## 与 omp btw 的差异

| omp btw                 | btw (piex)           |
| ----------------------- | -------------------- |
| 内建引擎级旁路机制      | context 钩子过滤实现 |
| 完全不在 session 中写入 | 写入带标记，后续过滤 |
| Bun 运行时              | Node.js (pi)         |

## 来源

功能灵感来自 [oh-my-pi](https://github.com/can1357/oh-my-pi) 的 `/btw` 旁路提问概念。
