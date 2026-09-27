---
id: P-003
name: selectivity on a falsified trigger
slug: selectivity-on-falsified-trigger
status: queued
code: none
---

# selectivity on a falsified trigger

**This is an experiment design, not an idea.** Its job is to answer one question
— is a fixed trigger worthless, or is it a real trigger we have been reading at
the wrong moments? — and either answer is acceptable. The second answer is worth
more than the first, because it closes off an enormous space of proposals that
have not been written yet.

It is queued third, not first, and it will stay third even if the backlog
empties. P-001 and P-002 are attempts to find something. This is an attempt to
stop wasting effort on something.

## Hypothesis

```yaml
name: >
  selectivity on a falsified trigger

market_mechanism: >
  A trigger can carry directional information and still lose money, if it is read
  in states where that information is not expressed. sma-cross fires when
  fast > slow. The informational content of that crossing depends on how far
  apart the two averages are relative to current noise: a 20/50 gap of 0.2 ATR
  and a gap of 1.5 ATR are the same boolean and very different amounts of
  evidence. We tested the boolean and discarded the magnitude on the way in. A
  pooled profit factor over 1,984 trades cannot separate a trigger with no
  information from a trigger with information that has been averaged against
  itself 1,984 times at arbitrary moments.

why_should_it_exist: >
  There is no counterparty claim here, and dressing this card up as one would be
  a mistake. What it has instead is an opponent in our own test design:
  `sma-cross` returned PF 1.013 over 1,984 trades with a Sharpe t-stat of −1.02
  and a 95% LCB of −0.067. That is a tight confidence interval around zero, and
  a tight interval around zero is consistent with two entirely different worlds
  — a trigger carrying nothing, or a trigger carrying something that a
  single-sign, always-on, unfiltered application has averaged to nothing. The
  pooled statistic cannot tell them apart. A pre-registered selectivity ladder on
  the identical trigger can, and that is the entire reason this card exists.

expected_regime: >
  Two outcomes, both acceptable, and the card is built so that neither reads as
  a failure. (1) Expectancy per trade rises as selectivity tightens, and does not
  rise by the same amount on _control_random: the trigger is informative,
  frequency was the cost, and every high-frequency trigger in the backlog becomes
  a filter candidate. (2) Expectancy per trade is flat or worse as selectivity
  tightens, and _control_random shows the same slope: the trigger is noise, no
  filter rescues it, and the "find the right filter on a fixed trigger" family is
  closed for the rest of the programme. It should NOT be expected to pass the
  gate, and that is deliberate — the gate requires trades >= 500 and PF > 1.3,
  and a diagnostic that answers its question at 200 trades is worth running even
  though the gate would reject it on sample size alone. It should NOT be read as
  a strategy in any circumstance, including in outcome (1).

required_data: >
  OHLCV only, plus the two control streams already in the repo: _control_alwayslong
  (2,278 trades, PF 0.837) and _control_random (2,270 trades, PF 0.751). The
  controls are the point rather than a formality. A filter that lifts expectancy
  on a random stream will lift it on any stream, and without a control arm the
  slope is uninterpretable. Same five symbols, 38,401 bars each, 192,005 bars
  total, 0 gaps. Fully representable under v1.

failure_condition: >
  Two distinct falsifications, and the one that matters is decided by the control
  arm, not by the strategy arm. (a) Per-trade expectancy is flat or worse at
  tight selectivity AND the same ladder on _control_random shows the same slope:
  the trigger is noise, the filter is selecting on trendiness which every stream
  has, and no filter can rescue a trigger. (b) Per-trade expectancy is flat or
  worse AND the random control's slope is also flat: the filter is selecting on
  nothing at all, which is the weaker and far less general conclusion. If
  expectancy rises on sma-cross but rises by the same amount on _control_random,
  that is case (a) wearing case (b)'s clothes and must be reported as (a).
```

## Rules as numbers

The trigger is held bit-identical to T-001 so the filter is the only difference
between the two runs.

```
fast = SMA(close, 20)                  # frozen at the T-001 value
slow = SMA(close, 50)                  # frozen at the T-001 value
atr  = ATR(14)

sig = fast > slow                      # the falsified trigger, unmodified
gap = (fast - slow) / atr              # the magnitude the boolean discarded

q = { L0: 0.00, L1: 0.10, L2: 0.25, L3: 0.50, L4: 1.00 }

IF   sig
AND  gap >= q[L]
THEN buy on the next bar's open

# reported per L, never pooled:
#   trades[L]     printed for every L, including the arms that fall below 500
#   expectancy[L] = sum(pnl[L]) / trades[L]
#   slope         = OLS coefficient of expectancy[L] on log(trades[L])
#
# primary readout : slope, and its sign
# control readout : the same slope computed on _control_random
# verdict         : compare strategy slope against control slope, not against 0
```

`L0` is `sma-cross` itself and must reproduce PF 1.013 over 1,984 trades. If it
does not, the harness differs from T-001's and the ladder is measuring that
difference instead of selectivity.

Second arm, pre-registered and singular: the P-001 autocorrelation-sign filter,
so that a null on the gap ladder is not confounded with "this particular filter
happened to be the wrong one". One arm, fixed in advance, no tuning. Two arms is
already a filter search.

| param | default | grid to test |
|---|---|---|
| `L` (selectivity level) | L2 | L0–L4, all five points required — the ladder **is** the experiment |
| `q` (gap threshold, ATR units) | 0.25 | {0.00, 0.10, 0.25, 0.50, 1.00} |
| `fast` | 20 | **not swept** — frozen at the T-001 value |
| `slow` | 50 | **not swept** — frozen at the T-001 value |

Sweeping `fast` and `slow` here would confound the diagnostic with an indicator
sweep, which `AGENT.md §6.9` already names as curve fitting in disguise. Sweep
the filter, never the trigger — a trigger sweep turns a clean yes/no into a
favourite number.

Expected ~600 trades at the tight end, against 1,984 at `L0`.

## When to use

- **Regime:** none. This is a research instrument and has no operating regime. If
  it ever acquires one, it has been mistaken for a strategy.
- **Horizon:** inherits T-001's exit exactly — 2×ATR(14) stop, 96-bar max hold,
  one open position. `L0` fires roughly once per 19 bars, which is churn, and
  part of what the ladder measures is how much of that churn was self-cancelling.
- **Sizing:** not applicable. The readout is expectancy per trade, not P&L, and
  sizing the ladder would destroy the comparison it exists to make. Run the arms
  at identical protocol risk settings and compare the per-trade figure.
- **Run it when the next filter idea arrives.** Before proposing filter X on
  trigger Y, the honest prior is that the answer is (a) — noise — because that
  is what this card is designed to establish. Skipping it does not save time; it
  just moves the discovery to a more expensive place.

## When not to use

- **Do not use it as a strategy, especially if it turns out profitable.** A
  diagnostic that happens to make money is still a diagnostic. Outcome (1) buys
  permission to test filters; it does not buy a position.
- **Do not read a gate rejection below 500 trades as a refutation.** The gate
  measures whether a strategy is real. This card asks whether a trigger family is
  worth further effort. Those are different questions and they will disagree.
- **Confusion risk:** rising expectancy on a shrinking sample is the standard way
  to manufacture a fake edge. Expectancy variance grows as the trade count falls;
  a single arm at 200 trades can show twice the expectancy of `L0` by luck. The
  `L0` reproduction and the random-control arm are the only things standing
  between this card and a false positive, and neither is optional.
- **Confusion risk:** a slope on a *single* filter family is a statement about
  that family. It is not a statement that selectivity in general is useless. The
  two arms bound the claim; more than two would be a search.

## Why it was proposed

`sma-cross` is the most informative card in the repo and it is a negative.
PF 1.013, Sharpe −0.023, t-stat −1.02, LCB −0.067, 1,984 trades, 1/5 symbols
passing alone, 20 criteria unmet. A t-stat of −1.02 over 1,984 trades is not
"not enough data" — it is a tight interval around zero, and that tightness is
precisely what makes the pooled figure ambiguous between the two worlds above.

Three specific numbers make this urgent rather than tidy:

1. **The noise floor here is 0.75–0.84, not 1.0.** `_control_random` returned PF
   0.751 over 2,270 trades and `_control_alwayslong` 0.837 over 2,278. So
   `sma-cross`'s 1.013 is marginally above a random trade stream, not above
   breakeven. Every future filter result will be measured against that floor.
2. **21.3% win rate under a 2×ATR stop requires a 3.3:1 average win/loss.** No
   result in the table supports that ratio. High churn plus a low win rate is
   what a zero-expectancy signal looks like when forced to trade often — and
   "forced to trade often" is exactly the variable this card varies.
3. **Win rate clustered at 16–23% across six unrelated triggers.** That cluster
   is a property of the shared exit, not of the triggers. Per-trade expectancy is
   the readout chosen here precisely because it is the quantity the shared exit
   does not dominate.

Reasoning beyond the data: the repo has never run a selectivity ladder on
anything. We therefore have no measurement of whether a filter applied to a fixed
trigger has any effect at all, which means every filter idea proposed from here
on inherits an unexamined assumption. This card is the cheapest place to examine
it.

## What would falsify it

If per-trade expectancy is flat or worse at high selectivity, and the same ladder
applied to `_control_random` shows the same slope, then the trigger is noise and
no filter can rescue it.

- **Most informative failure:** that combination. It is a *comparative* result,
  not an absolute one, which is why the control arm is not optional — an
  absolute null on a single stream cannot distinguish "no information" from "this
  filter is wrong", and only the first of those closes the family.
- **Most likely gate failures:** `trades >= 500` at the tight end of the ladder,
  and `profit factor > 1.3` if the trigger turns out to carry real information.
  These pull against each other by design, and the tension is deliberate.
  Targeting ~600 trades is the compromise: it sits above the 500 floor at the
  default `L2`, and going far below it means the gate rejects on sample size
  regardless of quality. In the most likely version of this card, the interesting
  arms are the ones the gate refuses.
- **Less interesting than all of the above:** a result that "makes money". If
  expectancy rises and PF clears 1.3 at 600 trades, the correct response is
  still to treat it as a diagnostic finding about frequency, not as an edge, and
  to require a second independent run before anyone writes a card proposing to
  trade it. The card's success criterion is a reported slope with a control arm
  attached — something the gate does not measure at all.
