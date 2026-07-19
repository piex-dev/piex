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

| 模式 | 工具 | 目的 |
|------|------|------|
| Plan | `read` / `bash`(受限) / `grep` / `find` / `ls`，**禁用** `edit`/`write` | 只收集事实、写计划 |
| Execution | 恢复全工具（含 edit/write） | 按步骤改代码 |

关键不是「提示词里写请不要修改」，而是 **真正从 active tools 里拿掉写工具**。模型就算想 edit，也没有这个工具。

### 2. bash 也不能放飞

只读模式里 bash 仍在（要跑 `git status`、`ls`、只读检查）。但破坏性命令会被 `tool_call` 钩子拦截，例如：

- 文件改动：`rm` / `mv` / `cp` / 重定向写入  
- 包管理：`npm install`、`pip install`…  
- git 写操作：`commit` / `push` / `reset`…  
- 权限与进程：`sudo`、`kill`、`reboot`…

这是第二道闸：防止「工具列表只读、bash 偷偷写盘」。

### 3. 计划如何变成 Todo

模型被要求输出：

```text
Plan:
1. …
2. …
3. …
```

扩展在 `turn_end` 解析编号列表，生成 `TodoItem[]`。  
进入执行模式后，模型每完成一步输出 `[DONE:1]` 这类标记，扩展勾选对应项并更新 UI。

### 4. 状态如何扛住 compaction

会话一长，pi 可能压缩历史。只靠聊天记录里的「Plan:」文本会丢。  
做法是：

- `pi.appendEntry("plan-mode", { enabled, todos, executing, ... })` 把结构化状态写入 session 自定义条目  
- 同时把计划落到工作区 `PLAN.md`  
- 恢复会话时读回状态，重建 footer / widget

**系统状态进 appendEntry，给人看的计划进 PLAN.md**，两边分工清晰。

### 5. 上下文注入

`before_agent_start` 时：

- 计划模式：注入 `[PLAN MODE ACTIVE]` 说明限制与输出格式  
- 执行模式：注入剩余步骤列表与「完成后打 `[DONE:n]`」约定  

模型每个 turn 都能再次看到约束，而不是只在进入模式时说一次。

---

## 实现方案

包路径：[`packages/plan`](https://github.com/piex-dev/piex/tree/main/packages/plan)，入口约 485 行单文件。

### 用户路径

```
/plan 或 Shift+Alt+P
  → 只读探索，产出 Plan: 编号列表
  → UI 提供 Execute / Stay / Refine 一类选择
  → Execute：打开全工具，按步执行
  → [DONE:n] 推进
  → 全部完成提示 Plan Complete
```

辅助命令：

- `/todos`：开关 todo widget 显示  
- CLI flag `plan`：启动即进入 plan mode  

### 用到的 pi Extension API（精选）

| 能力 | API |
|------|-----|
| 命令 | `registerCommand("plan" / "todos")` |
| 快捷键 | `registerShortcut` |
| 工具集切换 | `setActiveTools` / `getActiveTools` |
| 拦截危险 bash | `on("tool_call")` → `block` |
| 注入上下文 | `on("before_agent_start")` |
| 解析完成标记 | `on("turn_end")` |
| 交互 | `ctx.ui.select` / `editor` / `setStatus` / `setWidget` |
| 持久化 | `appendEntry` |

这是 piex 里「扩展 API 用得最全」的包之一，很适合当扩展编写教材。

### 工具集合并策略

进入 plan 时会记住 `toolsBeforePlanMode`。  
计划工具集 =（原 active 去掉 edit/write）∪ 只读工具集。  
退出时尽量恢复进入前的集合，并保留其它扩展注册的额外工具（不在 managed 集合里的名字会保留）。  
这样和 hashline/lsp/dap 共存时，不会把别人的工具误杀光。

### 与 omp 的差异（有意做轻）

| omp | piex plan |
|-----|-----------|
| 全屏 plan-review overlay | `select` 三选项级交互 |
| Plan TOC 侧栏 | 无（pi API 限制） |
| 子 agent plan handoff | 无（依赖未来 subagent） |
| write 禁用 | 一致 |

轻量的好处是：依赖面小、行为可预测、和上游 pi 示例同源好维护。
---

## 设计参考

| 项目 | 机制 | piex 取舍 |
|------|------|-----------|
| **pi 官方 plan-mode 示例** | `registerCommand("plan")` + `setActiveTools` + `tool_call` 拦截 bash | **采纳**核心 API 方案：工具切换、bash 拦截、`[DONE:n]` 标记解析、`before_agent_start` 注入。**增强**：`appendEntry` 跨 turn 持久化 + PLAN.md 落盘 + UI widget |
| **oh-my-pi plan** | 全屏 plan-review overlay + TOC 侧栏 + 子 agent handoff | **不采纳**：pi API 不支持全屏 overlay，且子 agent 未就绪。**借鉴**：步骤审批（改为 `select` 交互）、工具白名单可配置、与 `/review` 联动 |

核心取舍：坚持 pi 示例同源路线（轻、可预测、好维护），放弃 omp 式重 UI；用 `appendEntry` 扛 compaction 而不是 TUI 持久化。
## 优化计划

Plan Mode 解决的是制度，不是魔法；边界清楚，后续也围绕这些边界加厚：

1. **计划解析偏启发式**  
   正则吃 `Plan:` + 编号列表，标题一变或 bullet/中英混排就可能抽空或抽脏。  
   → 引入更稳的计划 IR（例如可选 JSON 块）；解析失败明确要求重发，而不是静默空 todos。

2. **`[DONE:n]` 靠自觉**  
   漏标、错标时进度会漂，也没有和 diff/测试的硬校验。  
   → 做弱验证：步骤里点名的文件若 working tree 完全未动，提示「标了 DONE 但无变化」。

3. **Refine 偏浅**  
   相对 omp 的段落级审批与 TOC，现在只有轻量选择。  
   → 在 pi API 能力范围内加强审批，而不是重做全屏 overlay。

4. **黑名单不是沙箱**  
   危险 bash 正则拦常见写法，拦不住所有等价绕过。  
   → 工具白名单可配置（例如 plan 阶段允许 `lsp`、收紧 bash），并在文档里把「降风险 ≠ 隔离」写死。

5. **单会话顺序执行**  
   大任务拆 subagent 不在本包范围。  
   → 先与 `/review` 收尾联动（plan → exec → review）；并行执行等子 agent 机制成熟再接。

另外可约定 `PLAN.md` frontmatter（目标、非目标、风险），方便人和自动化同读一份计划。

---

## 附录：omp 与 pi plan-mode 能力逐项对比

> 来源：迁移预研文档，记录两项目能力差距以供实现与演进参考。

| 能力 | omp plan-mode | pi plan-mode 示例 | piex plan |
|------|-------------|-----------------|-----------|
| /plan 命令 | ✅ | ✅ | ✅ |
| 只读工具限制 | ✅ (read/bash-safe/grep/find/ls) | ✅ | ✅ |
| 危险 bash 拦截 | ✅ 正则匹配 | ✅ | ✅ |
| Todo 提取 | ✅ 编号列表 + 标题解析 | ✅ 编号列表 | ✅ |
| 执行进度追踪 | ✅ [DONE:n] 标记 | ✅ | ✅ |
| Footer 状态 | ✅ ⏸ plan / 📋 n/m | ✅ | ✅ |
| Widget 进度 | ✅ todo 列表 | ✅ | ✅ |
| 状态持久化 | ✅ appendEntry | ✅ | ✅ appendEntry + PLAN.md |
| 会话恢复 | ✅ 扫描消息重建状态 | ✅ | ✅ |
| 快捷键 | Shift+P | Ctrl+Alt+P | Shift+Alt+P |
| 写计划到文件 | ✅ local:// 协议 | ❌ | ✅ PLAN.md |
| 计划审批弹窗 | ✅ plan-review-overlay 全屏 | ❌ | ❌ select 替代 |
| Plan TOC 侧栏 | ✅ 目录导航 + 删除段落 | ❌ | ❌ pi API 限制 |
| 子 agent 计划传递 | ✅ plan-handoff | ❌ | ❌ 依赖 subagent |
| Compaction 保护 | ✅ 计划文件不被清理 | ❌ | ✅ appendEntry |

piex plan 的策略：坚守 pi 示例同源路线，用 `appendEntry` 跨 turn 持久化 + `PLAN.md` 落盘补 compaction 缺口；放弃 omp 重 UI（overlay/TOC/handoff），保持轻量可维护。
