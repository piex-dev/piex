# 网站部署（piex.dev）

静态站点文件位于本目录（GitHub Pages 根）：

| 路径 | 作用 |
|------|------|
| `index.html` | 主页 |
| `assets/` | 共用 CSS/JS（`style.css` / `main.js` / `blog.css` / `blog.js`） |
| `<slug>.md` | **文档源稿**（design / architecture / roadmap / …） |
| `docs/<slug>/index.html` | **文档 HTML** → `https://piex.dev/docs/<slug>/` |
| `notes/<slug>.md` | **博客源稿** |
| `blogs/<slug>/index.html` | **博客 HTML** → `https://piex.dev/blogs/<slug>/` |
| `migration/` | 内部迁移笔记（不挂主页） |
| `CNAME` / `.nojekyll` | Pages 域名与 Jekyll 关闭 |

## URL 约定

| 类型 | URL | 源稿 | 线上页 |
|------|-----|------|--------|
| 主页 | `/` | — | `index.html` |
| 文档 | `/docs/<slug>/` | `docs/<slug>.md` | `docs/docs/<slug>/index.html` |
| 博客 | `/blogs/<slug>/` | `docs/notes/<slug>.md` | `docs/blogs/<slug>/index.html` |

文档与博客均为**结构化 HTML**。Markdown 只作 Git 底稿与内容来源；线上只使用上表路径。

## 内容生产：MD → 结构化 HTML

实践对齐 Claude 的观点：[The unreasonable effectiveness of HTML](https://claude.com/blog/using-claude-code-the-unreasonable-effectiveness-of-html) —— **md 适合写，HTML 适合读**。

```
写/改源稿 md  →  Agent 生成结构化 HTML  →  更新侧栏与主页入口  →  本地预览  →  commit/push  →  Pages
```

| 步骤 | 文档 | 博客 |
|------|------|------|
| 1. 源稿 | `docs/<slug>.md` | `docs/notes/<slug>.md`（含 title/date/tags） |
| 2. 生成 HTML | `docs/docs/<slug>/index.html` | `docs/blogs/<slug>/index.html` |
| 3. 导航 | 全部文档页 `.docs-nav` + 主页 `#docs` | 全部博客页侧栏 + 主页 `#blog` |
| 4. 预览 | `cd docs && python3 -m http.server 8080` | 同左 |
| 5. 发布 | push `main` 且触及 `docs/**` → `pages.yml` | 同左 |

### 生成原则

1. **提炼而非 dump**：结论前置；对比用卡片/表；流程用 timeline/arch-stack  
2. **复用组件**：`blog.css` 的 callout / cards / table / code / split / timeline 等  
3. **三栏壳**：左站内导航 · 中正文 · 右本页 TOC（`docs-layout`）  
4. **无 JS 可读完全文**；脚本只增强体验  
5. **md 与 HTML 同步**：论点改 md 再改 HTML  

### 可用组件（`assets/blog.css`）

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

### 页面壳检查清单（每篇 HTML）

- [ ] `canonical` / `og:url` = `https://piex.dev/docs/<slug>/` 或 `/blogs/<slug>/`
- [ ] 资源路径 `../../assets/style.css`、`blog.css`、`blog.js`、`main.js`（改样式则 bump `?v=`）
- [ ] 左栏 `.docs-nav`：列出**全部**同类文章，当前页 `is-active`（加新文要改**所有**同类页）
- [ ] 右栏 `.page-toc`：本篇 `h2/h3` 锚点；`id` 稳定
- [ ] 窄屏：`.docs-mobile-nav`（站内导航）+ `.blog-toc-mobile`（本页目录）
- [ ] 页脚 prev/next 或回列表；源稿 GitHub 链接指向对应 md
- [ ] **无**顶部「返回」链（左栏已承担导航）

### Agent 生成提示（可直接当任务描述）

```
根据源稿 <path/to/slug.md> 生成/更新结构化 HTML 阅读页：
- 输出路径：docs/docs/<slug>/index.html 或 docs/blogs/<slug>/index.html
- 复制同类型最近一篇页面作壳（docs-layout 三栏）
- 内容：提炼信息结构，用 blog.css 组件，不要 md 直出
- 同步：所有同类页左侧导航 + 主页卡片/列表 + 本页 TOC
- 验收：cd docs && python3 -m http.server 8080 ，检查桌面三栏与窄屏折叠
- 输出静态 HTML 正文，脚本仅增强体验
```

### 反模式

- CI/SSG 流水线把 md 编成站（本站刻意零构建）  
- 1:1 把 md 转成无结构的长 HTML  
- 只改 md 不改 HTML（线上不会变）  
- 只改新页侧栏、不更新其它页的导航列表  

## GitHub Pages

1. 仓库 **Settings → Pages**
2. **Build and deployment → Source**：GitHub Actions（`.github/workflows/pages.yml`）或 branch `main` / folder `/docs`
3. Custom domain：`piex.dev`（见 `CNAME`）

## DNS

| 类型 | 名称 | 值 |
|------|------|-----|
| `A` | `@` | `185.199.108.153` / `.109.` / `.110.` / `.111.153` |
| `CNAME` | `www` | `piex.dev` |

## 本地预览

```bash
cd docs && python3 -m http.server 8080
# http://127.0.0.1:8080/
# http://127.0.0.1:8080/docs/roadmap/
# http://127.0.0.1:8080/blogs/hashline/
```

## 新增 / 修改文档（速查）

1. 写/改 `docs/<slug>.md`
2. Agent 按 MD→HTML 原则生成 `docs/docs/<slug>/index.html`
3. 同步所有文档页左侧导航 + 主页 `#docs`
4. 本地 server 验收
5. commit / push → Pages

## 新增 / 修改 Blog（速查）

1. 写/改 `docs/notes/<slug>.md`
2. Agent 生成 `docs/blogs/<slug>/index.html`
3. 同步所有博客侧栏 + 主页 `#blog` 卡片
4. 本地验收 → commit / push → Pages
