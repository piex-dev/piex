---
title: goal — 让 agent 自主跑到目标完成
date: 2026-07-19
tags: [Goal, Autonomous, Agent-Loop, Extension]
package: goal
npm: "@piex-dev/goal"
type: extension
install: pi install npm:@piex-dev/goal
source: extensions/goal
---

> `/goal` 让 agent 不停在计划或半成品处中断：设定目标后从空闲边界自动续跑，直到用证据证明完成、遇到真实阻塞、或 token 预算耗尽。

## 简介

coding agent 跑长任务时常有两个失败：一是停在计划或半成品就等确认（premature yield），二是没验证就谎报完成（false completion）。`goal` 模式把这两件事都用机制兜住：强制续跑直到可验证完成，并要求完成调用带上当前 `goal_id` 和完成证据摘要。

pi 内置没有 autonomous completion 循环。`@piex-dev/goal` 以纯扩展补上：注册 `/goal` 命令与两个终端工具（`goal_complete` / `goal_blocked`），靠 pi 的 `agent_settled` 生命周期从「完全空闲」边界派发续跑，retry、compaction、steering、follow-up 全部排干后才继续，不重复入队。

## 技术原理

### agent_settled 续跑模型

续跑不是在 `agent_end` 立刻派发。agent 一轮结束后，pi 可能还在做 retry、自动 compaction、steering、或排队 follow-up；此刻插续跑会和这些工作撞车。`goal` 把续跑意图记成一张 ticket，只在 `agent_settled`（agent 真正空闲、无 pending message）时派发一次。重复的 settled 事件不会派发同一意图两次。

manual compaction 不发 `agent_settled`，所以 compaction hook 里用同一个 single-flight dispatcher 作为窄路径 fallback。

### 防陈旧续跑：owned-prompt marker

goal 拥有的 prompt（kickoff、resume、续跑）都注入一个 marker 注释。若一个延迟的旧 prompt 在 goal 被替换/暂停后才送达，marker 匹配会被消费掉、不再触发模型轮，避免旧 goal 的续跑盖过新 goal。stale tool-call block 还会在 goal 停止后拦截陈旧工具调用，直到新的非 goal 用户输入或成功 resume。

### goal_id stale 守卫

`goal_complete` / `goal_blocked` 必须传入当前 `goal_id`，与活跃 goal 不符即拒。resume / edit 会轮换 `goal_id`，使上一代延迟的 turn 无法完成新 goal。这是 owned-prompt marker 之外的第二道防线，挡住「跨代误完成」。

### blocked 通道：真实阻塞要证据

`goal_blocked` 不是普通暂停。它要求当前 `goal_id`、具体 reason、concrete evidence、且同一阻塞连续复发至少 3 个 goal turn（`repeated_turns ≥ 3`）。空 reason/evidence、stale id、非整数、小于 3 轮一律拒。它的意义不只是工具本身：审计措辞写进每个 goal prompt，持续塑造「不要轻易 yield、impasse 要证据」的行为，即便工具不被调用也有效。

### 记账：累计 totalTokens − baseline

每条持久化的 assistant message，用 `usage.totalTokens`（不可用时回退 `input + output + cacheRead + cacheWrite`）。goal 用量 = 当前 session branch 累计 assistant 总量 − 起始时捕获的 baseline，rewind 后 clamp 到 0。provider usage 只在 assistant message 完成时才权威，所以预算可能超一个 model call。

### 预算 wrap-up

预算首次在完成的工具活动后暴露耗尽时，goal 转一次 `budget_limited`，取消续跑，并排一条 bounded wrap-up 指令：只准简要总结进度/结果/阻塞，禁 substantive 工具。工具寻求型模型若在 wrap-up 中调 substantive 工具会被 abort，防无界循环。被拒的 `goal_complete` 也终止 wrap-up；被接受的完成仍需既有证据证明每项要求，但预算耗尽本身不等于完成。

## 使用说明

### 安装

```bash
pi install npm:@piex-dev/goal
```

### 命令

```text
/goal                          # 查看当前目标、状态、轮数、用时、token
/goal implement snake game     # 启动 goal 模式
/goal --tokens 100k fix tests  # 带 token 预算启动
/goal edit ship smaller fix    # 改目标，保留计数
/goal pause                    # 暂停续跑
/goal resume                   # 恢复
/goal clear                    # 清除目标
```

`--tokens` 支持 `k`/`m` 后缀（`100k`、`1.5m`）。目标文本上限 4000 字符，超长请放文件里再在 `/goal` 引用路径。

### 验证流程

1. `/goal <objective>` 启动，agent 收到 kickoff prompt 与 `goal_id`。
2. agent 自主工作；一轮结束若未完成，`agent_settled` 自动续跑。
3. 完成时 agent 调 `goal_complete({ goal_id, summary })`，summary 被审计（拒绝「not complete / tests still fail」类矛盾摘要）。
4. 真实阻塞时调 `goal_blocked({ goal_id, reason, evidence, repeated_turns })`。

### 配置（可选）

`~/.pi/piex-dev/goal/goal.json`：

```json
{
  "toolVisibility": "always"
}
```

`toolVisibility`：`"always"`（默认，工具恒在 schema）或 `"after-first-goal"`（首次激活或恢复未完成 goal 后才显露，保持非 goal 会话 prompt-cache 稳定）。非法配置回退默认并告警，扩展不自动建文件。

## 实现方案

### 取 pi-extensions/pi-goal 扩展骨架

`@piex-dev/goal` 以 `@narumitw/pi-goal`（pi-extensions）的扩展机制为基线移植，不是参考、是改写。保留：

- `agent_settled` 续跑派发 + owned-prompt marker + stale tool-call block
- `goal_complete` / `goal_blocked` 双工具 + `goal_id` 守卫 + summary 矛盾检测
- 状态机：`active / paused / blocked / usage_limited / budget_limited / complete`，区分用户暂停、真实阻塞、provider 限额、用户预算耗尽
- retryable / context-overflow recovery 状态：Pi 自己 retry 期间保持 active，不重复入队续跑
- session-entry 持久化（`pi.appendEntry`，customType `goal-state`），reload 可恢复
- `toolVisibility` 工具显隐策略

### 裁剪

- **实验性有序队列**（`/goal add|prioritize|drop-last|skip`）：pi-goal 自己标 experimental，v1 不引入。
- **跨扩展 RPC 契约**（`pi-goal:rpc:start/pause`、`pi-goal:state` 事件）：piex 暂无 subagent 扩展消费方，YAGNI，留待有需求再加。

### piex 化

- 包名 `@piex-dev/goal`（去 `pi-` 前缀，与 hashline/plan 一致）；配置统一放 `~/.pi/piex-dev/goal/`
- 双引号 + 分号、`node:` 前缀、相对导入 `.js`
- 不读上游 `~/.pi/agent/pi-goal-state.json`（新包无历史用户，干净起步）

### 不移植 `/guided-goal`

oh-my-pi 的 `/guided-goal`（side-session LLM 访谈精炼目标）耦合 obfuscator / providerSessionState 等 internals，且属「目标精炼」而非「完成」，是另一关注点。留待后续以独立 prompt 包形式引入。

## 设计参考

- **pi-extensions/pi-goal**：采纳扩展机制、双工具、`agent_settled` 续跑、状态分类、recovery。它是 piex 唯一可行的扩展路径范本。
- **oh-my-pi**：不采纳：goal 内置于 `coding-agent` 核心（`ToolSession`/`obfuscator`/`framedBlock`/provider transport），无法脱离内核运行，与 piex「100% Extension API」约束冲突。参考其完成审计 prompt 措辞与 `goal_token_delta` 记账思路。

## 迭代记录

### v0.1.0

- lean v1：单目标生命周期 + `agent_settled` 续跑 + token 预算 + wrap-up
- 双工具（`goal_complete` / `goal_blocked`）+ `goal_id` 守卫
- 裁剪实验性队列与 RPC 契约

### 路线图

- 评测对比 single op vs 双工具的误完成率 / 死循环率，用数据决定是否简化
- 按需加实验性有序队列、跨扩展 RPC 契约
- 独立 prompt 包形式引入 guided-goal 目标精炼
