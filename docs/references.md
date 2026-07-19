# 参考资料

## 设计哲学

| 资料 | 说明 |
|------|------|
| [What I learned building an opinionated and minimal coding agent](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) | pi 作者的设计纲领：minimal prompt/toolset、No plan mode、No sub-agents 等 |
| [pi README — Philosophy](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md) | "aggressively extensible"；"What pi doesn't do" 官方清单 |
| [oh-my-pi README](https://github.com/can1357/oh-my-pi) | fork + batteries-included 路线的自我表述，piex 的主要功能来源 |
| [porting-from-pi-mono.md](https://github.com/can1357/oh-my-pi/blob/main/docs/porting-from-pi-mono.md) | omp backport 上游的维护 playbook，fork 路线成本的一手材料 |

## pi 官方文档

基于 [earendil-works/pi](https://github.com/earendil-works/pi) 中 `packages/coding-agent` 的文档。
> 链接默认分支为 `main`；若 404，请对照 [earendil-works/pi](https://github.com/earendil-works/pi) 当前默认分支调整路径。

| 文档 | 链接 |
|------|------|
| pi 主文档 | [README.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md) |
| 扩展开发 | [docs/extensions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) |
| Package 管理 | [docs/packages.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) |
| Prompt 模板 | [docs/prompt-templates.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/prompt-templates.md) |
| Skills 开发 | [docs/skills.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md) |
| 主题开发 | [docs/themes.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/themes.md) |
| TUI 组件 | [docs/tui.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md) |
| 快捷键 | [docs/keybindings.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/keybindings.md) |
| SDK 集成 | [docs/sdk.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) |
| 自定义 Provider | [docs/custom-provider.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md) |
| 模型配置 | [docs/models.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md) |

## pi 扩展示例

[examples/extensions/](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions)

关键示例：

| 示例 | 用途 |
|------|------|
| [tool-override.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/tool-override.ts) | 覆盖内置工具（hashline 参考） |
| [tools.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/tools.ts) | 注册自定义工具 + 工具启用/禁用 |
| [plan-mode/index.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/plan-mode/index.ts) | 计划模式（plan 的基础） |
| [subagent/](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent) | 子 agent 实现参考 |
| [summarize.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/summarize.ts) | 自定义 compaction |
| [permission-gate.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/permission-gate.ts) | 权限控制 |
| [protected-paths.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/protected-paths.ts) | 路径保护 |

## 功能来源

| 功能 | 来源项目 | 源码 |
|------|---------|------|
| hashline | [oh-my-pi](https://github.com/can1357/oh-my-pi) | [packages/hashline/src/](https://github.com/can1357/oh-my-pi/tree/main/packages/hashline/src) |
| DAP | [oh-my-pi](https://github.com/can1357/oh-my-pi) | [packages/coding-agent/src/dap/](https://github.com/can1357/oh-my-pi/tree/main/packages/coding-agent/src/dap) |
| LSP | [oh-my-pi](https://github.com/can1357/oh-my-pi) | [packages/coding-agent/src/lsp/](https://github.com/can1357/oh-my-pi/tree/main/packages/coding-agent/src/lsp) |
| LSP 写后诊断闭环 | [OpenCode](https://github.com/anomalyco/opencode) | `packages/opencode/src/lsp/` + edit/write touchFile |
| Plan mode | [oh-my-pi](https://github.com/can1357/oh-my-pi) | [packages/coding-agent/src/plan-mode/](https://github.com/can1357/oh-my-pi/tree/main/packages/coding-agent/src/plan-mode) |
| Review command | [oh-my-pi](https://github.com/can1357/oh-my-pi) | [bundled/review/](https://github.com/can1357/oh-my-pi/tree/main/packages/coding-agent/src/extensibility/custom-commands/bundled/review) |
| Review tool | [oh-my-pi](https://github.com/can1357/oh-my-pi) | [tools/review.ts](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/tools/review.ts) |
| Plan TOC | [oh-my-pi](https://github.com/can1357/oh-my-pi) | [plan-toc.ts](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/modes/components/plan-toc.ts) |
| dark-terminal 主题 | [opencode-themes](https://github.com/debugtalk/opencode-themes) | [dark-terminal.json](https://github.com/debugtalk/opencode-themes/blob/main/dark-terminal.json) |

## 其他参考项目

- [oh-my-pi](https://github.com/can1357/oh-my-pi)：功能特性的主要来源
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)：交互模式参考
- [OpenCode](https://github.com/opencode-ai/opencode)：扩展机制参考
- [opencode-themes](https://github.com/debugtalk/opencode-themes)：终端暗色主题配色来源
