# @piex-dev/gpt-fast-mode

Enable OpenAI Codex **Fast mode** from pi with `/gpt-fast`, without changing the selected model or reasoning level. The extension injects `service_tier: "priority"` only for supported ChatGPT-auth Codex requests.

## Install

```bash
pi install npm:@piex-dev/gpt-fast-mode

# Local development
pi -e ./extensions/gpt-fast-mode/src/gpt-fast-mode.ts
```

## Commands and flag

```text
/gpt-fast             Toggle Fast mode
/gpt-fast on          Enable it for this session
/gpt-fast off         Disable it for this session
/gpt-fast status      Show mode, eligibility, and the last request outcome
```

Start a session with Fast mode enabled:

```bash
pi --fast
```

The `fast` status appears while the switch is enabled, the current model is eligible, and the payload observed by this extension's request hook has no tier conflict. A non-`priority` `service_tier` already set by another component is preserved and clears the status. Hooks from extensions loaded later can still change the final payload, so `/gpt-fast status` reports this extension's injection or observation rather than server confirmation. Authentication is rechecked before each turn and request. Enabling Fast mode on an unsupported model keeps the preference on but does not modify requests; switching to a supported model activates it automatically.

## Supported models

Fast mode is deliberately fail-closed:

| Provider       | Models                                                               | Authentication |
| -------------- | -------------------------------------------------------------------- | -------------- |
| `openai-codex` | `gpt-5.4`, `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | ChatGPT OAuth  |

`gpt-5.4-mini` and `gpt-5.3-codex-spark` are not included because the ChatGPT Codex catalog does not advertise priority tier support for them.

## Safety and behavior

Before modifying a request, the extension verifies all of the following:

1. provider is `openai-codex`;
2. API is `openai-codex-responses`;
3. model is on the explicit allowlist;
4. authentication is OAuth;
5. serialized payload model matches the selected model;
6. payload does not already contain `service_tier`.

It has no runtime dependencies, makes no network calls, stores no credentials, and writes no files. Fast mode requests can consume subscription quota faster. Fast mode is independent from pi's reasoning level.

> **Cost estimate limitation:** pi's public `before_provider_request` hook can replace the serialized payload but cannot set the provider's separate `serviceTier` request option. The Fast request still reaches Codex, but when Codex reports `service_tier` as `default` or omits it, pi's local session cost/telemetry may use standard-tier estimates. Backend subscription quota remains authoritative.

## Upstream differences

| Reference                       | Adopted                                                     | Not adopted                                      |
| ------------------------------- | ----------------------------------------------------------- | ------------------------------------------------ |
| `@diegopetrucci/pi-openai-fast` | strict provider/API/OAuth gates; preserve existing tier     | project/global config                            |
| `@benvargas/pi-openai-fast`     | on/off/status semantics; `--fast`; explicit model allowlist | `/fast` name; API-key OpenAI; persistent writes  |
| `@tunnckocore/pi-gpt-fast-mode` | small, dependency-free payload hook                         | unsupported Codex mini entry; keyboard shortcut  |
| `pi-openai-codex-fast`          | `priority` through pi's native Codex transport              | separate provider and version-coupled peer range |

The result stays focused on the existing `openai-codex` provider instead of registering a parallel provider.

> Deep-dive (Chinese): [https://piex.dev/zh/packages/gpt-fast-mode/](https://piex.dev/zh/packages/gpt-fast-mode/)
