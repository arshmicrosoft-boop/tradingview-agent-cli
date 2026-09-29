---
id: T-004
name: trend pullback continuation
slug: trend-pullback
status: falsified
code: research/strategies/trend-pullback.mjs
protocol: v1
protocol_hash: 31ca181720e76199
tested_at: 2026-09-27
dataset: BTC/ETH/DOGE/SOL/ZEC · 15m · 400d · 38,401 bars each · 0 gaps
trades: 1557
win_rate_pct: 23.4
profit_factor: 0.97
sharpe: -0.016
max_drawdown_pct: 42.63
total_return_pct: -6.68
gate: fail
unmet: 20
---

# trend pullback continuation

**The best Sharpe in the set (−0.016) and the highest profit factor among the
five real strategies (0.97). Both are still indistinguishable from zero. This
card is the clearest illustration of why the result table must not be ranked by
Sharpe.**

## Hypothesis

```yaml
name: trend pullback continuation

market_mechanism: >
  Within an established trend, price periodically retraces as early participants
  take profit. A pullback that holds above the prior impulse low and turns back
  up indicates the trend's participants are still in control, and the
  re-entry flow that follows is larger than the profit-taking flow that caused
  the pullback.

why_should_it_exist: >
  Plausibly, via a different route than most of these cards: the pullback is the
  point at which **counter-trend participants are forced to enter**. A
  pullback looks like a reversal to a participant using only recent price
  action, so trend-following stops and dip-buyers both get filled. That
  supply is what makes the re-entry attractive. This is a genuine
  structure — the trade is against people who entered for a reason that has
  just been invalidated.

expected_regime: >
  Should work in directional trends on a timeframe long enough for a 200-bar
  trend filter to mean something. On 15m bars, 200 bars is ~50 hours, so the
  "trend" being filtered for is a two-day horizon while the exit is a 24-hour
  time stop. **That mismatch is the hypothesis's main structural risk** and it
  was present before the test.

required_data: >
  OHLCV only

failure_condition: >
  If pullbacks offer better entry than breakouts, then this should outperform
  `donchian` on the same sample, since it enters later (at a better price) with
  the same exit. A PF of 0.97 against donachian's 0.92 is a small improvement
  in the right direction, but not distinguishable from noise at 1,557 trades.
  If entry timing is not the problem, the problem is the exit.
```

## Rules as numbers

```
sma  = SMA(close, 200)                          # trendLen
hi   = max(close of bars[i-20 .. i-1])          # pullback
vavg = mean(volume of bars[i-50 .. i-1])        # volLen
IF   close[i] > sma                             # uptrend
AND  close[i] < hi                              # pulled back
AND  close[i] > open[i]                         # buyers returned
AND  volume[i] > 1.2 * vavg                     # volMult 1.2
THEN buy on the next bar's open
```

No grid exported → measured at a single point → treated by the gate as unproven.

## When to use

- **Regime:** none identified in this sample.
- **Timeframe:** intended for 15m with a 200-bar trend filter. Note the horizon
  mismatch below.
- **The idea is not dead — the specification is.** A pullback entry with a
  trailing exit that holds with the trend is a different hypothesis, and it is
  blocked on v1's fixed exit.

## When not to use

- **With a fixed 2×ATR stop.** Pullback entries are structurally closer to
  invalidation, so a tight fixed stop cuts them at exactly the wrong moment. See
  the blocker section of `BACKLOG.md`.
- **Confusion risk:** a pullback in a trend and the start of a reversal look
  identical on 15m bars without higher-timeframe information. The 200-bar SMA is
  a crude proxy for the missing higher timeframe, and the price of using it is
  that it is derived from the same 15m series we are trading.

## Result under v1

| criterion | bar | actual |
|---|---|---|
| profit factor | > 1.3 | **0.97** |
| sharpe | > 1.0 | −0.016 (best in set) |
| sharpe t-stat | > 2.0 | failed |
| symbols passing alone | ≥ 60% | failed |
| parameter sensitivity | ≥ 30% | not measured — no grid |
| calmar vs regime-matched hold | required | failed |

**Basis note (2026-09-28).** `total_return_pct` (−6.68) and `max_drawdown_pct`
(42.63) were re-measured on this strategy's latest v1 run after the portfolio
model moved to an equal-weight additive book — return is the mean of the five
per-symbol returns, max drawdown is the drawdown of the pointwise-averaged
equity curve. The superseded figures (−99.3% and 82.6%) came from a 5×-geared
pooled replay and must not be mixed with these. Trades, profit factor, Sharpe
and the `fail` verdict are unchanged: they are per-run quantities and do not
depend on the portfolio basis. The shallowest portfolio return in the set is not
a positive result — the account still ruins, and the sign of the edge is still
negative.

**Basis note (2026-09-29).** The v1 archive was regenerated under a protocol
carrying a 19th threshold constant, `MIN_WF_COVERAGE: 100` — the walk-forward
fold coverage criterion, which passes on all ten cards — and with the
`beats hold in <reg>` benchmark corrected to compound rather than sum, which
lifted the bull-regime hold bar from 0.88% to 630.63%. This card returns 8.07%
in a bull regime, so `beats hold in bull` now fails and `unmet` moves 19 → 20;
`protocol_hash` moves to `31ca181720e76199`. Trades, profit factor, Sharpe,
`total_return_pct` and `max_drawdown_pct` are unchanged per-run quantities, and
the verdict is still `fail`.

## Why it failed

1. **The 200-bar trend filter is nearly meaningless on 15m.** ~50 hours. It
   selects for a mildly positive drift over two days, which in crypto 15m is
   close to "the market went up at some point recently". The filter's job was
   to restrict trading to genuine trends, and it does not do that.
2. **The four conditions multiply into a very rare signal**, and when it does
   fire the volume threshold of 1.2× is low enough to catch ordinary bars
   rather than exceptional ones. So the filter is simultaneously too loose to be
   selective and too tight to be meaningful.
3. **The exit is structurally wrong for this entry.** A pullback entry places
   you just above local invalidation. A fixed 2×ATR stop from there is inside
   the noise of the pullback itself, so the position is stopped on ordinary
   retracement and then the trend continues without us. 23.4% win rate is
   consistent with exactly that story.

The fact that this beat `donchian` slightly (0.97 vs 0.92) and lost to
`sma-cross` on PF (0.97 vs 1.013) is what noise looks like when five strategies
are all measuring the same absence with different instruments.

## What we learned

- **Timeframe coherence matters more than trigger quality.** A 200-bar filter
  on 15m is not a higher timeframe, it is a long memory. If a hypothesis needs
  higher-timeframe information, either fetch a higher timeframe or say plainly
  that it cannot be tested here. Faking it with a long SMA is worse than not
  having the filter, because it looks like the hypothesis was implemented.
- **Entry quality and exit quality are not separable in these results.** Every
  strategy shares one exit, and the two best-performing cards are the two with
  the most specific entries. That is weak evidence for the exit hypothesis
  (`BACKLOG.md`, "Blocked on the exit model") and it is the cheapest v2 change
  available.
- **Two strategies have now been recorded as measured at a single parameter
  point.** That is two wasted evaluation slots. Every strategy exports a grid
  from now on, without exception.
- **Best-Sharpe-among-falsified is not a runner-up.** It is the same zero,
  measured with a slightly different instrument.
