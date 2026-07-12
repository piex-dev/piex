# omp → pie 迁移功能对比分析

> 全面对比 [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) 与 [pie](https://github.com/debugtalk/coding-agents/pie) 的功能特性，识别可拆分迁移的候选功能。

## 🟢 已迁移（5 个 package）

| # | Package | 功能 | omp 源码 | pie 状态 | 行数 |
|---|---------|------|---------|---------|------|
| 1 | pie-hashline | hashline 编辑（覆盖 edit 工具） | `packages/hashline/` | ✅ 完成 | 318 |
| 2 | pie-dap | DAP 调试 — 14 个 debug adapter | `packages/coding-agent/src/tools/debug.ts` | ✅ 完成 | 2154 |
| 3 | pie-lsp | LSP 语言服务器 — 11 个 server | `packages/coding-agent/src/lsp/` | ✅ 完成 | 1069 |
| 4 | pie-plan | Plan Mode（/plan 命令 + 计划工作流） | `packages/coding-agent/src/modes/components/plan-*.ts` + slash-commands | ✅ 完成 | 348 |
| 5 | pie-review | 代码评审（/review + review 工具，轻量版） | `packages/coding-agent/src/tools/review.ts` + custom-commands | ✅ 完成 | 330 |

**已迁移 5 个 package，覆盖约 4219 行核心代码。** pie-review 多 agent 版待定（依赖 subagent 机制）。

---

## 🟡 候选功能：按迁移可行性分级

### Tier 1 — 高可行性（pi Extension API 原生支持，独立程度高）

| # | 候选 Package | 功能 | omp 源码 | 描述 |
|---|-------------|------|---------|------|
| 6 | **pie-todo** | Todo 工具 + /todo 命令 | `tools/todo.ts` | Agent 可调用的 todo 工具，支持增删改查、阶段管理、标记完成/放弃 |
| 7 | **pie-conflict** | 冲突解决 | `tools/conflict-detect.ts` | `conflict://N` 内部 scheme，`@ours/@theirs/@base` 标记语法 |
| 8 | **pie-ast-grep** | AST 结构搜索 | `tools/ast-grep.ts` + `crates/pi-ast/` | 50+ tree-sitter 语法的结构代码查询，依赖 ast-grep-core |
| 9 | **pie-ast-edit** | AST 结构编辑 | `tools/ast-edit.ts` | ast-grep rewrite → preview → accept 工作流 |
| 10 | **pie-glob** | 文件查找工具 | `tools/glob.ts` | 基于 glob 的文件路径搜索，Gitignore 感知 |
| 11 | **pie-ask** | 结构化提问工具 | `tools/ask.ts` | Agent 可调用的 option picker，生成交互式选择弹窗 |
| 12 | **pie-eval** | Eval 执行单元 | `tools/eval.ts` + `eval-backends.ts` | 持久化 Python / JavaScript 执行环境，共享 prelude |
| 13 | **pie-web-search** | 网页搜索 | `web/search.ts` | 多 provider 搜索（25 后端），返回结构化答案 + 引用 |
| 14 | **pie-export** | 会话导出 | slash `/export` | 导出 session 为 HTML 文件（含渲染的 tool cards） |
| 15 | **pie-share** | 加密分享 | slash `/share` | 加密导出 session 到分享服务器 |
| 16 | **pie-dump** | 会话转录 | slash `/dump` | 导出纯文本会话转录到剪贴板，附带 LLM 请求 JSON |
| 17 | **pie-context** | 上下文用量报告 | slash `/context` | 展示 session 的上下文使用率分布 |
| 18 | **pie-tools** | 工具可见性报告 | slash `/tools` | 列出当前 agent 可见/可用的所有工具 |
| 19 | **pie-usage** | 用量统计报告 | slash `/usage` | 展示各 provider 的 token 消耗、限额、速率重置 |
| 20 | **pie-learning** | 规则学习 | `tools/learn.ts` | Agent 从交互中提取模式，生成/更新项目规则 |
| 21 | **pie-resolution** | resolve/apply | `tools/resolve.ts` | 与 ast_edit 配对：proposed → accept/discard |
| 22 | **pie-changelog** | 更新日志查看 | slash `/changelog` | 查看 omp/pie 的更新日志 |

### Tier 2 — 中等可行性（需要较多适配，或依赖 pi 未完全暴露的能力）

| # | 候选 Package | 功能 | omp 源码 | 描述 |
|---|-------------|------|---------|------|
| 23 | **pie-browser** | 浏览器控制 | `tools/browser.ts` + `tools/puppeteer/` | Puppeteer 驱动的 Chromium，含 stealth 反检测 |
| 24 | **pie-gh** | GitHub 集成 | `tools/gh.ts` + `github-cache.ts` | GitHub CLI 封装：repo、PR、issues、code search |
| 25 | **pie-ssh** | SSH 远程执行 | `tools/ssh.ts` | 单次远程命令执行 |
| 26 | **pie-commit** | 原子提交拆分 | `omp commit` 子命令 | 分析 working tree → 拆分无关变更 → 依赖排序 |
| 27 | **pie-checkpoint** | 检查点/回退 | `tools/checkpoint.ts` | checkpoint + rewind（探索性对话回退并保留摘要） |
| 28 | **pie-compact** | 上下文压缩 | `/compact` slash | 手动触发会话压缩（summary/chunk/manual） |
| 29 | **pie-shake** | 内容精简 | `/shake` slash | 从上下文删除工具结果、大块内容 |
| 30 | **pie-memory** | Hindsight 记忆 | `tools/memory-*.ts` | retain/recall/reflect 工具链 + /memory slash |
| 31 | **pie-image-gen** | 图片生成 | `tools/image-gen.ts` | Gemini/GPT/xAI 模型的图片生成 |
| 32 | **pie-inspect-image** | 图片分析 | `tools/inspect-image.ts` | vision model 分析本地图片 |
| 33 | **pie-tts** | 文字转语音 | `tools/tts.ts` | xAI Grok Voice TTS |
| 34 | **pie-btw** | 旁路提问 | `/btw` slash | 用当前上下文问临时问题，不写入 session |
| 35 | **pie-settings** | 设置 UI | `/settings` slash | 开放设置选择器 |
| 36 | **pie-branch** | 分支选择器 | `/branch`/`/tree`/`/fork` slash | 会话树导航、分支创建、fork |
| 37 | **pie-model** | 模型切换 | `/model`/`/switch`/`/fast` slash | 运行时切换模型、快速模式切换 |
| 38 | **pie-ext-dashboard** | 扩展控制中心 | `/extensions` slash | 扩展/agent 控制面板 UI |

### Tier 3 — 高复杂度（深度耦合 omp 内部引擎，难独立提取）

| # | 候选 Package | 功能 | 原因 |
|---|-------------|------|------|
| 39 | **pie-subagent** | 子 agent 并行任务 `task` | 依赖 omp 的 task orchestrator、worktree isolation、output-manager。pi 有基础 subagent 示例但不完整 |
| 40 | **pie-advisor** | Advisor 双模型审核 | 依赖 omp 的 parallel model session、turn injection。pi Extension API 无多模型能力 |
| 41 | **pie-collab** | 实时协同会话 | 依赖 omp 的 relay 协议、WebSocket、participant 同步 |
| 42 | **pie-marketplace** | 插件市场 | 依赖 omp 的 marketplace manager、catalog 系统 |
| 43 | **pie-goal** | Goal 模式 | 持久化自主目标管理、token 预算 |
| 44 | **pie-vibe** | Vibe 模式 | 直接持续 fast/good worker 会话 |
| 45 | **pie-loop** | Loop 循环模式 | 每次 yield 自动重新提交 prompt |
| 46 | **pie-internal-schemes** | 内部 URL 方案 | pr://, issue://, skill://, rule://, agent:// 等。需要 deep tool integration |
| 47 | **pie-config-inheritance** | 配置文件自动继承 | 从 .cursor/.claude/.gemini 等自动读取配置 |
| 48 | **pie-force** | 强制 tool choice | `/force:<tool-name>` 限定下个 turn 的工具 |

---

## 📊 汇总统计

| 分类 | 数量 | 说明 |
|------|------|------|
| ✅ 已迁移 | 5 | pie-hashline, pie-dap, pie-lsp, pie-plan, pie-review |
| 🟢 Tier 1 (容易) | 17 | 可通过 pi Extension API 直接实现 |
| 🟡 Tier 2 (中等) | 16 | 需要适配或部分依赖外部 SDK |
| 🔴 Tier 3 (困难) | 10 | 依赖 omp 内部引擎，难独立 |
| **合计** | **48** | |

---

## 🎯 建议迁移优先级

### P0 — 立刻可做（高价值 + 低复杂度）

| 优先级 | Package | 理由 |
|--------|---------|------|
| **P0-1** | pie-todo | Agent 任务管理是最常用的交互需求，纯 tool 注册，一天可完成 |
| **P0-2** | pie-conflict | 冲突解决是 git 工作流高频痛点，方案简洁（scheme 注册） |
| **P0-3** | pie-ask | 结构化提问比手动问用户强太多，pi 已有 `ctx.ui.select/confirm` |

### P1 — 近期规划（独立工具，有外部依赖但可控）

| 优先级 | Package | 理由 |
|--------|---------|------|
| **P1-1** | pie-ast-grep | AST 搜索比 regex 精准，需 ast-grep CLI 或 native binding |
| **P1-2** | pie-ast-edit | AST 编辑 + resolve 模式，与 ast-grep 配套 |
| **P1-3** | pie-web-search | 多后端搜索，可选轻量版（只用 1-2 个免费后端） |
| **P1-4** | pie-gh | GitHub 集成，需 gh CLI 或 Octokit SDK |
| **P1-5** | pie-eval | Python/JS 持久执行环境，需确保安全 |
| **P1-6** | pie-memory | Hindsight 记忆系统，依赖 SQLite/embedding |

### P2 — 中长期规划（需要 pi 能力增强）

| 优先级 | Package | 理由 |
|--------|---------|------|
| **P2-1** | pie-browser | Puppeteer + stealth 反检测，依赖重但独立 |
| **P2-2** | pie-commit | 原子提交分析，算法独立但需要深度的 diff 理解 |
| **P2-3** | pie-checkpoint | Checkpoint/rewind，需 session 状态管理 |
| **P2-4** | pie-ssh | SSH 远程执行，需 SSH client 能力 |
| **P2-5** | pie-subagent | 子 agent 机制 — 等待 pi Extension API 完善 |

---

## 📋 已完成功能 vs 原版差异

### pie-hashline
| omp | pie | 差异 |
|-----|-----|------|
| 内建 edit 工具底层是 hashline | `pi.registerTool({ name: "edit", ... })` 覆盖 | ✅ 完全等效 |
| Node.js native fs APIs | polyfill: `Bun.file()` → `readFileSync` | ⚠️ 需要 Node polyfill (127 行) |

### pie-dap
| omp | pie | 差异 |
|-----|-----|------|
| 14 adapters | 14 adapters | ✅ 完全等效 |
| Bun.spawn() | child_process.spawn() | ⚠️ 替换 3 处 |
| Bun.sleep() | setTimeout promise | ⚠️ 替换 1 处 |

### pie-lsp
| omp | pie | 差异 |
|-----|-----|------|
| 11 LSP servers | 11 LSP servers | ✅ 完全等效 |
| 多文件架构 | 单文件精简 (570 + 499 JSON) | ⚠️ 代码量减少 60% |
| 原生语法高亮 + TUI 渲染 | 纯 JSON-RPC | ⚠️ 高亮省略 |

### pie-plan
| omp | pie | 差异 |
|-----|-----|------|
| 全屏 plan-review-overlay | select("Execute/Stay/Refine") | ⚠️ 简化为 select 弹窗 |
| Plan TOC 侧栏 | 无 | ⚠️ 省略 |
| 子 agent 计划传递 | 无 | ⚠️ 省略 |

### pie-review
| omp | pie | 差异 |
|-----|-----|------|
| 多 agent 并行评审 | 单 agent 直接评审 | ⚠️ 轻量版策略 A |
| TUI overlay 展示 findings | 文本输出 | ⚠️ 无 TUI overlay |
| 4 种评审模式 | 4 种（完整） | ✅ 等效 |
| Diff 解析 + 噪声过滤 | 完整移植 | ✅ 等效 |

---

## 🏗️ 架构对比

| 维度 | omp | pie |
|------|-----|-----|
| 运行环境 | Bun (TypeScript + Rust) | Node.js (TypeScript) |
| 工具注册 | 内建工具系统 | pi Extension API |
| Slash 命令 | 内建 register + 文件发现 | pi Extension API |
| TUI | 自有 TUI 引擎（pi-tui） | pi 内置 TUI |
| 模型管理 | ModelRegistry（40+ providers） | pi 内置 Model |
| Session 管理 | SessionManager + 持久化 | pi 内置 Session |
| 子 agent | task orchestrator（完整） | 示例级别 |
| 扩展系统 | Plugin + Skill + Rule | pi Extension + pi Package |
| 内部 schemes | 12 种 URL schemes | 无 |
| Rust native | 4 crates ~55k 行 | 通过 hashline 间接使用 pi-natives |

---

## 📌 方法论说明

迁移优先级评估的三要素：

1. **pi Extension API 兼容度** — 功能是否可被 registerTool / registerCommand / on event / ctx.ui 覆盖
2. **依赖隔离度** — 功能是否依赖 omp 内部引擎（SessionManager / ModelRegistry / 自有 TUI）
3. **用户价值** — 对日常编码工作流的实际提升

Tier 定义：
- **Tier 1**：API 兼容 + 低耦合 → 直接拆出，随装随用
- **Tier 2**：API 兼容 + 中耦合 → 需要适配层，但可行
- **Tier 3**：API 不兼容 或 高耦合 → 等待 pi 能力增强，或放弃
