# TradingView research + paper execution

Three layers, deliberately separated:

- **`research/`** — tests hypotheses and measures edge. **Cannot place orders.**
- **`execution/`** — reads charts and places paper orders, behind a risk gate.
- **`frontend/`** — the command centre. Reads the evidence, spawns the CLIs,
  streams state over SSE. It sees both layers and merges neither.

TradingView is the **eyes**, not the hands.

Read [`AGENT.md`](./AGENT.md) for operating instructions. Read
[`strategies/PLAYBOOK.md`](./strategies/PLAYBOOK.md) before writing a hypothesis.
This file is the human-facing overview; [`strategies/`](./strategies/) is the
knowledge base of what we have tried and what it taught us.

---

## Setup

Everything below is one prompt. Paste it into your agent (OpenCode, Claude Code,
or anything with shell access) from the repo root. It installs the MCP server,
registers it with whichever harness you're running, launches TradingView, and
proves the whole stack works before it hands back.

```
Set up this repository end to end. Work from the repo root and do not guess —
run each step, read its output, and stop and report if a step fails.

1. Confirm the toolchain.
   - node --version must be >= 20 (this repo has zero runtime dependencies).
   - If not, stop and tell me which Node version to install. Do not install it.

2. Install the TradingView MCP server globally, pinned:
     npm i -g tradingview-mcp@1.0.1
   Both the server and the TradingView Desktop build it bundles (38.2.2) are
   pinned deliberately: this repo drives undocumented internal TradingView APIs
   that break without notice.

3. Resolve the server entry point. Do not hardcode a path:
     npm root -g
   The entry point is <that output>/tradingview-mcp/src/server.js. Confirm the
   file exists before writing any config.

4. Detect which agent harness I am running, then register the MCP server in
   that harness's config, merging rather than overwriting the existing file:
     - OpenCode   -> ~/.config/opencode/opencode.jsonc  (key: mcp.tradingview)
     - Claude Code-> ./.mcp.json                        (key: mcpServers.tradingview)
   Entry to write, with the resolved path substituted:
     { "type": "local",
       "command": ["node", "<resolved path to tradingview-mcp/src/server.js>"],
       "enabled": true,
       "timeout": 120000 }
   The 120s timeout is required: a cold TradingView start exceeds the default.
   If both configs exist, write to the one matching the running harness and tell
   me which you chose. Preserve every other server already in the file. Back the
   file up before editing it.

5. Launch TradingView with the DevTools Protocol and guarantee a chart tab:
     npm run tv:launch
   Both halves are required and the second is the one that gets forgotten — see
   the two traps below. This step is expected to take up to 30 seconds.

6. Prove the MCP server answers, without needing a chart:
     npm run mcp:handshake
   Expect "78 tools" and YES on all eight key tools. If the server path cannot be
   resolved, the global install in step 2 did not land.

7. Prove the repo itself is sound:
     npm run verify
   Expect 17 passed, 0 failed: 8 selftests plus 9 architectural invariants,
   including 422 checks over the 15 strategy cards. Any failure here is a real
   defect — report it, do not work around it.

8. Optional:  npm run web
   Starts the command centre on http://127.0.0.1:7878. Zero dependencies,
   node:http only. It reads the evidence files and spawns the CLIs — it does not
   place orders, and it does not need TradingView running.

9. Optional, and slow — only if I ask:  npm run research:all
   Fetches ~17 MB of cached OHLCV for 5 symbols. Say how long it will take
   before starting.

Then report back, in this order:
  a. the Node version and the resolved tradingview-mcp path
  b. which harness config you edited, and the exact entry you wrote
  c. the mcp:handshake and verify result lines
  d. anything that failed, with the error text

Do not attempt a paper order. Do not run anything in execution/ beyond what is
written above. Finally, tell me I must restart my agent session before the new
MCP server appears in the tool list.
```

### The two traps

Both are why `npm run tv:launch` is a script and not a command you type by hand.

1. **CDP alone is not enough.** TradingView must be running with
   `--remote-debugging-port=9222` **and** have a real chart tab open. On startup
   the app restores your last tab; if that saved layout was deleted server-side
   it 404s and shows an error page. The MCP then attaches to the error renderer
   and *every* tool reports `api_available: false` with no error of its own.
   `launch-tv.ps1` handles both halves.
2. **`tv scroll` and `tv range` (get) are broken** in `tradingview-mcp@1.0.1`
   (`"evaluate is not defined"`). Only `range --from --to` works.

Also: the new-tab search box searches your **saved layouts**, not symbols.

### Manual equivalent

If you'd rather not hand an agent your shell, the same five commands are:

```bash
npm i -g tradingview-mcp@1.0.1
npm root -g                                    # -> the server path to register
npm run tv:launch
npm run mcp:handshake
npm run verify
```

Register the server with your harness by hand — OpenCode wants
`~/.config/opencode/opencode.jsonc`, Claude Code wants `./.mcp.json` — using the
JSON block in step 4 of the prompt above, then restart the agent.

---

## Verify everything

```bash
npm run verify
```

Runs 8 selftests (including 422 checks over the 15 strategy cards) and 9
architectural invariants, including `research/ never imports execution/`,
`research/ cannot reach TradingView`, and — the one that matters — every tested
strategy card reconciled against its actual run record.

## The pipeline

```
Agent ──{side, thesis}──▶ Risk Engine ──▶ Risk Gate ──▶ Execution ──▶ TradingView
                            (pure, ATR-sized)  (pure, pre-click)     (only impure part)
```

The signal decides **direction only**. Size, stop and leverage are computed by
the risk engine, which is the same code the backtest uses. The gate runs before
any click; if it blocks, nothing is clicked.

## Layout

```
package.json     verify.mjs     AGENT.md     README.md
config/          risk.json, audit.jsonl (git-ignored, created on demand)
research/        data, risk-engine, harness, gate, run, leakage, events,
                 regime-audit, protocol, registry, strategies/, data/
                 EVALUATION_PROTOCOL.md — why the frozen thresholds are what
                 they are, beside the protocol.v1.json the gate actually reads
execution/       paper-trade, launch-tv.ps1, ensure-chart, mcp-handshake
frontend/        server.mjs + lib/ + worker/ — the command centre
                 (node:http, zero deps; `npm run web` → 127.0.0.1:7878)
strategies/      the knowledge base — 15 cards: 11 falsified (2 of them
                 negative controls), 1 queued, 1 proposed, 2 blocked,
                 0 champion (there is none)
```

`config/audit.jsonl`, `research/registry/state.json` and `frontend/data/` are
git-ignored on purpose: all three are runtime state, and none of it is evidence.
The run records in `research/registry/*/runs.jsonl` *are* evidence and are
tracked.

## The knowledge base

Every hypothesis — tested, proposed, or blocked — is a markdown **card** under
[`strategies/cards/`](./strategies/). Code lives in `research/strategies/`;
knowledge lives in `strategies/`. A strategy file is thirty lines of arithmetic
and cannot hold *why* a rule exists or *when* it should be trusted.

`strategies/validate.mjs` enforces the format and runs in `npm run verify`, so
the rules are checked rather than merely written down. A card that misquotes its
own result fails the build.

```bash
node strategies/validate.mjs     # 422 checks across 15 cards
```

Start with [`strategies/PLAYBOOK.md`](./strategies/PLAYBOOK.md) (how to think),
then [`strategies/BACKLOG.md`](./strategies/BACKLOG.md) (what to test next), then
[`strategies/cards/proposed/`](./strategies/cards/proposed/) (the frontier).

## Research findings

Data: **BTC · ETH · DOGE · SOL · ZEC · 15m · 400 days · 38,401 bars each · 0 gaps**
(192,005 bars, Binance). One dataset, one hash, one protocol hash.

Hypotheses were written as numbers, not concepts. E.g.:

```
IF   bar.high  > max(high of previous 20 bars)     took liquidity
AND  bar.close < that prior high                   rejected it
AND  bar.volume > 2.0 * mean(volume of last 50)   participation
THEN short next bar
```

Every row is the latest run in `research/registry/<id>/runs.jsonl`. `t` is the
Sharpe t-statistic — the number that says whether the sample supports the point
estimate beside it.

| strategy | trades | PF | Sharpe | t | maxDD% | return% | unmet | gate |
|---|---|---|---|---|---|---|---|---|
| sma-cross | 1984 | 1.013 | −0.023 | −1.02 | 82.8 | −99.4 | 20 | fail |
| trend-pullback | 1557 | 0.972 | −0.016 | −0.63 | 82.6 | −99.3 | 19 | fail |
| donchian | 1645 | 0.917 | −0.044 | −1.78 | 82.1 | −99.6 | 19 | fail |
| vol-normalized-breakout ³ | 2583 | 0.935 | −0.038 | −1.93 | 84.0 | −99.6 | 18 | fail |
| long-with-stop ¹ | 2278 | 0.837 | −0.028 | −1.34 | 83.0 | −99.8 | 20 | fail |
| sweep-reversal | 1565 | 0.641 | −0.138 | −5.46 | 80.3 | −99.9 | 20 | fail |
| vol-expansion | 686 | 0.691 | −0.076 | −1.99 | 80.0 | −95.2 | 20 | fail |
| sideways-liquidity-reversal ² | 165 | 0.355 | −0.260 | −3.34 | 45.9 | −81.9 | 20 | fail |
| *control: always long* | *2278* | *0.837* | *−0.028* | *−1.34* | *83.0* | *−99.8* | *20* | *fail* |
| *control: random* | *2270* | *0.751* | *−0.057* | *−2.72* | *81.4* | *−99.9* | *21* | *fail* |

¹ `long-with-stop` is a strict duplicate of the `always long` control — same
`{ side: "buy" }` on every flat bar, identical metrics. It is not a distinct
hypothesis, which is why the tested count is seven and not eight.

² `sideways-liquidity-reversal` trades 165 times, so it fails the ≥500 minimum
on sample size alone. Its t is the worst in the table *and* the most honest:
after de-clustering, the trailing-window statistic it was built on measured
t = −1.38, not the +8.99 the raw overlapping samples claimed (AGENT.md §6.14).

³ `vol-normalized-breakout` (P-002) has the **fewest unmet criteria in the
table — 18 — and still fails.** That is the most informative row here. It is not
a new trigger: the trigger is donchian's and the exit is the protocol's, and the
only change is the denominator a price distance is divided by. Normalising the
units of a breakout and changing the breakout both look like progress on a
PF of 0.9. Neither is.

**No demonstrated edge.** Sharpe −0.26 to −0.016 across ~11,000 trades is a large
sample measuring approximately zero.

**The two italic rows are the important ones.** They are negative controls — a
signalless long and a random side — and they score **PF 0.837 and 0.751**, not
1.0, because 15 bps per round trip is charged on both sides of a churn-heavy
stream. That band, not 1.0, is the line a real edge has to clear. So the best
hypothesis here, `sma-cross` at 1.013, is **0.18 above a coin flip**, with a
t-stat of −1.02 that cannot distinguish the two.

The drawdowns are a consequence of a 1%-risk, 10x-leverage envelope applied to
a zero-expectancy signal: negative expectancy compounds to ruin. Read the
profit factor for the signal and the drawdown for the envelope, never the
reverse.

## The gate

`research/gate.mjs`, reading thresholds from the frozen
`research/protocol.v1.json`. Nothing is an edge until it clears all 21:

| Criterion | Bar | What it prevents |
|---|---|---|
| trades | ≥ 500 | conclusions from a handful of trades |
| symbols | ≥ 5 | one lucky instrument |
| directional regimes | ≥ 3 of bull/bear/sideways | a strategy that only works while the market does one thing |
| volatility regimes | ≥ 2 of high/low | ditto, on the axis that actually drives intraday behaviour |
| profit factor | > 1.3 | one outsized winner carrying the rest |
| Sharpe | > 1.0 | — |
| **Sharpe t-stat** | > 2.0 | a big Sharpe the sample cannot support |
| **Sharpe LCB (95%)** | > 0.3 | a big Sharpe *estimated from few trades* |
| max drawdown | < 35% | — |
| walk-forward consistency | ≥ 50% | tuning to the sample |
| P(dd ≥ 20%) | < 25% | surviving only the lucky orderings |
| holdout trades | ≥ 60 | conclusions from an empty test window |
| holdout Sharpe | > 0.5 | in-sample-only edge |
| degradation (test ÷ train) | ≥ 0.25 | an edge that evaporates out of sample |
| parameter sensitivity | ≥ 30% of grid profitable | a spike that only exists at one exact setting |
| cost survival | ≥ 40% of the cost grid | an edge that dies at 2× fees |
| max survivable cost | ≥ 25 bps (fee+slip) | ditto |
| symbols passing on their own merits | ≥ 60%, and ≥ 2 | a single-symbol coincidence |
| calmar vs regime-matched hold | must beat holding | buying risk, not edge |
| per-regime vs holding | must not be beaten anywhere it trades | a bull-window artefact |
| survived | account must not be ruined | trading on from a wiped account |

Directional and volatility regimes are separate axes on purpose: a single
trend-based label files a choppy-market strategy as "sideways" and fails it for
the wrong reason.

The full reasoning, and the five ways a backtest lies that each criterion
targets, is in [`research/EVALUATION_PROTOCOL.md`](./research/EVALUATION_PROTOCOL.md).
The JSON is the source of truth — if the two ever disagree, the JSON wins and
the prose is stale.

## What is not proven

- Any strategy is profitable
- That these results generalise beyond one 400-day window
- That a passing strategy would survive live execution

The platform is the deliverable. All six distinct tested hypotheses are
falsified — plus P-001, killed at the measurement stage before a line of trading
code was written — and the two controls confirm the instrument would have caught
a false positive.

## The next move

v1 is **frozen and stays frozen**. It is a discovery filter, not a scoreboard,
and the milestone is *one hypothesis that survives v1* — not a passing
indicator sweep.

Two cards have been closed without ever writing a strategy, which is the shape
this backlog is starting to take:

- **P-001, serial-correlation sign flip** — one self-agreement statistic killed
  it in about a minute of compute. No P&L, no exit model, no costs.
- **P-002, vol-normalized breakout** — got all the way to a full gate run and
  still missed 18 criteria, the fewest of any card here. Normalising the units
  of a breakout is not the same as changing the breakout.

Next is
[P-003, selectivity on a falsified trigger](./strategies/cards/proposed/selectivity-on-falsified-trigger.md).

## Paper trading

```powershell
npm run tv:launch
node execution/paper-trade.mjs propose buy DOGEUSD --thesis "..." --dry-run
```

Governed by `config/risk.json`; every action and refusal lands in
`config/audit.jsonl`. Set `"kill_switch": true` to stop everything — that is the
fastest stop available.

Cancelling is **manual** — the order line is canvas-drawn and probing for it is
unsafe. Two clicks: the order line's `x`, then **Cancel order**.

## Compatibility

Drives undocumented internal TradingView APIs that break without notice. Both
`tradingview-mcp` (1.0.1) and TradingView Desktop (38.2.2) are pinned for that
reason. Node ≥ 20. Windows and macOS are the tested platforms; the DevTools
port is 9222.

TradingView's ToU restricts automated data collection. Personal, educational
and research use only. Do not redistribute data obtained through this.
