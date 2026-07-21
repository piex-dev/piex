# @piex-dev/xai-oauth

xAI Grok OAuth subscription login for pi. Authenticate with a **SuperGrok** or **X Premium+** subscription instead of an API key.

## 深度解读

- 介绍：https://piex.dev/zh/packages/xai-oauth/
- 源稿：[`docs/packages/xai-oauth.md`](../../docs/packages/xai-oauth.md)

## 安装

```bash
pi install npm:@piex-dev/xai-oauth
```

## 使用

```bash
# 1. 在 pi 交互模式中执行
/login

# 2. 选择 "xAI Grok (SuperGrok / X Premium+)"

# 3. 浏览器会自动打开 x.ai 授权页面，确认登录

# 4. 登录成功后，选择模型开始使用
/model grok-4.5
```

## 原理

基于 [RFC 8628 Device Authorization Grant](https://datatracker.ietf.org/doc/html/rfc8628) 标准流程：

1. **OIDC 发现** — 从 `https://auth.x.ai/.well-known/openid-configuration` 获取 token endpoint
2. **请求设备码** — POST 到 `/oauth2/device/code`，获得 `device_code` + `user_code`
3. **浏览器授权** — 打开 `verification_uri_complete`，用户在 x.ai 确认
4. **轮询令牌** — 每 N 秒轮询 token endpoint，直到用户完成授权
5. **自动刷新** — pi 在 access_token 过期前自动用 refresh_token 续期

## 与内置 xAI 的区别

|          | pi 内置 `xai`           | 本扩展 `xai-oauth`                                        |
| -------- | ----------------------- | --------------------------------------------------------- |
| 认证方式 | API Key (`XAI_API_KEY`) | OAuth 订阅登录                                            |
| 模型     | 8 个公开 API 模型       | 11 个 fallback + 实时发现（登录后自动同步）               |
| 模型路由 | 固定 `api.x.ai`         | 订阅模型走 `cli-chat-proxy.grok.com`，其余走公开 API      |
| 模型同步 | 需手动升级扩展          | 登录后后台 fetch `/v1/models`，`/reload` 后新模型自动出现 |
| 计费     | API 按量付费            | 走 SuperGrok / X Premium+ 订阅配额                        |
| 安装     | 内置                    | 需手动 `pi install`                                       |

两个 provider 并存，互不冲突。

## 模型列表

- `grok-composer-2.5-fast`（仅订阅）
- `grok-4.5` / `grok-4.3`
- `grok-4.20-0309-reasoning` / `grok-4.20-0309-non-reasoning` / `grok-4.20-multi-agent-0309`
- `grok-3` / `grok-3-fast`
- `grok-build` / `grok-code-fast-1`

全部走 `openai-completions` API。登录后 pi 自动从 `api.x.ai/v1/models` 和
`cli-chat-proxy.grok.com/v1/models` 拉取最新模型列表；新模型出现后 `/reload`
即可使用，无需升级扩展。

### 过滤 / 排序模型

```bash
export PI_XAI_OAUTH_MODELS="grok-build,grok-4.5"
```

逗号分隔、按顺序排列。列表外模型不注册；未知 ID 自动补全默认配置。

## 来源

OAuth 流程移植自 [oh-my-pi](https://github.com/earendil-works/pi-mono) 的 `xai-oauth` provider，
其设备码流程参考 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)（MIT）。
模型发现逻辑移植自 [stnly/pi-grok](https://github.com/stnly/pi-grok)（MIT）。

> OAuth `client_id` 为 public device-flow client（非 secret），与 oh-my-pi / hermes-agent 同源。
> 若 xAI 吊销该 client，需更新扩展内常量。

## License

MIT
