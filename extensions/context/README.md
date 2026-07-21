# context

上下文用量报告扩展 — `/context` 命令，展示 session 条目分布与估算 token 占比。

## 功能

- **/context 命令**：一次性输出结构化上下文用量报告
- **条目分析**：统计 user/assistant/system/tool_call/tool_result/custom 各类条目数量
- **分布图表**：ASCII bar chart 展示 assistant/user/tool results 占比
- **Token 估算**：基于字符数 / 3.5 粗略估算 token 用量

## 使用说明

```bash
pi install npm:@piex-dev/context
```

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

## 依赖

- `@earendil-works/pi-coding-agent`（peer）

## 延伸阅读

- https://piex.dev/zh/packages/context/
