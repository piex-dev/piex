# @piex-dev/usage

Real-time **subscription quota** in the pi status bar for providers you use on a subscription. Shown **only while the active model belongs to that provider** — switching to another provider clears the status. Fully automatic: no commands needed.

```
Kimi:  5-Hour:21%🕙3h45 7-Day:26%🕙6d17h
Grok:  7-Day:32%🕙4d3h
```

| Provider | Credential | Data source |
| --- | --- | --- |
| Kimi For Coding (`kimi-coding`) | OAuth or `KIMI_API_KEY` | `GET https://api.kimi.com/coding/v1/usages` |
| xAI Grok SuperGrok (`xai` / `xai-oauth`) | OAuth (built-in `xai` login or [@piex-dev/xai-oauth](https://github.com/piex-dev/piex/tree/main/extensions/xai-oauth)) | `GET https://cli-chat-proxy.grok.com/v1/billing` |

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

- Quotas are measured in **requests** (Kimi weekly/window) or **percentages** (Grok credits), not tokens or money.
- Kimi monthly membership credits are web-console only (not exposed by the API) and are not shown.
