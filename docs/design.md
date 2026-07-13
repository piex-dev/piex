# 设计理念

Piex 是 pi 的功能拓展集合，从各类优秀 coding agent（oh-my-pi、Claude Code、OpenCode 等）中提取核心功能特性，以独立 piex package 形式分发。

## 核心原则

### 1. 100% 基于 pi Extension API

不 fork pi，不修改 pi 内部代码。所有功能通过 pi 的标准扩展接口实现：

| 能力 | 实现方式 |
|------|---------|
| 覆盖内置工具 | `pi.registerTool({ name: "edit", ... })` |
| 注册新工具 | `pi.registerTool({ name: "debug", ... })` |
| Hook 工具调用 | `pi.on("tool_call", ...)` |
| Hook 工具结果 | `pi.on("tool_result", ...)` |
| 注册命令 | `pi.registerCommand("review", ...)` |
| 注入上下文 | `pi.on("before_agent_start", ...)` |
| 会话清理 | `pi.on("session_shutdown", ...)` |
| 状态持久化 | `pi.appendEntry("state-key", ...)` |
| Footer/Widget | `ctx.ui.setStatus(...)`, `ctx.ui.setWidget(...)` |
| 交互弹窗 | `ctx.ui.select(...)`, `ctx.ui.editor(...)` |
| 快捷键 | `pi.registerShortcut(Key.shift("p"), ...)` |

### 2. 随 pi 升级而升级

- 每个 piex package 是独立的 npm 包，不嵌入 pi
- pi 升级时 piex 不受影响（扩展 API 向后兼容）
- piex 可通过 `pi update` 独立升级
- 版本号独立管理，无耦合

### 3. 按需安装

用户只安装需要的功能：

```bash
pi install npm:@piex-dev/hashline   # hashline 编辑
pi install npm:@piex-dev/dap        # DAP 调试
pi install npm:@piex-dev/plan       # 计划模式
```

### 4. 代码来源可追溯

每个 package 标注了功能特性和设计灵感的原始来源：

| Package | 功能来源 | 实现方式 |
|---------|---------|---------|
| hashline | oh-my-pi hashline | 依赖 `@oh-my-pi/hashline` + pi 适配层 + Node.js polyfill |
| dap | oh-my-pi DAP | 从 omp 独立移植（Bun → Node.js） |
| lsp | oh-my-pi LSP | 从 omp 精简移植 |
| plan | pi 官方示例 | 基于 plan-mode 示例增强 |
| review | oh-my-pi /review | 从 omp 精简移植 |
| theme-dark-terminal | [opencode-themes](https://github.com/debugtalk/opencode-themes) | pi.themes 静态主题 JSON 分发 |

## 架构模式

### 扩展 Package 模式

每个 package 遵循统一结构：

```
<name>/
├── package.json          # npm 包，含 "pi" manifest
├── README.md             # package 文档
└── extensions/
    └── <name>.ts         # pi 扩展入口，export default function(pi)
    └── ...辅助模块.ts
```

`package.json` 中的 `"pi": { "extensions": ["./extensions"] }` 告诉 pi 自动发现扩展文件。

### 扩展加载流程

```
pi 启动
  ├── 解析 settings.json → 发现 piex package
  ├── 读取 package.json → 找到 extensions/ 目录
  ├── jiti 加载 .ts 文件
  └── 调用 export default function(pi)
      ├── pi.registerTool(...)    ← 注册工具
      ├── pi.registerCommand(...)  ← 注册命令
      └── pi.on("event", ...)     ← 订阅事件
```

### 扩展入口函数签名

```typescript
// 同步（普通扩展）
export default function myExtension(pi: ExtensionAPI) { ... }

// 异步（需要初始化例如 fetch 远程配置）
export default async function myExtension(pi: ExtensionAPI) { ... }
```


### 主题 Package 模式

主题 package 没有 TypeScript 扩展代码，而是通过静态 JSON 文件分发。pi 支持 `themes/` 约定目录或 `pi.themes` 显式文件数组；为兼容 `/settings` 预览与运行时加载，推荐用约定目录形式：

```json
{
  "pi": { "themes": ["./themes"] }
}
```

```
<name>/
├── package.json          # npm 包，"pi": { "themes": ["./themes"] }
├── README.md
└── themes/
    └── <name>.json       # pi theme JSON（51 color tokens）
```

`package.json` 中的 `"pi": { "themes": ["./themes"] }` 告诉 pi 自动发现主题文件。

**安装方式选择：**

- **全局 settings**（`~/.pi/agent/settings.json`）：本地包路径必须传绝对路径，否则 `/reload` 后相对路径会按 settings 文件位置解析导致主题丢失。例：
  ```bash
  pi install /absolute/path/to/piex/packages/theme-dark-terminal
  ```
- **项目级 settings**（`.pi/settings.json`）：可用相对路径，团队共享。例：
  ```bash
  pi install -l ./packages/theme-dark-terminal
  ```

主题 JSON 包含 `name`（唯一主题名）、`vars`（可选色板变量）和 `colors`（51 个必需 token）。pi 启动时自动加载，`/settings` 切换。
