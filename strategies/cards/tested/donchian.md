---
id: T-002
name: donchian breakout
slug: donchian
status: falsified
code: research/strategies/donchian.mjs
protocol: v1
protocol_hash: a23de729e9a08dcd
tested_at: 2026-09-27
dataset: BTC/ETH/DOGE/SOL/ZEC · 15m · 400d · 38,401 bars each · 0 gaps
trades: 1645
win_rate_pct: 19.7
profit_factor: 0.92
sharpe: -0.044
max_drawdown_pct: 56.19
total_return_pct: -28.75
gate: fail
unmet: 20
---

# donchian breakout

## Hypothesis

```yaml
name: donchian channel breakout

market_mechanism: >
  Stops accumulate just outside the visible range. A price that trades through
  the prior N-bar high triggers those stops, and the orders required to fill
  them are price-insensitive — they must be filled. That mandatory volume is
  what carries price through the level rather than bouncing off it.

why_should_it_exist: >
  Genuinely, and this is the strongest mechanism of the six. Stop placement is
  observable, clustering is a documented tendency, and forced execution is real.
  The participant on the other side is a risk manager who has no discretion to
  wait — which is exactly the class of counterparty that produces persistent
  effects rather than temporary ones. This card's mechanism is the reason the
  idea is still alive in the backlog as a volume-filtered variant rather than
  being discarded with the rest.

expected_regime: >
  Should work where volatility is expanding and the breakout is accompanied by
  participation. Should NOT work when the break is a thin-book overshoot in a
  liquidity drought, or in sideways regimes where the channel is repeatedly
  crossed without follow-through. The signal as implemented had no volatility
  or participation condition at all, so it fired maximally in exactly the
  regimes where it should not.

required_data: >
  OHLCV only

failure_condition: >
  If stop-clustering is the mechanism, then breakouts with high volume should
  outperform breakouts without it, and profit factor should improve sharply
  with a participation filter. A flat-to-negative result across the whole
  parameter range means the forced-volume effect is either absent at 15m or
  swamped by the false breakouts that arrive in the same regime.
```

## Rules as numbers

```
hi = max(high of bars[i-20 .. i-1])    # default lookback
IF   close[i] > hi
THEN buy on the next bar's open
```

**No volume condition and no volatility condition.** The channel is in raw price
units, so the same 20-bar range is a much lower bar in a quiet week than in a
violent one.

No grid was exported, so the gate measured this at a single parameter point and
correctly treated that as unproven rather than robust.

## When to use

- **Regime:** none identified in this sample.
- **Horizon:** 2×ATR stop, 96-bar time out.
- **This is a family, not one rule.** A Donchian breakout with a participation
  filter, on a volatility-normalized channel, in an expanding-volatility regime
  is a *different hypothesis* from this one and is not ruled out by this result.

## When not to use

- **Unfiltered, on 15m.** Every trade is a coin flip against a 2×ATR stop with a
  19.7% win rate, which needs a 4:1 average win to break even.
- **Confusion risk:** a breakout in a thin book looks identical to a breakout with
  real participation, and this implementation cannot tell them apart. Volume is
  the only available discriminator and it was not used.

## Result under v1

| criterion | bar | actual |
|---|---|---|
| profit factor | > 1.3 | **0.92** |
| sharpe | > 1.0 | −0.044 |
| symbols passing alone | ≥ 60% | failed |
| parameter sensitivity | ≥ 30% | not measured — **no grid exported** |
| beats hold in sideways | required | failed |

**Basis note (2026-09-28).** `total_return_pct` (−28.75) and `max_drawdown_pct`
(56.19) were re-measured on this strategy's latest v1 run after the portfolio
model moved to an equal-weight additive book — return is the mean of the five
per-symbol returns, max drawdown is the drawdown of the pointwise-averaged
equity curve. The superseded figures (−99.6% and 82.1%) came from a 5×-geared
pooled replay and must not be mixed with these. Trades, profit factor, Sharpe
and the `fail` verdict are unchanged: they are per-run quantities and do not
depend on the portfolio basis.

**Basis note (2026-09-29).** The v1 archive was regenerated under a protocol
carrying a 19th threshold constant, `MIN_WF_COVERAGE: 100` — the walk-forward
fold coverage criterion, which passes on all ten cards — and with the
`beats hold in <reg>` benchmark corrected to compound rather than sum, which
lifted the bull-regime hold bar from 0.88% to 630.63%. That is the whole of the
movement: `beats hold in bull` now fails here, so `unmet` moves 19 → 20 and
`protocol_hash` moves to `31ca181720e76199`. Trades, profit factor, Sharpe,
`total_return_pct` and `max_drawdown_pct` are unchanged per-run quantities, and
the verdict is still `fail`.

**Basis note (2026-09-29, second run).** The archive was regenerated again, on a
**new experiment lineage rather than a threshold change**: `protocol.v1.json`
became the single source of truth for the experiment, gaining `data.as_of` and
`risk.allow_fractional`, with its `note` rewritten — so the hash moved to
`a23de729e9a08dcd` as a consequence of that reorganisation, not of any criterion
moving. All 19 criteria are unchanged, and every recorded figure on this card is
identical to the previous run: `unmet` holds at 20, trades 1,645, profit factor
0.917, Sharpe −0.044, `total_return_pct` (−28.75) and `max_drawdown_pct` (56.19)
are unchanged per-run quantities, and the verdict is still `fail`.

## Why it failed

Three defects, in order of severity:

1. **No participation condition.** A breakout on 1.0× average volume and a
   breakout on 3.0× average volume are the same trade to this code. If the
   mechanism is forced stop execution, that distinction is the entire trade.
2. **No volatility regime condition.** It fires equally in squeeze and in
   expansion, so it takes the breakout in a squeeze — the outcome with the worst
   base rate — as often as the one in expansion.
3. **Raw price units.** The channel width scales with price level and with
   volatility, so the same 20 bars is a different difficulty in every week.
   This is the P-002 defect.

Win rate 19.7% is the lowest of any strategy in the set apart from
`vol-expansion`, which is the same idea with a squeeze precondition. Both
confirm the same underlying point: **an unfiltered breakout on 15m crypto is
overwhelmingly a false breakout.**

## What we learned

- **The mechanism is not what failed; the specification was.** This is the one
  card where a better-specified version of the *same* idea is a genuinely
  different hypothesis and deserves a test. It is the basis of P-002.
- **Never again export a strategy without a grid.** The gate flagged this as
  unproven rather than falsely reporting robustness, which is the gate working
  correctly — but the run tells us nothing either way, and it cost a full
  evaluation slot.
- **Base rate first.** Before testing any breakout filter, the honest question is
  what fraction of breakouts follow through. If that is 40%, then a 19.7% win
  rate under a 2×ATR stop is not fixable by better entries — the exit is the
  problem, and the exit is not ours to set under v1.
