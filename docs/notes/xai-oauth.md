---
title: xAI OAuth：用订阅登录 Grok，而不是绑死 API Key
date: 2026-07-19
tags: [xAI, OAuth, Provider]
---

> 若你已为 Grok 订阅付费，`@piex-dev/xai-oauth` 让 pi 走同一套配额；API Key 通道仍留给自动化与按量场景。

## 问题背景

pi 内置的 `xai` provider 走 **API Key**（`XAI_API_KEY`）：按量计费、模型列表相对固定、适合自动化与 CI。

但很多个人用户手里是：

- SuperGrok 订阅  
- 或 X Premium+ 带来的 Grok 额度  

他们已经为订阅付过钱，却还要再开 API Key 走另一套账本，体验割裂。更麻烦的是：订阅侧模型目录会变，扩展若写死列表，用户只能「等发版」。

`@piex-dev/xai-oauth` 做的事：

1. 在 `/login` 里增加 **xAI Grok（SuperGrok / X Premium+）**  
2. 用标准 **设备码 OAuth** 完成授权（不用把密码交给扩展）  
3. 登录后后台发现模型，订阅模型与公开 API 模型分流  
4. 与内置 `xai` 并存，互不抢戏  

```bash
pi install npm:@piex-dev/xai-oauth
```

用法概要：`/login` → 选 xAI Grok → 浏览器确认 → `/model grok-4.5`（或你列表里出现的 id）。

---

## 技术原理

### 1. Device Authorization Grant（RFC 8628）

这是 TV、CLI 常用的「设备码登录」：

```
扩展                         xAI Auth                      用户浏览器
 |                              |                              |
 |-- 请求 device_code --------->|                              |
 |<- user_code + 验证 URL ------|                              |
 |-- 打开 verification_uri_complete -------------------------->|
 |                              |<---- 用户登录并确认 ---------|
 |-- 轮询 token endpoint ------>|                              |
 |<- access_token + refresh ----|                              |
```

特点：

- 扩展是 public client，不持有 client secret（client_id 可公开）  
- 用户在官方页面完成认证，扩展只拿 token  
- access_token 过期前用 refresh_token 续期（pi 的 OAuth 基础设施会配合）

### 2. 两个「门面」：公开 API vs 订阅代理

登录后模型可能来自：

| 通道 | Base URL（概念） | 用途 |
|------|------------------|------|
| 公开 API | `api.x.ai` | 常规 API 模型 |
| 订阅代理 | `cli-chat-proxy.grok.com` | 走订阅配额的 CLI/订阅模型 |

发现阶段会对两边 `/v1/models` 做拉取（可失败降级），再合并进 provider 的模型表。  
**新模型出现后 `/reload` 即可**，不必为了多一个 id 升级 npm 包。

### 3. 与内置 xai 的关系

| | 内置 `xai` | `xai-oauth` |
|--|------------|-------------|
| 认证 | API Key | OAuth 订阅 |
| 计费 | 按量 | 订阅配额 |
| 模型 | 固定公开集 | fallback + 实时发现 |
| 安装 | 内置 | 扩展 |

两者可以同时存在：CI 用 Key，本机交互用订阅。

---

## 实现方案

包路径：[`packages/xai-oauth`](https://github.com/piex-dev/piex/tree/main/packages/xai-oauth)。

```
extensions/xai-oauth.ts   # OAuth 流程 + registerProvider
extensions/models.ts      # 目录、发现、合并、路由
*.test.ts                 # 单元测试（不依赖真网）
```

piex 里**少数带单测**的包之一：`bun test packages/xai-oauth/...`。

### OAuth 关键常量与安全姿态

- Issuer：`https://auth.x.ai`  
- OIDC 发现：`/.well-known/openid-configuration`  
- Device code：`/oauth2/device/code`  
- Scope：含 `openid profile email offline_access` 以及 grok/api access 相关 scope  
- client_id：public device-flow client（与 oh-my-pi / hermes-agent 同源）；若 xAI 吊销需改常量  

安全相关实现要点：

- **错误信息截断**：OAuth 错误体只提取 `error` / `error_description`，限制长度，避免把整包响应（可能含敏感信息）打进日志  
- **端点校验**：仅允许可信主机形态（如 `*.x.ai` 相关），降低 open-redirect / 恶意 endpoint 风险  
- **token 过期 skew**：客户端提前数分钟视为过期，减少边界 401；同时有最小 TTL 地板，防止 skew 把短命 token 直接判死  
- **slow_down**：轮询遇到 slow_down 会加大间隔，遵守授权服务器节奏  

### 模型层（models.ts）

职责拆分：

1. **fallback 目录**：离线/发现失败时仍有一组可用模型 id 与默认元数据  
2. **triggerDiscovery**：登录成功后后台 fetch 两边 models  
3. **rebuildModelsForOAuth**：把发现结果与 fallback 合并，标记路由（订阅代理 vs 公开 API）  
4. **环境变量过滤**：`PI_XAI_OAUTH_MODELS=grok-build,grok-4.5` 可做白名单排序；未知 id 可补默认配置  

全部对话 API 形态按 `openai-completions` 兼容路径接入 pi。

### 来源溯源

- OAuth 设备码流程：oh-my-pi xai-oauth ← hermes-agent（MIT）  
- 模型发现思路：stnly/pi-grok（MIT）  

PieX 的原则是：**可追溯、可替换、不绑死 fork**。

---

## 优化计划

OAuth 扩展活在别人的策略之上，局限要和应对一起看：

1. **强依赖 xAI 侧变更**  
   client_id、endpoint、订阅模型可见性都可能单方面调整。  
   → 保持薄封装 + 快速跟版；OIDC / device code 用契约测试（快照 mock）防回归。

2. **模型发现是 best-effort**  
   网络或权限失败时静默回 fallback，用户常不知道「为什么没有某模型」。  
   → `/models` 或 status 标明来源（discovered / fallback）与路由；把 `PI_XAI_OAUTH_MODELS` 写成一等配置说明。

3. **错误与配额语义偏生**  
   额度用尽、区域限制、token 过期，提示仍可更动作化。  
   → 分错误类给出下一步（重新 `/login`、换模型、检查订阅）。

4. **与内置 `xai` 易混淆**  
   模型 id 可能重叠，会话到底走 Key 还是 OAuth 不够醒目。  
   → UI/status 明确当前 provider 与计费路径。

5. **企业场景未覆盖**  
   Device flow 适合个人 CLI；强制 SSO / 设备管理未必适配。  
   → 个人订阅路径做稳；企业需求单独评估，不硬塞进同一套交互。

凭证侧继续坚持：refresh_token 只走 pi 标准存储，扩展层不落盘、不打完整响应体。
