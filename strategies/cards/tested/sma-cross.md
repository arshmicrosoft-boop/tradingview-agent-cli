---
id: T-001
name: sma crossover
slug: sma-cross
status: falsified
code: research/strategies/sma-cross.mjs
protocol: v1
protocol_hash: a23de729e9a08dcd
tested_at: 2026-09-27
dataset: BTC/ETH/DOGE/SOL/ZEC · 15m · 400d · 38,401 bars each · 0 gaps
trades: 1984
win_rate_pct: 21.3
profit_factor: 1.013
sharpe: -0.023
max_drawdown_pct: 56.91
total_return_pct: -1.33
gate: fail
unmet: 21
---

# sma crossover

**The closest thing to a result in the entire set, and it is the most important
negative in the repo.** PF 1.013 over 1,984 trades is not a weak edge. It is a
*precise* measurement of no edge — if there were a real trend-following
advantage in this sample at this size, a PF of 1.013 would not be the answer.

## Hypothesis

```yaml
name: moving-average crossover

market_mechanism: >
  Trend persistence in crypto, driven by gradual information diffusion and
  herding: a price that has moved stays moved while the information that moved
  it is absorbed.

why_should_it_exist: >
  Partially. There is a real participant for this — a trend follower with a long
  horizon is genuinely slow, and a faster participant must therefore be
  positioned in the same direction, which is what makes the move continue. The
  problem is that this participant is *already in the market*. A crossover
  detects the trend after the early part of it has happened, which means the
  trade is taken by the participant who is now the late, crowded one — and who
  is therefore providing the exit liquidity to whoever entered earlier. The
  mechanism is real and the entry timing is on the wrong side of it.

expected_regime: >
  Should work in persistent directional moves lasting more than ~50 bars. Should
  NOT work in the choppy, mean-reverting phases that dominate a 400-day window
  on 15m bars — and it does not, which is consistent with this being the
  mechanism rather than a random failure.

required_data: >
  OHLCV only

failure_condition: >
  If trend persistence is the mechanism, then profit factor should be clearly
  above 1 and should degrade gracefully (not collapse) as costs rise. If PF sits
  at 1.01 with t-stat of -1.02, the signal carries no directional information
  and the persistence being measured is not tradeable at 15m.
```

## Rules as numbers

```
fast = SMA(close, 20)      # default
slow = SMA(close, 50)      # default
IF   fast > slow
THEN buy on the next bar's open
```

No exit — the simulator owns it: 2×ATR stop, 96-bar time out.

Grid tested: `fast ∈ {15,20,25}` × `slow ∈ {40,50,60}`.

## When to use

- **Regime:** none identified. That is the finding.
- **Horizon:** 96-bar time exit = 24 hours. Intended to catch multi-day trends;
  it never held long enough to express one.
- **Never use this for live trading.** The rule is falsified, and the size of
  the loss is not in doubt.

## When not to use

- **Always.** The honest statement is that no regime was found in which this
  makes money.

## Result under v1

21 criteria unmet, including every statistical and every robustness bar. The
failures that matter:

| criterion | bar | actual |
|---|---|---|
| profit factor | > 1.3 | **1.013** |
| sharpe | > 1.0 | −0.023 |
| sharpe t-stat | > 2.0 | −1.02 |
| sharpe LCB (95%) | > 0.3 | −0.067 |
| symbols passing alone | ≥ 60% | **1/5** |
| parameter sensitivity | ≥ 30% | failed — no variant profitable |
| cost survival | ≥ 40% | failed |
| beats hold in bear / sideways | required | failed |

t-stat −1.02 over 1,984 trades is a tight confidence interval around zero. This
is not "not enough data" — this is enough data.

**Basis note (2026-09-28).** `total_return_pct` (−1.33) and `max_drawdown_pct`
(56.91) above were re-measured on this strategy's latest v1 run after the
portfolio model moved to an equal-weight additive book — return is the mean of
the five per-symbol returns, max drawdown is the drawdown of the
pointwise-averaged equity curve. The superseded figures (−99.36% and 82.75%)
came from a 5×-geared pooled replay and must not be mixed with these. Trades,
profit factor, Sharpe and the `fail` verdict are unchanged: they are per-run
quantities and do not depend on the portfolio basis.

**Basis note (2026-09-29).** The v1 archive was regenerated under a protocol
carrying a 19th threshold constant, `MIN_WF_COVERAGE: 100` — the walk-forward
fold coverage criterion, which passes on all ten cards — and with the
`beats hold in <reg>` benchmark corrected to compound rather than sum, which
lifted the bull-regime hold bar from 0.88% to 630.63%. This card returns 39.71%
in a bull regime, so `beats hold in bull` now fails and `unmet` moves 20 → 21;
`protocol_hash` moves to `31ca181720e76199`. Trades, profit factor, Sharpe,
`total_return_pct` and `max_drawdown_pct` are unchanged per-run quantities, and
the verdict is still `fail`.

**Basis note (2026-09-29, second run).** The archive was regenerated again, on a
**new experiment lineage rather than a threshold change**: `protocol.v1.json`
became the single source of truth for the experiment, gaining `data.as_of` and
`risk.allow_fractional`, with its `note` rewritten — so the hash moved to
`a23de729e9a08dcd` as a consequence of that reorganisation, not of any criterion
moving. All 19 criteria are unchanged, and every recorded figure on this card is
identical to the previous run: `unmet` holds at 21, trades 1,984, profit factor
1.013, Sharpe −0.023, `total_return_pct` (−1.33) and `max_drawdown_pct` (56.91)
are unchanged per-run quantities, and the verdict is still `fail`. The precision
this card rests on — 1.013 over 1,984 trades — is exactly the same measurement it
was before.

## Why it failed

The hypothesis was directionally correct and the entry was too late. A moving
average crossover is a *detector* of a move that has already partly happened,
and the participant who is positioned for the continuation is the one who
entered during the part we could not see. What remains for us is the exit
liquidity.

Two secondary contributors, both consistent with the same diagnosis:

1. **Volatile crypto crosses its own SMA constantly.** On 15m bars, a 20/50
   cross whipsaws within the 24-hour time exit, paying the full round-trip cost
   each time. 1,984 trades over ~38,400 bars is a trade roughly every 19 bars —
   that is churn, not signal.
2. **The price threshold is in raw price units.** Volatility varies ~10× across
   the window, so the identical rule is a materially harder test in a volatile
   week. This is a measurement defect, and it is what P-002 addresses.

## What we learned

- **A PF of 1.01 is a strong negative result, not a weak positive.** Do not
  re-rank this as "the best candidate". The sample is large enough to measure
  the absence.
- **Trade frequency was a red flag we did not read.** ~1 trade per 19 bars with a
  21% win rate under a 2×ATR stop requires a 3.3:1 average win/loss ratio. No
  result anywhere in the table supports that. High churn plus a low win rate is
  what a zero-expectancy signal looks like when it is forced to trade often.
- **This is the correct substrate for P-003** (selectivity on a falsified
  trigger). It is a trigger we know is worthless; the question is whether a
  filter can make it worth something. If not, no filter rescues a trigger.
- **It should not be re-run with different SMAs.** A longer or shorter pair is
  the same hypothesis. That is an indicator sweep, which the grid in
  `AGENT.md §6.9` already names as curve fitting in disguise.
