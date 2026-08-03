# @piex-dev/aidp

Internal model gateway provider for pi — 通过内部 OpenAI 兼容网关的
`/crawl` 端点提供模型服务（默认 `gpt-5.6-sol`，模型列表可配置）。

网关地址为内部域名，**不硬编码在代码中**，通过环境变量或 models.json 配置。

## 安装

```bash
pi install /path/to/piex/extensions/aidp
```

## 配置

模型列表支持两种配置方式，**models.json 优先**：

### 方式一：models.json（推荐，与 zhipu 等 provider 一致）

在 `~/.pi/agent/models.json` 的 `providers.aidp` 中定义模型，扩展自动读取并
注册（无需设置 `AIDP_BASE_URL`）：

```json
{
  "providers": {
    "aidp": {
      "baseUrl": "https://aidp.bytedance.net/api/modelhub/online/v2/crawl",
      "api": "openai-completions",
      "models": [
        { "id": "gpt-5.6-sol", "name": "GPT-5.6 Sol" },
        { "id": "gpt-5.6-ultra", "name": "GPT-5.6 Ultra" }
      ]
    }
  }
}
```

- `api` 必须是 `openai-completions`（匹配扩展协议，请求才走 /crawl 改写）
- `baseUrl` 必写（pi 对自定义 provider 的校验要求）
- 每个模型的字段均可选，缺省值：`contextWindow: 128000`、`maxTokens: 16384`、
  `input: ["text", "image"]`、`reasoning: false`、cost 全 0
- 新增/切换模型 = 往 `models` 数组加一条，`/reload` 后生效

### 方式二：环境变量（轻量，无需改配置文件）

```bash
export AIDP_BASE_URL=<网关端点，形如 https://<internal-host>/.../v2/crawl>
export AIDP_API_KEY=<你的 ak>
export AIDP_MODELS=gpt-5.6-sol,gpt-5.6-ultra   # 可选，逗号分隔的模型列表
```

- `AIDP_BASE_URL` 必填（方式一未配置时），未设置则扩展跳过注册并提示警告
- `AIDP_MODELS` 可选：逗号分隔的模型 id 列表，未设置时默认只注册 `gpt-5.6-sol`

### 公共说明

- `AIDP_API_KEY` 从环境变量读取（两种方式都适用；models.json 也可写
  `apiKey: "$AIDP_API_KEY"` 覆盖）。密钥不会进入代码或配置文件明文提交
- models.json 的 `providers.aidp.modelOverrides` 可覆盖已注册模型的参数
  （contextWindow / maxTokens / cost / name 等，未知 id 被忽略）：

  ```json
  { "providers": { "aidp": { "modelOverrides": {
    "gpt-5.6-ultra": { "contextWindow": 262144 }
  } } } }
  ```

- **安全提示**：网关认证协议强制使用 `?ak=<key>` query 参数（实测不支持
  header 认证），key 会出现在请求 URL 中，可能进入网关/代理侧访问日志。
  这是上游协议限制，无替代方案，请勿在非可信环境中使用该密钥

## 使用

```bash
pi -m aidp/gpt-5.6-sol "hello"
# 或 /model 中选择 AIDP 下的模型；运行中按 Ctrl+P 可在 aidp/* 模型间循环切换
```

## 支持的 action

| 能力           | 支持 | 说明                                                      |
| -------------- | ---- | --------------------------------------------------------- |
| 流式输出 (SSE) | ✅   | 标准 `chat.completion.chunk` 格式                         |
| 工具调用       | ✅   | 标准 `delta.tool_calls` 流式                              |
| 图片输入       | ✅   | `content` 数组格式（data URL / 图片 URL）                 |
| 推理内容       | ⚠️   | 网关不暴露 `reasoning_content` 流，思考过程直接输出在正文 |
| usage 统计     | ✅   | 末 chunk 返回，成本按 0 计（内部网关无公开定价）          |

> 模型参数为估算值：`contextWindow: 128000`、`maxTokens: 16384`（无官方文档
> 支撑），可按模型在 models.json 中覆盖。

## 与上游 API 的差异

| 项              | 标准 OpenAI         | 本网关                   | 处理方式                              |
| --------------- | ------------------- | ------------------------ | ------------------------------------- |
| 认证            | `Authorization`     | `?ak=<key>` query 参数   | 注入包装 fetch，改写 URL              |
| 端点路径        | `/chat/completions` | 固定 `/crawl`，无后缀    | fetch 层剥离 SDK 追加的后缀           |
| 链路追踪        | 无要求              | 必须 `X-TT-LOGID` header | 每请求生成随机 id                     |
| max_tokens 字段 | 两者均可            | 官方示例用 `max_tokens`  | `compat.maxTokensField: "max_tokens"` |

## 实现说明

复用 pi-ai `openai-completions` 的 `stream`（SSE 解析、工具调用、usage、重试全部
继承），通过官方支持的 `ProviderRequestOptions.fetch` 注入点改写请求：
`/chat/completions` 后缀 → `/crawl`，`Authorization` → `?ak=`，附加 `X-TT-LOGID`。

模型列表来源：优先读 `~/.pi/agent/models.json` 的 `providers.aidp.models`
（扩展此时不声明模型，pi 合成逻辑保留 models.json 的列表，请求仍走扩展的
streamSimple 改写）；未配置时回退 `AIDP_MODELS` 环境变量。

请求改写逻辑为纯函数（`src/request.ts`），模型列表解析为纯函数
（`src/models.ts`），均有单元测试覆盖
（`bun test extensions/aidp/test/aidp.test.ts extensions/aidp/test/models.test.ts`）。

> **依赖注意**：当前版本通过 `@earendil-works/pi-ai/compat` 兼容入口导入
> `openAICompletionsApi`（该入口在 pi-ai 中标注为 temporary，将在
> ModelManager 迁移后移除）。升级 pi 后若此导入失效，请迁移到主入口
> `import { openAICompletionsApi } from "@earendil-works/pi-ai"`。
