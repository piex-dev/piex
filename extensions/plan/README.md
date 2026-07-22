# plan

计划模式扩展 — "先规划后执行"的工作流。

## 功能

- **计划模式**：只读工具，`edit` 和 `write` 禁用，专注分析和规划
- **结构化计划工具**：`plan_complete` 提交完整计划，`plan_question` 向用户提澄清问题（带选项的交互选择）
- **bash 词法级安全**：引号/转义/管道分段解析，白名单只读命令 + 逐命令参数校验（拒绝重定向、子 shell、变量展开、`find -delete`、`git` 写操作等）
- **systemPrompt 注入**：计划/执行指令直接追加到系统提示，session 历史零污染
- **Footer/Widget**：实时显示进度（📋 3/5）
- **Todo 追踪**：自动提取编号计划，执行中用 `plan_step_complete` 工具标记步骤完成（`[DONE:n]` 文本标签作兼容回退），连续无进展自动退出执行模式避免死循环
- **执行模式**：全工具权限，按步骤执行

## 使用说明

```bash
pi install npm:@piex-dev/plan
```

在 pi 中执行 `/plan` 进入计划模式，agent 只读探索并可用 `plan_question` 澄清关键决策；调用 `plan_complete` 提交计划后，用户选择 Execute / Stay / Refine。

冒烟测试：

```bash
pi -e ./extensions/plan/src/plan.ts -p "what is 1+1" --no-session
```

## 依赖

- `@earendil-works/pi-coding-agent`（peer）
- `@earendil-works/pi-tui`（peer，TUI 集成）
- `@earendil-works/pi-agent-core`（peer，agent 集成）
- `@earendil-works/pi-ai`（peer，AI 集成）
- `typebox`（peer）

## 延伸阅读

- https://piex.dev/zh/packages/plan/
