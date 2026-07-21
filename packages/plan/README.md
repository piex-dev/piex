# plan

计划模式扩展 — "先规划后执行"的工作流。

## 深度解读

- 博客：https://piex.dev/zh/blogs/plan/
- 源稿：[`docs/notes/plan.md`](../../docs/notes/plan.md)

## 功能

- **计划模式**: 只读工具，`edit` 和 `write` 禁用，专注分析和规划
- **结构化计划工具**: `plan_complete` 提交完整计划，`plan_question` 向用户提澄清问题（带选项的交互选择）
- **bash 词法级安全**: 引号/转义/管道分段解析，白名单只读命令 + 逐命令参数校验（拒绝重定向、子 shell、变量展开、`find -delete`、`git` 写操作等）
- **systemPrompt 注入**: 计划/执行指令直接追加到系统提示，session 历史零污染
- **Todo 追踪**: 自动提取编号计划，[DONE:n] 标记完成
- **执行模式**: 全工具权限，按步骤执行
- **Footer/Widget**: 实时显示进度（📋 3/5）
- **状态持久化**: 会话恢复时自动重建状态

## 工作流

```
用户: /plan
  ↓
Agent 只读探索，plan_question 澄清关键决策
  ↓
Agent 调用 plan_complete 提交计划（含 "Plan:" 编号步骤）
  ↓
用户选择: Execute / Stay / Refine
  ↓  Execute
[Execution Mode] 全工具 → Agent 执行步骤
  ↓
Agent: [DONE:1], [DONE:2] ...
  ↓
全部完成 → Plan Complete! ✓
```

## 架构

```
plan.ts                        # pi 扩展入口 (~1430 行)
├── plan_complete / plan_question  # 结构化计划工具（TypeBox 参数）
├── Bash safety                #   shell 词法分析 + 白名单校验器
├── Todo parsing               #   "Plan:" 编号提取 + [DONE:n] 标记
├── System prompt injection    #   before_agent_start → systemPrompt
├── Context hygiene            #   剥离 plan 制品（含旧会话残留）
├── State persistence          #   pi.appendEntry
├── UI components              #   Footer, Widget, select
└── Commands                   #   /plan, /todos
```

## pi API 使用

| 功能           | pi API                                       |
| -------------- | -------------------------------------------- |
| /plan 命令     | `pi.registerCommand("plan", ...)`            |
| 结构化计划工具 | `pi.registerTool({ name: "plan_complete" })` |
| 只读工具限制   | `pi.setActiveTools([...])`                   |
| 危险 bash 拦截 | `pi.on("tool_call", ...)` → block            |
| 注入系统提示   | `on("before_agent_start")` → `systemPrompt`  |
| 进度追踪       | `pi.on("turn_end", ...)`                     |
| 交互弹窗       | `ctx.ui.select(...)`, `ctx.ui.editor(...)`   |
| 状态持久化     | `pi.appendEntry("plan-mode", ...)`           |

## 安装

```bash
pi install npm:@piex-dev/plan
```

## bash 安全模型

计划模式下 bash 命令经 shell 词法分析：

1. 按 `;` `|` `||` `&&` 分段（引号/转义感知），每段独立校验
2. 拒绝重定向、子 shell、命令替换、变量赋值/展开、glob
3. 段首命令必须在白名单内：只读命令（`cat`/`grep`/`find`/`jq`…）、带参数校验的结构化命令（`git` 只读子命令、`npm ls/view/test`、`tsc --noEmit`、`cargo test`…）

- 安全模型默认拒绝、按规则放行，因此会误拦少数合法只读命令（参数含 `key=value` 形态会被当成变量赋值而拒绝，如 `git log -L foo=bar`）。这是有意的保守取舍：宁可误拦，不可放行等价绕过。

4. 参数级防护：`find` 禁 `-exec`/`-delete`、`sed` 仅允许 `-n Np`、`git show/log` 要求 `--no-textconv`、`sort` 禁 `-o` 等

## 与 omp 实现差异

| omp                                  | plan                       |
| ------------------------------------ | -------------------------- |
| 全屏 plan-review-overlay 审批计划    | `ctx.ui.select` 3 选项弹窗 |
| Plan TOC 侧栏（目录导航 + 删除段落） | 无（pi API 不支持）        |
| 子 agent 计划传递（plan-handoff）    | 无（依赖 subagent）        |
| plan mode 下 write 工具禁用          | ✅ 保持一致                |

## 来源

基于 pi 官方 [plan-mode 扩展示例](https://pi.dev/examples/extensions/plan-mode/)；bash 安全模型与结构化计划工具参考 [pi-extensions](https://github.com/narumiruna/pi-extensions) 的 `pi-plan-mode`。
