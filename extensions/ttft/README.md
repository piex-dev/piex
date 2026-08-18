# @piex-dev/ttft

Per-turn **TTFT** and decode **throughput** in the pi status bar: the latency signals from [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), reimplemented on pi's public Extension API. Session cache-hit statistics (cumulative + per-turn) are computed too, shown in `/ttft` detail.

```
TTFT 1.2s · 45.3t/s
```

| Metric | Meaning | Source |
| --- | --- | --- |
| `TTFT 1.2s` | Time to first token of the latest turn (live once the first token arrives) | `turn_start.timestamp` → first `message_update` |
| `45.3t/s` | Decode throughput of the latest turn, painted when the stream completes (before tools run) | decode wall time ÷ `usage.output` |
| `cache 82%` (in `/ttft`) | **Session-cumulative** prompt cache hit rate | `cacheRead / (input + cacheRead + cacheWrite)` |

## Install

```bash
pi install npm:@piex-dev/ttft

# Local dev
pi -e ./src/ttft.ts
```

No configuration. Metrics appear automatically after the first turn and are persisted per turn via `pi.appendEntry("ttft", …)`, so `/resume` restores the full history.

## Commands

```bash
/ttft    # session avg TTFT, token totals, cumulative cache rate,
         # per-turn table: TTFT, tokens/s, output tokens, per-turn cache rate
```

## How it works

- **TTFT**: `turn_start` carries pi's request timestamp; the first `message_update` for the assistant message is the first streamed token. The difference is painted to the status bar immediately and stays fixed for the turn.
- **Throughput**: decode wall time (first token → last stream update) over `usage.output`, painted the moment the stream completes (`message_end` carries usage **before** tools run), so the bar is not stuck at TTFT-only during tool execution. Bursty deliveries never claim a rate: samples below 200ms, or shorter than half the TTFT (a buffering gateway replaying 1000 tokens in 0.9s after a 22s wait would read as an impossible "1147 t/s"), are marked `buffered` in `/ttft` and shown without t/s.
- **Cache hit rate**: the four disjoint usage buckets (`input` / `output` / `cacheRead` / `cacheWrite`) are folded into session totals on every `turn_end` and rebuilt from assistant/toolResult-message entries on `session_start`, the same accumulation deepseek-harness's `TokenTotals` uses. It stays out of the status bar because pi's built-in footer already shows the latest turn's `CHxx.x%`; two cache numbers on one bar would collide. The cumulative rate lives in `/ttft`.
- **Persistence**: each settled turn appends a custom `ttft` entry; `session_start` rebuilds history from those entries, keeping numbering across `/resume` and `/fork`.
- **Multi-session safe**: pi runs several sessions in one process; state is rebuilt per `session_start` and stale-session events are ignored.

## Differences from deepseek-harness

| Aspect | deepseek-harness | @piex-dev/ttft |
| --- | --- | --- |
| TTFT anchor | Internal `timing.stepStartTime` (step start) | `turn_start.timestamp`, end-to-end, includes prompt assembly |
| Cache rate display | TUI footer `cache N%` (session cumulative) | `/ttft` detail (session cumulative + per-turn); the status bar shows only TTFT/t/s |
| Throughput | Window-scoped fold over timed steps | Per-turn decode sample + session history |
| Persistence | Durable session projection | `pi.appendEntry("ttft", …)` custom entries |
| Scope | Whole TUI stats strip (turns/steps, LLM/tool durations) | Latency only on the bar; token counts, cost and latest-turn `CH%` stay in pi's built-in footer |

> Deep-dive (Chinese): [https://piex.dev/zh/packages/ttft/](https://piex.dev/zh/packages/ttft/)
