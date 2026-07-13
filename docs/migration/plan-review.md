# Plan & Review 迁移方案

从 oh-my-pi (omp) 提取 Plan Mode 和 Review 功能，迁移为 piex extension。

> **状态**: ✅ plan 已实现 | ✅ review 轻量版已实现 | ⏸ review 多 agent 版待定

## 一、Plan Mode（计划模式）

### 1.1 功能概述

Plan Mode 是一个"先规划后执行"的工作流：先让 agent 在只读模式下分析代码并制定计划，用户确认后再开启完整工具权限执行。

### 1.2 omp 和 pi 现有实现对比

| 特性 | omp plan-mode | pi plan-mode (示例) |
|------|--------------|-------------------|
| /plan 命令 | ✅ | ✅ |
| 只读工具限制 | ✅ (read/bush-safe/grep/find/ls) | ✅ (同) |
| 危险 bash 拦截 | ✅ 正则匹配 | ✅ 同 |
| Todo 提取 | ✅ 编号列表 + 标题解析 | ✅ 编号列表 |
| 执行进度追踪 | ✅ [DONE:n] 标记 | ✅ 同 |
| Footer 状态 | ✅ ⏸ plan / 📋 n/m | ✅ 同 |
| Widget 进度 | ✅ todo 列表 | ✅ 同 |
| 状态持久化 | ✅ appendEntry | ✅ 同 |
| 会话恢复 | ✅ 扫描消息重建状态 | ✅ 同 |
| 关键快捷键 | Shift+P | Ctrl+Alt+P |
| 写计划到文件 | ✅ local://<slug>-plan.md | ❌ |
| 计划审批弹窗 | ✅ plan-review-overlay (全屏) | ❌ |
| Plan TOC 侧栏 | ✅ 目录导航 + 删除段落 | ❌ |
| 子 agent 计划传递 | ✅ plan-handoff | ❌ |
| Compaction 保护 | ✅ 计划文件不被清理 | ❌ |

### 1.3 plan 设计

**文件**: `packages/plan/extensions/plan.ts`

**核心能力**（从 pi 示例扩展而来）:

```
┌─────────────────────────────────────────────────────────┐
│                    plan                             │
│                                                        │
│  ┌─────────┐   ┌──────────┐   ┌────────────────────┐   │
│  │ /plan   │   │ 工具限制  │   │ Todo 追踪          │   │
│  │ Ctrl+P  │   │ read-only│   │ [DONE:n] 标记      │   │
│  └─────────┘   └──────────┘   └────────────────────┘   │
│                                                        │
│  ┌──────────────┐  ┌───────────────────────────────┐   │
│  │ 计划写文件    │  │ 交互审批                      │   │
│  │ → 写 PLAN.md │  │ → ui.select("执行/继续/优化") │   │
│  └──────────────┘  └───────────────────────────────┘   │
│                                                        │
│  ┌──────────────────────────────────────────────────┐   │
│  │ Footer Widget: ⏸ plan / 📋 3/5 + todo 列表     │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

**pi 扩展 API 映射**:

| 能力 | pi API |
|------|--------|
| 切换只读工具 | `pi.setActiveTools([...])` |
| 危险命令拦截 | `pi.on("tool_call", ...)` |
| 注入计划上下文 | `pi.on("before_agent_start", ...)` |
| 进度追踪 | `pi.on("turn_end", ...)` 提取 [DONE:n] |
| 用户交互 | `ctx.ui.select(...)` |
| Footer/Widget | `ctx.ui.setStatus(...)`, `ctx.ui.setWidget(...)` |
| 状态持久化 | `pi.appendEntry(...)` |
| /plan 命令 | `pi.registerCommand(...)` |
| 快捷键 | `pi.registerShortcut(Key.shift("p"), ...)` |

**新增能力**（omp 特有，pi 未实现）:

1. **计划写入文件**: agent 把计划写到 `PLAN.md`（本地文件），方便后续引用
2. **计划文件保护**: 通过 `pi.on("context", ...)` 在 compaction 时保护 PLAN.md 不被清理

**复杂度**: 中（主体已有 pi 示例，需要精简优化 + 增加写文件能力）

---

## 二、Review（代码评审）

### 2.1 功能概述

omp 的 Review 功能包含两个层次：

**Layer 1 — 轻量: `/review` 命令**
- 交互式菜单选择评审源（PR / 分支对比 / 未提交变更 / 指定 commit / 自定义）
- 获取 git diff，过滤噪声文件（lock/min/build/vendor/image/binary）
- 计算 diff 权重，推荐 reviewer agent 数量
- 生成结构化的 review prompt 模板

**Layer 2 — 重型: 多 agent 编排**
- 将 diff 按文件分摊到多个 reviewer sub-agent
- 每个 agent 用 `report_finding` 工具报告发现
- 聚合所有 finding 到 TUI overlay 展示
- 支持 findings 浏览、筛选、导出

### 2.2 pi 实现路径

pi 本身不支持 sub-agent，但可以通过 extension 实现。pi 已有 [`subagent` 扩展示例](https://pi.dev)。对于 review，有两种策略：

#### 策略 A: 轻量版 `review`（推荐优先实现）

```
┌──────────────────────────────────────────────────────┐
│                 review (轻量)                    │
│                                                     │
│  /review → 选择评审源 → 获取 diff → 当前 agent 评审  │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │ review 工具 (LLM 可调用)                     │    │
│  │  - review_diff: 评审指定的 diff             │    │
│  │  - review_file: 评审单个文件                │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │ /review 命令 (用户交互)                      │    │
│  │  - PR review (通过 gh CLI)                  │    │
│  │  - Uncommitted changes (git diff)           │    │
│  │  - Specific commit (git show)               │    │
│  │  - Custom instructions                      │    │
│  └─────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────┘
```

#### 策略 B: 完整版 `review`（含多 agent）

需要通过 `pi.registerTool({ name: "review", ... })` 注册一个 review 工具，并在 review 命令中：
1. 创建子 pi 会话（通过 `pi.sendUserMessage` + `ctx.sessionManager`）
2. 每个子 agent 评审一部分文件
3. 收集 findings

但 pi 的子 agent 模型与 omp 不同，实现更复杂。

### 2.3 review 轻量版设计（策略 A）

**文件**:
```
packages/review/
├── package.json
├── extensions/
│   ├── review.ts          # 主扩展入口 (/review 命令 + review 工具)
│   ├── diff.ts            # git diff 获取和解析
│   ├── prompts/
│   │   ├── review-request.md      # 评审请求模板
│   │   └── review-findings.md     # findings 格式模板
│   └── utils.ts           # 噪声过滤等工具函数
└── README.md
```

**pi 扩展 API 映射**:

| 能力 | pi API |
|------|--------|
| /review 命令 | `pi.registerCommand("review", ...)` |
| 交互菜单 | `ctx.ui.select(...)` |
| git diff 获取 | `pi.on("tool_call", ...)` 允许 bash 执行 git |
| review 工具 | `pi.registerTool({ name: "review", ... })` |
| 注入评审 prompt | `pi.on("before_agent_start", ...)` |

**review 工具参数**:

```typescript
{
  action: "diff" | "file" | "findings",
  source?: string,        // "uncommitted" | "staged" | "branch:<name>" | "commit:<sha>"
  file?: string,          // 文件路径（action=file）
  instructions?: string,  // 自定义评审指令
  focus?: string,         // 评审焦点（security/performance/style/...）
}
```

**Diff 解析能力**（从 omp 移植）:
- 解析 unified diff 输出
- 过滤噪声文件（lock/min/build/vendor/image/binary）
- 计算文件变更统计（+/- 行数）
- 按文件扩展名分类

---

## 三、实施计划

### 状态

| 阶段 | 内容 | 状态 | 复杂度 |
|------|------|------|--------|
| **4a** | `plan`（基于 pi 示例增强） | ✅ 已完成 | 中 |
| **4b** | `review` 轻量版 | ✅ 已完成 | 中 |
| **4c** | `review` 多 agent 版 | ⏸ 待定 | 高 |

### plan 完成情况

1. ✅ 从 pi 示例提取基础框架
2. ✅ 精简为自包含单文件 (348 行)
3. ✅ 计划写入 `PLAN.md` 文件
4. ✅ compaction 保护提示
5. ✅ package.json

### review 完成情况

1. ✅ 从 omp 移植 diff 解析模块
2. ✅ 从 omp 移植噪声文件过滤规则
3. ✅ 内置 review prompt 模板
4. ✅ `/review` 命令（交互菜单）
5. ✅ `review` 工具（LLM 可调用）
6. ✅ package.json

### 已解决的风险

| 风险 | 处理方式 |
|------|---------|
| pi 子 agent 模型不同 | 轻量版用单 agent 模式 |
| TUI overlay 依赖 omp 内部组件 | 使用 select/notify/editor 替代 |
| prompt `with { type: "text" }` 不兼容 | 模板内联在代码中 |

---

## 四、总结

| 功能 | 来源 | 移植难度 | pi 依赖 | 独立程度 |
|------|------|---------|---------|---------|
| plan | pi 示例 + omp plan-mode | 低 | 无外部依赖 | 完全独立 |
| review (轻量) | omp /review 命令 | 中 | 无外部依赖 | 完全独立 |
| review (多agent) | omp 完整实现 | 高 | 需要 subagent 机制 | 依赖 pi subagent 扩展 |
