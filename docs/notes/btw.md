---
title: BTW：不被记住的临时提问
date: 2026-07-19
tags: [BTW, Context, Extension]
---

> `/btw` 让你用满上下文问一个临时问题，答案不进入后续对话——就像会议里压低声音问旁边人一句。

## 问题背景

coding agent 的一个经典困境：你想问一个跟当前任务有关、但又不想它「当真」的问题。

举个典型场景：你在 debug 一个 Python 脚本，中间想顺手问一句「对了，这个项目的 Docker 镜像基镜像是哪个？」。如果直接发消息，agent 会把它理解成任务上下文的一部分，之后每次推理都要掂量「用户问过 Docker」，可能导致后续回答发散或缩短。

解决方法很笨拙：要么另开 session 问，要么忍到当前任务结束。都不是好体验。

oh-my-pi 的 `/btw`（by-the-way）解决了这个问题：利用引擎级旁路机制让临时问答**完全不被写入 session**。@piex-dev/btw 用 Extension API 的 context 钩子实现了等效行为。

```bash
pi install npm:@piex-dev/btw
```

---

## 技术原理

### 核心机制：标记 + 过滤

btw 不依赖引擎内部修改，全程走标准 API：

```
/btw 命令 ──► 设置 btwActive 标记 ──► before_agent_start 注入简洁指令
                 │
                 ▼
          agent 用当前上下文回答问题（不用工具、不长篇大论）
                 │
                 ▼
          agent_end ──► 清除 btwActive ──► context 钩子过滤所有 [BTW] 消息
                 │
                 ▼
          后续对话中，agent 感知不到 btw 发生过
```

### 为什么不用工具

btw 模式下禁止 agent 使用工具（read/edit/write/bash 等）。原因：临时提问不需要改动任何东西，开工具只会增加 token 消耗和不确定性。

### 会话恢复

跨 session 重启时，`session_start` 钩子会读取 `btw-mode` 的持久化条目（`pi.appendEntry`），确保状态干净恢复——不会因为上一次 session 中断而卡在 btw 模式。

---

## 实现方案

包路径：[`packages/btw`](https://github.com/piex-dev/piex/tree/main/packages/btw)，约 110 行单文件。

### 核心模块

| 钩子 | 作用 |
|------|------|
| `/btw` 命令 | 接受参数或交互输入，设置 `btwActive`，发送 `[BTW]` 前缀消息 |
| `before_agent_start` | 注入 `BTW MODE` 系统指令，要求 agent 简洁回答、禁用工具 |
| `context` | 非 btw 模式下，filter 掉所有 `[BTW]` user 消息及其 assistant 回复 |
| `agent_end` | 清除 `btwActive`，写持久化状态 |
| `session_start` | 恢复并清理 btw 状态，防止脏启动 |

### 上下文过滤策略

`context` 钩子使用三段式过滤：

1. **跳过 btw 系统消息**：`customType === "btw-ephemeral"` 的系统指令
2. **跳过 btw 用户消息**：以 `[BTW]` 开头的 user 消息
3. **跳过对应回复**：紧跟在 btw user 之后的 assistant 消息

### 与 omp btw 的对比

| omp btw | btw (piex) |
|---------|------------|
| 引擎级旁路 | context 钩子过滤 |
| 完全不在 session 中写入 | 写入带标记，后续过滤 |
| Bun 运行时 | Node.js (pi) |

---

## 优化计划

当前最明显的局限是简化版的「下一个 assistant 消息即 btw 回复」推断。如果 agent 在回答 btw 之前产生了其他消息（概率极低但理论存在），过滤会错位。更稳健的方案是用消息 ID 关联，但当前 Extension API 的消息 ID 机制尚不暴露——等后续 API 就绪再切换。

另一个方向：将 btw 过滤策略抽象为通用的「临时消息分组」模式，供其他需要消息过滤的扩展复用。
