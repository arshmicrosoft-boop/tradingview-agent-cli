---
id: T-003
name: liquidity sweep reversal
slug: sweep-reversal
status: falsified
code: research/strategies/sweep-reversal.mjs
protocol: v1
protocol_hash: a23de729e9a08dcd
tested_at: 2026-09-27
dataset: BTC/ETH/DOGE/SOL/ZEC · 15m · 400d · 38,401 bars each · 0 gaps
trades: 1565
win_rate_pct: 23.1
profit_factor: 0.64
sharpe: -0.138
max_drawdown_pct: 71.81
total_return_pct: -71.53
gate: fail
unmet: 20
---

# liquidity sweep reversal

> ## ⚠ Trap: this card is the most dangerous one in the repo
>
> PF 0.64 is the worst result in the set, and `README.md` line 66 says
> *"Sweep-reversal (PF 0.64) is inverted."*
>
> **Do not act on that sentence.** Flipping the sign of a strategy because it
> lost in-sample is not a discovery, it is the single most reliable way to
> manufacture a backtest that looks good. You do not know which side of zero
> the out-of-sample result will land on — you only know the side you already
> measured. The same logic would "invert" every losing strategy ever written,
> and it is the reason the protocol is frozen and hashed.
>
> The correct reading of PF 0.64 is: **reversal after a high-volume break of a
> prior high is worse than random in this sample.** The mechanism failed. Fix
> the hypothesis or drop it; do not flip the polarity of a measured loss and
> call it research. If an inverted version is ever genuinely worth testing, it
> needs a *mechanism stated in advance* for why the opposite side works — and
> "it lost" is not one.

## Hypothesis

```yaml
name: liquidity sweep reversal

market_mechanism: >
  Stop clusters sit just outside the visible range. A high that pokes through a
  prior N-bar high triggers the stops above it; if price then closes back below
  that level, the break was liquidity-taking rather than information, and the
  participants who were forced to sell into it are now positioned to be bought
  back.

why_should_it_exist: >
  The stop-clustering half of this is real and the forced-execution half is
  real. The premise fails at the last step, and it fails in a way worth
  recording: **the stop run is the mechanism, not an obstacle to it.** The
  forced sellers do not get "bought back at a good price" — they are filled,
  and the price continues down because the volume that absorbed them was real
  volume seeking the other direction. The sweep-reversal reading treats
  liquidity-taking as evidence of reversal, when the same fact is equally
  consistent with a participant who needed to be large and was.

expected_regime: >
  Should work when the break is thin and the reversal is immediate — high
  volatility ranges, not trends. Should NOT work when the break has genuine
  information behind it, which is where continuation is the correct behaviour.
  The implementation had no way to tell those two apart, because volume
  indicates *how much* traded but not *why*.

required_data: >
  OHLCV + volume

failure_condition: >
  If this is reversal after liquidity-taking, then profit factor should improve
  markedly when the sweep is small relative to the move that follows, and should
  degrade as the break extends. A PF of 0.64 — far below 1.0, not merely below
  the gate's 1.3 — means the continuation case dominates, not that the edge is
  small. It is the wrong sign, not a weak version of the right sign.
```

## Rules as numbers

```
hi    = max(high of bars[i-20 .. i-1])          # lookback
vavg  = mean(volume of bars[i-50 .. i-1])       # volLen
IF   high[i]  > hi                             # took liquidity
AND  close[i] < hi                             # rejected it
AND  volume[i] > 2.0 * vavg                    # volMult — participation
THEN short on the next bar's open
```

Grid tested: `lookback ∈ {15,20,25}` × `volMult ∈ {1.5,2.0,2.5}`.

## When to use

- **Regime:** none. Do not use.
- **The signal is short-only**, which makes it the only short-side test in the
  set. Its result is therefore the primary evidence that the *short* sign carries
  no information in this window either.

## When not to use

- **Always**, as implemented.
- **Confusion risk:** a high-volume break of a prior high in crypto is, far more
  often than not, a continuation. The pattern is being read as exhaustion when
  it is usually initiation. Note the 2× volume filter selects *for* the large
  moves, and large moves in crypto are directional.
- **Do not use as a template for "reversal" strategies generally.** It was the
  only mean-reversion test in the set and it lost badly.

## Result under v1

| criterion | bar | actual |
|---|---|---|
| profit factor | > 1.3 | **0.64** — worst in the set |
| sharpe | > 1.0 | **−0.138** — worst in the set |
| sharpe t-stat | > 2.0 | failed |
| symbols passing alone | ≥ 60% | failed |
| degradation (test ÷ train) | ≥ 0.25 | failed |
| cost survival | ≥ 40% | failed |

**Basis note (2026-09-28).** `total_return_pct` (−71.53) and `max_drawdown_pct`
(71.81) were re-measured on this strategy's latest v1 run after the portfolio
model moved to an equal-weight additive book — return is the mean of the five
per-symbol returns, max drawdown is the drawdown of the pointwise-averaged
equity curve. The superseded figures (−99.9% and 80.3%) came from a 5×-geared
pooled replay and must not be mixed with these. Trades, profit factor, Sharpe
and the `fail` verdict are unchanged: they are per-run quantities and do not
depend on the portfolio basis, and the account still ruins on this run, so the
reading below stands.

**Basis note (2026-09-29).** The v1 archive was regenerated under a protocol
carrying a 19th threshold constant, `MIN_WF_COVERAGE: 100` — the walk-forward
fold coverage criterion, which passes on all ten cards — and with the
`beats hold in <reg>` benchmark corrected to compound rather than sum, which
lifted the bull-regime hold bar from 0.88% to 630.63%. This card takes no bull
trades at all, so that change costs it nothing: `beats hold in bull` was already
unmet, `unmet` holds at 20, and only `protocol_hash` moves, to `31ca181720e76199`.
Trades, profit factor, Sharpe, `total_return_pct` and `max_drawdown_pct` are
unchanged per-run quantities, and the verdict is still `fail`.

**Basis note (2026-09-29, second run).** The archive was regenerated again, on a
**new experiment lineage rather than a threshold change**: `protocol.v1.json`
became the single source of truth for the experiment, gaining `data.as_of` and
`risk.allow_fractional`, with its `note` rewritten — so the hash moved to
`a23de729e9a08dcd` as a consequence of that reorganisation, not of any criterion
moving. All 19 criteria are unchanged, and every recorded figure on this card is
identical to the previous run: `unmet` holds at 20, trades 1,565, profit factor
0.641, Sharpe −0.138, `total_return_pct` (−71.53) and `max_drawdown_pct` (71.81)
are unchanged per-run quantities, and the verdict is still `fail`.

## Why it failed

The volume filter is the problem, and it is the opposite of what it looks like.

`volume > 2.0 × average` was meant to identify meaningful participation. What it
actually selects for is **the largest, most directional moves in the sample** —
2,785 times in total. It is a *momentum* filter wearing a reversal rule's
clothes. Every trade is short, taken after a large high-volume break of a prior
high, which in crypto is close to the textbook definition of a continuation
setup.

So the two errors compounded: the filter selected for exactly the moves where
continuation is the correct behaviour, and the rule then bet on reversal in each
of them. PF 0.64 is not a slightly-wrong edge; it is a sign error with good
statistical power behind it.

**A PF of 0.64 over 1,565 trades is genuinely informative negative evidence** —
it is confidently worse than random. This is the strongest statistical signal in
the whole result set, and it is a signal that the *hypothesis* was wrong rather
than the parameters.

## What we learned

- **High volume is not a participation filter, it is a trend-strength filter.**
  Any rule that says "and volume is high" is implicitly a continuation rule.
  Read every such condition in a reversal strategy as a red flag.
- **The mean-reversion side of the ledger is now genuinely tested.** Pure long
  (PF 0.84) and pure short (PF 0.64) have both lost. Neither sign is free.
- **This is the strongest support for P-001.** If both signs lose when the sign
  is fixed, but the sign of the true edge depends on the market state, then five
  fixed-sign tests averaging to zero is exactly the result P-001 predicts. This
  card does not prove P-001 — it is one of the reasons to believe it.
- **The trap at the top of this card is permanent.** It stays here, in the most
  findable place, because the temptation to re-read 0.64 as 1.56 will not go
  away just because we know better once. If that sentence in the root README
  ever becomes the basis for a decision, the protocol has failed.
