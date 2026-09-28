---
id: T-007
name: sideways liquidity sweep reversal
slug: sideways-liquidity-reversal
status: falsified
code: research/strategies/sideways-liquidity-reversal.mjs
protocol: v1
protocol_hash: ab8d990e445b2927
tested_at: 2026-09-27
dataset: BTC/ETH/DOGE/SOL/ZEC · 15m · 400d · 38,401 bars each · leakage clean
trades: 165
win_rate_pct: 45.5
profit_factor: 0.355
sharpe: -0.26
max_drawdown_pct: 27.6
total_return_pct: -27.24
gate: fail
unmet: 19
---

# sideways liquidity sweep reversal

**The most useful negative in the repo, because it tests a rescue and shows the
rescue does not work.** `sweep-reversal` already measured PF 0.641 on a raw
sweep trigger. This card asks the P-003 question directly: can a regime filter
make a known-falsified trigger worth trading? Answer: no — and it made the
trigger *worse*, not better.

## Hypothesis

```yaml
name: sideways liquidity sweep reversal

market_mechanism: >
  Stop orders cluster just beyond the visible high/low of a range, because that
  is the obvious place to put them. A trade through the extreme triggers that
  resting supply or demand. The forced flow that follows is larger than the
  participant who caused it, so price cannot sustain outside the range. The
  reclaim of the level on the same bar is the evidence the break failed: had
  the break absorbed the stops, the close would have stayed outside.

why_should_it_exist: >
  Only where a range exists to be swept. The regime gate is therefore not a
  filter for noise, it is a precondition for the mechanism: the same print in a
  trending market is a breakout, and the trade is backwards. This is the one
  structural difference from `sweep-reversal`, which took the signal in every
  regime including the ones where the mechanism is absent by definition.

expected_regime: >
  Should work in compressed, low-ADX, low-volatility ranges and nowhere else.
  Should specifically NOT work in directional moves. The trade count falling
  from 1,565 to 165 is the gate doing its job — it removed 89% of the
  opportunities, and if the mechanism is real the survivors should have been
  better than the whole, not worse.

required_data: >
  OHLCV only. No order book, no funding, no open interest.

failure_condition: >
  If selectivity is the mechanism, profit factor should RISE versus the
  unfiltered trigger. If it falls, either the filter selects a worse population
  or the filter itself is miscalibrated — and the two must be told apart before
  any conclusion is drawn about selectivity in general.
```

## Rules as numbers

```
adxPeriod = 14        adxMax   = 25        # Wilder ADX, regime 1
atrPctLen = 200       atrPctMax = 30       # regime 2, percentile of own history
rangeLen  = 50        squeeze  = 0.02      # regime 3, (hi-lo)/close
lookback  = 20        volLen   = 50        volMult = 2.0
dispAtr   = 0.5

IF   ADX(i) < adxMax
AND ATRpercentile(i) <= atrPctMax
AND (max(high,rangeLen) - min(low,rangeLen)) / close(i) < squeeze
AND volume(i) > volMult * mean(volume, volLen)

  IF   low(i)  < min(low,  lookback) AND close(i) > min(low,  lookback)
  AND (open(i) - close(i)) <= dispAtr * ATR(i)
  THEN buy

  IF   high(i) > max(high, lookback) AND close(i) < max(high, lookback)
  AND (close(i) - open(i)) <= dispAtr * ATR(i)
  THEN sell
```

No exit — the simulator owns it: 2×ATR stop, 96-bar time out.

Grid tested: `adxMax ∈ {20,25,30}` × `lookback ∈ {15,20,30}` × `volMult ∈ {1.5,2.0}`.

## When to use

- **Regime:** none. That is the finding, and it is the same finding as
  `sma-cross`, reached from the opposite direction.
- **Do not use this to justify the P-003 programme.** See "What we learned".

## When not to use

- **Always.** No regime was found in which this makes money, and it is
  measurably worse than the unfiltered trigger it was built to improve.

## Result under v1

19 criteria unmet. The failures that carry information:

| criterion | bar | `sweep-reversal` | this |
|---|---|---|---|
| trades | ≥ 500 | 1,565 | **165** |
| profit factor | > 1.3 | 0.641 | **0.355** |
| sharpe | > 1.0 | −0.138 | −0.26 |
| sharpe t-stat | > 2.0 | — | −3.34 |
| max survivable cost | ≥ 25 bps | 0 bps | **0 bps** |
| parameter sensitivity | ≥ 30% | 0% | **11.1%** |
| account survived | yes | ruined | **survived (−27.24%)** |
| leakage | clean | clean | clean |

Buy&hold returned +696.23% over the same window. The strategy returned −27.24%.

**The load-bearing comparison is PF 0.641 → 0.355.** Adding the regime filter and
the long side made the trigger measurably worse, not better.

**Basis note (2026-09-28).** `total_return_pct` (−27.24) and `max_drawdown_pct`
(27.6) were re-measured on this strategy's latest v1 run after the portfolio
model moved to an equal-weight additive book — return is the mean of the five
per-symbol returns, max drawdown is the drawdown of the pointwise-averaged
equity curve. The superseded figures (−81.88% and 45.9%) came from a 5×-geared
pooled replay and must not be mixed with these.

Two consequences are recorded rather than smoothed over. **The unmet count moved
from 20 to 19, entirely because the `max drawdown` criterion now passes at 27.6%
against a `< 35%` bar** — the book is shallower than the worst single sleeve it
used to be judged on, and the `< 35%` bar is being applied to the thing the
strategy actually deploys. And **the account no longer ruins** on this run, so
`account survived` and `symbols ruined` are met. Neither changes the verdict,
which is still `fail` on nineteen other grounds, and neither rescues the
hypothesis: trades, profit factor, Sharpe and every statistical and robustness
bar are unchanged, because they are per-run quantities that do not depend on the
portfolio basis.

## Why it failed

The mechanism is plausible and the filters are the right idea. The filters are
also, in combination, badly calibrated, and the two failures are separable.

1. **The regime gate is over-tight, so the sample cannot support a verdict.**
   Three independent conditions conjoined — ADX below a threshold, ATR in the
   bottom 30% of its own history, and a 2% range over 50 bars — cut 1,565
   opportunities to 165. At 165 trades with a 96-bar time exit the statistical
   bars the gate demands (≥500 trades, ≥60 holdout trades) are out of reach by
   construction. The holdout leg ran on **7 trades**. This is a power failure,
   and it is reported as one.

2. **What selectivity did select was worse, which is the finding that matters.**
   Profit factor fell by 44% against the unfiltered trigger. If the regime gate
   had merely removed noise, the survivors would have a *higher* PF. A lower PF
   means the gate is selecting a structurally different population — and the
   displacement guard is the likely culprit. Requiring `(open-close) <= 0.5·ATR`
   on a long systematically removes the bars where the reclaim was strongest,
   because a sweep-and-reclaim bar is by construction a bar that moved hard
   against the claimed direction before closing back. The guard is filtering on
   the very thing the hypothesis depends on.

3. **The pre-registered failure condition fired, and it is ambiguous.** The card
   states that if PF falls versus the unfiltered trigger, the filter is either
   selecting a worse population or is miscalibrated. It fell, but cause 2
   (miscalibration) is demonstrated by cause 3 above, and the two are
   confounded in a single run. **This card therefore does not refute P-003.** It
   refutes this filter design. Separating "selectivity does not work" from "this
   particular filter is an inverted bet on bar shape" requires a second run with
   the displacement guard removed and the regime gate intact — which is a
   different strategy, not a re-run of this one.

4. **The result is below the measured noise floor.** `registry.json` records PF
   0.751 for the random control and 0.837 for always-long. At **PF 0.355 this
   strategy is materially worse than generating signals at random**, which is a
   stronger statement than "no edge found": the entry rule is not merely
   uninformative, it is selecting trades that lose more than uninformative ones.
   The clearest candidate is again the displacement guard, which systematically
   vetoes the bars where the reclaim actually happened.

## What we learned

- **A filter that makes a falsified trigger worse is more informative than a
  filter that makes it slightly better** — but only once you have ruled out
  simple miscalibration. Here the honest reading is the boring one: the
  displacement guard is an inverted bet on bar shape, and it dominated the
  result. Do not generalise from this to "selectivity does not work".
- **Read every profit factor against the noise floor in `registry.json`, not
  against 1.0.** A signal with no information scores 0.751 here because costs
  are charged on both sides of a churn-heavy stream. `sma-cross` at 1.013 was
  the only strategy ever measured *above* random. Everything since has been
  worse than a coin flip, and reading those numbers against 1.0 hides how bad
  they are.
- **Do not assume "regime-gated" means "better".** Selectivity has a cost: it
  shrinks the sample and it can select on the wrong axis. The displacement
  guard is a clean example of a filter that looks like risk control and is
  actually an inverted bet on bar shape.
- **The 1m MA-cross falsification motivated this card, and this card did not
  rescue it.** That is the correct outcome. The honest reading is that the
  sideways opportunity the 1m run pointed at — 345 of 408 trades in a sideways
  regime — is not a mean-reversion edge either. The regime was the most common
  *context*, not evidence of an unexploited *mechanism*.
- **A leakage bug was found and fixed while building this**, not inherited.
  The first implementation of the Wilder ADX walked to `bars.length` to build
  its series; `leakage.mjs` wraps bars in a Proxy that throws on any index > i,
  and correctly reported LEAK DETECTED. The fix was to build the indicator
  incrementally, bounded by `i`. See `research/leakage.mjs` and the comment on
  `wilder()` in the strategy. **Any future indicator that needs history must be
  written this way** — a whole-series cache is structurally incompatible with
  the future-access guard, and will fail the gate.
- **This should not be re-run with a looser gate.** Loosening `adxMax` to
  recover trade count walks straight back to `sweep-reversal`, which is already
  falsified at PF 0.641. The sample-size problem is addressed with more data or
  a longer timeframe, never by relaxing the hypothesis.
