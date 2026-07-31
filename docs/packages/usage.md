---
title: usage — 订阅配额实时可见，不再焦虑
date: 2026-07-31
tags: [Usage, Quota, Status Bar, Extension]
package: usage
npm: "@piex-dev/usage"
type: extension
install: pi install npm:@piex-dev/usage
source: extensions/usage
---

> 状态栏实时展示订阅制 coding agent 的用量配额：Kimi 周配额、Grok 周 credits，用完变红，切换模型自动切换。

## 简介

订阅制 coding agent（Kimi For Coding、SuperGrok、GitHub Copilot 等）都有用量配额，但官方查看方式要么打开网页控制台，要么靠记忆。真到 429 报错才发现配额用完了，体验很差。

`@piex-dev/usage` 把可获得的订阅状态直接放到 pi 状态栏：Kimi/Grok/Zhipu/MiniMax 显示百分比 + 重置倒计时，Copilot 显示订阅档位与限流状态，DeepSeek/OpenRouter 显示余额；切换模型自动切换数据源。全自动，零操作。

> Zhipu / MiniMax / OpenRouter 三个适配器从 [cc-switch](https://github.com/farion1231/cc-switch) 的用量/余额查询能力迁移而来（其 `balance.rs` 与 `coding_plan.rs` 服务）；cc-switch 中的 SiliconFlow / StepFun / Novita 余额与火山方舟 AK/SK 签名配额在 pi 没有对应 provider，未迁移。

```text
Usage: 5-Hour:21%🕙3h45 7-Day:26%🕙6d17h                     Kimi / Zhipu / MiniMax
Usage: 7-Day:32%🕙4d3h                                      Grok
Usage: Copilot Pro
Usage: 今¥6.71 7d¥25.81 30d¥147.36 充值余额:¥50,561.12      DeepSeek
Usage: 余额:$37.50                                          OpenRouter
```

## 技术原理

### 数据源：官方 API 的用量接口

两个 provider 都有（未公开但稳定的）用量接口，直接返回配额与重置时间：

| Provider | 接口 | 返回 |
| --- | --- | --- |
| Kimi | `GET https://api.kimi.com/coding/v1/usages` | 周配额（limit/used/remaining/resetTime）+ 滚动窗口限制 |
| Grok | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` | 周 credits 百分比 + 周期起止 |
| Copilot | `copilot_internal/v2/token` | 订阅档位（sku）+ 限流配额（仅受限时非空） |
| DeepSeek | `GET https://api.deepseek.com/user/balance` | 余额（总额/充值/赠送），API key 认证 |
| DeepSeek 消费 | `platform.deepseek.com/api/v0/usage/cost`（需 `DEEPSEEK_PLATFORM_TOKEN`） | 今天 / 7 天 / 30 天消费（官方计费） |
| Zhipu（智谱） | `GET {open.bigmodel.cn\|api.z.ai}/api/monitor/usage/quota/limit` | 5 小时 + 周窗口配额（百分比），API key 认证（**不加 Bearer 前缀**） |
| MiniMax | `GET https://api.minimaxi.com\|io/v1/api/openplatform/coding_plan/remains` | 5 小时 + 周窗口配额（剩余百分比反转） |
| OpenRouter | `GET https://openrouter.ai/api/v1/credits` | credits 余额（total − usage），低于 $10 黄 / $2 红 |

### Copilot 的能力边界

GitHub Copilot **没有公开的用量余额接口**（`/users/{login}/settings/billing/ai_credit/usage` 需要 `copilot` scope 的 OAuth app，Copilot API 无 usage 端点）。官方 token 接口（`copilot_internal/v2/token`）能给出的只有：**订阅档位（sku）** 与 **限流配额（limited_user_quotas，仅被限流时非空）**。因此 Copilot 适配器展示档位徽标（`Copilot Pro` / `Copilot Free(OSS)`），被限流时显示红色 `limited` + 重置倒计时——这是接口极限，没有百分比余额。限流探测 best-effort 只读 pi 的 auth.json 中 GitHub OAuth token（遵循 `PI_CODING_AGENT_DIR`），只用于请求官方 token 接口，不写入也不记录 token。

### DeepSeek 消费统计（官方计费）

DeepSeek 的按日消费接口（`platform.deepseek.com/api/v0/usage/cost`）**只接受浏览器登录 token**（API key 返回 `invalid token`）。配置 `DEEPSEEK_PLATFORM_TOKEN`（登录 platform.deepseek.com 后从 DevTools 任意 `api/v0` 请求的 `Authorization` 头复制）即可展示官方实际计费：今天 / 7 天 / 30 天 + 近 7 天每日明细。token 为登录态（几天到几周），失效时状态栏显示 `token失效` 并降级为仅余额；未配置时只展示余额。

### 凭据：pi 自动刷新 OAuth token

扩展通过 `ctx.modelRegistry.getProviderAuth(provider)` 拿 token——pi 会在 OAuth token 过期时自动刷新并写回，扩展不碰 refresh 流程，也不落盘任何密钥。

### 按模型门控显示

`session_start` / `model_select` 时检查 `model.provider`：只有注册了 adapter 的 provider 才展示配额，其它模型立即清除状态栏，避免无关噪音。

### 实时刷新三层

1. **事件驱动**：每次 `turn_end` 后立即刷新（用完即见）
2. **后台轮询**：默认 300s 一次（`USAGE_POLL_SECONDS` 可调）
3. **本地倒计时**：30s 一次重算倒计时，只重渲染不请求 API

## 使用说明

### 安装

```bash
pi install npm:@piex-dev/usage
```

> 仓库源码：[`extensions/usage`](https://github.com/piex-dev/piex/tree/main/extensions/usage)

### 用法

零操作：选中 Kimi / Grok 模型即自动展示，切走自动清除。

```bash
/usage    # 手动刷新 + 显示详情（配额、重置时间、并发、会员等级）
```

### 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `USAGE_POLL_SECONDS` | `300` | API 轮询间隔（秒） |
| `USAGE_SHOW_XAI_MONTHLY` | 未设置 | 设为 `1` 显示 Grok 月度 unified billing 用量（官网不展示该口径，默认隐藏） |

### 验证

```bash
pi -e ./extensions/usage/src/usage.ts -p "say hi" --no-session
```

## 实现方案

包路径：[`extensions/usage`](https://github.com/piex-dev/piex/tree/main/extensions/usage)，`src/adapters.ts`（数据源适配器）+ `src/usage.ts`（事件编排）约 440 行。

### 适配器架构

```text
src/adapters.ts                  src/usage.ts
┌────────────────────┐           ┌──────────────────────┐
│ QuotaAdapter 接口  │           │ model_select /       │
│  ├─ kimiAdapter   │◄─匹配─────│  session_start 门控   │
│  └─ xaiAdapter    │           │ turn_end 触发刷新     │
│  providerIds      │           │ 轮询 + 倒计时 ticker  │
└────────────────────┘           │ /usage 命令          │
                                 └──────────────────────┘
```

新增 provider 只需实现 `QuotaAdapter`（`providerIds` + `fetch`），事件接线零改动。

### 渲染格式

```text
<窗口标签>:<用量百分比>%🕙<重置倒计时>
```

- 用量 ≥ 90% 红色、≥ 70% 黄色
- 倒计时格式：`6d17h`（天级）/ `3h45`（小时级）/ `45m`（分钟级）

### 关键细节

- **Bearer 去重**：`getProviderAuth` 返回的 header 已含 `Bearer` 前缀，统一剥离后由 adapter 拼接，避免 `Bearer Bearer` 双前缀（xAI 严格拒绝）
- **Grok 双 provider**：`xai` / `xai-oauth` 两个 provider id 都匹配，token 按序 fallback
- **容错**：接口字段可能随官方改版变化，解析失败显示 `<label>: offline` 并在下轮自动重试；Grok 月度接口为 best-effort，失败不影响主展示

## 设计参考

| 项目 | 机制 | piex 取舍 |
| --- | --- | --- |
| **官方控制台** | 网页查看配额，需手动打开 | **状态栏常驻**：用量 + 倒计时实时可见，429 前提前预警 |
| **kimi-code-usage 等社区工具** | CLI/MCP 查询，需手动执行 | **事件驱动**：turn_end 即刷新，零操作 |
| **pi 内置 footer 用量段** | 展示 token 消耗/成本（session 内） | **并存**：usage 展示订阅配额（账户级），两者互补 |

核心取舍：账户级配额优先于 session 级消耗（配额用尽才是硬中断），状态栏常驻优先于命令查询（可感知才可预防）。

## 迭代记录

### 路线图

1. **更多 provider**：Claude 订阅（`api.anthropic.com/api/oauth/usage`）、Codex（`wham/usage`）走同一 adapter 接口即可接入。
2. **阈值自定义**：`USAGE_WARN_RATIO` / `USAGE_ERROR_RATIO` 环境变量化。
3. **用量趋势**：本地记录每次快照，状态栏切换显示「较上次 -2%」。
4. **窗口明细可折叠**：多个滚动窗口时默认只显示最紧的，详情页看全量。

### 版本记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| 0.1.0 | 2026-07-31 | 初始版本：Kimi（周配额 + 滚动窗口）+ Grok（周 credits）状态栏实时展示；按模型门控；turn_end + 300s 轮询 + 30s 倒计时三层刷新；`/usage` 详情命令；`USAGE_SHOW_XAI_MONTHLY` 可选月度展示 |
