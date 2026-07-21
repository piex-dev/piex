---
title: BTW：不被记住的临时提问
date: 2026-07-19
tags: [BTW, Context, Extension]
---

> `/btw` 让你用满上下文问一个临时问题，问答完全不进入会话——就像会议里压低声音问旁边人一句。

## 问题背景

coding agent 的一个经典困境：你想问一个跟当前任务有关、但又不想它「当真」的问题。

举个典型场景：你在 debug 一个 Python 脚本，中间想顺手问一句「对了，这个项目的 Docker 镜像基镜像是哪个？」。如果直接发消息，agent 会把它理解成任务上下文的一部分，之后每次推理都要掂量「用户问过 Docker」，可能导致后续回答发散或缩短。

解决方法很笨拙：要么另开 session 问，要么忍到当前任务结束。都不是好体验。

`@piex-dev/btw` 的回答是：**问题压根不发给 agent**。扩展自己拿一份会话快照，旁路调一次模型，把答案弹给你看。session 里什么都不会留下。

---

## 技术原理

### 核心机制：旁路调用

扩展绕开 agent loop，用 pi-ai 的 `completeSimple` 直接对模型发一次性请求：

```
/btw 命令 ──► 解析模型与凭据 ──► 构建会话快照（≤40K 字符）
                 │
                 ▼
       completeSimple(model, { systemPrompt, messages })
                 │
                 ▼
       答案渲染进 Markdown pager（可滚动、可中断）
                 │
                 ▼
       session 中无任何写入，无需过滤
```

因为问答从不进入 session，「防污染」从运行时过滤变成了架构保证：没有东西需要被滤掉。

### 会话快照

上下文不是全量搬运，而是压缩后的摘要：

- 只取 user / assistant 消息
- toolCall 保留 `name(args)` 一行，toolResult 保留来源工具与结果 JSON
- 超过 40,000 字符时从**头部**截断（保留最近的对话），并标注 `[Earlier context omitted...]`

### 独立模型与 thinking level

`~/.pi/piex-dev/btw/btw.json` 可给 btw 配专用模型：

```json
{ "model": "anthropic/claude-haiku-4-5", "thinkingLevel": "low" }
```

临时提问通常不需要旗舰模型。凭据通过 `modelRegistry.getApiKeyAndHeaders` 解析（支持 OAuth），找不到模型或凭据失败时回退当前会话模型并弹出告警。

### UI：loader + pager

- 等待期间是 `BorderedLoader`，Esc 中断（AbortSignal 直达请求）
- 答案用 Markdown 渲染进自制 pager：`j/k` 滚动、PgUp/PgDn 翻页、Home/End 跳转、右下角进度百分比，`q`/Esc/Enter 关闭

---

## 实现方案

包路径：[`extensions/btw`](https://github.com/piex-dev/piex/tree/main/extensions/btw)，约 700 行单文件。

### 核心模块

| 模块                       | 作用                                                           |
| -------------------------- | -------------------------------------------------------------- |
| `/btw` 命令                | 参数或 `ctx.ui.input` 交互输入                                 |
| `loadCompleteSimple`       | 兼容 pi-ai 0.79（根导出）与 0.80（`/compat` 子路径）的动态加载 |
| `resolveBtwModel`          | 设置模型 → 当前模型的回退链，凭据校验                          |
| `buildConversationContext` | `sessionManager.getBranch()` → 压缩快照                        |
| `completeSideQuestion`     | 组装 systemPrompt + user prompt，带 AbortSignal                |
| `BtwAnswerPager`           | Markdown 滚动阅读器组件                                        |

### 与 omp btw 的对比

| omp btw                 | btw (piex)                |
| ----------------------- | ------------------------- |
| 引擎级旁路              | `completeSimple` 旁路调用 |
| 完全不在 session 中写入 | 同样不写入（架构保证）    |
| Bun 运行时              | Node.js (pi)              |

---

## 设计参考

| 项目                                                                      | 机制                                                               | piex 取舍                                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| **[pi-extensions `pi-btw`](https://github.com/narumiruna/pi-extensions)** | `completeSimple` 旁路 + 会话快照 + settings 文件 + loader/pager UI | **采纳**整体架构，保留 piex 的无参交互输入；pi-ai 0.79/0.80 兼容加载直接复用 |

---

## 版本迭代

| 版本          | 架构        | 说明                                                                                                                                    |
| ------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1.0         | 注入 + 过滤 | `[BTW]` 问题注入主 agent loop，靠 prompt 禁工具，事后用 `context` 钩子按「跳过下一条 assistant」推断过滤                                |
| 0.2.0（当前） | 旁路调用    | `completeSimple` 一次性请求 + ≤40K 会话快照，问答不写入 session；新增 `btw.json` 独立模型/thinking level、可中断 loader、Markdown pager |

0.1.0 的教训：「先污染、后治理」在异步消息流里很难做严——assistant 回复夹带 toolCall 序列时过滤推断会错位漏滤，agent 忙时消息排队会让 btw 标记盖到错误的 turn，注入的指令消息本身也成了要清扫的制品。0.2.0 换成「不产生污染」，整类边界随之消失。

## 优化计划

1. **快照不含 system prompt 与工具结果全文**：40K 字符的压缩快照对「刚刚那个报错什么意思」这类问题可能缺关键细节。后续可按问题相关性做选择性携带（例如始终保留最后一个 toolResult 全文）。
2. **无多轮追问**：目前一问一答。可以考虑在 pager 里加输入行，追问时携带上一轮回合（仍不写入 session）。
3. **模型配置热更新**：`btw.json` 现在每次提问重读，行为正确但没有 `/btw model` 之类的快捷配置命令，后续可补。
