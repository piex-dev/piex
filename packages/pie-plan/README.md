# pie-plan

计划模式扩展 — "先规划后执行"的工作流。

## 功能

- **计划模式**: 只读工具，专注分析和规划
- **Todo 追踪**: 自动提取编号计划，[DONE:n] 标记完成
- **执行模式**: 全工具权限，按步骤执行
- **计划文件**: 写入 `PLAN.md`，compaction 保护
- **Footer/Widget**: 实时显示进度（📋 3/5）
- **状态持久化**: 会话恢复时自动重建状态

## 工作流

```
用户: /plan (或 Shift+P)
  ↓
[Plan Mode] 只读工具 → Agent 探索代码
  ↓
Agent 输出 "Plan:" + 编号列表
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
plan.ts                        # pi 扩展入口 (348 行)
├── Tool management            #   工具切换 (pi.setActiveTools)
├── Bash protection            #   危险命令拦截
├── Todo parsing               #   计划解析 + [DONE:n] 标记
├── Context injection          #   [PLAN MODE] / [EXECUTING]
├── State persistence          #   pi.appendEntry
├── UI components              #   Footer, Widget, select
└── Commands                   #   /plan, /todos, Shift+P
```

## pi API 使用

| 功能 | pi API |
|------|--------|
| /plan 命令 | `pi.registerCommand("plan", ...)` |
| 快捷键 | `pi.registerShortcut(Key.shift("p"), ...)` |
| 只读工具限制 | `pi.setActiveTools([...])` |
| 危险 bash 拦截 | `pi.on("tool_call", ...)` → block |
| 注入计划上下文 | `pi.on("before_agent_start", ...)` |
| 进度追踪 | `pi.on("turn_end", ...)` |
| 交互弹窗 | `ctx.ui.select(...)`, `ctx.ui.editor(...)` |
| 状态持久化 | `pi.appendEntry("plan-mode", ...)` |

## 安装

```bash
pi install npm:@debugtalk/pie-plan
pi -e ./extensions/plan.ts
```

## 来源

基于 pi 官方 [plan-mode 扩展示例](https://pi.dev/examples/extensions/plan-mode/)，增强计划文件写入和 compaction 保护。
