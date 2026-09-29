---
id: C-002
name: random signal control
slug: random
status: falsified
code: research/strategies/_control_random.mjs
protocol: v1
protocol_hash: a23de729e9a08dcd
tested_at: 2026-09-27
dataset: BTC/ETH/DOGE/SOL/ZEC · 15m · 400d · 38,401 bars each · 0 gaps
trades: 2270
profit_factor: 0.751
sharpe: -0.057
max_drawdown_pct: 74.33
total_return_pct: -72.89
gate: fail
unmet: 21
---

# random signal control

**Not a hypothesis. A second ruler, on the other axis.** C-001 proves the gate
rejects a signalless long. This proves the gate rejects a signalless *trade* —
same entry rate, same churn, but the direction is drawn at random rather than
fixed.

The comparison between the two is the useful result. C-001 and C-002 differ by
one thing: whether the side is `buy` because it is always buy, or because it is
random. Everything else — trade count, cost paid, exit model, risk envelope — is
held fixed.

## Hypothesis

```yaml
name: randomised direction

market_mechanism: >
  None. The side is chosen by a seeded random draw, so the strategy has no
  information about the market whatsoever. Its purpose is to establish what a
  correct evaluator returns when handed a trade stream that is statistically
  independent of price.

why_should_it_exist: >
  It should not, and it does not. It exists to bound the *noise floor* of the
  measurement. Every profit factor in this repo is a comparison against an
  implied zero, but a zero measured on 2,270 random trades is not exactly 1.00
  — it is a distribution. This card is one draw from that distribution, and its
  metrics are the scale against which a real strategy's profit factor should be
  read: a real strategy scoring 1.01 is scoring roughly what a coin flip scores.

expected_regime: >
  Should fail everywhere, and should fail by a *similar margin* to C-001. A large
  gap between the two controls would mean the harness treats a random side
  differently from a fixed side, which would be a bug in the evaluator.

required_data: >
  OHLCV only. A seeded PRNG produces the side; no market data informs the
  direction.

failure_condition: >
  The control passes the gate, or it passes materially more criteria than C-001
  despite carrying strictly less information. Either result means the gate
  rewards trades rather than edge, and every conclusion drawn from the five
  falsified strategies has to be withdrawn.
```

## Rules as numbers

```
seed = 12345
IF   flat
THEN side = (draw(seed) > 0.5) ? buy : sell
THEN enter on the next bar's open
```

No parameters to vary. The seed is fixed so the run is reproducible; it is not
tuned, and tuning it would be fitting noise.

Exit is owned by the simulator — 2×ATR stop, 96-bar time out.

## When to use

- **Regime:** never. This is not a trading rule.
- **Horizon:** identical entry logic to C-001, so the holding-period distribution
  is the same for the same reason.
- **Sizing:** risk engine, as with every other strategy.

## When not to use

- **Always.**
- **Confusion risk:** a random side will occasionally produce a run that looks
  survivable over a short window. This card was run over 400 days precisely so
  that such a coincidence is visible — over that span it returns −72.89%.
  A short-window random result is not evidence of anything, and the fact that
  this one is not is the point of running it.

## Result under v1

**Failed, as it must.** 21 criteria unmet — the most of any run in the repo.

| criterion | bar | actual |
|---|---|---|
| profit factor | > 1.3 | **0.751** |
| sharpe | > 1.0 | −0.057 |
| sharpe t-stat | > 2.0 | −2.72 |
| sharpe LCB (95%) | > 0.3 | −0.098 |
| symbols passing alone | ≥ 60% | 0/5 |
| cost survival | ≥ 40% | failed |
| account survived | required | failed |

**Basis note (2026-09-28).** `total_return_pct` (−72.89) and `max_drawdown_pct`
(74.33) were re-measured on this control's latest v1 run after the portfolio
model moved to an equal-weight additive book — return is the mean of the five
per-symbol returns, max drawdown is the drawdown of the pointwise-averaged
equity curve. The superseded figures (−99.91% and 81.43%) came from a 5×-geared
pooled replay and must not be mixed with these. Trades, profit factor, Sharpe
and the `fail` verdict are unchanged: they are per-run quantities and do not
depend on the portfolio basis, so the noise-floor calibration this card exists
to provide is unaffected. The `symbols passing alone` row above reads 0/5 on the
current run, as the registry records it.

**Basis note (2026-09-29).** The v1 archive was regenerated under a protocol
carrying a 19th threshold constant, `MIN_WF_COVERAGE: 100` — the walk-forward
fold coverage criterion, which passes on all ten cards — and with the
`beats hold in <reg>` benchmark corrected to compound rather than sum, which
lifted the bull-regime hold bar from 0.88% to 630.63%. This control takes no
bull trades at all, so that change costs it nothing: `beats hold in bull` was
already unmet, `unmet` holds at 21 — still the most of any run in the repo — and
only `protocol_hash` moves, to `31ca181720e76199`. Trades, profit factor, Sharpe,
`total_return_pct` and `max_drawdown_pct` are unchanged per-run quantities, so the
noise-floor calibration this card exists to provide is unaffected.

**Basis note (2026-09-29, second run).** The archive was regenerated again, on a
**new experiment lineage rather than a threshold change**: `protocol.v1.json`
became the single source of truth for the experiment, gaining `data.as_of` and
`risk.allow_fractional`, with its `note` rewritten — so the hash moved to
`a23de729e9a08dcd` as a consequence of that reorganisation, not of any criterion
moving. All 19 criteria are unchanged, and every recorded figure on this control
is identical to the previous run: `unmet` holds at 21 — still the most of any run
in the repo — trades 2,270, profit factor 0.751, Sharpe −0.057,
`total_return_pct` (−72.89) and `max_drawdown_pct` (74.33) are unchanged per-run
quantities, and the verdict is still `fail`. The noise-floor calibration this
card exists to provide is unaffected.

### The one thing this card is also evidence for

This strategy was run **twice**. Both runs produced *identical* metrics — 2,270
trades, profit factor 0.751, Sharpe −0.057, t-stat −2.72. The runs differ in
exactly one field of the `notes` string:

```
leakage FAILED
leakage clean
```

Identical results, opposite leakage verdicts. The interpretation matters: a
strategy with no predictive content has no future information to leak, so
detecting a leak in it and detecting no leak in it cannot change the outcome.
The two observations are therefore consistent with a **conservative detector**
flagging a suspicious pattern that happens to be harmless here.

That is a result about the detector, and it is the reason `research/leakage.mjs`
is treated as a hard disqualifier rather than a soft advisory. It also means
that a leakage flag on a real strategy must be investigated, not waved away as
a false positive on the grounds that the numbers looked fine — for this control
the numbers were fine *because* there was nothing to leak.

The full list of unmet criteria is in
`research/registry/_control_random/runs.jsonl` under `failed`.

## Why it failed

For the same reason C-001 failed, and by a similar margin, which is the
comparison that gives this card its value: PF 0.751 here versus 0.837 there,
with everything except how the side is chosen held fixed.

A random side is, if anything, slightly *worse* than a constant long side over
this window, and the reason is visible in the numbers. The asset drifted upward
across 400 days, so always-long occasionally got a free ride from beta. A random
side captured that drift only half the time and paid two-way costs on the other
half. **PF 0.751 is therefore a lower bound on what "no information" costs when
there is a positive drift to bleed, and 0.837 is the same thing measured against
a side that never shorted.**

This is worth stating because it means the two controls bracket the real
strategies rather than sitting under them:

```
_control_random    0.751   <- no information, half the drift
_control_alwayslong 0.837  <- no information, all the drift, always long
sma-cross          1.013   <- a trigger with a little information
gate requires      1.300
```

The margin between the best hypothesis and the controls is 0.18 of profit factor.
The margin to the gate is 0.29. The controls are not a formality in this repo —
they are the calibration that gives 1.013 its meaning.

## What we learned

- **The noise floor is around profit factor 0.75–0.84, not 1.0.** A trade
  stream with no information does not score 1.0 on this harness; it scores below
  it, because costs are charged on both sides of a churn-heavy trade stream.
  Every profit factor in the repo should be read against that band. This is the
  single most useful calibration in the whole set.
- **Consequently, `sma-cross` at 1.013 is above the random baseline and still
  nothing.** It is not "the best candidate" — it is a draw that landed slightly
  high, and the t-stat of −1.02 says the measurement cannot distinguish it from
  the controls.
- **More unmet criteria than any real strategy.** 21 versus 20. The controls
  fail the gate harder than the hypotheses do, which is the correct ordering and
  a direct check that the criteria are not secretly rewarding trade count.
- **The double run was worth the time it cost.** It surfaced the leakage
  detector's behaviour on a signal where leakage is definitionally impossible,
  which is a fact we could not have obtained any other way.
