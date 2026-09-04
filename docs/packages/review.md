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

> 用户只需运行 `/review`：插件自动确定范围、启动独立只读 reviewer，并用可验证 finding 给出 `PASS` 或 `NEEDS FIX`。

## 简介

AI review 的难点不是再多一个模式，而是建立稳定的质量门槛：范围是否覆盖完整工作、reviewer 是否独立、问题是否有证据，以及修复后何时可以停止。

`@piex-dev/review` 因此把人类入口收敛为一个 `/review`。默认覆盖当前分支相对默认分支的已提交、暂存、未暂存与未跟踪文件；评审在隔离的 Pi SDK session 中执行，不继承作者对话；结果经过 changed-line、触发条件、影响与置信度校验。普通改动只用一个 reviewer，风险较高时内部自动增加一个专项 reviewer，用户不需要理解或选择评审编排。

## 技术原理

### Review = 冻结范围 + 独立判断 + 证据裁决

```text
/review → 解析默认分支并冻结 base/head/diff
        → 物理剔除 lock/build/vendor/generated/binary
        → 新建只读 reviewer session
        → 按风险选择 1 个 reviewer 或 lead + specialist
        → 实时展示阶段、模型、thinking level 与工具活动
        → 按需打开安全 reviewer transcript
        → submit_review 结构化提交
        → evidence gate 校验 patch 归因与 changed-line
        → PASS / NEEDS FIX，并持久化 re-review 状态
```

核心洞见：**更多 reviewer 不等于更可靠**。默认单 reviewer 能控制成本和噪声；只有安全、数据、并发、跨仓契约或大 diff 才启动第二个专项 reviewer，最后仍由 lead 合并和裁决，而不是把多份意见直接堆给用户。

### 一个默认入口，高级能力留给工具

| 入口             | 行为                                                                        |
| ---------------- | --------------------------------------------------------------------------- |
| `/review`        | 自动评审相对默认分支的全部当前工作，不弹模式菜单                            |
| `/review <repo>` | 同一流程作用于指定仓库；多个路径触发跨仓契约评审                            |
| `review` 工具    | 默认 `auto`；为 agent/脚本保留 `diff`、`staged`、`branch`、`commit`、`file` |

### Re-review 是状态迁移，不是从零抽奖

每次结果以自定义 session entry 记录 `scopeKey`、`diffHash`、reviewer 模型、finding ID 与规范化后的开放集合。再次 review 时，旧 finding 必须被分类为 `resolved`、`still_open`、`invalid` 或 `superseded`；reviewer 没有给出非空关闭理由时，旧 finding 会继续保留到后续轮次。相同 diff 直接返回缓存。

开放集合会按 finding ID 与语义键去重。重复或旧格式状态优先保留更高优先级的候选，优先级相同时保留更高置信度；尚未关闭的 P0/P1 不能仅靠改报 P2 降级，置信度也按最终生效的优先级校验。P0/P1 决定 `NEEDS FIX`，P2 只是 advisory，因此“继续修复”有明确停止条件。

## 使用说明

### 安装

```bash
pi install npm:@piex-dev/review
```

> 仓库源码：[`extensions/review`](https://github.com/piex-dev/piex/tree/main/extensions/review)

### 前提条件

当前目录是 git 仓库（或通过参数指定任意 git 仓库路径），本机有 `git`。

### 用法

```text
/review
/review ../piex
/review "../piex" "../oh-my-pi"
```

支持 Pi 的 `@path`、autocomplete 引号和相对/绝对路径。多仓路径逐个校验、按 git 根目录去重；任一无效就汇总错误并中止，不产生不完整报告。

`/review` 不做网络请求或隐式 fetch。默认分支按 `origin/HEAD`、`init.defaultBranch`、`main` / `master` / `trunk` 的顺序解析，再从 merge-base 到当前工作区生成一个连贯 diff。若无法可靠确定默认分支，则退化为 `HEAD` 到工作区。

结果语义：

- `NEEDS FIX`：至少一个证据充分的 P0/P1，修复后再次 `/review`
- `PASS`：没有阻塞 finding；P2 可按收益决定，不要求继续循环
- `cached`：scope 与 diff 均未变化，没有重新调用 reviewer

### 实时进度与 reviewer transcript

交互式 TUI 的 `/review` 只在编辑器上方显示实时面板，避免与状态栏重复；非 TUI UI 会回退为状态栏紧凑摘要：

```text
Review · 00:31 · reviewing
● lead · openai-codex/gpt-5.6-sol · thinking xhigh · reading src/reviewer.ts · 3 tools
● specialist/security · openai-codex/gpt-5.6-sol · thinking max · reasoning about changes · 2 tools
```

面板会随 `preparing`、`reviewing`、`adjudicating`、`validating` 等阶段，以及读取源码、搜索、检查冻结 diff 和提交报告等活动更新。通过 `review` 工具调用时，同一份结构化快照会经 `onUpdate` 返回；最终报告会持久化实际 reviewer 模型和 thinking level。

在交互式 TUI 中，`/review` 会在后台执行并立即交还输入框。review 运行期间可直接输入 `/review-log`，也可按 `Ctrl+Alt+R`，两种方式都会打开铺满终端窗口、实时且可滚动的 transcript 浮层；完成后再次运行 `/review-log` 可回看最近一次记录。浮层支持用 `Tab` 切换 lead 与 specialist，方向键或 `j` / `k` 滚动，`G` 回到末尾并恢复自动跟随，`q` / `Esc` 关闭。

transcript 记录任务 prompt、assistant 可见文本、工具调用与结果摘要、阶段/重试状态和最终 `submit_review`，但不采集原始 thinking/reasoning。记录进入内存前会递归脱敏 secret/token/password 等字段与常见凭据格式，并限制单条文本、序列化值、集合深度、条目数和 UI 渲染行数。它不写入作者主 session，也不落盘，`/reload` 或进程退出后清除。

Agent 通常使用 `{ action: "auto" }`。高级工具参数还包括 `repo` / `repos`、`base`、`commit`、`file` 和附加关注点 `instructions`。`commit` 评审以目标提交的第一父提交为基线，因此 merge commit 只展示该次合并相对第一父提交引入的内容；根提交则相对 Git 空树评审。

### 可选配置

默认使用当前模型和 thinking level。`~/.pi/piex-dev/review/settings.json` 可固定 reviewer：

```json
{
  "model": "provider/model-id",
  "specialistModel": "provider/other-model-id",
  "thinkingLevel": "high",
  "specialistThinkingLevel": "max",
  "maxReviewers": 2
}
```

`thinkingLevel` 控制主 reviewer，`specialistThinkingLevel` 只控制风险路由启动的专项 reviewer。两者接受 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`；专项等级未配置时继承主 reviewer。默认 `maxReviewers: 2` 只是允许风险路由启动第二个 reviewer；普通变更仍然只启动一个。显式配置的 `model` / `specialistModel` 始终优先；只有未配置对应模型时，同一 scope 的 re-review 才沿用首次记录的 reviewer 模型。

注意：`ultra` 不是 Pi thinking level。[GPT-5.6 Sol 模型说明](https://developers.openai.com/api/docs/models/gpt-5.6-sol)列出的最高 API `reasoning.effort` 是 `max`；Codex Ultra 使用 maximum reasoning，并可能额外运行 agent，见 [OpenAI Model guidance](https://developers.openai.com/api/docs/guides/latest-model)。因此，`max` 是本扩展可传给单个 reviewer 的最高档，不等于完整的 Codex Ultra 模式；配置中的 `ultra` 会被忽略。

### 验证

```bash
pi -e ./extensions/review/src/review-v2.ts -p "what is 1+1" --no-session
```

## 实现方案

包路径：[`extensions/review`](https://github.com/piex-dev/piex/tree/main/extensions/review)。范围采集、diff、reviewer 编排、finding gate、session state 与渲染分模块实现。

### 噪声过滤（EXCLUDED_PATTERNS）

自动排除 lock、构建产物、vendor、生成物、媒体与二进制。过滤发生在 diff chunk 层，`filteredDiff` 是 reviewer 唯一可见的 patch；原始 diff 只留作本地诊断，避免“列表说排除了、prompt 实际仍包含”的假过滤。

### Diff 解析

按 `diff --git` 切块，记录每个文件的 +/− 与 new-side changed ranges。finding 文件路径先按仓库相对路径精确匹配；只有精确匹配失败时，才把开头的 `a/` 或 `b/` 解释为 Git 展示前缀，避免把真实的顶层 `a`、`b` 目录映射到错误文件。范围对象同时冻结 base/head OID、scope identity 与 diff hash；finding 必须命中这些 changed ranges。

### 独立 reviewer 与只读工具

每个 reviewer 通过 `createAgentSession` 新建内存 session，关闭 extensions、skills、templates、themes 和自动 system/context 注入，只开放 `read` / `grep` / `find` / `ls`、精确返回冻结 patch 的 `review_diff`，以及强类型终止工具 `submit_review`。仓库约束由 reviewer 通过只读工具显式读取，因此不能覆盖 reviewer 的系统角色；reviewer 也不能写文件或运行命令。小 diff 直接内嵌；大 diff 必须逐文件读取，避免截断后仍误报“已覆盖”。

主流程订阅每个独立 session 的 lifecycle、message 类型与 tool execution 事件，并归约成按角色隔离的进度快照。并行 lead/specialist 不会互相覆盖；每秒 heartbeat 即使在长时间 reasoning 期间也会刷新耗时。路径在展示前会移除控制字符并截断，grep pattern、thinking delta 与 text delta 不进入紧凑进度输出。

同一事件流还会写入独立的有界内存 transcript store。只有 `text_delta` 的可见文本会按 reviewer 与阶段合并；`thinking_delta` 被显式丢弃，工具参数和结果先脱敏再截断。每轮记录带 run ID，迟到的旧轮事件不能污染新 review。TUI 浮层订阅 store 变化并实时刷新，滚动离开末尾时暂停自动跟随，回到底部后恢复。

交互式 `/review` 把长时评审放进受控后台任务，使 Pi 主输入循环立即恢复，因此运行中的 `/review-log` 能被即时分派。后台任务使用独立 AbortSignal；退出、`/reload` 或切换 session 时，`session_shutdown` 会先取消任务并等待 reviewer 清理。命令入口与工具入口仍共享执行门禁，不会同时写入同一份 transcript。

### Evidence gate 与自适应复核

`submit_review` 候选进入确定性 gate：仓库/文件必须存在于冻结范围，行号必须和 changed hunk 重叠，`introducedByPatch` 为真，trigger/impact/evidence 非空，P0/P1 置信度至少 0.8，P2 至少 0.75。旧 blocking finding 的置信度按保留下来的有效优先级判断；候选再按稳定 ID 与语义键规范化，冲突时先保留更高优先级，优先级相同时再保留更高置信度。`PASS` / `NEEDS FIX` 与最终摘要都从门禁后的当前 finding 和开放集合确定性生成，不直接复用 reviewer 的原始摘要，因此被拒绝的候选不会造成结论与摘要矛盾。

风险路由只在必要时创建第二个独立 session：security、data-integrity、concurrency、contracts 或 coverage。lead 与 specialist 并行；若 specialist 提交 finding，lead 再做一次证据裁决，最后始终只输出一份报告。

### 与全量多 agent review 对比

| 方案                   | 成本与行为                                       |
| ---------------------- | ------------------------------------------------ |
| 每次固定 N 个 reviewer | 覆盖面高，但重复 finding、成本和“新问题漂移”也高 |
| PieX 自适应 1→2        | 普通 patch 单审；高风险专项复核；lead 统一裁决   |
| 当前作者模型直接自审   | 成本低，但共享上下文容易确认偏误                 |

## 设计参考

| 项目                | 借鉴点                                   | PieX 取舍                                        |
| ------------------- | ---------------------------------------- | ------------------------------------------------ |
| **Pi SDK**          | `createAgentSession`、resource/tool 隔离 | 直接创建独立只读 reviewer，不复用作者 session    |
| **oh-my-pi review** | 多 reviewer、diff 分片、结构化结果       | 不暴露模式矩阵，改成最多两个 reviewer 的风险路由 |
| **主流 PR review**  | changed-line finding、severity、置信度   | 落为运行时 evidence gate，而不只依赖 prompt 自觉 |

核心取舍：**简洁是外部 API，复杂度留在内部编排**。`/review` 永远只有一条主路径；并行、模型和范围细节由风险与自动化入口处理。

## 迭代记录

### 路线图

1. **Diff 边界**：继续补 rename、submodule 与超大文件样本。
2. **项目级策略**：未来可支持 `.reviewignore` 与显式默认分支，但不增加 `/review` 模式菜单。
3. **门禁输出**：在保留 Markdown UX 的同时，为 CI 导出稳定的机器可读报告。
4. **新 finding 稳定性**：积累 re-review 数据后，再决定是否对“旧 hunk 上突然出现的新 P1”增加额外复核。

### 版本记录

| 版本  | 日期       | 变更                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.4.0 | 2026-09-03 | `/review` 收敛为零选择默认流程；自动覆盖相对默认分支的 committed/staged/unstaged/untracked 工作；用 Pi SDK 创建隔离、只读 reviewer session；风险路由最多增加一个 security/data/concurrency/contracts/coverage specialist 并由 lead 裁决，主 reviewer 与专项 reviewer 可独立配置 thinking level；新增按角色隔离的实时进度面板、heartbeat、实际模型/thinking level 展示与最终报告元数据，TUI 只保留详情面板避免状态栏重复；新增 `Ctrl+Alt+R` 实时 reviewer transcript 与 `/review-log` 完成后回看，支持角色切换、滚动/自动跟随、thinking 过滤、敏感字段脱敏和有界内存记录；显式模型配置优先于 re-review 历史模型；引入强类型 `submit_review`、changed-line/confidence/impact evidence gate、稳定 finding ID、session 分支持久化 re-review、同 diff 缓存；开放 finding 跨轮保留，重复 ID 规范化且旧 blocking 优先级不可静默降级；结论与摘要由门禁后的规范结果生成；`a/`、`b/` 路径采用精确匹配优先；merge commit 相对第一父提交评审；工具保留高级 scope；diff 噪声物理剔除且 git 错误不再静默当作 clean |
| 0.3.0 | 2026-07-30 | 多仓库联动评审：`/review "piex" "oh-my-pi"` 一次指定多个仓库（`parseRepoArgs` 解析多 token，引号 / `@` / 弯引号可混用），统一模式应用到所有仓库并合成一条合并 prompt（`buildMultiRepoPrompt`），要求模型检查跨仓库一致性（共享接口/契约/import 路径/重复逻辑）；`resolveRepos` 逐个校验并去重、任一非法汇总全部错误中止；`review` 工具新增 `repos` 数组参数（优先于 `repo`，多仓库仅支持 `diff`/`staged`/`branch`）；过大 diff 按仓库独立 skip；vs 默认分支时用 `canCompareToBase` 区分「比较失败」（无 remote / 没 fetch 到 / 默认分支名不对）与「确实无变更」，失败仓库标注 ⚠️ 不静默当成无变更；单仓库/零仓库行为完全不变                                                                                                                                                                                                                                                                                                                                                                         |
| 0.2.1 | 2026-07-23 | 修复 `/review @"piex"`：pi autocomplete 产生的引号路径（`@"…"` / `"…"` / 弯引号）在 `resolveRepo` 中自动剥离，不再解析成带引号的错误路径                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 0.2.0 | 2026-07-22 | 跨仓库评审：`/review [path]` 命令、`review` 工具 `repo` 参数、菜单「Switch repository path…」；`resolveRepo` 校验路径与 git 仓库（`rev-parse --show-toplevel`，支持 worktree/submodule）并剥离 pi 路径引用前缀 `@`（`/review @piex/` 同 `/review piex`）；安全硬化 `git()` 改用 `execFileSync` 透传 argv，杜绝 `base`/`commit`/`file` 参数的 shell 注入；修复 `parseDiff` 重复累加（excluded 文件不再计入 totals）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 0.1.1 | 2026-07-19 | 初始版本：diff 引擎（`parseDiff`）+ 噪声过滤（`EXCLUDED_PATTERNS`，lock/build/vendor/generated/binary）；5 种模式（uncommitted/staged/branch/commit/custom）；`buildReviewPrompt` 结构化 prompt（过大 diff 不内嵌）；人机共用引擎（`/review` 命令 + `review` 工具）；omp 轻量版（不做多 agent 并行与 TUI overlay）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
