# 实施路线

## 进度总览

| 阶段 | Package | 状态 | 说明 |
|------|---------|------|------|
| 1 | hashline | ✅ 已完成 | hashline 编辑 + polyfill |
| 2 | dap | ✅ 已完成 | 14 个 debug adapter |
| 3 | lsp | ✅ 已完成 | 11 个 LSP server |
| 4a | plan | ✅ 已完成 | Plan Mode / plan 命令 |
| 4b | review (轻量版) | ✅ 已完成 | /review 命令 + review 工具 |
| 5 | review (多 agent 版) | ⏸ 待定 | 依赖 subagent 扩展 |

## 后续规划

### 待迁移功能 (来自 oh-my-pi)

- Plan review overlay (TUI 全屏计划审批)
- Plan TOC sidebar (目录导航)
- Multi-agent review (子 agent 并行评审)

### 待迁移功能 (来自其他 agent)

- Claude Code 的交互模式参考
- OpenCode 的扩展机制参考
- 其他优秀 agent 的功能特性

详见各 package 的 README.md。
