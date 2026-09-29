---
id: T-006
name: long with stop
slug: long-with-stop
status: falsified
code: research/strategies/long-with-stop.mjs
protocol: v1
protocol_hash: 31ca181720e76199
tested_at: 2026-09-27
dataset: BTC/ETH/DOGE/SOL/ZEC · 15m · 400d · 38,401 bars each · 0 gaps
trades: 2278
win_rate_pct: 23.4
profit_factor: 0.837
sharpe: -0.028
max_drawdown_pct: 71.41
total_return_pct: -55.22
gate: fail
unmet: 21
---

# long with stop

> ## This is a duplicate, and it was counted as a strategy
>
> `long-with-stop` and the negative control `_control_alwayslong` **are the same
> signal**. Both return `{ side: "buy" }` unconditionally on every bar. The
> only difference is that this file does not export a `grid` and the control
> does.
>
> The metrics confirm it exactly: 2,278 trades, Sharpe −0.028, PF 0.84 / 0.837,
> max drawdown 71.41%. These are the same run.
>
> **So one of the six "strategies" in the original result table is a negative
> control wearing a different filename, and the distinct hypothesis count is
> five, not six.** That is a research-hygiene defect in the set, and it is
> recorded here rather than quietly deleted, because "we tested six things" was
> the framing used when the results were read and it was wrong by one.

## Hypothesis

```yaml
name: long with a fixed stop

market_mechanism: >
  None claimed. This file is not a hypothesis — it is the risk envelope
  measured on its own, with no directional input at all. It exists to compare
  the *cost of the envelope* against holding, and it is the reason the true
  buy-and-hold benchmark has to live in `research/gate.mjs` using raw bars
  rather than going through the simulator.

why_should_it_exist: >
  It has no mechanism and does not need one. Its purpose is diagnostic: it
  measures what the 1%-risk / 10x-leverage / 2×ATR-stop envelope does to an
  asset that goes up over the sample. The answer is that it loses 55.22%.

expected_regime: >
  Not applicable.

required_data: >
  OHLCV only

failure_condition: >
  Not applicable. This is a benchmark probe, not a testable claim.

  The duplicate control already established the substantive finding: a
  risk-gated long position in a rising asset loses to simply holding, because
  the stop converts a monotonic gain into a high-frequency sequence of
  small losses. The envelope, not the direction, was the problem.
```

## Rules as numbers

```
IF   always
THEN buy on the next bar's open
```

No conditions. No grid.

## When to use

- **Never, as a strategy.** It exists as a probe.
- **Its real use:** the 27.6–74.3% drawdowns across the entire result table are
  this strategy's fingerprint. Every strategy in the set wore the same envelope
  and all of them produced a drawdown in the same band, an order of magnitude
  below anything a trigger could earn. That tells you the drawdown column
  measures the envelope, not skill.

## When not to use

- **As evidence about directional signals.** It says nothing about whether a
  trigger has information.
- **As a benchmark.** It is *worse* than holding by construction, so it must
  never appear in a "does this beat the benchmark" table. The real benchmark
  is raw buy-and-hold, in `research/gate.mjs`.

## Result under v1

| criterion | bar | actual |
|---|---|---|
| profit factor | > 1.3 | **0.837** |
| sharpe | > 1.0 | −0.028 |
| sharpe t-stat | > 2.0 | failed |
| max drawdown % | < 35% | **71.41** — exceeded only by `sweep-reversal` (71.81) and the random control (74.33) |
| total return | — | **−55.22%** |
| calmar vs regime-matched hold | required | failed |
| beats hold in bull | required | failed |

**Basis note (2026-09-28).** `total_return_pct` (−55.22) and `max_drawdown_pct`
(71.41) were re-measured on this strategy's latest v1 run after the portfolio
model moved to an equal-weight additive book — return is the mean of the five
per-symbol returns, max drawdown is the drawdown of the pointwise-averaged
equity curve. The superseded figures (−99.8% and 83.0%) came from a 5×-geared
pooled replay and must not be mixed with these. Trades, profit factor, Sharpe
and the `fail` verdict are unchanged: they are per-run quantities and do not
depend on the portfolio basis. The account still reaches the ruin threshold
(`account survived (no ruin)` is still unmet), so the conclusion below stands.

**Basis note (2026-09-29).** The v1 archive was regenerated under a protocol
carrying a 19th threshold constant, `MIN_WF_COVERAGE: 100` — the walk-forward
fold coverage criterion, which passes on all ten cards — and with the
`beats hold in <reg>` benchmark corrected to compound rather than sum, which
lifted the bull-regime hold bar from 0.88% to 630.63%. This card returns 10.11%
in a bull regime, so `beats hold in bull` now fails and `unmet` moves 20 → 21;
`protocol_hash` moves to `31ca181720e76199`. Trades, profit factor, Sharpe,
`total_return_pct` and `max_drawdown_pct` are unchanged per-run quantities, and
the verdict is still `fail`.

## Why it failed

Because it is the same trade as holding, wrapped in a stop, over a 400-day
window in which the asset rose.

Every dip below 2×ATR is exited for a loss; the position is re-entered at a
slightly higher price; the next dip does it again. Over 2,278 trades in a rising
market, the sum of small losses plus costs exceeds the trend capture. The
account reaches the ruin threshold and the simulator stops.

## What we learned

- **The drawdown column is not a measurement of the strategies.** 42.63, 48.58,
  56.19, 56.91, 71.41, 71.81 — six different triggers, one envelope, one band.
  When every candidate produces a drawdown of the same order, the drawdown is
  measuring the envelope. This is why `README.md`'s result table must be read in
  the order given in `strategies/README.md`, with Sharpe and drawdown last.
- **PF 0.837 is the reference point for "an asset went up".** Any directional
  strategy that cannot clear this has produced nothing. Only `sma-cross` at
  1.013 got close, and it is within noise of it.
- **Risk configuration was never tested as a hypothesis.** 1% risk at 10x
  leverage with a 2×ATR stop is one configuration. It was never varied, so no
  statement in this repo should be read as "this risk model is good" or "this
  risk model is bad". What is established is narrower: *at this configuration, a
  zero-expectancy signal compounds to ruin, and negative expectancy compounds
  faster.* Sizing is the difference between a drawdown you can survive and one
  that ends the experiment — it is not a source of edge.
- **A hypothesis count needs an audit.** This duplicate was found by comparing
  the two implementations, not by trusting the file listing. Worth doing
  whenever a result is summarised, and worth a check in `verify.mjs` that two
  strategies do not return identical signals on the same bar.
