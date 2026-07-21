# 网站部署（piex.dev）

静态站点文件位于本目录（GitHub Pages 根）：

| 路径                            | 作用                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `index.html`                    | 主页（JS 字典 i18n，URL 无语言前缀）                                                             |
| `assets/`                       | 共用 CSS/JS（`style.css` / `main.js` / `blog.css` / `blog.js`）                                  |
| `<slug>.md`                     | **文档唯一源稿（中文）**                                                                         |
| `notes/<slug>.md`               | **博客唯一源稿（中文，frontmatter: title/date/tags）**                                           |
| `zh/docs/<slug>/index.html`     | 中文文档 HTML → `/zh/docs/<slug>/`                                                               |
| `en/docs/<slug>/index.html`     | 英文文档 HTML → `/en/docs/<slug>/`（由中文 md 翻译生成，**无** en md）                           |
| `zh/blogs/<slug>/index.html`    | 中文博客 HTML → `/zh/blogs/<slug>/`                                                              |
| `en/blogs/<slug>/index.html`    | 英文博客 HTML → `/en/blogs/<slug>/`（由中文 md 翻译生成）                                        |
| `zh/packages/<slug>/index.html` | 中文 package 介绍页 → `/zh/packages/<slug>/`                                                     |
| `en/packages/<slug>/index.html` | 英文 package 介绍页 → `/en/packages/<slug>/`（由中文 md 翻译生成）                               |
| `packages/<slug>.md`            | **package 介绍页唯一源稿（中文，frontmatter: title/date/tags/package/npm/type/install/source）** |
| `migration/`                    | 内部迁移笔记（不挂主页）                                                                         |
| `site.md`                       | 本文件（运维约定，非站点正文）                                                                   |
| `CNAME` / `.nojekyll`           | Pages 域名与 Jekyll 关闭                                                                         |

## 核心原则：中文 md 唯一源

```
写/改 中文 md  ──►  同时生成/更新 中文 HTML + 英文 HTML  ──►  校验一致  ──►  commit
```

| 规则                    | 说明                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| **只写中文 md**         | 文档：`docs/<slug>.md`；博客：`docs/notes/<slug>.md`；package 介绍页：`docs/packages/<slug>.md` |
| **HTML 才分语言**       | 中英 HTML 分别在 `docs/zh/...` 与 `docs/en/...`                                                 |
| **禁止语言目录里的 md** | 不要写 `docs/zh/**.md` 或 `docs/en/**.md`                                                       |
| **一次生成双语 HTML**   | 改一篇中文 md，必须同步产出 zh + en 两套结构化 HTML                                             |
| **源稿链接统一**        | 中英 HTML 页脚「源稿」都指向同一中文 md                                                         |
| **提交前校验**          | 见 `scripts/check-docs-i18n.sh`                                                                 |

## URL 约定（多语言）

语言码是路径第一段，**预留扩展**（今天 `en` / `zh`，以后加 `ja` 等同理）：

| 类型           | URL                        | 源稿                              | 线上页                                   |
| -------------- | -------------------------- | --------------------------------- | ---------------------------------------- |
| 主页           | `/`                        | —                                 | `index.html`（字典切换，不拆页）         |
| 文档           | `/{lang}/docs/<slug>/`     | `docs/<slug>.md`（唯一）          | `docs/{lang}/docs/<slug>/index.html`     |
| 博客           | `/{lang}/blogs/<slug>/`    | `docs/notes/<slug>.md`（唯一）    | `docs/{lang}/blogs/<slug>/index.html`    |
| Package 介绍页 | `/{lang}/packages/<slug>/` | `docs/packages/<slug>.md`（唯一） | `docs/{lang}/packages/<slug>/index.html` |

| 语言    | 路径前缀 | 说明                                         |
| ------- | -------- | -------------------------------------------- |
| English | `/en/`   | 默认对外语言；`hreflang="x-default"` 指向 en |
| 中文    | `/zh/`   | 完整中文正文                                 |

文档、博客与 package 介绍页均为**结构化 HTML**。Markdown 只作 Git 底稿与中文内容来源；线上只使用上表路径。

### 语言切换行为

- 主页：顶栏 EN / 中文 → `localStorage.piex-lang` + 字典替换；内容链接被改写为 `/{lang}/docs|blogs|packages/...`
- 文档 / 博客页：顶栏切换 → **跳转到对端语言同 slug URL**（`/zh/docs/design/` ↔ `/en/docs/design/`），并写入 `piex-lang`
- 每页 `<link rel="alternate" hreflang="en|zh|x-default">` 互指

实现：`assets/main.js`（`pathForLang` / `localizeContentHrefs` / `piexSwitchLang`）。

## 内容生产：中文 MD → 中英 HTML

实践对齐 Claude 的观点：[The unreasonable effectiveness of HTML](https://claude.com/blog/using-claude-code-the-unreasonable-effectiveness-of-html)：**md 适合写，HTML 适合读**。

```
写/改 docs/<slug>.md  或  docs/notes/<slug>.md
        │
        ├─► docs/zh/docs|blogs/<slug>/index.html   （中文结构化页）
        └─► docs/en/docs|blogs/<slug>/index.html   （英文结构化页，同结构翻译）
        │
        ├─► 同步同语言侧栏 + 主页入口 + hreflang
        └─► scripts/check-docs-i18n.sh 通过
```

| 步骤              | 文档                                                | 博客                              |
| ----------------- | --------------------------------------------------- | --------------------------------- |
| 1. 源稿（仅中文） | `docs/<slug>.md`                                    | `docs/notes/<slug>.md`            |
| 2a. 中文 HTML     | `docs/zh/docs/<slug>/index.html`                    | `docs/zh/blogs/<slug>/index.html` |
| 2b. 英文 HTML     | `docs/en/docs/<slug>/index.html`                    | `docs/en/blogs/<slug>/index.html` |
| 3. 导航           | 各语言全部同类页 `.docs-nav` + 主页 `#docs`/`#blog` | 同左                              |
| 4. 校验           | `./scripts/check-docs-i18n.sh`                      | 同左                              |
| 5. 预览           | `cd docs && python3 -m http.server 8080`            | 同左                              |
| 6. 发布           | push `main` 且触及 `docs/**` → `pages.yml`          | 同左                              |

### 生成原则

1. **提炼而非 dump**：结论前置；对比用卡片/表；流程用 timeline/arch-stack
2. **复用组件**：`blog.css` 的 callout / cards / table / code / split / timeline 等
3. **三栏壳**：左站内导航 · 中正文 · 右本页 TOC（`docs-layout`）
4. **无 JS 可读完全文**；脚本只增强体验
5. **中英成对**：同一 slug 的 zh/en HTML 章节结构对齐；壳层文案随语言写死
6. **源稿只中文**：en HTML 页脚源稿链接仍指向 `docs/<slug>.md` 或 `docs/notes/<slug>.md`
7. **代码/路径/包名** 保持英文原样，不翻译

### 可用组件（`assets/blog.css`）

| Class                                      | 用途                                   |
| ------------------------------------------ | -------------------------------------- |
| `.blog-callout.insight\|note\|warn`        | 结论 / 提示 / 警告                     |
| `.blog-cards` / `.blog-card-item`          | 多方案并排对比                         |
| `.blog-table-wrap`                         | 横向滚动表（表头强调）                 |
| `.blog-code` + `.blog-code-bar`            | 可复制代码块                           |
| `.blog-split`                              | 左右对照                               |
| `.arch-stack`                              | 分层架构                               |
| `.blog-timeline` / `.phase-list`           | 生命周期 / 路线阶段                    |
| `.fail-map`                                | 失效范围等条形可视化                   |
| `.feature-grid`                            | 要点网格                               |
| `.docs-layout` + `.docs-nav` + `.page-toc` | 三栏：左站内导航 · 中正文 · 右本页目录 |

### 页面壳检查清单（每篇 HTML，中英各一份）

- [ ] `canonical` / `og:url` = `https://piex.dev/{lang}/docs|blogs/<slug>/`
- [ ] `hreflang` alternate 指向 en + zh（+ `x-default` → en）
- [ ] 资源路径 `../../../assets/style.css`、`blog.css`、`blog.js`、`main.js`（改样式则 bump `?v=`）
- [ ] 左栏 `.docs-nav`：列出**同语言全部**同类文章，当前页 `is-active`；链接带 `/{lang}/` 前缀
- [ ] 右栏 `.page-toc`：本篇 `h2/h3` 锚点；`id` 稳定
- [ ] 窄屏：`.docs-mobile-nav` + `.blog-toc-mobile`
- [ ] 页脚 prev/next；**源稿 GitHub 链接指向中文 md**（`docs/...` 或 `docs/notes/...`）
- [ ] 顶栏含 `.lang-switch`（EN / 中文）；**静态 HTML 即标记当前语言 active**（zh 页中文 active，en 页 EN active）
- [ ] 正文语言与 `{lang}` 一致

### Agent 生成提示（可直接当任务描述）

```
根据中文源稿 docs/<slug>.md（文档）或 docs/notes/<slug>.md（博客）
同时生成/更新中英两套结构化 HTML：
- 中文输出：docs/zh/docs|blogs/<slug>/index.html
- 英文输出：docs/en/docs|blogs/<slug>/index.html（翻译正文，壳层用英文文案）
- 复制同类型最近一篇页面作壳（docs-layout 三栏）；en 壳用英文导航标签
- 内容：提炼信息结构，用 blog.css 组件，不要 md 直出
- 中英章节结构对齐（h2/h3 对应）；代码块/路径/包名不翻译
- 源稿链接：中英页脚都指向同一中文 md
- 同步：各语言全部同类页左侧导航 + 主页卡片 + hreflang
- 校验：./scripts/check-docs-i18n.sh
- 验收：cd docs && python3 -m http.server 8080
```

### 反模式

- 在 `docs/zh/` 或 `docs/en/` 下写 md 源稿
- 只生成中文 HTML、漏英文（或反过来）
- 只改 md 不改 HTML
- 只改一种语言的 HTML
- 正文依赖 JS 字典切换（破坏「无 JS 可读」）
- 内容链接不带 `/{lang}/` 前缀
- CI/SSG 流水线把 md 编成站（本站刻意零构建）

## 提交前校验

```bash
./scripts/check-docs-i18n.sh           # 全量：配对 + 语言一致性
./scripts/check-docs-i18n.sh --staged  # 仅检查本次 staged 变更（commit 前用）
```

校验项：

1. 每个中文 md（`docs/*.md` 除 `site.md`，及 `docs/notes/*.md`）都有对应 zh + en HTML
2. 不存在 `docs/zh/**/*.md`、`docs/en/**/*.md` 源稿
3. 改过的 md（staged）对应中英 HTML 已 staged；HTML 未 staged 但 mtime 新于 md 的，视为已核对同步（warning 不阻断）
4. zh HTML 正文以中文为主、en HTML 正文以英文为主（启发式）
5. 中英 HTML 的 h2 数量接近（结构对齐启发式）
6. 页脚源稿链接指向 `docs/` 或 `docs/notes/`（非 `docs/zh/`）

Agent 在用户要求 commit、且本次变更触及文档/博客 md 时，**必须先跑** `--staged` 并通过后再提交。

CI：`.github/workflows/pages.yml` 在 deploy 前跑 `python3 scripts/check_docs_i18n.py`；PR 也会跑校验（不部署）。

## GitHub Pages

1. 仓库 **Settings → Pages**
2. **Build and deployment → Source**：GitHub Actions（`.github/workflows/pages.yml`）或 branch `main` / folder `/docs`
3. Custom domain：`piex.dev`（见 `CNAME`）

## DNS

| 类型    | 名称  | 值                                                 |
| ------- | ----- | -------------------------------------------------- |
| `A`     | `@`   | `185.199.108.153` / `.109.` / `.110.` / `.111.153` |
| `CNAME` | `www` | `piex.dev`                                         |

## 本地预览

```bash
cd docs && python3 -m http.server 8080
# http://127.0.0.1:8080/
# http://127.0.0.1:8080/en/docs/design/
# http://127.0.0.1:8080/zh/docs/design/
# http://127.0.0.1:8080/docs/design/   → 按语言偏好重定向到 /en|zh/docs/design/
```

## 新增 / 修改文档（速查）

1. 只写/改 `docs/<slug>.md`
2. 生成 `docs/zh/docs/<slug>/index.html` **与** `docs/en/docs/<slug>/index.html`
3. 同步各语言文档侧栏 + 主页 `#docs`（如有新文）
4. `./scripts/check-docs-i18n.sh` 通过
5. 本地 server 验收 → commit / push

## 新增 / 修改 Blog（速查）

1. 只写/改 `docs/notes/<slug>.md`
2. 生成双语 HTML 到 `docs/{zh,en}/blogs/<slug>/index.html`
3. 同步各语言博客侧栏 + 主页 `#blog`

## 新增 / 修改 package 介绍页（速查）

每个 `extensions/<name>/`、`prompts/<name>/`、`themes/<name>/` 对应一个 package 介绍页（`ai-code-report` 为 private 不发布，不纳入）。

1. 只写/改 `docs/packages/<slug>.md`（frontmatter 必填 `package/npm/type/install/source`；正文结构：简介 / 技术原理 / 使用说明 / 实现方案 / 设计参考 / 迭代记录[路线图+版本记录]）
2. **版本记录与 `package.json` 版本号一致**
3. 生成双语 HTML 到 `docs/{zh,en}/packages/<slug>/index.html`（侧栏列全部 package，源稿链接指 `docs/packages/<slug>.md`）
4. 首页 `#packages` 卡片链接指向 `/en/packages/<slug>/`；各 package 目录 `README.md`「深度解读」链接指向 `/zh/packages/<slug>/`
5. 若从 blog 迁移：删除 `docs/notes/<slug>.md` 与 `docs/{zh,en}/blogs/<slug>/index.html`
6. `./scripts/check-docs-i18n.sh` → 本地验收 → commit / push
