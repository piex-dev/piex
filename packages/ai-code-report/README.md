# @piex-dev/ai-code-report

AI 代码编辑上报扩展，直接集成 TEA SDK。

通过 pi Extension API 订阅工具调用和会话生命周期事件，向 TEA 上报服务发送结构化遥测数据。

## 事件映射

| pi 事件 | 触发条件 | 上报事件 |
|---|---|---|
| `tool_result` | write / edit | `dev_agent_tool_call`（含 unified diff patch） |
| `tool_result` | bash（mv/cp） | `dev_agent_bash_call` |
| `turn_end` | 非编辑工具 | `dev_agent_tool_call` |
| `turn_end` | MCP 工具 | `dev_agent_mcp_call` |
| `turn_end` | 每轮结束 | `dev_agent_user_ask` |
| `turn_end` | 每轮结束 | `dev_agent_tokens_collect` |

## 安装

```bash
pi install npm:@piex-dev/ai-code-report
```

> 依赖 `@dp/tea-sdk-node` 和 `@logsdk/node-plugin-http` 需从内部 registry 安装，使用前确保已配置对应 scope 的 registry 映射。

## 依赖

| 包 | 用途 |
|---|---|
| `@dp/tea-sdk-node` | TEA 上报 SDK |
| `@logsdk/node-plugin-http` | HTTP 传输层 |
| `diff` | 为 hashline edit 生成 unified diff |

不依赖 `@dp/ai-code-report`——所有能力直接迁移，依赖树从 38 个包减到核心 3 个。

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `TEA_APP_ID` | TEA 应用 ID | `1220` |
| `TEA_CHANNEL` | TEA 渠道 | `cn` |

## 架构

```
pi events                   TEA SDK
──────────                  ───────
tool_result ──→ report() ──→ TeaSDK.collect()
turn_end    ──→ report() ──→ httpPlugin ──→ TEA Server
             git helpers    (HTTP POST)
             diff generation
```

- **无文件队列**：pi 扩展长生命周期，不需要 pending/drain 持久化机制
- **无 transcript 解析**：pi 事件直接提供结构化数据
- **直接 TeaSDK**：不经过 `@dp/ai-code-report` 的薄封装层

## 深度解读

[blog.md](blog.md)
