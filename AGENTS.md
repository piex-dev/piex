# AGENTS.md

PieX — Pi 扩展集合 monorepo。按 pi package 类型分目录：`extensions/<name>/`（TS 扩展）、`prompts/<name>/`（prompt 包）、`themes/<name>/`（theme 包），均发布为 `@piex-dev/<name>`。100% 基于 pi Extension API。根目录无 `package.json`、无 workspace。

## 关键结构事实

- **入口**：TS 扩展包 `extensions/<name>/src/<name>.ts` → `export default function(pi: ExtensionAPI)`。pi 通过 `package.json` 的 `"pi": { "extensions": ["./src/<name>.ts"] }` 发现，jiti JIT 加载 `.ts`，无需编译。包内代码统一在 `src/`，单测在 `test/`。
- **三类 pi 包**：`extensions/<name>/`（TS 扩展，走 `pi.extensions`）、`prompts/<name>/`（prompt 包，走 `pi.prompts`）、`themes/<name>/`（theme 包，走 `pi.themes`）。
- **有运行时依赖的包**（本地开发需 `npm install`）：
  - `extensions/hashline/` — `@oh-my-pi/hashline`，含 `node_modules/`
  - `extensions/ai-code-report/` — `@dp/tea-sdk-node` + `@logsdk/node-plugin-http` + `diff`，需内部 registry；**`private: true`，不发布**
  - `extensions/lsp/` — mock LSP server 依赖（单测用），见 `docs/testing.md`
- **prompt 包** `prompts/init/` 无 TypeScript，`"pi": { "prompts": ["./prompts"] }` → `.md` 变成斜杠命令
- **`extensions/plan/` 特殊依赖**：额外 peer dep `@earendil-works/pi-tui`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`（TUI 集成），不同于其他扩展仅需 `pi-coding-agent`
- **主题包** `themes/theme-dark-terminal/` 无 TypeScript，`"pi": { "themes": ["./themes"] }` → 安装必须用绝对路径，否则 `/reload` 后丢失
- **package 自有配置/数据文件**：统一放 `~/.pi/piex-dev/<package>/`。代码里用 `join(dirname(getAgentDir()), "piex-dev", "<package>")` 构造。

## 开发命令

```bash
# 冒烟测试（扩展改动后必跑）
pi -e ./extensions/<name>/src/<name>.ts -p "what is 1+1" --no-session

# 单元测试
bun test extensions/xai-oauth/test/xai-oauth.test.ts extensions/xai-oauth/test/models.test.ts
cd extensions/lsp && npm install && bun test   # mock LSP server，需先 npm install

# 格式化
npx prettier --write .

# 本地安装（按类型目录：extensions/ prompts/ themes/）
cd extensions/hashline && npm install && cd ../..   # hashline 运行时依赖；ai-code-report 需内部 registry
pi install extensions/<name>                        # 全局（TS 扩展）
pi install prompts/init                             # 全局（prompt 包）
pi install themes/theme-dark-terminal               # 全局（theme 包，须绝对路径）
pi install -l extensions/<name>                     # 项目级

# 发布（发布前 bump 版本号；脚本遍历 extensions/ prompts/ themes/，自动跳过 private 包）
./scripts/publish-all.sh
# ai-code-report 为 private，发布脚本自动跳过

# 评测（需 Docker）
cd eval && npm install && npm run build
npm run run -- run -b aider-polyglot -a pi-bare,pi-piex

# 类型检查
cd eval && npm run check   # 需要 tsgo
```

**没有 CI 测试**。唯一工作流是 `pages.yml`（部署文档站）。没有自动化测试/lint/发布 CI，agent 不要假设 CI 会拦截问题。改动后自己跑冒烟测试。

## 代码约定

- TypeScript ESM（`"type": "module"`），Node ≥ 18；peerDependencies 版本均为 `"*"`
- **全局 Prettier**：双引号、带分号（`singleQuote: false, semi: true`），无 `.prettierignore`
- **相对导入扩展名各包不同**：hashline 用 `.js`，dap 不带扩展名，xai-oauth 用 `.ts`。jiti 都能加载，**修改时跟随所在文件现有写法，不要统一**
- Node 内置模块带 `node:` 前缀，类型用 `import type`
- 模块级单例常见，错误用自定义类型（`MismatchError`、`OAuthError` 等）

## 关键实现模式

- **工具覆盖**：hashline 注册同名 `edit` 工具覆盖内置，hook `tool_result` 注入 `[PATH#TAG]` 快照头
- **hashline polyfill 顺序**：`import "./bun-polyfill.js"` 必须在 `await import("@oh-my-pi/hashline")` 之前
- **hashline EditGuard**：连续 3 次 byte-identical noop 抛 `[E_NOOP_LOOP]`，成功编辑后重发相同 payload 抛 `[E_DUPLICATE_EDIT]`
- **plan 模式**：`edit`/`write` 被禁用，仅 `read`/`bash`/`grep`/`find`/`ls`，内置危险命令拦截
- **配置即数据**：dap、lsp 默认配置在 `defaults.json`

## 文档站（docs/ → piex.dev）

### 硬规则

1. 源稿只在 `docs/*.md` 和 `docs/notes/*.md`（中文），**禁止在 `docs/zh/` / `docs/en/` 下写 md**
2. 改中文 md 必须同步生成/更新中英 HTML。英文只存在于 HTML
3. **commit 前门禁**：staged 含 `docs/*.md` 或 `docs/notes/**/*.md` 时必须先跑：

   ```bash
   ./scripts/check-docs-i18n.sh --staged
   ```

   失败则补齐中英 HTML 再提交

4. 触达 HTML/JS/shell 的提交前跑自检：

   ```bash
   bash -n docs/install.sh && bash -n scripts/publish-all.sh
   grep -cF '</main>' docs/index.html      # 必须 =1
   grep -cF '</footer>' docs/index.html    # 必须 =1
   grep -cF '</html>' docs/index.html      # 必须 =1
   grep -c '<section id="blog"' docs/index.html      # 必须 =1
   grep -c '<section id="packages"' docs/index.html   # 必须 =1
   grep -c '<section id="docs"' docs/index.html       # 必须 =1
   grep -c '<section id="why"' docs/index.html        # 必须 =1
   python3 scripts/check_docs_i18n.py
   ```

**Agent 义务**：用户要求 commit、且变更/暂存触及 `docs/*.md`（除 `site.md`）或 `docs/notes/**/*.md` 时，必须先跑 `./scripts/check-docs-i18n.sh --staged`，失败则补齐中英 HTML 再提交。

### 文案约定

- em-dash（`—`）仅用于：表格空值（`| — |`）、标题分隔（`设计理念 — PieX`）、引用原文
- 中文正文**禁止**用破折号：解释用 `：`，转折用「但/而」，补充用逗号/句号。禁止全局替换 `——`/`—`

### Package 博客

每个 `extensions/<name>/`、`prompts/<name>/`、`themes/<name>/` 必须有对应博客源稿 `docs/notes/<name>.md`（slug = 目录名），frontmatter 必填 `title` / `date` / `tags`，各 package `README.md` 须有「深度解读」回链。正文结构：

1. **问题背景** — 要解决的痛点
2. **技术原理** — 核心机制
3. **实现方案** — 本仓库实现与取舍
4. **设计参考**（可选）— 借鉴项目及采纳/不采纳原因
5. **优化计划** — 不足与下一步（合并写，不要拆成问题+路线图）

文首 frontmatter 后用 blockquote 导语（一句话价值主张）。新增/实质改动 package 时同步写/改博客 md，并按文档站流程补中英 HTML。

### 新 package 要求

- `README.md`：安装说明、支持的 action、上游差异表、「深度解读」回链到 `https://piex.dev/zh/blogs/<name>/`
- `docs/notes/<name>.md`：package 博客
- 发布前完成冒烟测试
- 主题包须含合法 `themes/*.json`（`name` + 全部必需 color token）
- 同步：`scripts/publish-all.sh` PACKAGES、根 `README.md` 表格、`docs/install.sh` PACKAGES、首页 `index.html` 卡片。详见 `docs/site.md`

### 同步检查清单

新增/修改 package 或网站功能时，以下项目必须全部同步，缺一不可：

| 变更类型                       | 必须同步检查                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 新增 package                   | `scripts/publish-all.sh` PACKAGES 数组、根 `README.md` 表格、首页 `index.html` 卡片、`docs/install.sh` PACKAGES 数组 |
| 新增博客                       | `docs/blogs/<slug>/` 重定向桩、首页 `index.html` blog-list、全部博客 HTML 侧栏 `.docs-nav`（中英各一份）             |
| 新增 URL 路径（如 `/zh/xxx/`） | 对应目录 `index.html`（防 Directory listing）、上级目录 `index.html`（如有）                                         |
| 修改首页布局                   | `docs/assets/main.js` en + zh 字典键必须对称，不要只加 en 不加 zh                                                    |
| 修改包列表                     | 根 `README.md`、首页卡片、`docs/install.sh` PACKAGES、`scripts/publish-all.sh` PACKAGES                              |
| 修改博客日期                   | 首页 `index.html` 博客卡片日期、博客源稿 `date:` frontmatter、中英 HTML blog-date                                    |
| 修改博客侧栏顺序               | 首页博客卡片顺序也必须同步调整，保持一致                                                                             |

详细流程见 `docs/site.md`。

## 安全注意

- xai-oauth：端点校验仅接受 `https://*.x.ai`，避免输出含 token/PII 的响应体
- **plan 模式危险命令拦截**：plan 模式下 `edit`/`write` 被禁用，仅保留 `read`/`bash`/`grep`/`find`/`ls`，且 `plan.ts` 内置 bash 危险命令拦截
- eval 评测会把宿主机 `API_KEY`/`AUTH_TOKEN`/`ANTHROPIC_*`/`OPENAI_*` 等环境变量传入 Docker——跑不可信任务注意凭据面
- 发布不可逆：`./scripts/publish-all.sh` 直接 `npm publish`，执行前确认版本号已 bump
- 不存放密钥；`.gitignore` 忽略 `node_modules/`、`*.log`、`.DS_Store`、`extensions/**/package-lock.json`
