# btw

旁路提问扩展 — `/btw` 命令，利用当前会话上下文回答临时问题，问答完全不进入会话。

## 深度解读

- 博客：https://piex.dev/zh/blogs/btw/
- 源稿：[`docs/notes/btw.md`](../../docs/notes/btw.md)

## 功能

- **/btw 命令**: 临时提问，问答不写入 session，无需任何事后过滤
- **旁路调用**: 通过 `completeSimple` 直接调模型，不经过 agent loop，不会触发工具
- **上下文快照**: 自动携带当前会话摘要（user/assistant + tool call 概要，头部截断 40K 字符）
- **独立模型**: `~/.pi/piex-dev/btw/btw.json` 可配置专用模型与 thinking level（凭据解析失败自动回退当前模型并告警）
- **阅读器 UI**: 可中断的加载动画 + Markdown 滚动 pager（j/k、PgUp/PgDn、Home/End、进度百分比）

```
btw.ts                          # pi 扩展入口 (~700 行)
├── /btw 命令                   #   交互式输入或参数传递
├── completeSimple 旁路调用     #   不经过 agent loop
├── 会话快照构建                #   sessionManager.getBranch() → 40K 字符摘要
├── btw.json 设置               #   model / thinkingLevel
└── BtwAnswerPager              #   Markdown 滚动阅读器
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

加载动画按 Esc 可中断；答案 pager 按 `q` / Esc / Enter 关闭。

## 设置（可选）

`~/.pi/piex-dev/btw/btw.json`：

```json
{
  "model": "anthropic/claude-haiku-4-5",
  "thinkingLevel": "low"
}
```

- `model`：`provider/model-id` 格式。给 btw 配一个便宜快速的模型，主对话继续用强模型
- `thinkingLevel`：`off | minimal | low | medium | high | xhigh | max`，缺省跟随当前会话

## 工作原理

1. `/btw` 解析问题（参数或交互输入）
2. 解析模型与凭据（`modelRegistry.getApiKeyAndHeaders`），失败回退当前模型
3. 从 `sessionManager.getBranch()` 构建会话快照（40K 字符上限，从头部截断）
4. `completeSimple(model, { systemPrompt, messages })` 一次性调用，带 AbortSignal
5. 答案渲染进 Markdown pager；问题和答案**从不写入 session**

## 与 omp btw 的差异

| omp btw                 | btw (piex)                |
| ----------------------- | ------------------------- |
| 内建引擎级旁路机制      | `completeSimple` 旁路调用 |
| 完全不在 session 中写入 | 同样不写入（架构保证）    |
| Bun 运行时              | Node.js (pi)              |

## 来源

旁路架构参考 [pi-extensions](https://github.com/narumiruna/pi-extensions) 的 `pi-btw`；功能灵感来自 [oh-my-pi](https://github.com/can1357/oh-my-pi) 的 `/btw` 旁路提问概念。
