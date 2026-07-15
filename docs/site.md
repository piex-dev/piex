# 网站部署（piex.dev）

静态站点文件位于本目录：`index.html`、`assets/`、项目文档 `*.md`、博客 `blogs/*.md`。

## GitHub Pages

1. 仓库 **Settings → Pages**
2. **Build and deployment → Source**：选择 **GitHub Actions**（推荐，见 `.github/workflows/pages.yml`）
   - 或选择 **Deploy from a branch**，Branch `main`，Folder **`/docs`**
3. **Custom domain** 填 `piex.dev`，保存后启用 **Enforce HTTPS**
4. 仓库已包含 `docs/CNAME`，内容与自定义域名一致

## DNS（piex.dev）

在域名服务商添加记录（以 GitHub 当前文档为准）：

| 类型 | 名称 | 值 |
|------|------|-----|
| `A` | `@` | `185.199.108.153`、`185.199.109.153`、`185.199.110.153`、`185.199.111.153` |
| `CNAME` | `www` | `piex-dev.github.io`（若使用 www 子域） |

apex 使用四条 A 记录指向 GitHub Pages；也可按 GitHub 控制台提示配置。

## 本地预览

```bash
cd docs && python3 -m http.server 8080
# 打开 http://127.0.0.1:8080/
```

## 说明

- `.nojekyll`：禁用 Jekyll，避免 `_` 开头路径被忽略
- 文档阅读：`doc.html?doc=design.md`
- 博客阅读：`doc.html?doc=blogs/<slug>.md`（源文件在 `docs/blogs/`，与 Pages 同源）
- 首页文档/博客入口走 `doc.html`，不再直链裸 `.md`
