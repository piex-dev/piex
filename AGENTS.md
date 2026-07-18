# AGENTS.md

> 本文件面向 AI coding agent，假设读者对本项目一无所知。内容涵盖仓库结构、架构、开发命令、代码约定、测试与发布流程。

## 项目概览

Piex 是 [Pi](https://pi.dev)（pi-coding-agent）的功能扩展集合，以独立 npm 包 `@piex-dev/*` 分发的 monorepo。它从 oh-my-pi (omp)、Claude Code、OpenCode 等优秀 coding agent 中提取核心功能，**100% 基于 pi Extension API 重新实现**——不 fork pi、不修改 pi 内部代码。

核心原则（详见 `docs/design.md`）：

1. **100% Extension API**：所有功能通过 `pi.registerTool` / `pi.registerCommand` / `pi.on(...)` 等标准扩展接口实现。
2. **随 pi 升级而升级**：每个 package 是独立 npm 包，版本独立管理，与 pi 无耦合。
3. **按需安装**：用户用 `pi install npm:@piex-dev/<name>` 只安装需要的功能。
4. **来源可追溯**：每个 package 的 README 标注了功能的原始来源（多为 oh-my-pi 移植，plan 基于 pi 官方示例，theme 来自 opencode-themes）。

## 仓库结构

```
piex/
├── packages/                 # 7 个独立可发布的 package（无 workspace 配置，各自独立）
│   ├── hashline/             # 覆盖内置 edit 工具，替换为 hashline DSL 编辑
│   ├── dap/                  # DAP 调试扩展，注册 debug 工具（14 个 adapter）
│   ├── lsp/                  # LSP 扩展，注册 lsp 工具（11 个 server）
│   ├── plan/                 # /plan、/todos 命令 + 计划模式
│   ├── review/               # /review 命令 + review 工具
│   ├── xai-oauth/            # xAI Grok OAuth 订阅登录 provider（含实时模型发现）
│   └── theme-dark-terminal/  # 静态暗色高对比终端主题（无 TS 代码）
├── eval/                     # Docker 化评测框架（pi bare vs pi+piex vs omp）
├── docs/                     # 中文文档 + 手工搭建的静态站点（GitHub Pages，piex.dev）
├── scripts/publish-all.sh    # 顺序发布全部 @piex-dev/* 包
└── .github/workflows/        # 唯一的 CI：pages.yml（部署 docs/ 到 GitHub Pages）
```

根目录**没有** `package.json`、没有 npm workspace、没有统一构建。每个 package 独立。

### 各 package 内部结构

扩展包统一遵循：

```
<name>/
├── package.json          # npm manifest + pi 发现清单（"pi": { "extensions": [...] }）
├── README.md             # package 文档（功能、action、安装、上游差异表）
└── extensions/
    ├── <name>.ts         # pi 扩展入口，export default function(pi)
    └── ...辅助模块.ts
```

关键文件分布：

- `packages/hashline/extensions/`：`hashline.ts`（入口）、`bun-polyfill.ts`、`filesystem.ts`、`patches.ts`（EditGuard 容错）。**唯一有运行时依赖的 package**（`@oh-my-pi/hashline`），含 `node_modules/` 和 `package-lock.json`，本地使用前需先 `npm install`。
- `packages/dap/extensions/`：`dap.ts`（入口）、`client.ts`（JSON-RPC 客户端）、`session.ts`、`config.ts`、`types.ts`、`utils.ts`、`non-interactive-env.ts`（强制非交互 pager/editor 的环境变量集）、`defaults.json`（adapter 默认配置）。
- `packages/lsp/extensions/`：`lsp.ts`、`defaults.json`（server 默认配置）。
- `packages/xai-oauth/extensions/`：`xai-oauth.ts`（入口）、`models.ts`（模型目录/发现）。单元测试在 package 根目录：`xai-oauth.test.ts`、`models.test.ts`（从 `./extensions/` 导入）。
- `packages/theme-dark-terminal/themes/`：`dark-terminal.json`（`name` + 可选 `vars` + 51 个必需 color token）。

## 架构与数据流

### 扩展加载流程

pi 通过 package.json 中的 `pi` 字段发现扩展，用 jiti JIT 加载 TypeScript，调用默认导出：

```json
{
  "pi": { "extensions": ["./extensions/plan.ts"] }
}
```

```typescript
// packages/plan/extensions/plan.ts
export default function planExtension(pi: ExtensionAPI) {
  pi.registerCommand("plan", { ... });
  pi.on("tool_call", (ctx) => { ... });
}
```

入口可以是 `async`（需要 IO 初始化时，如 xai-oauth 拉取远程配置）。

常用 API（`docs/design.md` 有完整映射表）：`pi.registerTool`（注册或**覆盖**工具）、`pi.registerCommand`、`pi.registerProvider`、`pi.on("tool_call" | "tool_result" | "before_agent_start" | "session_shutdown" | "turn_end", ...)`、`pi.appendEntry`（跨 turn 持久化）、`pi.registerShortcut`、`ctx.ui.setStatus/setWidget/select/editor`。

### 主题包流程

主题包无 TS 入口，通过静态 JSON 分发：

```json
{
  "pi": { "themes": ["./themes"] }
}
```

pi 启动时自动加载 `themes/*.json`，`/settings` 中切换。安装时注意：**全局 settings 必须用绝对路径**（`pi install /abs/path/packages/theme-dark-terminal`），否则 `/reload` 后相对路径按 settings 文件位置解析导致主题丢失；项目级用 `pi install -l ./packages/theme-dark-terminal`。

### 评测框架流程

`eval/src/runner.ts`（commander CLI）→ `orchestrator.ts`（任务调度、Docker 运行、judge 集成）→ `agents/pi.ts`（pi-bare / pi-piex 两种配置）或 `agents/omp.ts` → `sandbox.ts`（Docker 容器生命周期）→ benchmark 对应的 judge（`benchmarks/swebench.ts`、`benchmarks/aider-polyglot.ts`）→ `report.ts` 生成 Markdown 报告到 `eval/results/YYYY-MM-DD/`（已 gitignore）。

对比三个 agent：`pi (bare)`（baseline）、`pi + piex`（加载 hashline/dap/lsp/plan/review 5 个扩展，**不含** xai-oauth）、`omp`。评测集：Aider Polyglot（`eval/fixtures/tasks/polyglot.jsonl`）和 SWE-bench Lite。

## 技术栈与运行时

- **语言**：TypeScript，全仓库 ESM（每个 package.json 均 `"type": "module"`）。
- **packages 运行时**：Node.js ≥ 18；hashline 同时兼容 Bun ≥ 1.3.14。由 pi 通过 jiti 直接 JIT 加载 `.ts`，无需编译步骤。
- **peer 依赖**：多数包依赖 `@earendil-works/pi-coding-agent` + `typebox`；plan 额外依赖 `pi-tui` / `pi-agent-core` / `pi-ai`；xai-oauth 额外依赖 `pi-ai`；theme 仅依赖 `pi-coding-agent`。均为 `"*"` 版本。
- **eval 运行时**：Node.js + tsx，需要 Docker。`tsconfig.json` 为 Node16 模块解析、strict、`erasableSyntaxOnly`、`noEmit`、`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`。
- **Docker 镜像**：`node:22-slim`（pi）、`oven/bun:1.3.14-slim`（omp）、`python:3.12-slim-bookworm`（swebench）、`debian:bookworm-slim`（test-runner）。固定的 agent 版本：`@earendil-works/pi-coding-agent@0.80.6`（pi）、`@oh-my-pi/pi-coding-agent@16.4.8`（omp）。
- **Lint/格式化**：无配置，跟随各文件现有风格。

## 常用开发命令

### 冒烟测试（需已安装 pi CLI）

```bash
pi -e ./packages/<name>/extensions/<name>.ts -p "what is 1+1" --no-session
```

各包示例及功能性验证命令（hashline 的 read→edit 工作流、dap 的 debug 工具、lsp 诊断等）见 `docs/testing.md`。

### 单元测试（仅 xai-oauth 有）

```bash
bun test packages/xai-oauth/xai-oauth.test.ts packages/xai-oauth/models.test.ts
```

覆盖 OAuth helper、模型目录回退、发现合并、env 过滤，不依赖网络。

### 本地安装

```bash
cd packages/hashline && npm install && cd ../..   # 仅 hashline 需要（有运行时依赖）
pi install packages/hashline                      # 全局 settings
pi install -l packages/hashline                   # 项目 .pi/settings.json
pi list                                           # 查看已安装
pi remove -l ./packages/hashline                  # 移除
```

### 发布

```bash
npm login                  # 需 @piex-dev org 发布权限
./scripts/publish-all.sh
```

按 `hashline → dap → lsp → plan → review → theme-dark-terminal → xai-oauth` 顺序发布；中途失败即停止，已发布的包保持已发布（重发前需先 bump 版本号）。当前所有包版本均为 `0.1.1`。

### 评测框架

```bash
cd eval && npm install
npm run build             # 构建 pi + omp 镜像（也可单独 build:pi / build:omp / build:swebench）
npm run run -- run -b aider-polyglot                      # 跑全部三个 agent
npm run run -- run -b aider-polyglot -a pi-bare,pi-piex   # 指定 agent
npm run run -- run -b aider-polyglot -s fixtures/tasks/custom.jsonl  # 指定任务文件
npm run check             # tsgo --noEmit 类型检查（需 tsgo 可用）
```

任务 JSONL 格式：`{"id", "prompt", "files": {...}, "test_cmd", "language"}`。报告输出到 `eval/results/YYYY-MM-DD/report.md`。

### 文档站预览

```bash
cd docs && python3 -m http.server 8080   # http://127.0.0.1:8080/
```

`docs/` 是手工搭建的静态站（**零构建**，GitHub Pages 直推 `docs/`）。  
线上正文是**结构化 HTML**；Markdown 只作源稿与 Git diff 底稿。部署见 `docs/site.md`。

| 角色 | 源稿（仓库） | HTML（线上真相） | URL |
|------|--------------|------------------|-----|
| 文档 | `docs/<slug>.md` | `docs/docs/<slug>/index.html` | `/docs/<slug>/` |
| 博客 | `docs/notes/<slug>.md` | `docs/blogs/<slug>/index.html` | `/blogs/<slug>/` |
| 主页 | — | `docs/index.html` | `/` |

- 共用资源：`assets/style.css`、`main.js`、`blog.css`、`blog.js`
- 对外 URL：`/docs/<slug>/`、`/blogs/<slug>/`
- **没有** SSG / CI 编译步骤：HTML 在仓库里生成并提交，Pages 原样托管

### 文档站 · MD → HTML 原则（Claude 实践）

参考：[The unreasonable effectiveness of HTML](https://claude.com/blog/using-claude-code-the-unreasonable-effectiveness-of-html)

核心判断：**Markdown 适合写与 diff；HTML 适合读。**  
不要把 md 当皮肤贴进页面。正确流程是：

1. **人（或 Agent）先把内容写进 md 源稿**（结构完整、可 review）
2. **再由 Agent 根据源稿生成/更新结构化 HTML**（阅读体验页）
3. **HTML 提交进 git，成为线上唯一展示形态**

#### 生成时必须遵守

| 规则 | 说明 |
|------|------|
| **提炼，不是 1:1 dump** | 30 秒结论放前面；长表/对比改成卡片或可视化；次要细节可折叠或后置 |
| **用组件，不写裸标签堆** | 复用 `blog.css` 已有 class（见下表）；缺组件先扩 CSS 再写文 |
| **壳与导航一致** | 复制最近一篇同类型页作壳；左栏文档/博客导航、右栏本页 TOC、header/footer/GA |
| **无 JS 也能读完正文** | 脚本只做增强（TOC 高亮、代码复制、移动折叠） |
| **源稿与 HTML 双写同步** | 改论点先改 md，再改 HTML；只改版式可只动 HTML |
| **静态 HTML 即正文** | 正文在 HTML 中写死；脚本只做 TOC/复制等增强 |

#### 可用组件（`assets/blog.css`）

| Class | 用途 |
|-------|------|
| `.blog-callout.insight\|note\|warn` | 结论 / 提示 / 警告 |
| `.blog-cards` / `.blog-card-item` | 多方案并排对比 |
| `.blog-table-wrap` | 横向滚动表（表头强调） |
| `.blog-code` + `.blog-code-bar` | 可复制代码块 |
| `.blog-split` | 左右对照 |
| `.arch-stack` | 分层架构 |
| `.blog-timeline` / `.phase-list` | 生命周期 / 路线阶段 |
| `.fail-map` | 失效范围等条形可视化 |
| `.feature-grid` | 要点网格 |
| `.docs-layout` + `.docs-nav` + `.page-toc` | 三栏：左站内导航 · 中正文 · 右本页目录 |

#### 页面壳检查清单（每篇 HTML）

- [ ] `canonical` / `og:url` = `https://piex.dev/docs/<slug>/` 或 `/blogs/<slug>/`
- [ ] 资源路径 `../../assets/style.css`、`blog.css`、`blog.js`、`main.js`（改样式则 bump `?v=`）
- [ ] 左栏 `.docs-nav`：列出**全部**同类文章，当前页 `is-active`（加新文要改**所有**同类页）
- [ ] 右栏 `.page-toc`：本篇 `h2/h3` 锚点；`id` 稳定
- [ ] 窄屏：`.docs-mobile-nav`（站内导航）+ `.blog-toc-mobile`（本页目录）
- [ ] 页脚 prev/next 或回列表；源稿 GitHub 链接指向对应 md
- [ ] **无**顶部「返回」链（左栏已承担导航）

#### Agent 生成提示（可直接当任务描述）

```
根据源稿 <path/to/slug.md> 生成/更新结构化 HTML 阅读页：
- 输出路径：docs/docs/<slug>/index.html 或 docs/blogs/<slug>/index.html
- 复制同类型最近一篇页面作壳（docs-layout 三栏）
- 内容：提炼信息结构，用 blog.css 组件，不要 md 直出
- 同步：所有同类页左侧导航 + 主页卡片/列表 + 本页 TOC
- 验收：cd docs && python3 -m http.server 8080 ，检查桌面三栏与窄屏折叠
- 输出静态 HTML 正文，脚本仅增强体验
```

### 文档站 · 新增 / 修改文档

1. 写/改源稿 `docs/<slug>.md`
2. **按上一节原则生成/更新** `docs/docs/<slug>/index.html`
3. 更新**所有**文档页左侧 `.docs-nav`（含新条目）
4. `docs/index.html` `#docs`（及 footer 如需）增加 `/docs/<slug>/`
5. 本地验收：
   ```bash
   cd docs && python3 -m http.server 8080
   # http://127.0.0.1:8080/docs/<slug>/
   ```
6. commit / push 由你主动要求；push 后 `pages.yml` 部署

### 文档站 · 新增 / 修改 Blog

1. 写/改源稿 `docs/notes/<slug>.md`  
   frontmatter 必填：`title`、`date`（`YYYY-MM-DD`）、`tags`
2. **按 MD→HTML 原则生成/更新** `docs/blogs/<slug>/index.html`  
   （复制 `blogs/hashline/index.html` 作壳；博客比文档更强调信息图与结论前置）
3. 更新**所有**博客页左侧导航
4. `docs/index.html` `#blog` 卡片：`date` / `tag` / `title` / `excerpt` / `href="/blogs/<slug>/"`
5. 可选：`assets/main.js` 增加中英 i18n key
6. 本地验收 `/blogs/<slug>/` → commit / push（主动要求后）

### 文档站 · 修改已有文

| 变更类型 | 操作 |
|----------|------|
| 论点 / 数据 / 章节 | 先改 md 源稿，再让 Agent 按原则同步 HTML |
| 仅版式 / 组件 | 只改 HTML 或 `blog.css` / `blog.js` |
| 标题 / 日期 / slug | md + HTML 页头 + 主页卡片 + **全部**侧栏文案 |

### 文档站 · 明确不做

- 不引入 Hugo/Vite/SSG；不在 CI 里 md→html
- 不为「省事」做 1:1 md dump（违背 Claude HTML 实践）

## 代码约定

### 模块与导入风格

- Node 内置模块一律 `node:` 前缀：`import * as path from "node:path";`。
- 类型用 type-only import：`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`。
- 相对导入的扩展名**各包不统一**：hashline 用 `.js`（`./bun-polyfill.js`）、dap 不带扩展名（`./session`）、xai-oauth 用 `.ts`（`./models.ts`）。pi 用 jiti 加载，三种写法都能工作——修改时**跟随所在文件的现有写法**，不要统一重改。
- 模块级单例常见（如 dap 的 `DapSessionManager`、hashline 的 `InMemorySnapshotStore`/`EditGuard`）。

### 代码风格（packages 与 eval 不同）

- `packages/`：双引号、带分号。
- `eval/`：单引号、不带分号、相对导入一律 `.ts` 扩展名（由 tsconfig 的 `rewriteRelativeImportExtensions` 支持）。

### 命名约定

- 文件：kebab-case（`xai-oauth.ts`、`dark-terminal.json`、`non-interactive-env.ts`）。
- 类型/接口：PascalCase（`ExtensionAPI`、`TodoItem`）。
- 函数：camelCase；扩展入口函数常命名为 `<name>Extension`。
- 常量：静态列表/正则用 UPPER_SNAKE_CASE（如 plan 的 `PLAN_MODE_TOOLS`）。

### 典型实现模式

- **工具覆盖**：hashline 通过注册同名工具覆盖内置 `edit`（`pi.registerTool({ name: "edit", ... })`），并 hook `tool_result` 捕获 read 结果、注入 `[PATH#TAG]` 快照头。
- **容错 guard**：hashline 的 `patches.ts` 中 `EditGuard` 实现 Phase 1 容错——连续 3 次 byte-identical noop 抛 `[E_NOOP_LOOP]`、成功编辑后重发相同 payload 抛 `[E_DUPLICATE_EDIT]`、DSL 方言归一化（CRLF/代码块包裹/多余空行）。
- **跨运行时 polyfill**：hashline 为 `@oh-my-pi/hashline` 用到的 Bun API 提供 Node polyfill，必须先于依赖导入（`import "./bun-polyfill.js"` 在前，`await import("@oh-my-pi/hashline")` 在后，规避 ES 模块提升）。
- **配置即数据**：dap、lsp 把 adapter/server 默认配置放在 `defaults.json`，与代码分离。
- **错误处理**：防御性 guard + 单例；异步操作用 `AbortSignal` 超时（dap JSON-RPC client）；自定义错误类型（`MismatchError`、`OAuthError`、`LoginCancelledError`）。
- **状态管理**：模块内内存单例（会话级）；plan 模式用 `pi.appendEntry` 跨 turn 持久化（防 compaction 丢失）；`ctx.ui.setStatus/setWidget` 管临时 UI 状态。

## 测试与质量保障

- **无 CI 测试**：唯一的工作流是 `.github/workflows/pages.yml`（push 到 main/master 且触及 `docs/**` 时部署文档站到 GitHub Pages）。没有自动化测试、lint、发布 CI。
- **单元测试**：仅 `packages/xai-oauth`（见上文命令）。
- **冒烟测试**：每个扩展改动后用 `pi -e ... -p "what is 1+1" --no-session` 验证可加载；功能性验证命令见 `docs/testing.md`。
- **仓库级 QA**：`eval/` Docker 评测框架，指标含 `resolve_rate`、`avg_tokens`、`avg_time`、`est_cost` 及归因指标（`edit_accuracy`、`debug_success`、`plan_follow_rate`）。
- **新 package 要求**：带 `README.md`（安装说明、支持的 action、上游差异表）；发布前完成冒烟测试；主题包须含合法 `themes/*.json`（`name`、可选 `vars`、全部必需 color token）。

## 安全注意事项

- **凭据处理**：xai-oauth 处理 OAuth token，代码有意避免输出可能含 token/PII 的原始响应体；端点校验仅接受 `https://*.x.ai` 主机（`validateXAIEndpoint`）。修改时保持这些防护。
- **破坏性命令防护**：plan 模式下 `edit`/`write` 被禁用（只保留 `read`/`bash`/`grep`/`find`/`ls`），且 `plan.ts` 内置 bash 危险命令拦截。
- **eval 环境变量透传**：`eval/src/orchestrator.ts` 的 `collectApiEnvVars()` 会把宿主机上匹配 `API_KEY`/`AUTH_TOKEN`/`ANTHROPIC_*`/`OPENAI_*` 等模式的环境变量传入 Docker 容器——跑不可信任务时注意凭据暴露面。
- **发布权限**：`scripts/publish-all.sh` 直接 `npm publish` 到公共 registry（`publishConfig.access: public`），不可逆，执行前确认版本号已 bump。
- 仓库不存放任何密钥；根 `.gitignore` 仅忽略 `node_modules/`、`*.log`、`.DS_Store`，`eval/.gitignore` 额外忽略 `results/`、`dist/`。

## 重要文件索引

| 文件 | 作用 |
|------|------|
| `README.md` | 项目概览、安装方式、package 总览、文档索引 |
| `docs/site.md` | 文档站部署、URL 约定、Blog 流程摘要 |
| `docs/blogs/<slug>/index.html` | 博客 HTML（`/blogs/<slug>/`） |
| `docs/notes/<slug>.md` | 博客 Markdown 源稿 |
| `docs/assets/blog.css` / `blog.js` | 文档与博客共用组件样式 / TOC / 复制 |
| `docs/docs/<slug>/index.html` | 文档 HTML（`/docs/<slug>/`） |
| `docs/<slug>.md` | 文档 Markdown 源稿 |
| `packages/hashline/extensions/hashline.ts` | 被覆盖的 `edit` 工具与 read hook |
| `packages/dap/extensions/dap.ts` | `debug` 工具入口与会话管理 |
| `packages/lsp/extensions/lsp.ts` | `lsp` 工具入口与 server 管理 |
| `packages/plan/extensions/plan.ts` | `/plan`、`/todos`、工具门控、bash 防护 |
| `packages/review/extensions/review.ts` | `/review` 命令与 `review` 工具 |
| `packages/xai-oauth/extensions/xai-oauth.ts` | OAuth provider 注册与 device flow |
| `packages/theme-dark-terminal/themes/dark-terminal.json` | 静态主题 token |
| `eval/src/runner.ts` | 评测 CLI 入口 |
| `eval/src/orchestrator.ts` | 任务调度、Docker 运行、judge 集成 |
| `eval/src/sandbox.ts` | Docker 容器生命周期 |
| `eval/src/agents/pi.ts` / `agents/omp.ts` | 三种 agent 配置 |
| `eval/src/benchmarks/swebench.ts` / `benchmarks/aider-polyglot.ts` | 评测集加载与判定 |
| `scripts/publish-all.sh` | 全部 `@piex-dev/*` 包的顺序发布脚本 |
| `.github/workflows/pages.yml` | docs/ → GitHub Pages 部署 |
