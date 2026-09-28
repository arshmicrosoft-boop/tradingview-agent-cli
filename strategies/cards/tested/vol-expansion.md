---
id: T-005
name: volatility expansion breakout
slug: vol-expansion
status: falsified
code: research/strategies/vol-expansion.mjs
protocol: v1
protocol_hash: ab8d990e445b2927
tested_at: 2026-09-27
dataset: BTC/ETH/DOGE/SOL/ZEC · 15m · 400d · 38,401 bars each · 0 gaps
trades: 686
win_rate_pct: 16.5
profit_factor: 0.69
sharpe: -0.076
max_drawdown_pct: 48.58
total_return_pct: -36.18
gate: fail
unmet: 20
---

# volatility expansion breakout

**Lowest trade count (686) and the lowest win rate in the set (16.5%). Below the
gate's 500-trade minimum in the per-symbol legs, and a 16.5% win rate under a
2×ATR stop requires a 5:1 average win/loss ratio to break even. This is the
clearest case in the set of an exit model that cannot be reconciled with the
entry.**

## Hypothesis

```yaml
name: volatility expansion breakout

market_mechanism: >
  Sustained compression in realised range indicates the market has neither
  agreed on a direction nor found counterparties. When the range expands
  through a prior high, the participants who were positioned for a break
  (either side) must transact, and the resulting flow resolves the compression
  in the direction of expansion.

why_should_it_exist: >
  This one has an unusually concrete counterparty, which is why the mechanism
  is not rejected. Stops in a compressed range are tightly and visibly
  clustered. Both breakout triggers fire and both stop clusters are triggered
  in the same move. That is a genuine double-sided forced-flow event, and it
  should produce a decisive directional move — the only question is which
  side, and the code answers "up" by construction.

expected_regime: >
  Should work after a genuine multi-day squeeze, on a timeframe where the
  compression is a real absence of movement. The implementation's `squeeze`
  threshold of 0.02 — a 50-bar range under 2% of price — is that condition,
  but it is applied to *every* bar without checking that the compression is
  ending rather than continuing.

required_data: >
  OHLCV only

failure_condition: >
  If post-squeeze breaks resolve directionally and continue, then the trades
  that follow a squeeze should show the largest excursions of any strategy in
  the set. If PF is 0.69 with a 16.5% win rate, the expansion is not resolving
  in favour of the breakout — it is resolving against it, or it is not
  resolving at all. That would falsify the compression-detector half of the
  hypothesis and is the single most informative failure in the set.
```

## Rules as numbers

```
range = (max(high,50) - min(low,50)) / close[i]  # squeezeLen 50
hi    = max(high of bars[i-20 .. i-1])           # lookback 20
vavg  = mean(volume of bars[i-50 .. i-1])       # volLen 50
IF   range < 0.02                                # compressed
AND  close[i] > hi                               # breakout
AND  volume[i] > 1.5 * vavg                      # volMult 1.5
THEN buy on the next bar's open
```

No grid exported → single parameter point → unproven by the gate's definition.

## When to use

- **Regime:** none identified.
- **Trade count:** 686 across 5 symbols over 400 days. Even if the hypothesis
  had worked, this would have failed the ≥500 trades criterion in most
  per-symbol legs. **Any future version of this card must increase its firing
  rate or be tested on a longer window** — both are protocol-relevant, and the
  second is a v2 consideration.

## When not to use

- **With a 2×ATR stop.** At a 16.5% win rate this exit is arithmetically
  disqualifying. No entry improvement fixes a 5:1 required payoff ratio.
- **Confusion risk:** a range that is narrow because the market is dead, and a
  range that is narrow because price is pinned at a level, are treated
  identically. The former is a setup; the latter has no participants at all.
- **Confusion risk:** the strategy is long-only. If squeezes resolve downward
  as often as upward in this window — which is consistent with PF 0.69 — then
  half the edge available was never tested. This is a *design* asymmetry, not a
  parameter, and it is the specific hole P-001 addresses.

## Result under v1

| criterion | bar | actual |
|---|---|---|
| profit factor | > 1.3 | **0.69** |
| sharpe | > 1.0 | −0.076 |
| sharpe t-stat | > 2.0 | failed |
| trades (per-symbol legs) | ≥ 500 | **failed — 686 total across 5 symbols** |
| symbols passing alone | ≥ 60% | failed |
| parameter sensitivity | ≥ 30% | not measured — no grid |

**Basis note (2026-09-28).** `total_return_pct` (−36.18) and `max_drawdown_pct`
(48.58) were re-measured on this strategy's latest v1 run after the portfolio
model moved to an equal-weight additive book — return is the mean of the five
per-symbol returns, max drawdown is the drawdown of the pointwise-averaged
equity curve. The superseded figures (−95.2% and 80.0%) came from a 5×-geared
pooled replay and must not be mixed with these. Trades, profit factor, Sharpe
and the `fail` verdict are unchanged: they are per-run quantities and do not
depend on the portfolio basis, and the account still ruins on this run, so the
reading below stands.

## Why it failed

1. **The squeeze threshold is a fixed percentage of price, not of volatility.**
   0.02 is a 2% range. Whether that is unusually tight depends entirely on what
   the market's realised volatility has been doing. In a calm regime 2% is
   common and the "squeeze" is not unusual at all; in a violent regime it
   essentially never triggers. So the condition means something different in
   every week — the same defect as `donchian`, in its most extreme form, and
   exactly what P-002 proposes to fix.
2. **A compression is not a bottom, and the strategy treats it as one.** The
   range condition is evaluated on the prior 50 bars and the breakout on the
   current bar, but nothing distinguishes a compression that is *about to
   resolve* from one that is mid-drift.
3. **A 16.5% win rate is not fixable by better entries.** With a 2×ATR stop,
   a strategy needs either a much higher hit rate or a payoff ratio near 5:1.
   Compression breakouts are not known for 5:1 payoffs, and the fixed time exit
   truncates the right tail that would be required to get there.

## What we learned

- **Percentage-of-price thresholds are the same defect as raw price
  thresholds.** A threshold must be expressed in units of the market's own
  current volatility to mean the same thing across regimes. This is now the
  third card to arrive at the same conclusion independently (`donchian`,
  `trend-pullback`, `vol-expansion`), which is strong support for promoting
  P-002 to the front of the queue.
- **Low trade count is a design failure, not a data failure.** 686 trades means
  the card could never have passed on sample size. Firing rate must be part of
  the hypothesis, not an afterthought discovered afterwards.
- **The mechanism (double-sided stop clusters in a squeeze) is the most
  physically credible one we have tested, and it produced the second-worst
  result.** That is worth sitting with. Either the threshold does not isolate
  real squeezes, or post-squeeze expansion in crypto 15m is not directional in
  the way the hypothesis assumes. Both are open questions, and neither is
  answered by re-running with different numbers.
- **Third strategy recorded as measured at a single parameter point.** The grid
  export is now a hard requirement in the template, not a recommendation.
