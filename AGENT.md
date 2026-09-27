# AGENT.md — operating instructions

Everything an agent needs to work in this repo. **Keep this file current.**
If you learn something that would have cost you time, add it here in the same
change that taught you it.

---

## 1. What this system is

Two layers that must never be confused:

| | Layer | Purpose | Can it trade? |
|---|---|---|---|
| **Research** | `research/` | test hypotheses, measure edge | **No — enforced** |
| **Execution** | `execution/` | read charts, place paper orders | Yes, behind a risk gate |

```
Agent ──{side, thesis}──▶ Risk Engine ──▶ Risk Gate ──▶ Execution ──▶ TradingView
                            (pure, ATR-sized)   (pure, pre-click)      (only impure part)
```

In research, a signal is a pure function and there is no path to an order:

```
signal(bar, ctx) ──▶ Risk Engine ──▶ Simulator ──▶ Metrics ──▶ Gate verdict
```

`verify.mjs` enforces that `research/` never imports `execution/` and can never
reach TradingView. It is not a convention — it is a failing test.

## 2. First commands

```bash
npm run verify          # all selftests + architectural invariants  (17 checks)
npm run test:gate       # gate rules only
npm run research:all    # every strategy × 5 symbols × 15m, then the gate
```

**Run `npm run verify` before you claim anything works.**

## 3. Layout

```
package.json          scripts only, zero runtime deps
verify.mjs            single command proving repo state
AGENT.md              this file
README.md             human-facing overview + setup prompt + research findings
config/
  risk.json           limits for the risk engine and the execution gate
  audit.jsonl         append-only log of every action and refusal
                      (git-ignored runtime state; verify.mjs creates it)
research/
  data.mjs            OHLCV providers (binance, yahoo) + gap audit
  risk-engine.mjs     ATR sizing — PURE, shared by backtest AND live
  harness.mjs         simulator, metrics, monte carlo, walk-forward
  gate.mjs            regime labelling + the research gate
  run.mjs             CLI: run strategies, hold them to the gate
  leakage.mjs         lookahead / warmup / append-invariance audit
  events.mjs          event-outcome measurement vs an unconditional baseline
  regime-audit.mjs    variance-ratio sign persistence (closed P-001)  protocol.v1.json    the FROZEN thresholds the gate reads — the only copy
  protocol.mjs        loads + hashes protocol.v1.json
  EVALUATION_PROTOCOL.md  why the protocol is what it is
  registry.mjs        append-only run records + champion/challenger state
  registry/           runs.jsonl per strategy, plus a derived state.json
  strategies/*.mjs    signal functions
  data/               cached klines (regenerated; safe to delete)
execution/
  paper-trade.mjs     risk-gated paper order entry
  launch-tv.ps1       start TradingView with CDP + guarantee a chart
  ensure-chart.mjs    open/repair the chart tab
  mcp-handshake.mjs   verify the MCP server responds
frontend/             the command centre — a third layer, node:http, zero deps
  server.mjs          reads the evidence files, spawns the CLIs, streams SSE
  lib/                repo, proc, sse, jobs, analytics
  worker/             backtest-worker.mjs
  data/               pid, boot.err, run cache (git-ignored)
```

## 4. The research gate — what "edge" means

Nothing is an edge until it clears all of these (`CRITERIA` in `research/gate.mjs`):

| Criterion | Bar | What it prevents |
|---|---|---|
| trades | ≥ 500 | drawing conclusions from a handful of trades |
| **Sharpe t-stat** | > 2.0 | a big Sharpe that the sample cannot support |
| **Sharpe LCB (95%)** | > 0.3 | a big Sharpe *estimated from few trades* — the point estimate flatters a small sample |
| symbols | ≥ 5 (BTC ETH DOGE SOL ZEC) | one lucky instrument |
| **directional** regimes traded | ≥ 3 (bull/bear/sideways) | a strategy that only works while the market does one thing |
| **volatility** regimes traded | ≥ 2 (high/low) | ditto, on the axis that actually drives intraday behaviour |
| profit factor | > 1.3 | a strategy carried by one outsized winner |
| Sharpe | > 1.0 | — |
| max drawdown | < 35% | — |
| walk-forward consistency | ≥ 50% | tuning to the sample |
| P(max drawdown ≥ 20%) | < 25% | surviving only the lucky orderings |
| **holdout trades** | ≥ 60 | conclusions from an empty test window |
| **holdout Sharpe** | > 0.5 | in-sample-only edge |
| **degradation** (test ÷ train) | ≥ 0.25 | an edge that evaporates out of sample |
| **parameter sensitivity** | ≥ 30% of the grid profitable | a narrow spike that only exists at one exact setting |
| **cost survival** | ≥ 40% of the cost grid | an edge that dies at 2× fees |
| **max survivable cost** | ≥ 25 bps (fee+slip) | ditto |
| calmar vs regime-matched hold | must beat holding | buying risk, not edge |
| per-regime vs holding | must not be beaten anywhere it trades | a bull-window artefact |
| survived | account must not be ruined | — |

The two regime axes are deliberately separate. A single trend-based label hides
the case that matters most: a strategy that only works in choppy markets gets
filed as "sideways" and fails for the wrong reason.

**On "20 trades, Sharpe 3"** — per-trade Sharpe 3 over 20 trades gives
t = 13.4, so it *is* statistically significant. What makes it untrustworthy is
different, and the gate handles both parts separately: the trade-count
requirement rejects it outright, and the LCB shows the estimate's uncertainty
(LCB 1.97 against a point estimate of 3.0). A big Sharpe from a small sample is
not noise — it is a badly measured number.

## 5. Writing a strategy

A signal decides **direction only**. It cannot express size, leverage or stop —
the risk engine computes those. Signature:

```js
export default function myStrategy({ bars, i, cfg = {} }) {
  // bars: full array, bars[i] is the CLOSED bar
  // return { side: "buy" | "sell" } or null for no signal
  const lookback = cfg.lookback ?? 20;
  if (i < lookback + 2) return null;
  return { side: "buy" };
}
```

Optional export — the parameter grid to test sensitivity across:

```js
export const grid = { lookback: [15, 20, 25], volMult: [1.5, 2.0, 2.5] };
```

**Always export a grid.** Without one, sensitivity is measured at a single
point and the gate correctly treats that as unproven rather than robust. A
strategy whose edge only exists at `lookback: 20` is a curve fit.

Rules:

- **Every term must be a number you can print.** No "smart money", no
  "sweep", no discretionary language.
- **State the economic reason** the behaviour should exist, in a comment. A
  rule with no mechanism is a description of the past, not a hypothesis.
- **Expose parameters** with defaults so the gate can be run against variants.
- **No lookahead.** The signal sees bars up to and including `i`. Execution
  happens on bar `i+1`'s open, enforced by the simulator.
- One position at a time; exits are the simulator's job (stop / max hold).

### The holdout discipline

`holdoutEvaluate` picks the best variant on the **train** half, then evaluates
that exact variant on the **test** half. You must not look at the test half to
choose anything — that converts it into a second training set, and the whole
point of a holdout is that it is the one piece of data nobody optimised against.

## 6. Research rules learned the hard way

These are the mistakes that actually happened. Read them before trusting output.

1. **Never pool equity curves across symbols.** Concatenating five independent
   curves fabricates 90–100% drawdowns from the jump between one symbol's
   ending equity and the next's start. Pool *trades*; take *worst* drawdown per
   symbol; *compound* returns per symbol.

2. **A ruined account must stop trading.** The simulator once ran 4,908 trades
   off a wiped account, which would have *passed* the 500-trade minimum. Ruin
   detection halts at `ruinEquityPct` (default 0.2) and ruin is disqualifying.

3. **Monte Carlo cannot report final-equity percentiles.** The sum of a fixed
   P&L set is order-invariant, so shuffling cannot change it — percentiles come
   out identical and look like a result. Order changes only the *path*. Report
   drawdown distribution, P(threshold breach), and losing streaks.

4. **Warmup bars are unknown, not sideways.** Defaulting them to a real regime
   invents exposure that never existed and flatters any strategy trading early.

5. **A regime recurs — benchmark contiguous runs, not labels.** Treating every
   occurrence of "bull" as one leg makes first→last span the quiet stretches in
   between, inflating every regime's return to roughly the whole-period return.

6. **Verify the instrument before trusting the instrument.** A data adapter once
   returned price 79.62 for DOGE because the symbol switch hadn't landed. A human
   sees "wrong chart"; an automated system sees "valid number". Always verify
   the quote matches what you asked for.

7. **Compare against holding in the same regime, risk-adjusted.** Raw return in
   a bull window mostly measures "did you sit out a bull run without a stop".

8. **Index-aligned arrays are not timestamp lookups.** `regimes[i]` is positional;
   writing `regimes[b.time]` silently yields `undefined` and every downstream
   count comes out zero.

9. **Don't call an indicator sweep "testing 20 more indicators."** That is curve
   fitting wearing a disguise. Test one stated hypothesis at a time.

10. **A boolean that looks impossible usually means a stale splice.** A check
    read `1.501 > 0.3` as `false` while the identical expression evaluated `true`
    in isolation — the file had been edited by a scripted line-splice that
    silently corrupted it. Hoist the expression into a named `const` and, if it
    still misbehaves, print the raw tuple. Don't reason about precedence in a
    file you have been rewriting with string replacement.

11. **A whole-series indicator cache is a lookahead leak.** `leakage.mjs` wraps
    `bars` in a Proxy that throws if any index `> i` is read. An indicator that
    is recursively smoothed back to the start of the data (Wilder's ADX/ATR) is
    naturally written as "loop to `bars.length`, build the series, look up `i`"
    — and that loop reads the entire future on every single bar. It was caught
    as `LEAK DETECTED` on the first run of `sideways-liquidity-reversal`.

    Two requirements are in genuine tension here: memoising is what stops a
    recursive indicator being O(n²), and memoising the *whole* series is
    exactly what leaks. The resolution is to build **incrementally, bounded by
    `i`**, and cache on something that survives the Proxy. Key on `bars[0]` —
    the bar *object*, not the array — because the guard hands each call a fresh
    Proxy, so an array-keyed cache misses every time, while the underlying bar
    at index 0 is the same object either way. Key additionally on array length
    so a sliced series cannot serve a longer one.

    Any future indicator needing history must be written this way. See the
    comment on `wilder()` in `research/strategies/sideways-liquidity-reversal.mjs`.

12. **Derive every data limit from the timeframe, and verify the span came
    back.** `run.mjs` capped fetches at `days * 100`, which is correct only for
    15m (96 bars/day). At 1m a day is 1,440 bars, so a "30d @ 1m" run asked for
    43,200 bars and silently received 3,000 — about two days — while the cache
    file kept the full 30-day *name*. A short sample wearing a long sample's
    name is how a backtest reports an edge it never measured. The cap now comes
    from `barsPerDay(tf)`, and `run.mjs` throws if the loaded span is under 90%
    of the request. Prefer a loud failure to a plausible number.

13. **Read a profit factor against the noise floor in `strategies/registry.json`,
    never against 1.0.** The negative controls define what a signal with *no*
    information scores: random = 0.751, always-long = 0.837, because costs are
    charged on both sides of a churn-heavy trade stream. A PF of 0.6 is not
    "slightly below breakeven", it is *worse than a coin flip*. Only
    `sma-cross` (1.013) has ever measured above random in this repo.

14. **De-cluster every statistic before quoting a t-statistic.** Anything
    computed on a trailing window produces samples that overlap. Two samples
    20 bars apart share 180 of 200 window bars and all of their forward path.
    That inflates n, shrinks the standard error, and is indistinguishable from
    signal once the t crosses ±2.

    This was measured, not assumed. In `research/regime-audit.mjs` the trending
    state showed a mean +20-bar return at **t = +8.99** on raw samples
    (n=51,576 from 192,000 bars). De-clustered to disjoint windows the same
    state read **t = −1.38**, and the sign of the effect flipped. The whole
    apparent result was overlap.

    Take **one sample per window length** at minimum, and use a lag of one full
    window when testing whether a state persists. Consecutive-bar agreement is
    meaningless for this: 199 of 200 bars are shared, so it measures the
    estimator's smoothness, not the regime's stability.

15. **Compare an event against the unconditional baseline, never against zero.**
    "This event returns +0.08%" is uninterpretable if the market itself returns
    +0.10% over the same window — the event is then a *negative* signal wearing
    a positive sign. In a 400-day bull window the drift alone is +0.044% to
    +0.120% per 5–48 bars.

    `research/events.mjs` shipped without this and reported a volatility-expansion
    effect at **t = +2.10 and +2.17**. Those were *raw* returns. With the
    baseline subtracted the same events read **t = +0.18 and −0.21**. Every
    event statistic belongs next to its unconditional mean, and the excess
    carries the t-statistic — not the raw number.

16. **Measure a card's central claim before writing its strategy.** A card whose
    mechanism is a claim about the *data* (serial dependence, regime stability,
    an information barrier) can usually be falsified with no P&L, no exit model
    and no costs. P-001 was closed in about a minute of compute by one
    self-agreement statistic; a gate run would have produced twenty criterion
    lines and answered none of them as directly.

17. **`simulate()` did not forward `cfg` to the signal — FIXED 2026-09-27, and
    it had silently voided the parameter-sensitivity criterion.** The `ctx`
    object handed to a strategy had no `cfg` key at all, so every strategy ran on
    its own hardcoded defaults. `holdoutEvaluate` enumerates the cartesian
    product of a strategy's exported `grid` and calls
    `simulate({ cfg: { ...cfg, ...params } })` once per point — but `params` went
    nowhere. Every "variant" was the same default-config run.

    The damage is subtle and worth being precise about. It did **not** corrupt
    any headline result: a strategy reads `cfg.lookback ?? 20`, and with `cfg`
    absent the default applies, so PF, Sharpe, trade count and return were all
    correct at default parameters. Re-running `sweep-reversal` after the fix
    reproduced trades 1565 / PF 0.641 / Sharpe −0.138 exactly. What was void was
    **`parameter sensitivity`, which reported 0% for all 14 recorded runs** —
    and 0% reads exactly like "no variant was profitable" when it actually meant
    "nothing was varied". Any card citing sensitivity as evidence of
    non-robustness was citing an unmeasured quantity.

    Proof, had it been needed earlier: a probe signal keyed on `cfg.n`, firing
    when `i % n === 0`, returned an identical 213 trades for n = 3, 7 and 40.
    `research/harness.mjs` now asserts this in its selftest, so it cannot
    regress. Related and fixed at the same time: a throwing signal was swallowed
    by `try { … } catch { sig = null }` and became indistinguishable from a
    silent one. `simulate` now returns `signalErrors` and `firstSignalError`.

    The general lesson: **a criterion that can only fail for the right reason is
    not a test.** "Sensitivity 0%" is only meaningful if something varied.

## 7. Data

TradingView's MCP is capped at **300 bars per read** (299d on D, 3d on 15m).
That is enough to smoke-test and nowhere near enough for research, so the
research layer does not use it.

| provider | depth | notes |
|---|---|---|
| `binance` | 1000 bars/call, pageable | no key; ~7 years of DOGEUSDT |
| `yahoo` | ~1250 daily (5y request) | equities, no key |

```bash
node research/run.mjs --strategy myStrategy --tf 15m --days 400 --equity 1000
node research/run.mjs --all --tf 15m
```

`data.mjs` audits gaps. A backtest across unknown gaps silently invents edge.
Bars are `{ time (unix SECONDS), open, high, low, close, volume }`, ascending.

## 8. Execution layer

**Nothing in the execution layer runs unless a human asked for it.** It places
real orders into a paper broker. Treat every invocation as consequential.

```powershell
npm run tv:launch                        # start TradingView + guarantee a chart
node execution/paper-trade.mjs status
node execution/paper-trade.mjs account
node execution/paper-trade.mjs propose buy DOGEUSD --thesis "..." --dry-run
```

`propose` is the normal path — the agent supplies a thesis, the engine sizes it.
`buy`/`sell <qty>` is a manual override and the audit records
`sized_by: "agent-explicit"`.

### Kill switch

Set `"kill_switch": true` in `config/risk.json`. Every order is refused
immediately. This is the fastest stop.

### The gate blocks on

`KILL_SWITCH` · `STATE_UNREADABLE` · `RECONCILIATION_UNAVAILABLE` ·
`RECONCILIATION_MISMATCH` · `PRICE_UNKNOWN` · `MAX_OPEN_ORDERS` ·
`MAX_ORDER_NOTIONAL` · `MAX_TOTAL_MARGIN`

`STATE_UNREADABLE` means the account summary could not be read. The gate
**fails closed** — it never assumes zero exposure. Expand the Paper Trading
panel (chevron next to the label) and re-run.

### Auditing

Every action and every refusal is appended to `config/audit.jsonl`. Check it
after any run that behaved unexpectedly.

## 9. TradingView Desktop — the two non-obvious facts

1. **CDP alone is not enough.** The app must also have a **chart tab open**.
   On startup it restores your last tab; if that layout was deleted it 404s and
   shows an error page. The MCP then attaches to the error renderer and every
   tool reports `api_available: false`. `launch-tv.ps1` handles this.

2. **`tv scroll` and `tv range` (get) are broken** in `tradingview-mcp@1.0.1`
   (`"evaluate is not defined"`). Only `range --from --to` works.

Also: the new-tab search box searches your **saved layouts**, not symbols.

## 10. Current state

**No demonstrated edge.** Seven strategies, ~10,000 trades, Sharpe −0.26 to
−0.016. See README for the table. The pipeline is the deliverable; the
strategies are all falsified.

Read their profit factors against the **noise floor** in
`strategies/registry.json` (random 0.751, always-long 0.837), not against 1.0 —
see §6.13. Only `sma-cross` (PF 1.013) has ever measured above random, and
that was a precise measurement of nothing.

## 11. Before you touch a paper order

- [ ] `npm run verify` passes
- [ ] The chart tab is open and `status` shows `api_available: true`
- [ ] The Paper Trading panel is expanded (account state is readable)
- [ ] You used `--dry-run` first and read the engine's size and stop
- [ ] `config/risk.json` limits are ones you chose deliberately
- [ ] You know how to cancel by hand: order line `x`, then **Cancel order**

## 12. Update this file

Add to it when you learn:

- a new failure mode of TradingView's UI
- a bug class in the simulator or metrics
- a rule about what counts as evidence
- a parameter whose effect surprised you

The value of this file is entirely in its accuracy. An entry that turned out to
be wrong should be corrected, not left to mislead the next agent.
## Adding a strategy

If a hypothesis genuinely warrants a test, it is a single file in
`research/strategies/` exporting `signal({ bars, i, cfg })` and a `grid`. It is
then falsified or promoted automatically by `npm run research`. That is the
entire workflow. There is no special path for promising ideas, and there should
not be � a strategy that needs special handling to be evaluated is a strategy
whose evaluation cannot be trusted.
