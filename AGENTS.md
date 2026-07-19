# AGENTS.md

> 本文件面向 AI coding agent，假设读者对本项目一无所知。内容涵盖仓库结构、架构、开发命令、代码约定、测试与发布流程。

## 项目概览

PieX 是 [Pi](https://pi.dev)（pi-coding-agent）的功能扩展集合，以独立 npm 包 `@piex-dev/*` 分发的 monorepo。它从 oh-my-pi (omp)、Claude Code、OpenCode 等 coding agent 中提取核心功能，**100% 基于 pi Extension API 重新实现**，不 fork pi、不修改 pi 内部代码。

核心原则（详见 `docs/design.md`，线上中英 HTML 见 `/zh|en/docs/design/`）：

1. **100% Extension API**：所有功能通过 `pi.registerTool` / `pi.registerCommand` / `pi.on(...)` 等标准扩展接口实现。
2. **随 pi 升级而升级**：每个 package 是独立 npm 包，版本独立管理，与 pi 无耦合。
3. **按需安装**：用户用 `pi install npm:@piex-dev/<name>` 只安装需要的功能。
4. **来源可追溯**：每个 package 的 README 标注功能的原始来源（多为 oh-my-pi 移植，plan 基于 pi 官方示例，theme 来自 opencode-themes）。

## 仓库结构

```
piex/
├── packages/                 # 7 个独立可发布的 package（无 workspace，各自独立）
│   ├── hashline/             # 覆盖内置 edit 工具，替换为 hashline DSL 编辑
│   ├── dap/                  # DAP 调试扩展，注册 debug 工具（14 个 adapter）
│   ├── lsp/                  # LSP 扩展，注册 lsp 工具（11 个 server）
│   ├── plan/                 # /plan、/todos 命令 + 计划模式
│   ├── review/               # /review 命令 + review 工具
│   ├── xai-oauth/            # xAI Grok OAuth 订阅登录 provider（含实时模型发现）
│   └── theme-dark-terminal/  # 静态暗色高对比终端主题（无 TS 代码）
├── eval/                     # Docker 化评测框架（pi bare vs pi+piex vs omp）
├── docs/                     # 中文 md 源稿 + 中英 HTML 静态站（piex.dev）
├── scripts/                  # publish-all.sh + check-docs-i18n.sh（文档双语校验）
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

值得注意的偏差：

- `packages/hashline/`：**唯一有运行时依赖的 package**（`@oh-my-pi/hashline`），含 `node_modules/` + `package-lock.json`，本地使用前需先 `npm install`。辅助模块：`bun-polyfill.ts`、`filesystem.ts`、`patches.ts`（EditGuard 容错）。
- `packages/dap/extensions/`：多模块，含 `client.ts`（JSON-RPC 客户端）、`session.ts`、`config.ts`、`non-interactive-env.ts`、`defaults.json`（adapter 默认配置）等。
- `packages/lsp/extensions/`：`lsp.ts` + `defaults.json`（server 默认配置）。
- `packages/xai-oauth/`：辅助模块 `models.ts`；单元测试在 package 根目录（`xai-oauth.test.ts`、`models.test.ts`，从 `./extensions/` 导入）。
- `packages/theme-dark-terminal/`：无 `extensions/`，主题为 `themes/dark-terminal.json`（`name` + 可选 `vars` + 51 个必需 color token）。

## 架构与数据流

### 扩展加载流程

pi 通过 package.json 中的 `pi` 字段发现扩展，用 jiti JIT 加载 TypeScript，调用默认导出：

```json
{ "pi": { "extensions": ["./extensions/plan.ts"] } }
```

```typescript
// packages/plan/extensions/plan.ts
export default function planExtension(pi: ExtensionAPI) {
  pi.registerCommand("plan", { ... });
  pi.on("tool_call", (ctx) => { ... });
}
```

入口可以是 `async`（需要 IO 初始化时，如 xai-oauth 拉取远程配置）。

常用 API（完整映射见 `docs/design.md`）：`pi.registerTool`（注册或**覆盖**工具）、`pi.registerCommand`、`pi.registerProvider`、`pi.on("tool_call" | "tool_result" | "before_agent_start" | "session_shutdown" | "turn_end", ...)`、`pi.appendEntry`（跨 turn 持久化）、`pi.registerShortcut`、`ctx.ui.setStatus/setWidget/select/editor`。

### 主题包流程

主题包无 TS 入口，通过静态 JSON 分发（`"pi": { "themes": ["./themes"] }`），pi 启动时自动加载 `themes/*.json`，`/settings` 中切换。安装注意：**全局 settings 必须用绝对路径**（`pi install /abs/path/packages/theme-dark-terminal`），否则 `/reload` 后相对路径按 settings 文件位置解析导致主题丢失；项目级用 `pi install -l ./packages/theme-dark-terminal`。

### 评测框架流程

`eval/src/runner.ts`（commander CLI）→ `orchestrator.ts`（任务调度、Docker 运行、judge 集成）→ `agents/pi.ts`（pi-bare / pi-piex）或 `agents/omp.ts` → `sandbox.ts`（Docker 容器生命周期）→ judge（`benchmarks/swebench.ts`、`benchmarks/aider-polyglot.ts`）→ `report.ts` 生成 Markdown 报告到 `eval/results/YYYY-MM-DD/`（已 gitignore）。

对比三个 agent：`pi (bare)`（baseline）、`pi + piex`（加载 hashline/dap/lsp/plan/review 5 个扩展，**不含** xai-oauth）、`omp`。评测集：Aider Polyglot（`eval/fixtures/tasks/polyglot.jsonl`）和 SWE-bench Lite。

## 技术栈与运行时

- **语言**：TypeScript，全仓库 ESM（每个 package.json 均 `"type": "module"`）。
- **packages 运行时**：Node.js ≥ 18；hashline 同时兼容 Bun ≥ 1.3.14。pi 通过 jiti 直接 JIT 加载 `.ts`，无需编译步骤。
- **peer 依赖**：多数包为 `@earendil-works/pi-coding-agent` + `typebox`；plan 额外加 `pi-tui` / `pi-agent-core` / `pi-ai`；xai-oauth 额外加 `pi-ai`。均为 `"*"` 版本。
- **eval 运行时**：Node.js + tsx，需要 Docker。`tsconfig.json` 为 Node16 模块解析、strict、`erasableSyntaxOnly`、`noEmit`、`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`。
- **Docker 镜像**：`node:22-slim`（pi）、`oven/bun:1.3.14-slim`（omp）、`python:3.12-slim-bookworm`（swebench）、`debian:bookworm-slim`（test-runner）。固定 agent 版本：`@earendil-works/pi-coding-agent@0.80.6`（pi）、`@oh-my-pi/pi-coding-agent@16.4.8`（omp）。
- **Lint/格式化**：无配置，跟随各文件现有风格。

## 常用开发命令

### 冒烟测试（需已安装 pi CLI）

```bash
pi -e ./packages/<name>/extensions/<name>.ts -p "what is 1+1" --no-session
```

每个扩展改动后都应跑冒烟测试验证可加载。各包功能性验证命令（hashline 的 read→edit 工作流、dap 的 debug 工具、lsp 诊断等）见 `docs/testing.md`。

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

按 `hashline → dap → lsp → plan → review → theme-dark-terminal → xai-oauth` 顺序发布；中途失败即停止，已发布的包保持已发布（重发前需先 bump 版本号）。

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

## 文档站（docs/ → piex.dev）

`docs/` 是零构建静态站：无 SSG、无 CI 编译，GitHub Pages 原样托管。**线上正文是结构化 HTML**；**Markdown 只写中文**（文档在 `docs/*.md`，博客在 `docs/notes/`），作 Git 底稿与内容唯一来源。只改 md 不改 HTML，线上不会变。

### 源稿与产出（中文 md 唯一源）

| 角色 | 源稿（仅中文） | HTML（中英各一份） | URL |
| --- | --- | --- | --- |
| 文档 | `docs/<slug>.md` | `docs/{zh,en}/docs/<slug>/index.html` | `/{lang}/docs/<slug>/` |
| 博客 | `docs/notes/<slug>.md`（frontmatter: `title`/`date`/`tags`） | `docs/{zh,en}/blogs/<slug>/index.html` | `/{lang}/blogs/<slug>/` |
| 主页 | — | `docs/index.html`（JS 字典 i18n） | `/` |

**硬性规则：**

1. **禁止在语言目录写 md**（不要写 `docs/zh/**.md` 或 `docs/en/**.md`）。源稿只在 `docs/*.md` / `docs/notes/*.md`；英文只存在于 HTML。
2. **改一篇中文 md，必须同时生成/更新中文 HTML + 英文 HTML**（翻译在生成 HTML 时完成）。
3. 中英 HTML 页脚「源稿」链接都指向**同一中文 md**。
4. 内容页顶栏切换跳转对端 URL；主页用字典。旧路径 `/docs|blogs/<slug>/` 按语言偏好重定向（`piex-lang` → `navigator.language` → 默认 en）。

### 新增/修改流程

1. **只写/改中文 md**（论点、数据、章节变更必须先改 md；仅版式调整可只动 HTML/`blog.css`）。
2. **同时**生成/更新中英结构化 HTML：复制同类型壳（`docs-layout` 三栏），复用 `blog.css` 组件，**提炼而非 1:1 dump**；en 页翻译正文、壳层用英文文案；无 JS 也能读完全文。
3. 同步导航：各语言全部同类页左栏 `.docs-nav` + 主页 `#docs`/`#blog` + 本页 TOC + `hreflang`。
4. **提交前校验**（触及文档/博客 md 时必须跑）：
   ```bash
   ./scripts/check-docs-i18n.sh           # 全量
   ./scripts/check-docs-i18n.sh --staged  # commit 前：staged md 必须连带 staged 中英 HTML
   ```
   校验：无 en md、每篇 zh md 有中英 HTML、语言启发式（zh 中文为主 / en 英文为主）、h2 结构大致对齐、源稿链接指向 `docs/zh/`。
5. 本地验收：`cd docs && python3 -m http.server 8080`，检查 `/zh/...` 与 `/en/...`、顶栏切换跳转。
6. commit / push 由用户主动要求；push 到 main 且触及 `docs/**` 后 `pages.yml` 自动部署。

**Agent 义务：** 用户要求 commit 且 staged/变更包含 `docs/*.md`（除 `site.md`）或 `docs/notes/**/*.md` 时，必须先跑 `./scripts/check-docs-i18n.sh --staged`，失败则先补齐中英 HTML 再提交。

### 文案约定（破折号）

- **该用**：表格空值（`| — |`）、标题分隔（`设计理念 — PieX`）、引用原文中的破折号
- **不该用**：中文正文叙述（解释用 `：`，转折用「但/而」，补充用逗号/句号或拆句）。禁止全局替换 `——`/`—`

### Package 博客（每个 package 必有一篇）

每个已实现的 `packages/<name>/` **必须**有对应中文博客源稿，面向读者讲清「为什么 / 怎么做 / 做成了什么 / 下一步」，不是 API 说明书（说明书在 package `README.md`）。

| 项 | 约定 |
| --- | --- |
| 路径 | `docs/notes/<name>.md`，**slug = package 目录名**（如 `packages/dap` → `docs/notes/dap.md`） |
| 线上 URL | `https://piex.dev/zh/blogs/<name>/`（英：`/en/blogs/<name>/`） |
| frontmatter | 必填 `title` / `date` / `tags` |
| README 回链 | 每个 package 的 `README.md` 须有「深度解读」小节，链到上述 URL（可附源稿相对路径） |

**正文结构（四级标题，均为四字，顺序固定）：**

1. **问题背景**：要解决什么痛点、对用户的影响  
2. **技术原理**：核心概念与机制，通俗深入浅出  
3. **实现方案**：本仓库当前实现、关键模块与取舍  
4. **优化计划**：不足与下一步合并写（现状 → 影响 → 怎么补），避免「问题列表 + 路线图」两套重复  

**版式约定：**

- 文首 frontmatter 之后、第一个 `##` 之前：一段 **blockquote 导语**（一句话价值主张，结论先行）  
- 可选 `## 附录：…` 放对比表、调研细节；正文四节保持干净  
- 面向读者，少堆内部黑话；需要时用表格/小例子，不写成长 PRD  
- 新增或实质改动 package 时：同步写/改博客 md；按文档站流程补中英 HTML 与导航（用户明确「只写 md」时可暂缓 HTML，但 README 链接与源稿不得缺）  
- 机制类长文（如 `pi-extension-mechanism`）不占用 package slug，与 package 博客分开



## 代码约定

### 模块与导入风格


- Node 内置模块一律 `node:` 前缀：`import * as path from "node:path";`。
- 类型用 type-only import：`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`。
- 相对导入的扩展名**各包不统一**：hashline 用 `.js`、dap 不带扩展名、xai-oauth 用 `.ts`。jiti 都能加载；修改时**跟随所在文件的现有写法**，不要统一重改。
- 模块级单例常见（如 dap 的 `DapSessionManager`、hashline 的 `InMemorySnapshotStore`/`EditGuard`）。

### 代码风格（packages 与 eval 不同）

- `packages/`：双引号、带分号。
- `eval/`：单引号、不带分号、相对导入一律 `.ts` 扩展名（由 tsconfig 的 `rewriteRelativeImportExtensions` 支持）。

### 命名约定

- 文件：kebab-case（`xai-oauth.ts`、`non-interactive-env.ts`）。
- 类型/接口：PascalCase（`ExtensionAPI`、`TodoItem`）。
- 函数：camelCase；扩展入口函数常命名为 `<name>Extension`。
- 常量：静态列表/正则用 UPPER_SNAKE_CASE（如 plan 的 `PLAN_MODE_TOOLS`）。

### 典型实现模式

- **工具覆盖**：hashline 注册同名工具覆盖内置 `edit`（`pi.registerTool({ name: "edit", ... })`），并 hook `tool_result` 捕获 read 结果、注入 `[PATH#TAG]` 快照头。
- **容错 guard**：hashline `patches.ts` 的 `EditGuard` 会在连续 3 次 byte-identical noop 时抛 `[E_NOOP_LOOP]`、成功编辑后重发相同 payload 时抛 `[E_DUPLICATE_EDIT]`，并对 DSL 方言做归一化（CRLF/代码块包裹/多余空行）。
- **跨运行时 polyfill**：hashline 为 `@oh-my-pi/hashline` 用到的 Bun API 提供 Node polyfill，必须先于依赖导入（`import "./bun-polyfill.js"` 在前，`await import("@oh-my-pi/hashline")` 在后，规避 ES 模块提升）。
- **配置即数据**：dap、lsp 把 adapter/server 默认配置放在 `defaults.json`，与代码分离。
- **错误处理**：防御性 guard + 单例；异步操作用 `AbortSignal` 超时（dap JSON-RPC client）；自定义错误类型（`MismatchError`、`OAuthError`、`LoginCancelledError`）。
- **状态管理**：模块内内存单例（会话级）；plan 模式用 `pi.appendEntry` 跨 turn 持久化（防 compaction 丢失）；`ctx.ui.setStatus/setWidget` 管临时 UI 状态。

## 测试与质量保障

- **无 CI 测试**：唯一工作流是 `.github/workflows/pages.yml`（push 触及 `docs/**` 时部署文档站）。没有自动化测试、lint、发布 CI。文档双语本地校验：`./scripts/check-docs-i18n.sh`（commit 触及 md 时 agent 必须跑 `--staged`）；CI 在 `pages.yml` deploy 前强制跑全量校验。
- **仓库级 QA**：`eval/` Docker 评测框架，指标含 `resolve_rate`、`avg_tokens`、`avg_time`、`est_cost` 及归因指标（`edit_accuracy`、`debug_success`、`plan_follow_rate`）。
- **新 package 要求**：带 `README.md`（安装说明、支持的 action、上游差异表、**深度解读**链到 `https://piex.dev/zh/blogs/<name>/`）；必有 `docs/notes/<name>.md` package 博客（结构见上文「Package 博客」）；发布前完成冒烟测试；主题包须含合法 `themes/*.json`（`name`、可选 `vars`、全部必需 color token）。

## 安全注意事项

- **凭据处理**：xai-oauth 处理 OAuth token，代码有意避免输出可能含 token/PII 的原始响应体；端点校验仅接受 `https://*.x.ai` 主机（`validateXAIEndpoint`）。修改时保持这些防护。
- **破坏性命令防护**：plan 模式下 `edit`/`write` 被禁用（只保留 `read`/`bash`/`grep`/`find`/`ls`），且 `plan.ts` 内置 bash 危险命令拦截。
- **eval 环境变量透传**：`eval/src/orchestrator.ts` 的 `collectApiEnvVars()` 会把宿主机匹配 `API_KEY`/`AUTH_TOKEN`/`ANTHROPIC_*`/`OPENAI_*` 等模式的环境变量传入 Docker 容器。跑不可信任务时注意凭据暴露面。
- **发布不可逆**：`scripts/publish-all.sh` 直接 `npm publish` 到公共 registry（`publishConfig.access: public`），执行前确认版本号已 bump。
- 仓库不存放任何密钥；根 `.gitignore` 仅忽略 `node_modules/`、`*.log`、`.DS_Store`，`eval/.gitignore` 额外忽略 `results/`、`dist/`。

