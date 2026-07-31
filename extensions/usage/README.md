# @piex-dev/usage

Real-time **subscription quota** in the pi status bar for providers you use on a subscription. Shown **only while the active model belongs to that provider** — switching to another provider clears the status. Fully automatic: no commands needed.

```
Usage: 5-Hour:21%🕙3h45 7-Day:26%🕙6d17h
Usage: 7-Day:32%🕙4d3h
Usage: Copilot Pro
Usage: 今¥6.71 7d¥25.81 30d¥147.36 充值余额:¥50,561.12
```

| Provider | Credential | Data source |
| --- | --- | --- |
| Kimi For Coding (`kimi-coding`) | OAuth or `KIMI_API_KEY` | `GET https://api.kimi.com/coding/v1/usages` |
| xAI Grok SuperGrok (`xai` / `xai-oauth`) | OAuth (built-in `xai` login or [@piex-dev/xai-oauth](https://github.com/piex-dev/piex/tree/main/extensions/xai-oauth)) | `GET https://cli-chat-proxy.grok.com/v1/billing` |
| GitHub Copilot (`github-copilot`) | OAuth (`/login` → GitHub Copilot) | `copilot_internal/v2/token` (SKU + limited-user quota) |
| DeepSeek API (`deepseek`) | `DEEPSEEK_API_KEY` (+ `DEEPSEEK_PLATFORM_TOKEN` for official spend) | `GET https://api.deepseek.com/user/balance` · `platform.deepseek.com/api/v0/usage/cost` |

## Install

```bash
pi install npm:@piex-dev/usage

# Local dev
pi -e ./src/usage.ts
```

Requires the provider credential configured in pi (`/login` → Kimi Code / xAI Grok, or the matching API key).

## How it works

- **Model-gated display**: on `session_start` / `model_select` the extension checks `model.provider`; only providers with an adapter show quota, everything else clears the status bar.
- **Credential**: `ctx.modelRegistry.getProviderAuth(provider)` — resolves OAuth access tokens or API keys; pi auto-refreshes expired OAuth tokens.
- **Refresh**: immediately after every turn (`turn_end`), plus a background poll (default 300s, `USAGE_POLL_SECONDS` to override) and a 30s local countdown ticker that re-renders without hitting the API.
- **Resilience**: undocumented endpoints may change — a failed fetch shows `<label>: offline` and retries on the next cycle. xAI monthly unified billing (`USAGE_SHOW_XAI_MONTHLY=1`) is off by default — the official console does not show that figure.

## Commands

| Command | Description |
| --- | --- |
| `/usage` | Force refresh and show details (limits, reset times, concurrency/membership level) |

## Adding a provider

Drop a new adapter in `src/adapters.ts` implementing `QuotaAdapter` (`providerIds`, `fetch`) and it lights up automatically — no changes to the event wiring.

## Notes

- Quotas are measured in **requests** (Kimi weekly/window), **percentages** (Grok credits), or **money balance** (DeepSeek, warn below ¥20 / red below ¥5).
- Copilot has **no public balance endpoint** (billing API requires a `copilot`-scoped app) — the extension shows the subscription SKU (`Pro` / `Pro+` / `Free(OSS)`) and a red `limited` marker with reset countdown when GitHub rate-limits the account. The limited-state check reads pi's GitHub OAuth token from auth.json (honors `PI_CODING_AGENT_DIR`) only to call the official token endpoint; it never writes or logs the token. Grok monthly unified billing is off by default (`USAGE_SHOW_XAI_MONTHLY=1`).
- DeepSeek spend (today / 7d / 30d) comes from the **official billing API** (`platform.deepseek.com/api/v0/usage/cost`) via `DEEPSEEK_PLATFORM_TOKEN` (login to platform.deepseek.com → DevTools → any `api/v0` request → `Authorization` header). Without it, only the balance shows; an expired token degrades to balance-only with a warning.
- Kimi monthly membership credits are web-console only (not exposed by the API) and are not shown.
