# @piex-dev/xai-oauth

xAI Grok OAuth subscription login for pi. Authenticate with a **SuperGrok** or **X Premium+** subscription instead of an API key.

## 安装

```bash
# 本地路径（开发阶段，推荐绝对路径）
pi install /path/to/piex/packages/xai-oauth

# npm（发布后）
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

| | pi 内置 `xai` | 本扩展 `xai-oauth` |
|---|---|---|
| 认证方式 | API Key (`XAI_API_KEY`) | OAuth 订阅登录 |
| 模型 | 相同 8 个 Grok 模型 | 相同 8 个 Grok 模型 |
| 计费 | API 按量付费 | 走 SuperGrok / X Premium+ 订阅配额 |
| 安装 | 内置 | 需手动 `pi install` |

两个 provider 并存，互不冲突。

## 模型列表

- `grok-3` / `grok-3-fast`
- `grok-4.20-0309-non-reasoning` / `grok-4.20-0309-reasoning`
- `grok-4.3` / `grok-4.5`
- `grok-build-0.1`
- `grok-code-fast-1`

全部走 `openai-completions` API，与内置 xAI provider 模型完全一致。

> 模型字段与 pi 内置 xAI provider 对齐；pi 升级模型列表时需同步本扩展。

## 来源

OAuth 流程移植自 [oh-my-pi](https://github.com/earendil-works/pi-mono) 的 `xai-oauth` provider，
其设备码流程参考 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)（MIT）。

> OAuth `client_id` 为 public device-flow client（非 secret），与 oh-my-pi / hermes-agent 同源。
> 若 xAI 吊销该 client，需更新扩展内常量。

## License

MIT
