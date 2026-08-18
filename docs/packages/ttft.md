---
title: ttft — 首 token 延迟实时可见，缓存命中率随 /ttft 查看
date: 2026-08-18
tags: [TTFT, Latency, Cache, Throughput, Status Bar, Extension]
package: ttft
npm: "@piex-dev/ttft"
type: extension
install: pi install npm:@piex-dev/ttft
source: extensions/ttft
---

> 状态栏实时展示每轮 TTFT（首 token 延迟）与解码吞吐（tokens/s），首 token 一到就上屏；会话累计与每轮缓存命中率在 `/ttft` 明细中查看，`/resume` 不丢历史。

## 简介

用 coding agent 时，最影响等待体感的两个指标肉眼不可见：**模型多久开始吐字**（TTFT），以及**吐字有多快**（解码吞吐）。pi 内置 footer 只有 token 消耗、成本与最新一条消息的缓存命中率，没有 TTFT 也没有吞吐。`@piex-dev/ttft` 把这部分能力从 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 StatsLine 迁移到 pi 状态栏：

```text
TTFT 1.2s · 45.3t/s
```

全自动：首 token 到达的瞬间 TTFT 上屏，轮次落定后补上解码吞吐。每轮指标通过 `pi.appendEntry` 持久化，`/resume` 后历史完整重建。

缓存命中率也在统计范围内（会话累计 + 每轮），但**不上状态栏**：pi 内置 footer 已展示最新一轮的 `CH%`，同栏再出现一个不同口径的 cache 数字只会混淆。累计命中率放在 `/ttft` 明细中，与 deepseek-harness 的 `cache N%` 同口径。

## 技术原理

### 指标的事件来源

| 指标 | 计算 | 展示位置 |
| --- | --- | --- |
| TTFT | `turn_start.timestamp` → 首个 `message_update`，pi 在每轮 LLM 请求前发射 `turn_start`（带时间戳），首个流式更新即为首 token | 状态栏，首 token 即上屏 |
| tokens/s | 首 token → 末次流式更新 ÷ `usage.output`，三者齐备且 decode ≥ 200ms 才采样（burst 抑制） | 状态栏，流结束即上屏（早于工具执行） |
| cache 命中率 | `cacheRead / (input + cacheRead + cacheWrite)`，四个 disjoint bucket 与 deepseek-harness 的 `TokenTotals` 同构，公式照搬 | `/ttft` 明细（会话累计 + 每轮） |

### 缓存展示的取舍：一个状态栏只有一个 cache 数字

pi 0.84+ 内置 footer 已展示 `↑input ↓output R W CH%`，其中 `CH` 是**最新一条 assistant 消息**的命中率；deepseek-harness 展示的是**会话累计**命中率。`@piex-dev/ttft` 补上了后者（session 内所有消息的 bucket 先累加再求比，长会话里更能反映「前缀复用是否持续生效」），但把它放在 `/ttft` 明细而非状态栏：状态栏出现两个不同口径的 cache 值（内置 `CH` 与本包累计值）会让用户无法判断该看哪个。状态栏只展示 pi 完全缺失的 TTFT 与吞吐，cache 信号归 `/ttft`。

### 持久化与重建

每轮落定后 `pi.appendEntry("ttft", …)` 写入自定义 entry（不进 LLM context）；`session_start` 时扫描 `sessionManager.getEntries()` 重建：

- **轮次历史**只来自 `ttft` 自定义 entry（TTFT/吞吐/每轮命中率）
- **token 累计**只来自 assistant/toolResult 消息与 compaction/branch_summary 的 usage，与 pi 内置 footer 同一套算法（自定义工具可上报 usage）

两个来源互不重叠，重建不会重复计数。TTFT 锚点用 `turn_start`：pi 在请求组装前发射该事件，因此测的是**端到端**首 token 延迟（含 prompt 组装），与 deepseek-harness 的 step 级口径语义一致。

## 使用说明

### 安装

```bash
pi install npm:@piex-dev/ttft
```

> 仓库源码：[`extensions/ttft`](https://github.com/piex-dev/piex/tree/main/extensions/ttft)

### 用法

零配置。首轮对话后状态栏自动出现：

```text
TTFT <延迟> · <tokens/s>t/s
```

- 首 token 一到，`TTFT` 立即上屏且本轮不再变化（首 token 延迟就此定格）
- 流结束（`message_end`，早于工具执行）即补精确 `t/s`；decode 短于 200ms 或短于 TTFT 一半的缓冲回放不展示 t/s（网关分块回放噪声，`/ttft` 标注 `buffered`）
- 整个 segment 用 dim 渲染，与状态栏其他字符（pwd/model/context）一致
- 缓存命中率不上状态栏，避免与 pi 内置 footer 的 `CH%` 撞车

```bash
/ttft    # 会话平均 TTFT、token 累计、会话累计命中率、每轮 TTFT/吞吐/输出/命中率表格
```

### 验证

```bash
pi -e ./extensions/ttft/src/ttft.ts -p "say hi" --no-session
bun test extensions/ttft/test/ttft.test.ts
```

## 实现方案

包路径：[`extensions/ttft`](https://github.com/piex-dev/piex/tree/main/extensions/ttft)，单文件 `src/ttft.ts` 约 300 行，纯逻辑（格式化、命中率公式、轮次记录推导）与事件编排分层，全部可单测。

### 事件编排

```text
turn_start        记录轮次锚点（event.timestamp）
message_update    首个 assistant 更新 → 首 token，立即 paintStatus
message_end       流结束即拿 usage → 精确 t/s 上屏（早于工具执行）
turn_end          采样 usage，推导 TurnRecord，appendEntry 持久化
session_start     从 entries 重建历史 + token 累计
session_shutdown  清空活动引用，防止跨会话串扰
```

- **渲染时机**：只在首 token、流结束（`message_end`，usage 早于工具执行到达）与轮次落定三个时刻重绘，流式期间不做逐 token 重绘；`message_end` 即上屏精确 t/s，避免状态栏在工具执行期间只挂 TTFT
- **解码时长下限**：decode 短于 200ms 或短于 TTFT 一半的采样视为网关缓冲回放，t/s 不展示并在 `/ttft` 标注 `buffered`；输出 token 数仍记录。分块回放是典型伪装：TTFT 22s 后 1000 token 在 0.9s 内刷完，会读出不可能的「1147 t/s」
- **渲染内容**：状态栏只放 TTFT 与 t/s；cache 累计（`totals`）持续维护但只进 `/ttft` 明细
- **多会话隔离**：pi 单进程跑多个 session（`/new`、`/resume`、`/fork`），module-level 状态在 `session_start` 全量重建，事件处理器校验 session id，旧 session 的迟到事件无法污染新 session 的状态栏
- **轮次编号**：重建时取历史最大编号 + 1，`/resume` 后新轮次不会从 1 重排
- **容错**：`appendEntry` 失败不影响状态栏（best-effort 持久化）；无 timing 或无首 token 的轮次不产生记录（与 deepseek-harness「无采样即不显示」一致）

## 设计参考

| 项目 | 机制 | piex 取舍 |
| --- | --- | --- |
| **deepseek-harness StatsLine** | 内部记录 `timing.stepStartTime/firstTokenTime/completedTime`，durable projection 持久化，展示平均 TTFT、tokens/s、cache 命中率 | **公开事件近似**：`turn_start` + `message_update` + `usage` 达到同等信号；`appendEntry` 替代 projection；cache 命中率移入 `/ttft` 明细而非状态栏（见上） |
| **pi 内置 footer** | 展示 token 消耗、成本与最新消息 `CH%` | **互补不重叠**：内置 CH 是最新轮；本包状态栏只做 TTFT 与吞吐，累计命中率归 `/ttft` |
| **terminal 计时器类工具** | 手动计时或事后统计，无事件驱动 | **事件驱动**：首 token 即上屏，零操作 |

核心取舍：状态栏常驻优于命令查询（等待焦虑发生在当下，不是事后复盘）；一个信号一个位置（cache 已有内置展示，本包只补口径、不重复上栏）；持久化优于内存（`/resume` 是高频操作，历史断了统计就没有意义）。

## 迭代记录

### 路线图

1. **工具耗时统计**：`tool_execution_start` → `tool_execution_end` 累计 LLM 与工具时长占比（对齐 deepseek-harness StatsLine 的 durations 组）。
2. **平均 TTFT 上状态栏**：当前平均 TTFT 只在 `/ttft` 详情中，考虑在状态栏展示 `avg` 段（需评估空间）。
3. **ttft 历史视图**：`/ttft --last 10` 只显示最近 N 轮。
4. **cache miss 提示**：复用 pi 的 cache-stats 思路，`/ttft` 中缓存命中率骤降时标注可能原因（TTL 过期、模型切换）。

### 版本记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| 0.1.0 | 2026-08-18 | 初始版本：每轮 TTFT + tokens/s 状态栏展示（`message_end` 即上屏 t/s，早于工具执行；decode 短于 200ms 或短于 TTFT 一半的缓冲回放不展示 t/s，`/ttft` 标注 `buffered`）；cache 统计（会话累计 + 每轮）归 `/ttft` 明细，不与内置 footer CH% 撞车；`appendEntry` 持久化与 `session_start` 重建；`/ttft` 详情命令；多会话隔离；21 项单测 |
