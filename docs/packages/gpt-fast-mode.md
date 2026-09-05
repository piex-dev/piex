---
title: gpt-fast-mode — Codex Fast 模式，快而不越界
date: 2026-08-26
tags: [OpenAI, Codex, Fast Mode, Extension]
package: gpt-fast-mode
npm: "@piex-dev/gpt-fast-mode"
type: extension
install: pi install npm:@piex-dev/gpt-fast-mode
source: extensions/gpt-fast-mode
---

> 用 `/gpt-fast` 为受支持的 ChatGPT Codex 模型开启 `priority` service tier，同时严格拦住错误 provider、API、认证和模型。

## 简介

OpenAI Codex 的 Fast 模式不是 reasoning level，也不是切换到另一个模型，而是在请求里设置：

```json
{ "service_tier": "priority" }
```

pi 的 `openai-codex-responses` 已能把 `serviceTier` 传成 `service_tier`，但目前没有内置 Fast 控制面。`@piex-dev/gpt-fast-mode` 用公开 Extension API 补上 `/gpt-fast on|off|status`，避免占用过于宽泛的 `/fast` 命令名；`--fast` 可在启动时开启，激活后状态栏显示 `fast`。

Fast 模式通常响应更快，但会更快消耗订阅额度。扩展只改变 service tier，不改变模型、reasoning level、工具或提示词。

## 技术原理

扩展监听 `before_provider_request`，在 provider 已完成序列化、HTTP 请求尚未发送时检查并复制 payload，追加 `service_tier: "priority"`。注入采用六层 fail-closed 门禁：

1. provider 必须是 `openai-codex`；
2. API 必须是 `openai-codex-responses`；
3. 模型必须在显式 allowlist；
4. 必须使用 ChatGPT OAuth；
5. payload 的 `model` 必须与当前模型一致；
6. payload 已有 `service_tier` 时不覆盖。

当前 allowlist：`gpt-5.4`、`gpt-5.5`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-6-astra`。`gpt-5.4-mini` 与 `gpt-5.3-codex-spark` 不在 ChatGPT Codex priority tier 支持范围，因此明确拒绝，不做猜测式兼容。

`session_start` 根据 `--fast` 初始化状态，`model_select` 只重算状态栏，不改变用户开关。用户在不支持的模型上开启后，开关保持 on 但请求不修改；切换到支持模型后自动生效。

## 使用说明

### 安装

```bash
pi install npm:@piex-dev/gpt-fast-mode
```

> 仓库源码：[`extensions/gpt-fast-mode`](https://github.com/piex-dev/piex/tree/main/extensions/gpt-fast-mode)

### 命令

```text
/gpt-fast             切换 Fast 模式
/gpt-fast on          当前会话开启
/gpt-fast off         当前会话关闭
/gpt-fast status      查看开关、当前模型可用性与最近请求结果
```

启动时开启：

```bash
pi --fast
```

状态栏出现 `fast` 表示当前开关已开启、模型通过资格门禁，且本扩展的请求 hook 观测到的 payload 没有 tier 冲突。若其他组件此前已经设置非 `priority` 的 `service_tier`，扩展会保留原值并清除状态。加载顺序更靠后的扩展仍可修改最终 payload，因此 `/gpt-fast status` 报告的是本扩展的注入或观测结果，不代表服务端确认。OAuth 会在每轮和每次请求前重新检查。

### 验证

```bash
bun test extensions/gpt-fast-mode/test/gpt-fast-mode.test.ts
pi -e ./extensions/gpt-fast-mode/src/gpt-fast-mode.ts --fast -p "say hi" --no-session
```

## 实现方案

包路径：[`extensions/gpt-fast-mode`](https://github.com/piex-dev/piex/tree/main/extensions/gpt-fast-mode)，核心为单文件 `src/gpt-fast-mode.ts`。

```text
/gpt-fast / --fast     只维护会话内 enabled 状态
        │
model_select ──────────┼─► eligibility ─► 状态栏 fast / 清除
        │              │
before_provider_request└─► 六层门禁 ─► clone payload + priority
```

实现不注册平行 provider，继续复用 pi 内置 `openai-codex` 的 OAuth 刷新、模型目录和请求传输；不读取 token、不发网络请求、不写配置文件，也没有运行时依赖。已有 `service_tier` 不覆盖，避免和更早执行的 payload hook 争夺已有值；若已有 tier 不是 `priority`，状态栏会清除并由 `/gpt-fast status` 报告冲突。后续 hook 的最终改写不在公开 API 的可观测范围内，因此状态文案不会声称最终请求一定使用 `priority`。

需要说明一个公开 API 边界：`before_provider_request` 只能替换序列化后的 payload，不能设置 provider 内部独立的 `serviceTier` 请求选项。Fast 请求仍会发往 Codex，但当 Codex 把响应 tier 报告为 `default` 或不返回 tier 时，pi 本地 session cost/telemetry 可能仍按标准 tier 估算。订阅额度以后端结果为准。为修正本地估算而覆盖整个 provider 会破坏扩展组合，因此本包不采用该方案。

单测覆盖支持模型集合、mini/Spark 拒绝、provider/API/OAuth 门禁、payload 模型匹配、已有 tier 保留与冲突状态、认证变化、命令/flag、状态栏、模型切换和多会话隔离，共 15 项。

## 设计参考

| 项目                            | 采纳                                             | 未采纳及原因                                               |
| ------------------------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| `@diegopetrucci/pi-openai-fast` | provider/API/OAuth 严格门禁，已有 tier 不覆盖    | 项目/全局配置：本包先保持零文件写入                        |
| `@benvargas/pi-openai-fast`     | on/off/status 语义、`--fast`、显式模型 allowlist | `/fast` 命令名、API-key OpenAI 与状态持久化：超出本包边界  |
| `@tunnckocore/pi-gpt-fast-mode` | 单文件、无依赖、payload hook                     | Codex mini 支持项与当前 catalog 不符；快捷键容易冲突       |
| `pi-openai-codex-fast`          | 使用 `priority` service tier                     | 平行 provider 增加模型重复项，且版本 peer range 与 pi 耦合 |

核心取舍：**安全的窄功能优于通用配置层**。Fast 只是一个请求属性，不值得复制 provider；模型能力变化时显式更新 allowlist，比 `gpt-*` 模糊匹配更可靠。

## 迭代记录

### 路线图

1. 从 pi 模型 catalog 的明确 capability 自动生成 allowlist，前提是上游提供稳定字段。
2. 若存在真实需求，再增加 PieX 标准目录下的默认开关配置；不默认写文件。
3. 结合 `@piex-dev/usage` 在 `/gpt-fast status` 显示 Fast 模式的额度影响，但不耦合两个包。

### 版本记录

| 版本  | 日期       | 变更                                                                                                                                                                           |
| ----- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0.1.0 | 2026-08-26 | 初始版本：`/gpt-fast on\|off\|status`、`--fast`、状态栏与请求冲突指示；仅对 ChatGPT OAuth 的受支持 Codex 模型注入 `service_tier: "priority"`；六层 fail-closed 门禁；15 项单测 |
