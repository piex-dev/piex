# @piex-dev/xai-oauth

xAI Grok OAuth subscription login for pi. Authenticate with a **SuperGrok** or **X Premium+** subscription instead of an API key.

## 功能

- 在 pi `/login` 中增加 xAI Grok（SuperGrok / X Premium+）选项
- 基于 RFC 8628 Device Authorization Grant 完成授权，不用把密码交给扩展
- 登录后后台发现模型，订阅模型与公开 API 模型分流
- 与内置 `xai` provider 并存，互不冲突

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
