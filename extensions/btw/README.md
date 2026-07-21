# btw

旁路提问扩展 — `/btw` 命令，利用当前会话上下文回答临时问题，问答完全不进入会话。

## 功能

- **/btw 命令**：临时提问，问答不写入 session，无需任何事后过滤
- **旁路调用**：通过 `completeSimple` 直接调模型，不经过 agent loop，不会触发工具
- **上下文快照**：自动携带当前会话摘要（user/assistant + tool call 概要，头部截断 40K 字符）
- **独立模型**：`~/.pi/piex-dev/btw/btw.json` 可配置专用模型与 thinking level（凭据解析失败自动回退当前模型并告警）
- **阅读器 UI**：可中断的加载动画 + Markdown 滚动 pager（j/k、PgUp/PgDn、Home/End、进度百分比）

## 使用说明

```bash
pi install npm:@piex-dev/btw
```

```bash
# 带参数
/btw git status 能显示 untracked 文件吗

# 交互式输入
/btw
> BTW question: ...
```

加载动画按 Esc 可中断；答案 pager 按 `q` / Esc / Enter 关闭。

设置（可选）`~/.pi/piex-dev/btw/btw.json`：

```json
{
  "model": "anthropic/claude-haiku-4-5",
  "thinkingLevel": "low"
}
```

- `model`：`provider/model-id` 格式。给 btw 配一个便宜快速的模型，主对话继续用强模型
- `thinkingLevel`：`off | minimal | low | medium | high | xhigh | max`，缺省跟随当前会话

## 依赖

- `@earendil-works/pi-coding-agent`（peer）
- `@earendil-works/pi-tui`（peer，阅读器 UI）
- `@earendil-works/pi-ai`（peer，模型调用）
- `typebox`（peer）

## 延伸阅读

- https://piex.dev/zh/packages/btw/
