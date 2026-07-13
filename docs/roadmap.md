# 实施路线

> 全面对比 [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) 与 [piex](https://github.com/piex-dev/piex) 的功能特性，基于 [pi](https://pi.dev) Extension API 基准，识别可拆分迁移的候选功能并制定实施优先级。

## 分类标注说明

每个功能从两个维度标注：

| 维度 | 标签 | 含义 | 互斥 |
|------|------|------|------|
| 一层 | 🆕 **新功能** | pi 不具备此能力，piex 从零引入 | ✅ |
| 一层 | ➕ **功能增量** | pi 已有基础版本，piex 显著增强/替换 | ✅ |
| 一层 | 🔧 **平台适配** | 纯工程桥接，功能语义不变 | ✅ |
| 二层 | 📈 **指标优化** | 核心价值在可量化指标提升（准确率、token、延迟、成功率） | ❌ |
| 二层 | ✨ **体验优化** | 改善交互感受、信息呈现（错误提示、进度反馈、视觉布局） | ❌ |

> 一层标签互斥，每个功能必选其一；二层标签可选，可与一层叠加。

---

## 进度总览

### P0 — 已完成

| # | Package | 一层 | 二层 | 功能 | 来源 | 行数 |
|---|---------|------|------|------|------|------|
| 1 | **hashline** | ➕ 功能增量 | 📈 指标优化（准确率↑ token↓） | hashline 编辑（覆盖 edit 工具） | omp | 318 |
| 2 | **dap** | 🆕 新功能 | — | DAP 调试 — 14 个 debug adapter | omp | 2154 |
| 3 | **lsp** | 🆕 新功能 | — | LSP 语言服务器 — 11 个 server | omp | 1069 |
| 4 | **plan** | 🆕 新功能 | ✨ 体验优化（步骤审批、工具锁定） | Plan Mode（/plan 命令 + 计划工作流） | omp | 348 |
| 5 | **review** | 🆕 新功能 | — | 代码评审（/review + review 工具，轻量版） | omp | 330 |

**已迁移 5 个 package，覆盖约 4219 行核心代码。** review 多 agent 版待定（依赖 subagent 机制）。

### 功能分布统计

| 一层分类 | Tier 1 | Tier 2 | Tier 3 | 已完成 | 合计 |
|----------|--------|--------|--------|--------|------|
| 🆕 新功能 | 10 | 11 | 9 | 3 | **33** |
| ➕ 功能增量 | 7 | 5 | 1 | 1 | **14** |
| 🔧 平台适配 | 0 | 0 | 0 | 1 | **1** |
| **合计** | **17** | **16** | **10** | **5** | **48** |

---

## OMP 功能迁移分析

### Tier 1 — 高可行性（pi Extension API 原生支持，独立程度高）

| # | 候选 Package | 功能 | 一层 | 二层 | 描述 |
|---|-------------|------|------|------|------|
| 6 | **todo** | Todo 工具 + /todo 命令 | 🆕 新功能 | ✨ 体验优化（结构化任务管理） | Agent 可调用的 todo 工具，支持增删改查、阶段管理、标记完成/放弃 |
| 7 | **conflict** | 冲突解决 | 🆕 新功能 | 📈 指标优化（减少冲突处理错误率） | `conflict://N` 内部 scheme，`@ours/@theirs/@base` 标记语法 |
| 8 | **ast-grep** | AST 结构搜索 | 🆕 新功能 | 📈 指标优化（比 regex 更精准） | 50+ tree-sitter 语法的结构代码查询，依赖 ast-grep-core |
| 9 | **ast-edit** | AST 结构编辑 | 🆕 新功能 | 📈 指标优化（精准编辑，减少 token） | ast-grep rewrite → preview → accept 工作流 |
| 10 | **glob** | 文件查找工具 | ➕ 功能增量 | — | 基于 glob 的文件路径搜索，Gitignore 感知（pi 已有 `find`） |
| 11 | **ask** | 结构化提问工具 | 🆕 新功能 | ✨ 体验优化（结构化选择替代手动输入） | Agent 可调用的 option picker，生成交互式选择弹窗 |
| 12 | **eval** | Eval 执行单元 | 🆕 新功能 | 📈 指标优化（持久化环境减少重复初始化） | 持久化 Python / JavaScript 执行环境，共享 prelude |
| 13 | **web-search** | 网页搜索 | 🆕 新功能 | ✨ 体验优化（结构化结果 + 引用） | 多 provider 搜索（25 后端），返回结构化答案 + 引用 |
| 14 | **export** | 会话导出 | ➕ 功能增量 | — | 导出 session 为 HTML 文件（含渲染的 tool cards），pi 已有基础 `/export` |
| 15 | **share** | 加密分享 | ➕ 功能增量 | — | 加密导出 session 到分享服务器，pi 已有 `/share`(Gist) |
| 16 | **dump** | 会话转录 | 🆕 新功能 | — | 导出纯文本会话转录到剪贴板，附带 LLM 请求 JSON |
| 17 | **context** | 上下文用量报告 | ➕ 功能增量 | — | 展示 session 的上下文使用率分布，pi 有 `/session` + `ctx.getContextUsage()` |
| 18 | **tools** | 工具可见性报告 | ➕ 功能增量 | — | 列出当前 agent 可见/可用的所有工具，pi 有 `getActiveTools()` API |
| 19 | **usage** | 用量统计报告 | ➕ 功能增量 | — | 展示各 provider 的 token 消耗、限额、速率重置，pi 有 token 追踪 |
| 20 | **learning** | 规则学习 | 🆕 新功能 | 📈 指标优化（自动规则提取提升准确率） | Agent 从交互中提取模式，生成/更新项目规则 |
| 21 | **resolution** | resolve/apply | 🆕 新功能 | — | 与 ast_edit 配对：proposed → accept/discard |
| 22 | **changelog** | 更新日志查看 | ➕ 功能增量 | — | 查看 omp/piex 的更新日志，pi 已有 `/changelog` |

### Tier 2 — 中等可行性（需要较多适配，或依赖 pi 未完全暴露的能力）

| # | 候选 Package | 功能 | 一层 | 二层 | 描述 |
|---|-------------|------|------|------|------|
| 23 | **browser** | 浏览器控制 | 🆕 新功能 | — | Puppeteer 驱动的 Chromium，含 stealth 反检测 |
| 24 | **gh** | GitHub 集成 | 🆕 新功能 | — | GitHub CLI 封装：repo、PR、issues、code search |
| 25 | **ssh** | SSH 远程执行 | 🆕 新功能 | — | 单次远程命令执行 |
| 26 | **commit** | 原子提交拆分 | 🆕 新功能 | 📈 指标优化（减少提交错误） | 分析 working tree → 拆分无关变更 → 依赖排序 |
| 27 | **checkpoint** | 检查点/回退 | 🆕 新功能 | ✨ 体验优化（探索可回退，降低风险） | checkpoint + rewind（探索性对话回退并保留摘要） |
| 28 | **compact** | 上下文压缩 | ➕ 功能增量 | — | 手动触发会话压缩（summary/chunk/manual），pi 已有 `/compact` |
| 29 | **shake** | 内容精简 | 🆕 新功能 | — | 从上下文删除工具结果、大块内容 |
| 30 | **memory** | Hindsight 记忆 | 🆕 新功能 | 📈 指标优化（跨会话知识保留） | retain/recall/reflect 工具链 + /memory slash，依赖 SQLite/embedding |
| 31 | **image-gen** | 图片生成 | 🆕 新功能 | — | Gemini/GPT/xAI 模型的图片生成 |
| 32 | **inspect-image** | 图片分析 | 🆕 新功能 | — | vision model 分析本地图片 |
| 33 | **tts** | 文字转语音 | 🆕 新功能 | — | xAI Grok Voice TTS |
| 34 | **btw** | 旁路提问 | 🆕 新功能 | — | 用当前上下文问临时问题，不写入 session |
| 35 | **settings** | 设置 UI | ➕ 功能增量 | — | 开放设置选择器，pi 已有 `/settings` |
| 36 | **branch** | 分支选择器 | ➕ 功能增量 | — | 会话树导航、分支创建、fork，pi 已有 `/fork`/`/clone`/`/tree` |
| 37 | **model** | 模型切换 | ➕ 功能增量 | — | 运行时切换模型、快速模式切换，pi 已有 `/model`/`/scoped-models` |
| 38 | **ext-dashboard** | 扩展控制中心 | 🆕 新功能 | — | 扩展/agent 控制面板 UI，pi 有 `pi install/list/remove` 但无控制面板 |

### Tier 3 — 高复杂度（深度耦合 omp 内部引擎，难独立提取）

| # | 候选 Package | 功能 | 一层 | 原因 |
|---|-------------|------|------|------|
| 39 | **subagent** | 子 agent 并行任务 | ➕ 功能增量 | 依赖 omp 的 task orchestrator、worktree isolation、output-manager。pi 有基础 `createAgentSession()` API 但不完整 |
| 40 | **advisor** | Advisor 双模型审核 | 🆕 新功能 | 依赖 omp 的 parallel model session、turn injection。pi Extension API 无多模型能力 |
| 41 | **collab** | 实时协同会话 | 🆕 新功能 | 依赖 omp 的 relay 协议、WebSocket、participant 同步 |
| 42 | **marketplace** | 插件市场 | 🆕 新功能 | 依赖 omp 的 marketplace manager、catalog 系统 |
| 43 | **goal** | Goal 模式 | 🆕 新功能 | 持久化自主目标管理、token 预算 |
| 44 | **vibe** | Vibe 模式 | 🆕 新功能 | 直接持续 fast/good worker 会话 |
| 45 | **loop** | Loop 循环模式 | 🆕 新功能 | 每次 yield 自动重新提交 prompt |
| 46 | **internal-schemes** | 内部 URL 方案 | 🆕 新功能 | pr://, issue://, skill://, rule://, agent:// 等。需要 deep tool integration |
| 47 | **config-inheritance** | 配置文件自动继承 | 🆕 新功能 | 从 .cursor/.claude/.gemini 等自动读取配置 |
| 48 | **force** | 强制 tool choice | 🆕 新功能 | `/force:<tool-name>` 限定下个 turn 的工具 |

---

## 迁移优先级建议

### P0 — 立刻可做（高价值 + 低复杂度）

| 优先级 | Package | 一层 | 二层 | 理由 |
|--------|---------|------|------|------|
| **P0-1** | todo | 🆕 新功能 | ✨ 体验优化 | Agent 任务管理是最常用的交互需求，纯 tool 注册，一天可完成 |
| **P0-2** | conflict | 🆕 新功能 | 📈 指标优化 | 冲突解决是 git 工作流高频痛点，方案简洁（scheme 注册） |
| **P0-3** | ask | 🆕 新功能 | ✨ 体验优化 | 结构化提问比手动问用户强太多，pi 已有 `ctx.ui.select/confirm` |

### P1 — 近期规划（独立工具，有外部依赖但可控）

| 优先级 | Package | 一层 | 二层 | 理由 |
|--------|---------|------|------|------|
| **P1-1** | ast-grep | 🆕 新功能 | 📈 指标优化 | AST 搜索比 regex 精准，需 ast-grep CLI 或 native binding |
| **P1-2** | ast-edit | 🆕 新功能 | 📈 指标优化 | AST 编辑 + resolve 模式，与 ast-grep 配套 |
| **P1-3** | web-search | 🆕 新功能 | ✨ 体验优化 | 多后端搜索，可选轻量版（只用 1-2 个免费后端） |
| **P1-4** | gh | 🆕 新功能 | — | GitHub 集成，需 gh CLI 或 Octokit SDK |
| **P1-5** | eval | 🆕 新功能 | 📈 指标优化 | Python/JS 持久执行环境，需确保安全 |
| **P1-6** | memory | 🆕 新功能 | 📈 指标优化 | Hindsight 记忆系统，依赖 SQLite/embedding |

### P2 — 中长期规划（需要 pi 能力增强或依赖较重）

| 优先级 | Package | 一层 | 二层 | 理由 |
|--------|---------|------|------|------|
| **P2-1** | browser | 🆕 新功能 | — | Puppeteer + stealth 反检测，依赖重但独立 |
| **P2-2** | commit | 🆕 新功能 | 📈 指标优化 | 原子提交分析，算法独立但需要深度的 diff 理解 |
| **P2-3** | checkpoint | 🆕 新功能 | ✨ 体验优化 | Checkpoint/rewind，需 session 状态管理 |
| **P2-4** | ssh | 🆕 新功能 | — | SSH 远程执行，需 SSH client 能力 |
| **P2-5** | subagent | ➕ 功能增量 | — | 子 agent 机制 — 等待 pi Extension API 完善 |

### 未排优先级（Tier 1/2 中 pi 已有基础版本，边际价值待评估）

| Package | 一层 | pi 已有能力 | 额外价值 |
|---------|------|------------|----------|
| glob | ➕ 功能增量 | `find` 工具 | gitignore 感知 |
| export | ➕ 功能增量 | `/export` (HTML/JSONL) | tool card 渲染、agent-callable |
| share | ➕ 功能增量 | `/share` (Gist) | 加密分享服务器 |
| dump | 🆕 新功能 | — | 纯文本转录到剪贴板 |
| context | ➕ 功能增量 | `/session` | 详细分布展示 |
| tools | ➕ 功能增量 | `getActiveTools()` API | slash 命令暴露 |
| usage | ➕ 功能增量 | token 追踪 | 按 provider 分项报告 |
| learning | 🆕 新功能 | — | 自动规则学习 |
| resolution | 🆕 新功能 | — | 与 ast-edit 配对 |
| changelog | ➕ 功能增量 | `/changelog` | 差异待评估 |
| compact | ➕ 功能增量 | `/compact` | 不同压缩策略 |
| shake | 🆕 新功能 | — | 内容精简 |
| btw | 🆕 新功能 | — | 旁路提问 |
| settings | ➕ 功能增量 | `/settings` | 差异化 UI |
| branch | ➕ 功能增量 | `/fork`/`/clone`/`/tree` | 增强导航 |
| model | ➕ 功能增量 | `/model`/`/scoped-models` | 增强 UX |
| ext-dashboard | 🆕 新功能 | — | 扩展控制面板 |

---

## 已完成功能 vs 原版差异

### hashline

| omp | piex | 差异 |
|-----|-----|------|
| 内建 edit 工具底层是 hashline | `pi.registerTool({ name: "edit", ... })` 覆盖 | ✅ 完全等效 |
| Node.js native fs APIs | polyfill: `Bun.file()` → `readFileSync` | ⚠️ 需要 Node polyfill (127 行) |

### dap

| omp | piex | 差异 |
|-----|-----|------|
| 14 adapters | 14 adapters | ✅ 完全等效 |
| Bun.spawn() | child_process.spawn() | ⚠️ 替换 3 处 |
| Bun.sleep() | setTimeout promise | ⚠️ 替换 1 处 |

### lsp

| omp | piex | 差异 |
|-----|-----|------|
| 11 LSP servers | 11 LSP servers | ✅ 完全等效 |
| 多文件架构 | 单文件精简 (570 + 499 JSON) | ⚠️ 代码量减少 60% |
| 原生语法高亮 + TUI 渲染 | 纯 JSON-RPC | ⚠️ 高亮省略 |

### plan

| omp | piex | 差异 |
|-----|-----|------|
| 全屏 plan-review-overlay | select("Execute/Stay/Refine") | ⚠️ 简化为 select 弹窗 |
| Plan TOC 侧栏 | 无 | ⚠️ 省略 |
| 子 agent 计划传递 | 无 | ⚠️ 省略 |

### review

| omp | piex | 差异 |
|-----|-----|------|
| 多 agent 并行评审 | 单 agent 直接评审 | ⚠️ 轻量版策略 A |
| TUI overlay 展示 findings | 文本输出 | ⚠️ 无 TUI overlay |
| 4 种评审模式 | 4 种（完整） | ✅ 等效 |
| Diff 解析 + 噪声过滤 | 完整移植 | ✅ 等效 |

---

## 架构对比

| 维度 | omp | pi | piex |
|------|-----|-----|------|
| 运行环境 | Bun (TypeScript + Rust) | Node.js (TypeScript) | Node.js (TypeScript) |
| 工具注册 | 内建工具系统 | 内建工具系统 + Extension API | 纯 pi Extension API |
| Slash 命令 | 内建注册 + 文件发现 | 内建 22 命令 + Extension API | 纯 pi Extension API |
| TUI | 自有 TUI 引擎（pi-tui） | 自有 TUI 引擎 | 继承 pi TUI |
| 模型管理 | ModelRegistry（40+ providers） | 40+ 内置 providers | 继承 pi 模型层 |
| Session 管理 | SessionManager + 持久化 | JSONL 持久化 + 会话树 | 继承 pi session |
| 子 agent | task orchestrator（完整） | 基础 API | 待建设 |
| 扩展系统 | Plugin + Skill + Rule | Extension + Package + Skill | 纯 Extension Package |
| 内部 schemes | 12 种 URL schemes | 无 | 无 |
| Rust native | 4 crates ~55k 行 | 通过 hashline 间接使用 | 通过 pi 间接使用 |

---

## 方法论说明

迁移优先级评估的三要素：

1. **pi Extension API 兼容度** — 功能是否可被 registerTool / registerCommand / on event / ctx.ui 覆盖
2. **依赖隔离度** — 功能是否依赖 omp 内部引擎（SessionManager / ModelRegistry / 自有 TUI）
3. **用户价值** — 对日常编码工作流的实际提升

Tier 定义：

- **Tier 1**：API 兼容 + 低耦合 → 直接拆出，随装随用
- **Tier 2**：API 兼容 + 中耦合 → 需要适配层，但可行
- **Tier 3**：API 不兼容 或 高耦合 → 等待 pi 能力增强，或放弃

### pi 对 omp 的替代关系

迁移时判断 pi 是否已有等价能力的标准：

| pi 能力 | 判定等价的条件 |
|---------|----------------|
| 同名工具/命令 | 需对比能力差异，仅同名不等于等价 |
| 同名但不同实现 | 归为"功能增量"，标注 pi 基线能力 |
| Extension API 暴露但未被工具化 | 归为"功能增量"（pi 有数据但无用户入口） |
| pi 完全缺失 | 归为"新功能" |

---

## 后续规划

### 待迁移功能 (来自 oh-my-pi)

- Plan review overlay (TUI 全屏计划审批)
- Plan TOC sidebar (目录导航)
- Multi-agent review (子 agent 并行评审)

### 待探索功能 (来自其他 agent)

- Claude Code 的交互模式参考
- OpenCode 的扩展机制参考
- 其他优秀 agent 的功能特性

---

各 package 详细文档见对应目录下的 `README.md`。
