# 参考资料

## pi 官方文档

| 文档 | 路径 |
|------|------|
| pi 主文档 | `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/README.md` |
| 扩展开发 | `docs/extensions.md` |
| Package 管理 | `docs/packages.md` |
| Prompt 模板 | `docs/prompt-templates.md` |
| Skills 开发 | `docs/skills.md` |
| 主题开发 | `docs/themes.md` |
| TUI 组件 | `docs/tui.md` |
| 快捷键 | `docs/keybindings.md` |
| SDK 集成 | `docs/sdk.md` |
| 自定义 Provider | `docs/custom-provider.md` |
| 模型配置 | `docs/models.md` |

## pi 扩展示例

`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/`

关键示例：

| 示例 | 用途 |
|------|------|
| `tool-override.ts` | 覆盖内置工具（hashline 参考） |
| `tools.ts` | 注册自定义工具 + 工具启用/禁用 |
| `plan-mode/index.ts` | 计划模式（plan 的基础） |
| `subagent/` | 子 agent 实现参考 |
| `summarize.ts` | 自定义 compaction |
| `permission-gate.ts` | 权限控制 |
| `protected-paths.ts` | 路径保护 |

## 功能来源

| 功能 | 来源项目 | 源码路径 |
|------|---------|---------|
| hashline | oh-my-pi | `packages/hashline/src/` |
| DAP | oh-my-pi | `packages/coding-agent/src/dap/` |
| LSP | oh-my-pi | `packages/coding-agent/src/lsp/` |
| Plan mode | oh-my-pi | `packages/coding-agent/src/plan-mode/` |
| Review command | oh-my-pi | `packages/coding-agent/src/extensibility/custom-commands/bundled/review/` |
| Review tool | oh-my-pi | `packages/coding-agent/src/tools/review.ts` |
| Plan TOC | oh-my-pi | `packages/coding-agent/src/modes/components/plan-toc.ts` |
| dark-terminal 主题 | [opencode-themes](https://github.com/debugtalk/opencode-themes) | `dark-terminal.json` |

## 其他参考项目

- [oh-my-pi](https://github.com/can1357/oh-my-pi) — 功能特性的主要来源
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — 交互模式参考
- [OpenCode](https://github.com/opencode-ai/opencode) — 扩展机制参考
- [opencode-themes](https://github.com/debugtalk/opencode-themes) — 终端暗色主题配色来源
