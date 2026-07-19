# init

引导式 `AGENTS.md` 生成 — 纯 prompt 包，安装后提供 `/init`。

## 深度解读

- 博客：https://piex.dev/zh/blogs/init/
- 源稿：[`docs/notes/init.md`](../../docs/notes/init.md)

## 功能

- **/init 命令**：扫描仓库高信号源，创建或就地改进项目根 `AGENTS.md`
- **可选参数**：`/init focus on testing` 等，约束生成重点
- **零运行时**：无 extension、无工具覆盖，只分发 `prompts/init.md`

```
init/
├── package.json          # pi.prompts → ./prompts
├── README.md
└── prompts/
    └── init.md           # → /init
```

## 安装

```bash
pi install npm:@piex-dev/init
# 本地开发
pi install -l packages/init
```

## 用法

```bash
# 交互
/init
/init focus on monorepo packages and test commands

# 非交互
pi -p "/init" --no-session
```

写完后执行 `/reload`（或新开 session），pi 才会把新的 `AGENTS.md` 注入上下文。

## 与 opencode / omp 的差异

| 能力                   | opencode            | oh-my-pi         | @piex-dev/init         |
| ---------------------- | ------------------- | ---------------- | ---------------------- |
| `/init` 生成 AGENTS.md | 内置 slash + prompt | 无               | pi prompt 包           |
| 多格式 context 发现    | AGENTS / CLAUDE 等  | 多 provider 加载 | 依赖 pi 原生加载       |
| 实现形态               | 内核 command 模板   | —                | `prompts/init.md` only |
| 运行时依赖             | 内置                | —                | 无                     |

## 来源

Prompt 结构借鉴 [OpenCode](https://github.com/anomalyco/opencode) 内置 `/init`（`initialize.txt`），改写为 pi 语境（`.pi/settings.json`、`/reload`、不提 `opencode.json`）。oh-my-pi 强化的是 context **加载**，不生成规则文件。
