# @piex-dev/xai-oauth

xAI Grok subscription models & live discovery for pi. pi 内置 `xai` 自 v0.80.8 起已支持 SuperGrok / X Premium+ 的 OAuth 登录，公开模型（grok-4.5 等）用订阅 token 打 `api.x.ai` 即走订阅配额。但 `grok-composer` 这类订阅专属模型只在 `cli-chat-proxy.grok.com` 上暴露，api.x.ai 的 catalog 里没有，内置访问不到。本扩展补上这条 proxy 路由，并后台实时发现新模型。

## 功能

- 订阅专属模型（`grok-composer-2.5-fast` 等）路由到 `cli-chat-proxy.grok.com`：这些模型只在 proxy 上暴露，api.x.ai 访问不到（与内置 `xai` provider 并存，互不冲突）
- 基于 RFC 8628 Device Authorization Grant 完成授权，不用把密码交给扩展
- 登录后后台拉取双 endpoint `/models`（`api.x.ai` + `cli-chat-proxy.grok.com`），新模型 `/reload` 即可出现，不必等 pi 升级 catalog

## 使用说明

```bash
pi install npm:@piex-dev/xai-oauth
```

```bash
# 1. 在 pi 交互模式中执行
/login

# 2. 选择 "xAI Grok (SuperGrok / X Premium+)"

# 3. 浏览器会自动打开 x.ai 授权页面，确认登录

# 4. 登录成功后，选择模型开始使用
/model grok-4.5
```

过滤 / 排序模型：

```bash
export PI_XAI_OAUTH_MODELS="grok-build,grok-4.5"
```

逗号分隔、按顺序排列。列表外模型不注册；未知 ID 自动补全默认配置。

单测：

```bash
bun test extensions/xai-oauth/test/xai-oauth.test.ts extensions/xai-oauth/test/models.test.ts
```

## 依赖

- `@earendil-works/pi-coding-agent`（peer）
- `@earendil-works/pi-ai`（peer）

## 延伸阅读

- https://piex.dev/zh/packages/xai-oauth/
