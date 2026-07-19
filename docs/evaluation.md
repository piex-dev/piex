# 评测方案

以 pi 为基准线，在相同评测集下对比 pi + piex 和 omp，核心目标是量化 piex 对 pi 的提升幅度，同时以 omp 作为参照了解 piex 在行业中的相对水平。

## 评测目标

核心问题：**piex 能帮助 pi 提升多少？相比 omp 的指标如何？**

| 角色 | Agent | 说明 |
|------|-------|------|
| **基准线** | pi (bare) | pi 原生，不加载任何扩展，展示起点 |
| **评测对象** | pi + piex | 加载全部已实现 piex packages，量化提升 |
| **参照系** | omp | oh-my-pi，piex 能力来源，行业相对水平参照 |

通过三者同评测集对比，回答：

- piex 对 pi 的量化提升有多大？
- pi + piex 相比 omp 的指标差距如何？

## 对比矩阵

在相同评测集、相同模型下，三者一起评测。竞品数据引用公开 leaderboard，不自行跑分。

### 自测 Agent

| 角色 | Agent | 配置 |
|------|-------|------|
| 基准线 | pi (bare) | pi 原生，不加载任何 extension |
| 评测对象 | pi + piex | pi + 全部已实现 piex packages |
| 参照系 | omp | oh-my-pi，内建全部能力 |

### 竞品参考（引用公开数据）

SWE-bench Leaderboard、官方 Blog、论文中 Claude Code / Aider / OpenHands / Devin 等 Agent 的公开评测结果。

## PieX 评测范围

每次评测加载全部已实现的 piex packages，未来新增 package 后重跑即可。

### 已实现（评测覆盖）

| Package | 能力 | 评测关联 |
|---------|------|---------|
| **hashline** | 覆盖 `edit`（hashline 语法） | SWE-bench（编辑正确率、token 效率）、Can It Edit |
| **dap** | `debug`（14 个 adapter） | DebugBench、SWE-bench（调试路径） |
| **lsp** | `lsp`（11 个 server） | RepoBench、SWE-bench（代码理解） |
| **plan** | `/plan`、`/todos`（计划模式） | SWE-bench（多步任务规划） |
| **review** | `/review`、`review` 工具 | CodeReviewer / c-CRAB |

### 规划中（评测预留）

| Package | 状态 | 评测关联 |
|---------|------|---------|
| todo | 📋 P0 | SWE-bench（任务管理） |
| conflict | 📋 P0 | 自定义合并冲突评测 |
| ast-grep / ast-edit | 📋 P1 | SWE-bench（搜索/编辑精准度） |
| web-search | 📋 P1 | 外部知识评测 |
| eval | 📋 P1 | 数据分析类任务 |
| memory | 📋 P1 | 跨 session 知识保留 |
| gh | 📋 P1 | PR/Issue 操作 |
| browser | 📋 P2 | Web 交互评测 |

## 评测集选择

### Tier 1 — 核心评测

| 评测集 | 规模 | 测什么 | piex 关联 |
|--------|------|--------|----------|
| **SWE-bench Verified** | 500 题，12 Python 仓库 | 仓库级 bug 修复全链路 | 覆盖编辑、搜索、调试、规划，几乎所有 piex 能力 |
| **Aider Polyglot** | 225 题，多语言 | 自然语言 → 代码编辑 | hashline 编辑能力 |
| **Can It Edit** | 多语言编辑指令 | 细粒度代码修改 | hashline / ast-edit 精准度 |

### Tier 2 — 专项评测

| 评测集 | 规模 | piex 关联 |
|--------|------|----------|
| **DebugBench** | 4,253 bug | dap：自动定位并修复 bug |
| **RepoBench** | 跨文件补全 | lsp + ast-grep：多文件上下文理解 |
| **CodeReviewer / c-CRAB** | PR review | review：AI review quality |

### Tier 3 — 扩展评测（覆盖规划功能后启用）

| 评测集 | piex 关联 |
|--------|----------|
| SWE-bench Multimodal | browser（图片 issue） |

## 指标设计

### 核心指标（三者可对比）

| 指标 | 定义 | 重点关注 |
|------|------|---------|
| **resolve_rate** | 任务通过率 (pass / total) | pi + piex 与 omp 的差距 |
| **avg_tokens** | 平均每任务消耗 token | 效率对比 |
| **avg_time** | 平均 wall time | 速度对比 |
| **est_cost** | 平均每任务 API 费用 | 成本对比 |

### 归因指标（pi 系列内部对比，定位 piex 各 package 的贡献）

| 指标 | 定义 | 关联 package |
|------|------|------------|
| **edit_accuracy** | edit 调用中 hashline 语法正确的比例 | hashline |
| **search_precision** | grep/glob/lsp 结果中相关的比例 | lsp |
| **first_try_rate** | 第一次 edit 就正确的比例 | hashline |
| **debug_success** | dap 调用后成功定位到 bug 的比例 | dap |
| **plan_follow_rate** | Agent 按 plan 执行的比例 | plan |
| **review_quality** | review 发现真实问题的比例 | review |

## Docker 架构

每个 Task 在同一 Docker 环境中，依次用基准线（pi bare）、评测对象（pi + piex）、对标参考（omp）执行，由标准 harness 统一判题。

```
┌────────────────────────────────────────────────────────────┐
│                        Eval Orchestrator                    │
│  eval/runner.ts                                            │
│                                                             │
│  Task Loader ──→ Agent Runner ──→ Sandbox ──→ Judge       │
│  (JSONL)        (pi/omp CLI)    (Docker)    (SWE-bench)    │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              Metrics Collector                        │  │
│  │  resolve_rate │ token 用量 │ wall time │ API 成本    │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              Report Generator                         │  │
│  │  基准线 → 评测对象 → 对标参考 + 公开 leaderboard     │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

### 单 Task 执行流

```
1. Task Loader: 读取 { repo_url, base_commit, issue_text, test_patch }

2. Sandbox: docker run swebench-image-{repo}
   → 容器内已 checkout base_commit，依赖已安装

3. Agent Runner:
   docker exec pi pi --model ${MODEL} \
     -e /piex/packages/hashline/extensions/hashline.ts \
     -e /piex/packages/dap/extensions/dap.ts \
     -e /piex/packages/lsp/extensions/lsp.ts \
     -e /piex/packages/plan/extensions/plan.ts \
     -e /piex/packages/review/extensions/review.ts \
     -p "${ISSUE_TEXT}" > /workspace/result.json

4. 收集: result.json → patch + tool_calls + token_usage

5. Judge: 应用 patch → 运行 test_patch → pass/fail

6. Metrics: SQLite / JSONL 持久化
```

### Docker 镜像

| 镜像 | 说明 |
|------|------|
| `pi.Dockerfile` | pi 基础镜像（Node.js），同时用于 pi bare 和 pi+piex |
| `omp.Dockerfile` | omp 镜像（Bun 环境） |
| `swebench.Dockerfile` | SWE-bench 仓库运行环境 |

pi bare 和 pi+piex 使用同一镜像，通过 `-e` 参数控制扩展加载。

## 目录结构

```
piex/eval/
├── README.md                  # 评测工具使用文档
├── package.json
├── tsconfig.json
│
├── src/
│   ├── runner.ts              # CLI 主入口
│   ├── orchestrator.ts        # 任务调度（并行、重试）
│   ├── sandbox.ts             # Docker 容器管理
│   ├── agents/
│   │   ├── pi.ts              # pi bare + piex 两种模式
│   │   └── omp.ts             # omp runner
│   ├── benchmarks/
│   │   ├── swebench.ts        # SWE-bench 数据集 + 判题
│   │   ├── aider-polyglot.ts  # Aider Polyglot
│   │   ├── can-it-edit.ts     # Can It Edit
│   │   ├── debugbench.ts      # DebugBench
│   │   └── repobench.ts       # RepoBench
│   ├── metrics.ts             # 指标收集与计算
│   └── report.ts              # Markdown / JSON 报告生成
│
├── docker/
│   ├── pi.Dockerfile          # pi 基础镜像（共享）
│   ├── omp.Dockerfile         # omp 镜像
│   └── swebench.Dockerfile    # SWE-bench 环境
│
├── results/                   # gitignored
│   └── 2026-07-14/
│       ├── swebench-pi-bare.json
│       ├── swebench-pi-piex.json
│       ├── swebench-omp.json
│       └── report.md
│
└── fixtures/                  # 自定义评测素材
    └── merge-conflicts/       # 合并冲突评测集（conflict 后续使用）
```

## 报告格式

每次评测生成 Markdown 报告，先呈现 piex 对 pi 的提升，再以 omp 为参照系对比：

```markdown
## SWE-bench Verified：piex 评测报告 (2026-07-14)

### 评测结果

| 角色 | Agent | Model | Resolve Rate | Avg Tokens | Avg Time | Est. Cost |
|------|-------|-------|-------------|------------|----------|-----------|
| 基准线 | pi (bare) | deepseek-v3 | 12.4% | 85K | 3.2min | $0.18 |
| **评测对象** | **pi + piex** | deepseek-v3 | **18.8%** | 62K | 2.8min | $0.14 |
| 参照系 | omp | deepseek-v3 | 19.2% | 60K | 2.6min | $0.13 |

### pi + piex 效果分析

| 指标 | pi (bare) 基准线 | pi + piex | omp 参照系 | 相对基准提升 | 与 omp 参照差距 |
|------|-----------------|-----------|---------|------------|-----------|
| resolve_rate | 12.4% | 18.8% | 19.2% | **+51.6%** | **-2.1%** |
| avg_tokens | 85K | 62K | 60K | **-27.1%** | **+3.3%** |
| edit_accuracy | 67% | 91% | 92% | **+35.8%** | **-1.1%** |
| avg_tool_calls | 42 | 28 | 26 | **-33.3%** | **+7.7%** |

### 公开 Leaderboard 参考（同评测集）

| Agent | Resolve Rate | 来源 |
|-------|-------------|------|
| Claude 4 Opus + SWE-agent | 42.6% | anthropic.com/blog |
| Devin | 35.8% | swebench.com |
| GPT-5 + OpenHands | 38.2% | openhands.dev |

### 结论

- piex 对 pi 的量化提升：resolve rate **+51.6%**，token 用量降低 **27.1%**
- 相比 omp 参照系：pi + piex 差距 **< 5%**，核心编辑能力在相近水平
- pi Extension API 可承载 omp 级别 agent 能力，piex 架构更轻量
```

## 实施路径

### Phase 1 — Docker 基础设施 + 首个评测（预估 1 周）

- [ ] `docker/pi.Dockerfile`：pi 基础镜像
- [ ] `docker/omp.Dockerfile`：omp 镜像
- [ ] `docker/swebench.Dockerfile`：SWE-bench 环境
- [ ] `src/sandbox.ts`：Docker 容器生命周期管理
- [ ] `src/agents/pi.ts`：pi bare + piex 两种模式
- [ ] `src/agents/omp.ts`：omp runner
- [ ] `src/benchmarks/aider-polyglot.ts`：首个评测集，验证全链路

### Phase 2 — SWE-bench 接入（预估 1 周）

- [ ] `src/benchmarks/swebench.ts`：数据集加载 + 官方 harness 判题
- [ ] pi vs pi+piex vs omp 首份对比报告

### Phase 3 — 专项评测（按需）

- [ ] `can-it-edit.ts` → hashline 编辑能力
- [ ] `debugbench.ts` → DAP 调试能力
- [ ] `repobench.ts` → LSP 代码理解
- [ ] `src/benchmarks/code-reviewer.ts` → review 评审准确率

## 约束与风险

| 风险 | 对策 |
|------|------|
| SWE-bench 数据污染 | 关注相对提升而非绝对值；后续接入 LiveCodeBench |
| ARM64 x86 模拟性能 | 优先跑 SWE-bench Lite（300 题）；可上 Modal 云端 |
| pi 非交互模式限制 | 验证 `-p` 模式效果；必要时用 PTY 模拟 |
| 评测成本 | Lite 先行，按需跑全量 Verified |
