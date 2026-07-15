# 网站部署（piex.dev）

静态站点文件位于本目录：`index.html`、`assets/`、项目文档 `*.md`、博客 `blogs/*.md`。

## GitHub Pages

1. 仓库 **Settings → Pages**
2. **Build and deployment → Source**：选择 **GitHub Actions**（推荐，见 `.github/workflows/pages.yml`）
   - 或选择 **Deploy from a branch**，Branch `main`，Folder **`/docs`**
3. **Custom domain** 填 `piex.dev`，保存
4. 仓库已包含 `docs/CNAME`，内容与自定义域名一致

## DNS

在域名服务商添加以下记录（以 GitHub 当前文档为准）：

| 类型 | 名称 | 值 |
|------|------|-----|
| `A` | `@` | `185.199.108.153` |
| `A` | `@` | `185.199.109.153` |
| `A` | `@` | `185.199.110.153` |
| `A` | `@` | `185.199.111.153` |
| `CNAME` | `www` | `piex.dev` |

### 说明

- apex 用四条 A 记录指向 GitHub Pages IP
- **`www` CNAME 指向 `piex.dev`（apex），而非 `piex-dev.github.io`**
  原因：GitHub Pages 自定义 apex 域时，`www` 作为 apex 的别名才能通过域名验证。
  若指向 `*.github.io` 会被判为 `InvalidDNSError`（`www.piex.dev is improperly configured`）。

## 启用 HTTPS

DNS 修改后，GitHub 会自动签发 Let's Encrypt 证书并允许勾选 **Enforce HTTPS**。

若提示 **"Unavailable — domain is not properly configured to support HTTPS"**：

1. 确认 DNS 已改对（`www` CNAME → `piex.dev`，而非 `piex-dev.github.io`）
2. **Settings → Pages → Custom domain**：删掉 `piex.dev`，Save
3. 重新填入 `piex.dev`，Save
4. 等待 1–5 分钟，刷新页面，**Enforce HTTPS** 会变为可勾选

> 本质是 GitHub 需要重新验证域名并申请证书。删掉重加是最快的触发方式。

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
