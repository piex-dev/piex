# 架构概览

## 项目结构

```
piex/                                  # monorepo
├── README.md                         # 项目入口
├── docs/                             # 📚 文档 + 静态站（piex.dev，Pages 根）
│   ├── index.html                    #   主页（JS 字典 i18n）
│   ├── <slug>.md                     #   文档源稿（仅中文）
│   ├── notes/<slug>.md               #   博客源稿（仅中文）
│   ├── {lang}/docs/<slug>/index.html #   中/英文档 HTML → /{lang}/docs/<slug>/
│   ├── {lang}/blogs/<slug>/index.html#   中/英博客 HTML → /{lang}/blogs/<slug>/
│   ├── assets/                       #   style / main / blog 静态资源
│   └── migration/                    #   迁移方案记录
└── packages/                         # 📦 7 个独立 piex package
    ├── hashline/
    │   ├── README.md
    │   ├── package.json
    │   └── extensions/
    │       ├── hashline.ts
    │       └── bun-polyfill.ts
    ├── dap/
    │   ├── README.md
    │   ├── package.json
    │   └── extensions/
    │       ├── dap.ts, client.ts, session.ts
    │       ├── config.ts, types.ts, utils.ts
    │       ├── defaults.json, non-interactive-env.ts
    ├── lsp/
    │   ├── README.md
    │   ├── package.json
    │   └── extensions/
    │       ├── lsp.ts, defaults.json
    ├── plan/
    │   ├── README.md
    │   ├── package.json
    │   └── extensions/
    │       └── plan.ts
    ├── review/
    │   ├── README.md
    │   ├── package.json
    │   └── extensions/
    │       └── review.ts
    ├── xai-oauth/
    │   ├── README.md
    │   ├── package.json
    │   └── extensions/
    │       ├── xai-oauth.ts
    │       └── models.ts
    └── theme-dark-terminal/
        ├── README.md
        ├── package.json
        └── themes/
            └── dark-terminal.json
```

## Package 总览

| Package | 代码量 | 工具 | 外部依赖 | 功能来源 |
|---------|--------|------|---------|---------|
| hashline | 191 行 + polyfill 127 行 | 覆盖 `edit` | `@oh-my-pi/hashline` | oh-my-pi |
| dap | 1942 行 + 212 行 JSON | `debug` | 无 | oh-my-pi |
| lsp | 570 行 + 499 行 JSON | `lsp` | 无 | oh-my-pi |
| plan | 348 行 | `/plan`, `/todos` | 无 | pi 示例 |
| review | 330 行 | `/review`, `review` | 无 | oh-my-pi |
| xai-oauth | 530 行 + 419 行 models | `/login` xAI Grok OAuth 订阅登录（含实时模型发现） | 无 | oh-my-pi / pi-grok |
| theme-dark-terminal | — | 暗终端高对比度主题 | 无 | [opencode-themes](https://github.com/debugtalk/opencode-themes) |

## 工具注册总览

| 工具名 | 来源 | 类型 | 说明 |
|--------|------|------|------|
| `read` | pi 内置 | 读 | 读取文件 |
| `bash` | pi 内置 | 读写 | 执行命令 |
| `write` | pi 内置 | 写 | 写入文件 |
| `grep` | pi 内置 | 读 | 搜索内容 |
| `find` | pi 内置 | 读 | 搜索文件 |
| `ls` | pi 内置 | 读 | 列出目录 |
| **`edit`** | **hashline** | 写 | hashline 编辑（覆盖内置） |
| **`debug`** | **dap** | 读写 | DAP 调试（launch/attach/step/evaluate） |
| **`lsp`** | **lsp** | 读写 | LSP 语言服务器（diagnostics/hover/references） |
| **`review`** | **review** | 读 | 代码评审（diff/file/branch/commit） |

## Provider 注册总览

| Provider | 来源 | 认证 | 说明 |
|----------|------|------|------|
| **`xai-oauth`** | **xai-oauth** | OAuth 订阅 | SuperGrok / X Premium+ 登录；订阅模型经 cli-chat-proxy，支持登录后后台模型发现 |

## pi Extension API 映射

| 原功能概念 | 来源 | piex 实现 | pi API |
|-----------|------|---------|--------|
| 覆盖 edit 工具 | omp | hashline.ts | `pi.registerTool({ name: "edit" })` |
| Hook read 追加 header | omp | hashline.ts | `pi.on("tool_result", ...)` |
| 注册 debug 工具 | omp | dap.ts | `pi.registerTool({ name: "debug" })` |
| 会话清理 DAP 进程 | omp | dap.ts | `pi.on("session_shutdown", ...)` |
| 注册 lsp 工具 | omp | lsp.ts | `pi.registerTool({ name: "lsp" })` |
| 计划模式 /plan | pi 示例 | plan.ts | `pi.registerCommand("plan", ...)` |
| 只读工具切换 | pi 示例 | plan.ts | `pi.setActiveTools([...])` |
| 危险命令拦截 | pi 示例 | plan.ts | `pi.on("tool_call", ...)` → block |
| 进度追踪 [DONE:n] | pi 示例 | plan.ts | `pi.on("turn_end", ...)` |
| 交互评审菜单 | omp | review.ts | `pi.registerCommand("review", ...)` |
| 注册 review 工具 | omp | review.ts | `pi.registerTool({ name: "review" })` |
| 状态持久化 | pi | plan.ts | `pi.appendEntry("plan-mode", ...)` |
| Footer/Widge | pi | plan.ts | `ctx.ui.setStatus/setWidget(...)` |
| 注册 xAI OAuth provider | omp | xai-oauth.ts | `pi.registerProvider("xai-oauth", { oauth: {...} })` |
