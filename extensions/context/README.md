# context

上下文用量报告扩展 — `/context` 命令，展示 session 条目分布与估算 token 占比。

## 深度解读

- 博客：https://piex.dev/zh/blogs/context/
- 源稿：[`docs/notes/context.md`](../../docs/notes/context.md)

## 功能

- **/context 命令**: 一次性输出结构化上下文用量报告
- **条目分析**: 统计 user/assistant/system/tool_call/tool_result/custom 各类条目数量
- **分布图表**: ASCII bar chart 展示 assistant/user/tool results 占比
- **Token 估算**: 基于字符数 / 3.5 粗略估算 token 用量

```
context.ts                      # pi 扩展入口 (~160 行)
├── analyzeEntries()            #   遍历所有 session entry 统计
├── buildReport()               #   生成 markdown 表格 + ASCII 柱状图
├── estimateTokens()            #   chars → tokens 估算
└── /context 命令               #   registerCommand 注册
```

## 安装

```bash
pi install npm:@piex-dev/context
```

## 使用

```bash
/context
```

输出示例：

```
## Context Usage Report

### Overview
Total entries      | 42
Estimated tokens   | ~3.2k
User messages      | 12
Assistant messages | 14
Tool calls         | 8
Tool results       | 6

### Distribution
████████████░░░░░░░░ Assistant     62%
██████░░░░░░░░░░░░░░ User          28%
██░░░░░░░░░░░░░░░░░░ Tool Results  10%

Estimated total: ~3.2k tokens (11,234 chars)
```

## 与 pi /session 的差异

| pi /session       | context (piex)             |
| ----------------- | -------------------------- |
| 展示 session 列表 | 展示当前 session 内容分布  |
| 无分布图表        | ASCII bar chart 分布可视化 |
| 无 token 估算     | chars → tokens 估算        |
| 无条目分类        | 按 role/type 详细分类      |

## 来源

功能灵感来自 [oh-my-pi](https://github.com/can1357/oh-my-pi) 的 context 用量报告概念，增强 pi 已有 `/session` 命令。
