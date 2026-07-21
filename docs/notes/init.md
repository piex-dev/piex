---
title: Init：一键写出项目的 AGENTS.md
date: 2026-07-19
tags: [Init, AGENTS.md, Prompt]
---

> `/init` 不发明新协议：把「扫仓库 → 写规则」收成一条可重复的 prompt，让每个新项目第一步就能建好 agent 约定。

## 问题背景

Coding agent 进仓库的第一件事，本该是读项目规则。现实里却常是：

1. **没有规则**：新项目或小仓库根本没有 `AGENTS.md`，模型只能猜 scripts 和目录边界
2. **规则过时**：人手写过一版，toolchain 已换，agent 仍按旧约定跑
3. **迁移成本高**：已有 `CLAUDE.md` / Cursor rules，却没人整理成 agent 通用的 `AGENTS.md`
4. **入口不统一**：有人记得手写，有人每次用自然语言「帮我写个 AGENTS」，质量漂移

对用户的影响很直接：没有高信号规则，agent 更容易猜错测试命令、改错包边界、重复踩环境坑。  
`@piex-dev/init` 把这件事收成：`pi install` 一次，之后 `/init` 即可。

```bash
pi install npm:@piex-dev/init
/init
```

## 技术原理

### 1. pi 只加载规则，不生成规则

pi 启动时会从 `~/.pi/agent` 与 cwd 向上发现 `AGENTS.md` / `CLAUDE.md` 并注入 system prompt，但内置 slash 列表里没有 `/init`。  
这是极简设计：内核只做发现与注入；「怎么写出一份好规则」交给扩展或 prompt 包。

### 2. Prompt template = 零代码的 slash 命令

pi package 可声明 `pi.prompts`。`prompts/init.md` 的文件名即命令名，frontmatter 提供 description 与 argument-hint，正文支持 `$ARGUMENTS`。  
用户输入 `/init …` 时，pi 展开模板为完整 user message，当前会话模型按指令调研并写文件。

### 3. 价值在调查清单，不在模板长度

好的 init prompt 规定三件事：先读什么、提取什么、写什么/不写什么。  
可执行源（package.json scripts、CI、lockfile）优先于散文 README；已有规则就地改进，不盲目整文件覆盖。

## 实现方案

本包是 **纯 prompt 包**，无 `extensions/`、无 peer 依赖：

```
prompts/init/
├── package.json          # "pi": { "prompts": ["./prompts"] }
├── README.md
└── prompts/init.md
```

`init.md` 要求：

1. 优先读 README、manifest、构建/测试/CI、既有 instruction 文件、`.pi/settings.json`
2. 只保留 agent 容易猜错的高信号事实（精确命令、包边界、环境坑）
3. 仓库答不上的关键约定才向用户提问
4. 写到项目根 `AGENTS.md`；写完提示 `/reload` 使当前会话生效

刻意不做：全局 `~/.pi/agent/AGENTS.md` 自动写入、交互菜单、extension 包装。全局规则与 UI 壳层可后续按需加，首版保持可装即可用。

## 设计参考

| 项目                 | 机制                                                                              | piex 取舍                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **OpenCode `/init`** | 内置 slash，模板 `initialize.txt` 注入会话；可问 `question`；就地改进 `AGENTS.md` | **采纳**调查清单、写作规则、`$ARGUMENTS`、in-place 改进。**不采纳**内核内置、opencode 专用配置引用；改为 pi `prompts/` 包 |
| **oh-my-pi**         | 多 provider 发现/加载 `AGENTS.md`、`CLAUDE.md`、`.omp/` 等；无生成 `/init`        | **不重复**加载层（pi 已 walk-up）。**借鉴**「规则文件是一等上下文」的产品共识，补齐生成侧                                 |
| **pi 原生**          | `loadProjectContextFiles` 只读；`prompts/*.md` 可作 slash                         | **直接建立在** prompt template 上，零运行时、随 pi 升级                                                                   |

结论：生成逻辑应是「可分发的 prompt」，不是第二个 agent 内核功能。OpenCode 证明 prompt 驱动足够好用；piex 用 pi 官方 package 形态交付同一能力。

## 优化计划

- **现状**：单文件 prompt，依赖模型自觉按清单调研；无结构化校验生成质量
- **影响**：复杂 monorepo 可能漏包级命令；写完后需用户手动 `/reload`
- **怎么补**：可选 thin extension 注入绝对路径与「已存在则提示 update」；生成后自检 checklist（是否含 test/lint 命令）；支持 `/init global` 写用户级规则；与 learning 类扩展衔接（会话中沉淀规则再 merge 进 AGENTS.md）
