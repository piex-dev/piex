# 架构概览

## 项目结构

```
piex/                                  # monorepo
├── README.md                         # 项目入口
├── .gitignore
├── docs/                             # 📚 文档
│   ├── design.md                     #   设计理念与核心原则
│   ├── architecture.md               #   架构概览（本文档）
│   ├── roadmap.md                    #   实施计划与进度
│   ├── testing.md                    #   测试指南
│   ├── references.md                 #   参考资料索引
│   └── migration/                    #   迁移方案记录
│       └── plan-review.md
└── packages/                         # 📦 5 个独立 piex package
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
    └── review/
        ├── README.md
        ├── package.json
        └── extensions/
            └── review.ts
```

## Package 总览

| Package | 代码量 | 工具 | 外部依赖 | 功能来源 |
|---------|--------|------|---------|---------|
| hashline | 191 行 + polyfill 127 行 | 覆盖 `edit` | `@oh-my-pi/hashline` | oh-my-pi |
| dap | 1942 行 + 212 行 JSON | `debug` | 无 | oh-my-pi |
| lsp | 570 行 + 499 行 JSON | `lsp` | 无 | oh-my-pi |
| plan | 348 行 | `/plan`, `/todos` | 无 | pi 示例 |
| review | 330 行 | `/review`, `review` | 无 | oh-my-pi |

## 工具注册总览

安装全部 piex package 后，pi 提供的工具：

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
