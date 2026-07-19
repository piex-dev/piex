# @piex-dev/ai-code-report

AI 代码编辑上报扩展，直接集成 TEA SDK。

> 逐行上报，与 `@dp/ai-code-report` 字段对齐。GitHub 仓库自动跳过，无需配置。

通过 pi Extension API 订阅工具调用和会话生命周期事件，向 TEA 上报服务发送结构化遥测数据。

## 事件映射

| pi 事件       | 触发条件      | 上报事件                                          |
| ------------- | ------------- | ------------------------------------------------- |
| `tool_result` | write / edit  | `dev_agent_tool_call`（逐行上报，accept_content） |
| `tool_result` | bash（mv/cp） | `dev_agent_bash_call`                             |
| `turn_end`    | 非编辑工具    | `dev_agent_tool_call`                             |
| `turn_end`    | MCP 工具      | `dev_agent_mcp_call`                              |
| `turn_end`    | 每轮结束      | `dev_agent_user_ask`                              |
| `turn_end`    | 每轮结束      | `dev_agent_tokens_collect`                        |

## 安装

```bash
pi install npm:@piex-dev/ai-code-report
```

> 依赖 `@dp/tea-sdk-node` 和 `@logsdk/node-plugin-http` 需从内部 registry 安装，使用前确保已配置对应 scope 的 registry 映射。

## 依赖

| 包                         | 用途                               |
| -------------------------- | ---------------------------------- |
| `@dp/tea-sdk-node`         | TEA 上报 SDK                       |
| `@logsdk/node-plugin-http` | HTTP 传输层                        |
| `diff`                     | 为 hashline edit 生成 unified diff |

不依赖 `@dp/ai-code-report`——所有能力直接迁移，依赖树从 38 个包减到核心 3 个。

## 环境变量

| 变量          | 说明        | 默认值 |
| ------------- | ----------- | ------ |
| `TEA_APP_ID`  | TEA 应用 ID | `1220` |
| `TEA_CHANNEL` | TEA 渠道    | `cn`   |

### Debug 日志

安装扩展后自动启用，所有上报事件和生命周期信息会以 JSONL 格式写入 `~/.pi/piex-dev/ai-code-report/<YYYYMMDD>.jsonl`：

```
{"ts":"2026-07-19T...","step":"session_start","userId":"...","repoUrl":"...","branch":"...","skipReport":false}
{"ts":"2026-07-19T...","step":"code_edit","tool":"write","file":"src/index.ts","patchBytes":1234,"lines":12}
{"ts":"2026-07-19T...","step":"report","event":"dev_agent_tool_call","session_id":"...","name":"write","accept_content":"import ..."}
```

日志 step 类型：

| step               | 含义                                            |
| ------------------ | ----------------------------------------------- |
| `session_start`    | 会话启动，含 git 信息和 GitHub 过滤结果         |
| `skip_tool_result` | 因 GitHub 仓库跳过的工具调用                    |
| `skip_turn_end`    | 因 GitHub 仓库跳过的 turn_end                   |
| `code_edit`        | write/edit 的 diff 提取结果（patch 大小、行数） |
| `report`           | 每一次 TeaSDK.collect() 调用，含完整 payload    |
| `report_error`     | TeaSDK 上报异常                                 |

## 与 @dp/ai-code-report 字段对齐

### dev_agent_tool_call（代码编辑：write / edit）

| 字段             | `@dp/ai-code-report` | `@piex-dev/ai-code-report` | 说明                                     |
| ---------------- | -------------------- | -------------------------- | ---------------------------------------- |
| `session_id`     | ✅                   | ✅                         |                                          |
| `uuid`           | ✅                   | ✅                         |                                          |
| `name`           | ✅                   | ✅                         | write / edit                             |
| `file_path`      | ✅                   | ✅                         |                                          |
| `patch`          | ✅                   | —                          | piex 改为逐行上报，patch 仅用于内部 diff |
| `accept_content` | —                    | ✅                         | 逐行上报，截断 400 字符                  |
| `timestamp`      | ✅                   | ✅                         |                                          |
| `source`         | `"claude-code"`      | `"pi"`                     |                                          |
| `user_unique_id` | ✅                   | ✅                         | git config user.email                    |
| `model`          | ✅                   | ✅                         | turn_end 时填充                          |
| `repo`           | ✅                   | ✅                         | git remote get-url origin                |
| `branch`         | —                    | ✅                         | git rev-parse --abbrev-ref HEAD          |
| `call_id`        | —                    | ✅                         | toolCallId                               |
| `skill`          | ✅                   | —                          | pi 无此概念                              |

### dev_agent_bash_call

| 字段             | `@dp/ai-code-report` | `@piex-dev/ai-code-report` | 说明           |
| ---------------- | -------------------- | -------------------------- | -------------- |
| `session_id`     | ✅                   | ✅                         |                |
| `uuid`           | ✅                   | ✅                         |                |
| `name`           | ✅                   | ✅                         | "bash"         |
| `action`         | ✅                   | ✅                         | mv / cp        |
| `source_path`    | ✅                   | ✅                         |                |
| `file_path`      | ✅                   | ✅                         |                |
| `command`        | ✅                   | ✅                         | 原始命令字符串 |
| `timestamp`      | ✅                   | ✅                         |                |
| `source`         | ✅                   | ✅                         |                |
| `user_unique_id` | ✅                   | ✅                         |                |
| `repo`           | —                    | ✅                         |                |
| `branch`         | —                    | ✅                         |                |

### dev_agent_tool_call（非编辑工具）

| 字段                | `@dp/ai-code-report` | `@piex-dev/ai-code-report` | 说明                          |
| ------------------- | -------------------- | -------------------------- | ----------------------------- |
| `name`              | ✅                   | ✅                         |                               |
| `session_id`        | ✅                   | ✅                         |                               |
| `uuid`              | ✅                   | ✅                         |                               |
| `conversation_uuid` | ✅                   | ✅                         |                               |
| `input`             | ✅                   | ✅                         | JSON 序列化，截断 64KB        |
| `output`            | ✅                   | ✅                         | JSON 序列化，截断 64KB        |
| `is_error`          | ✅                   | ✅                         |                               |
| `timestamp`         | ✅                   | ✅                         |                               |
| `duration`          | ✅                   | 0                          | pi tool_result 事件无耗时字段 |
| `model`             | ✅                   | ✅                         |                               |
| `patch`             | ✅                   | —                          |                               |
| `repo`              | ✅                   | ✅                         |                               |
| `branch`            | —                    | ✅                         |                               |
| `source`            | ✅                   | ✅                         |                               |
| `user_unique_id`    | ✅                   | ✅                         |                               |
| `skill`             | ✅                   | —                          | pi 无此概念                   |

### dev_agent_mcp_call

| 字段                | `@dp/ai-code-report` | `@piex-dev/ai-code-report` | 说明          |
| ------------------- | -------------------- | -------------------------- | ------------- |
| `name`              | ✅                   | ✅                         | MCP server 名 |
| `tool`              | ✅                   | ✅                         | MCP 工具名    |
| `session_id`        | ✅                   | ✅                         |               |
| `uuid`              | ✅                   | ✅                         |               |
| `conversation_uuid` | ✅                   | ✅                         |               |
| `input`             | ✅                   | ✅                         |               |
| `output`            | ✅                   | ✅                         |               |
| `is_error`          | ✅                   | ✅                         |               |
| `timestamp`         | ✅                   | ✅                         |               |
| `duration`          | ✅                   | 0                          |               |
| `model`             | ✅                   | ✅                         |               |
| `repo`              | ✅                   | ✅                         |               |
| `branch`            | —                    | ✅                         |               |
| `source`            | ✅                   | ✅                         |               |
| `user_unique_id`    | ✅                   | ✅                         |               |
| `skill`             | ✅                   | —                          |               |

### dev_agent_user_ask

| 字段             | `@dp/ai-code-report` | `@piex-dev/ai-code-report` | 说明                          |
| ---------------- | -------------------- | -------------------------- | ----------------------------- |
| `session_id`     | ✅                   | ✅                         |                               |
| `uuid`           | ✅                   | ✅                         |                               |
| `parent_uuid`    | ✅                   | —                          | pi 无 conversation chain 概念 |
| `model`          | ✅                   | ✅                         |                               |
| `is_thinking`    | ✅                   | ✅                         |                               |
| `thinking_model` | ✅                   | ✅                         |                               |
| `timestamp`      | ✅                   | ✅                         |                               |
| `duration`       | ✅                   | 0                          |                               |
| `skill`          | ✅                   | —                          |                               |
| `repo`           | ✅                   | ✅                         |                               |
| `branch`         | —                    | ✅                         |                               |
| `source`         | ✅                   | ✅                         |                               |
| `user_unique_id` | ✅                   | ✅                         |                               |
| `input_tokens`   | ✅                   | ✅                         |                               |
| `output_tokens`  | ✅                   | ✅                         |                               |

### dev_agent_tokens_collect

| 字段                      | `@dp/ai-code-report` | `@piex-dev/ai-code-report`        | 说明                    |
| ------------------------- | -------------------- | --------------------------------- | ----------------------- |
| `timestamp`               | ✅                   | ✅                                |                         |
| `source`                  | ✅                   | ✅                                |                         |
| `session_id`              | ✅                   | ✅                                |                         |
| `conversation_id`         | ✅                   | —                                 |                         |
| `model_name`              | ✅                   | ✅                                |                         |
| `input_tokens`            | ✅                   | ✅                                |                         |
| `output_tokens`           | ✅                   | ✅                                |                         |
| `total_tokens`            | ✅                   | ✅                                |                         |
| `cache_read_tokens`       | ✅                   | ✅（cache_read_input_tokens）     | 字段名不同              |
| `cache_write_tokens`      | ✅                   | ✅（cache_creation_input_tokens） | 字段名不同              |
| `reasoning_tokens`        | ✅                   | ✅                                | usage.reasoning         |
| `is_estimated`            | ✅                   | ✅                                | pi 为精确值，始终 false |
| `user` / `user_unique_id` | ✅                   | ✅                                |                         |
| `parent_session_id`       | ✅                   | —                                 |                         |
| `agent_id`                | ✅                   | —                                 |                         |
| `agent_type`              | ✅                   | —                                 |                         |

### 设计差异

| 维度          | `@dp/ai-code-report`                                 | `@piex-dev/ai-code-report`      |
| ------------- | ---------------------------------------------------- | ------------------------------- |
| 上报粒度      | 整 patch（一次编辑一条）                             | 逐行（一行一条 accept_content） |
| 架构          | hook stdin JSON → 文件队列 → detached drain → TeaSDK | pi 事件 → 进程内 TeaSDK         |
| 依赖          | 5 个直接依赖，38 个传递依赖                          | 3 个直接依赖，36 个传递依赖     |
| GitHub 过滤   | ❌                                                   | ✅                              |
| Debug 日志    | ✅ tracer + reportLogger                             | ❌                              |
| 断点续传      | ✅ codePending + codeOutbox                          | —（不需要，长生命周期）         |
| Subagent 追踪 | ✅ subagentStop                                      | ❌（pi subagent 是独立进程）    |

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
