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

### 生成原则（摘要）

1. **提炼而非 dump**：结论前置；对比用卡片/表；流程用 timeline/arch-stack  
2. **复用组件**：`blog.css` 的 callout / cards / table / code / split / timeline 等  
3. **三栏壳**：左站内导航 · 中正文 · 右本页 TOC（`docs-layout`）  
4. **无 JS 可读完全文**；脚本只增强体验  
5. **md 与 HTML 同步**：论点改 md 再改 HTML  

完整检查清单与 Agent 提示词见仓库根目录 `AGENTS.md`「文档站 · MD → HTML 原则」。

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
