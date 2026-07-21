---
title: context — 看清 Session 到底吃了多少 Token
date: 2026-07-19
tags: [Context, Session, Extension]
package: context
npm: "@piex-dev/context"
type: extension
install: pi install npm:@piex-dev/context
source: extensions/context
---

> `/context` 一眼看清当前 session 的内容分布：谁在占用上下文、哪些条目膨胀最快、你的 token 预算都花在哪了。

## 简介

coding agent 用久了，上下文窗口是最大的隐形成本。你感觉「越聊越慢」「回答变浅」，但很难定位根源——是 tool results 膨胀？是某次 read 拉了一堆冗余内容？还是对话历史本身过长？

pi 内置的 `/session` 只能展示 session 列表，缺少单 session 内的内容分布分析。`@piex-dev/context` 填补这个缺口：一次性输出结构化的条目分析、角色占比和 token 估算。

## 技术原理

### Token 估算模型

context 不做精确 token counting（精确计数需调模型 tokenizer，成本太高），而是用业界通用的「字符数 / 3.5」经验公式。对于中英混合内容，这个系数偏保守但不失为有用的相对比较。

### 分析维度

```text
session entries ──► 按 role 分类（user / assistant / system）
                 │
                 ├─► 按 type 分类（message / tool_call / tool_result / custom）
                 │
                 ├─► 按角色统计字符数
                 │
                 └─► 生成 ASCII bar chart + 结构化表格
```

三个角色为分析主轴：

- **Assistant**：模型生成的回答，通常是 token 占比较大头
- **User**：你的指令和上下文
- **Tool Results**：工具返回，是最容易意外膨胀的部分（read 大文件、grep 结果过多等）

## 使用说明

### 安装

```bash
pi install npm:@piex-dev/context
```

> 仓库源码：[`extensions/context`](https://github.com/piex-dev/piex/tree/main/extensions/context)

### 用法

```bash
/context
```

输出包含 Overview 表格 + Distribution ASCII 柱状图 + token 估算。

### 配置

无配置项，开箱即用。token 估算固定用 chars / 3.5 系数。

### 验证

```bash
pi -e ./extensions/context/src/context.ts -p "what is 1+1" --no-session
```

## 实现方案

包路径：[`extensions/context`](https://github.com/piex-dev/piex/tree/main/extensions/context)，约 160 行单文件。

### 核心函数

| 函数               | 职责                                                |
| ------------------ | --------------------------------------------------- |
| `analyzeEntries()` | 遍历 session entries，按 role/type 统计数量和字符数 |
| `countChars()`     | 适配 string 和 content block 数组两种内容格式       |
| `buildReport()`    | 生成 Markdown 表格 + ASCII 柱状图                   |
| `estimateTokens()` | chars / 3.5 估算法                                  |
| `buildBar()`       | 生成 █ / ░ 字符柱状图                               |

### 报告结构

```text
## Context Usage Report

### Overview
| Metric            | Value |
|-------------------|-------|
| Total entries     | 42    |
| Estimated tokens  | ~3.2k |
| User messages     | 12    |
| Assistant messages| 14    |
| Tool calls        | 8     |
| Tool results      | 6     |

### Distribution
████████████░░░░░░░░ Assistant     62%
██████░░░░░░░░░░░░░░ User          28%
██░░░░░░░░░░░░░░░░░░ Tool Results  10%

Estimated total: ~3.2k tokens (11,234 chars)
```

### 与 pi /session 对比

| pi /session       | context (piex)             |
| ----------------- | -------------------------- |
| 展示 session 列表 | 展示当前 session 内容分布  |
| 无分布图表        | ASCII bar chart 分布可视化 |
| 无 token 估算     | chars → tokens 估算        |
| 无条目分类        | 按 role/type 详细分类      |

## 设计参考

| 项目                   | 机制                                     | piex 取舍                                                                                     |
| ---------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| **pi 内置 `/session`** | 展示 session 列表，无单 session 内容分布 | **并存**：context 补齐 `/session` 缺的分布分析、token 估算、role/type 分类，不替换 `/session` |
| **业界 token 估算**    | 字符数 / 3.5 经验公式                    | **采纳**：相对比较够用且零成本（无需 tokenizer），偏保守但适合定位「谁在膨胀」                |

核心取舍：相对比较优先于精确计数（零成本、定位问题够用），静态快照优先于时序分析（先解决「现在谁占得多」）。

## 迭代记录

### 路线图

1. **精确 token 计数**：当前 chars/3.5 对中英混合偏差较大。→ 如果 pi 将来暴露 tokenizer 接口，切换到精确计算。
2. **时序分析**：当前只做静态快照。→ 加入「token 消耗随时间/turn 增长」的时序图，更直观定位哪个 turn 膨胀最快。
3. **异常检测**：自动标记 tool results 超过阈值（如 50K chars）的条目，提示用户检查是否拉了多余内容。
4. **可配置度量**：支持按项目自定义估算系数，甚至接入外部 tokenizer。

### 版本记录

| 版本  | 日期       | 变更                                                                                                                                                                                                                                                                        |
| ----- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1.0 | 2026-07-19 | 初始版本：`/context` 输出 session 内容分布报告；`analyzeEntries` 按 role（user/assistant/system）+ type（message/tool_call/tool_result/custom）分类统计；`estimateTokens`（chars/3.5）；ASCII bar chart 分布可视化；与 pi `/session` 并存（补分布分析 + token 估算 + 分类） |
