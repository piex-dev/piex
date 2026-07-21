---
title: review — 把 Code Review 做成 Agent 的一等公民
date: 2026-07-19
tags: [Review, Git, Extension]
package: review
npm: "@piex-dev/review"
type: extension
install: pi install npm:@piex-dev/review
source: extensions/review
---

> `/review` 把「贴一段 diff 让 AI 看看」收成可重复能力：范围清楚、噪声可控、人机同一套引擎。

## 简介

「让 AI 看看这段代码有没有问题」人人都会说，真正落地时却常卡住：**Diff 从哪来**（工作区/暂存区/相对 main/某 commit，场景不同）、**噪声太大**（lockfile、min.js、dist 进来上下文瞬间被垃圾填满）、**提示词不稳**（每次手写质量漂移）、**人和模型入口分裂**（命令和工具两套逻辑容易分叉）。

`@piex-dev/review` 把评审收成一条产品线：人用交互命令 `/review`，模型用可调用工具 `review`，内核是同一套 git diff 采集 + 噪声过滤 + 结构化 prompt。它是 omp review 的**轻量版**：完整保留 diff 引擎与模式，不做多 agent 并行评审和 TUI overlay。

## 技术原理

### Review = 选范围 + 清噪声 + 喂结构化上下文

```text
选择模式（uncommitted / staged / branch / commit / custom）
        ↓
     git diff / show
        ↓
   解析 unified diff → 按文件统计 +/−
        ↓
   噪声文件剔除（lock/min/build/vendor/…）
        ↓
   生成 Markdown 评审 prompt
        ↓
   交给当前会话模型输出 findings
```

核心洞见：**评审质量高度依赖「喂给模型的 diff 是否干净」**。模型再强，若一半 token 是 `package-lock.json`，也在浪费。

### 模式对应真实开发动作

| 模式           | 典型问题                                        |
| -------------- | ----------------------------------------------- |
| Uncommitted    | 我这堆还没 commit 的改动靠谱吗？                |
| Staged         | 即将 commit 的内容有没有坑？                    |
| vs base branch | 这个 PR 相对 main 怎么样？（含 fetch）          |
| Commit         | 某一个 sha 引入了什么风险？                     |
| Custom         | 不按 diff，按我的文字指令审（架构、安全清单等） |

### 人和模型共用引擎

`/review` 走 UI 菜单选模式；`review` 工具走参数。两端最后都进 `parseDiff` + `buildReviewPrompt`，避免「命令路径和工具路径行为不一致」的长期维护噩梦。

## 使用说明

### 安装

```bash
pi install npm:@piex-dev/review
```

> 仓库源码：[`extensions/review`](https://github.com/piex-dev/piex/tree/main/extensions/review)

### 前提条件

当前目录是 git 仓库，本机有 `git`。

### 用法

- 人：交互命令 `/review`，列出模式菜单（Uncommitted / Staged / vs base branch / Custom）
- 模型：调用 `review` 工具，传 `action` 参数（`diff` / `staged` / `commit` / `branch`）

选中后生成 prompt，经 `pi.sendUserMessage(..., { deliverAs: "followUp" })` 丢回会话，由当前模型继续当 reviewer。

### 验证

```bash
pi -e ./extensions/review/src/review.ts -p "what is 1+1" --no-session
```

## 实现方案

包路径：[`extensions/review`](https://github.com/piex-dev/piex/tree/main/extensions/review)，约 350 行单文件。

### 噪声过滤（EXCLUDED_PATTERNS）

自动排除：lock（`package-lock.json`、`yarn.lock`、`pnpm-lock.yaml`、`Cargo.lock`…）、构建产物（`dist/`、`build/`、`out/`、`*.min.js`）、vendor（`node_modules/`、`vendor/`）、生成物（`*.generated.*`、`*.snap`、`*.map`）、媒体与二进制（图片、字体、zip/pdf…）。被排除的文件仍出现在 prompt 的「Excluded」小节（路径 + 原因 + 行数），模型知道「有东西被滤掉了」但不吞全文。

### Diff 解析

按 `diff --git` 切块，统计每个文件 `+`/`-` 行（忽略 `+++`/`---` 头）。产出：变更文件表（路径、+/−、扩展名）、排除列表、原始 diff 文本。

### Prompt 生成策略

`buildReviewPrompt`：写 Summary → 列 Changed Files 表 → 列 Excluded → 附加自定义 instructions → **过大则不内嵌全文 diff**（diff > 50k 字符或文件数 > 20 时提示模型用 `read` 按需查看，防止打爆上下文）→ 统一评审指令（按 critical / warning / info 分级，给文件与行号，最后 overall assessment）。实用主义：宁可少喂一点，也别让会话 OOM 式膨胀。

### 与 omp 对比

| omp              | piex review       |
| ---------------- | ----------------- |
| 多 agent 并行审  | 当前 agent 直接审 |
| TUI overlay 展示 | 文本输出          |
| Diff + 噪声过滤  | ✅                |
| 多模式           | ✅（轻量集合）    |
| 结构化 prompt    | ✅ 精简版         |

## 设计参考

| 项目                 | 机制                                                                                                | piex 取舍                                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **oh-my-pi review**  | `/review` 命令 + review 工具；多 agent 并行评审 + TUI overlay；diff 引擎 + 噪声过滤 + 结构化 prompt | **采纳**：diff 引擎（`parseDiff`）、噪声过滤（`EXCLUDED_PATTERNS`）、多模式、人机共用 `buildReviewPrompt`。**不采纳**：多 agent 并行（依赖 subagent）、TUI overlay（改 `sendUserMessage` followUp） |
| **OpenCode /review** | 内置 `/review` 命令，review 未提交或指定 commit/branch                                              | **借鉴**：交互菜单模式选择、统一 prompt 模板、ci/commit/pr 等多 source 评审                                                                                                                         |

核心取舍：完整保留 diff 引擎与噪声过滤（让模型吃饱干净的上下文），放弃并行与视觉 overlay。等 subagent 成熟再迁多 agent 版。

## 迭代记录

### 路线图

1. **单模型单线程**：没有「安全/性能」多视角并行，大 PR 容易审浅。→ 近期可选多 pass（先 critical 再 style）；远期等 subagent 成熟再迁 omp 多 agent 版。
2. **findings 与代码位置弱绑定**：要求给行号，但未挂 hashline tag / LSP 位置，文件一变就对不齐。→ 输出约定 findings JSON；指出的文件联动 diagnostics，运行时嫌疑引向 dap。
3. **base branch 与噪声规则偏朴素**：`fetch origin base` 依赖远端命名；排除列表再长也盖不住怪仓库。→ 项目级 `.reviewignore` / pathspec；远端与默认分支可配置。
4. **结果主要是聊天文本**：不便 CI 门禁或「按 finding 自动开 fix」。→ Markdown 报告外附机器可读块，先服务本地工作流，再考虑门禁。
5. **极端 diff**：rename、binary、submodule 等统计可能漂。→ 解析器按真实 PR 样本补边界，而不是只堆正则。

### 版本记录

| 版本  | 日期       | 变更                                                                                                                                                                                                                                                                                                               |
| ----- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0.1.1 | 2026-07-19 | 初始版本：diff 引擎（`parseDiff`）+ 噪声过滤（`EXCLUDED_PATTERNS`，lock/build/vendor/generated/binary）；5 种模式（uncommitted/staged/branch/commit/custom）；`buildReviewPrompt` 结构化 prompt（过大 diff 不内嵌）；人机共用引擎（`/review` 命令 + `review` 工具）；omp 轻量版（不做多 agent 并行与 TUI overlay） |
