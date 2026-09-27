---
id: P-001
name: serial-correlation sign flip
slug: serial-correlation-sign-flip
status: falsified
code: none
measured_by: research/regime-audit.mjs
---

# serial-correlation sign flip

**KILLED AT THE MEASUREMENT STAGE, 2026-09-27. No strategy was ever written.**

`research/regime-audit.mjs` tested the card's central claim directly — is the
sign of short-horizon return autocorrelation state-dependent *and knowable in
advance*? — before any trading rule was coded. The answer was no, and the
answer came from this card's own primary failure condition. See
**Result under v1** below.

The reason for measuring first: this claim is a statement about the data, not
about a trading rule, and it costs a minute of compute to test. Writing the
strategy first would have produced a full gate run on a card that was already
dead, and would have spent the run interpreting P&L instead of the one number
that mattered.

**Do this one next.** This is the only card in the backlog that attacks a hole
in our own experiment design rather than adding another trigger to it. It is
also the only one that explains our existing null result instead of ignoring it.

## Hypothesis

```yaml
name: state-dependent sign of short-horizon return autocorrelation

market_mechanism: >
  The sign of short-horizon return autocorrelation in cryptocurrency is
  state-dependent, not fixed. Two distinct regimes are present in any 400-day
  window and both are observable in advance. When information diffuses gradually
  and participants herd, autocorrelation is positive: a price that has moved
  keeps moving while the news is absorbed. When a liquidity-demand shock hits and
  participants overreact, autocorrelation is negative: the overshoot unwinds. A
  strategy with a fixed sign averages these two opposing effects to
  approximately zero.

why_should_it_exist: >
  There are two real counterparties, one per regime, and neither is a
  discretionary opinion. In the trending regime the counterparty is the
  participant who is slow to react — a longer-horizon holder who is
  price-insensitive and therefore provides the liquidity that lets the
  continuation happen. In the reverting regime the counterparty is the forced
  seller: a liquidation, a risk-limit cut, or a scheduled rebalance that must
  transact regardless of price, which is what creates an overshoot to revert.
  The reason this should beat a fixed sign is that the fixed-sign strategies
  paid the cost of both sides in every regime, which is exactly what a profit
  factor of 0.84 for long-only and 0.64 for short-only looks like when you add
  them together.

expected_regime: >
  Should work when the estimated autocorrelation is positive, and should work
  with the sign reversed when it is negative. It should do WORSE than a fixed
  sign if the regime estimate is not stable, because then the strategy is
  flipping direction on estimation noise and paying two-way costs to do it. The
  regime must be knowable from data available strictly before the entry bar; if
  the classification is only correct in hindsight, the mechanism is real but the
  edge is not tradeable, and that is still a null result.

required_data: >
  OHLCV only. Uses closes to estimate autocorrelation and ATR to normalise
  thresholds. Representable under protocol v1 — but see the estimator warning
  below, which is the real risk on this card.

failure_condition: >
  The estimated correlation sign changes more often than it holds, OR the
  strategy's profit factor is not materially above the better of the two
  fixed-sign variants. Either outcome means the regime is not measurable in
  advance, and "the edge exists but you cannot tell which regime you are in" is
  not an edge. Note the second clause is a high bar on purpose: beating a
  fixed-sign variant that scored 1.013 requires clearing the ~0.75–0.84 control
  band by a wide margin, not landing at 1.05.
```

## Why this card exists

**The hole:** five of six tested strategies were long-only, and the sixth was
short-only. We varied the trigger five times and the *sign* zero times. Every
single result is therefore a measurement of a fixed-sign strategy, and a
fixed-sign strategy is guaranteed to lose if the true sign varies.

**The evidence that both signs lose:**

| variant | trades | PF | Sharpe |
|---|---|---|---|
| `_control_alwayslong` (pure long) | 2278 | 0.837 | −0.028 |
| `sweep-reversal` (pure short) | 1565 | 0.64 | −0.138 |
| `sma-cross` (mildly informative trigger) | 1984 | 1.013 | −0.023 |

Both signs are negative. The only variant that got near 1.0 is the one whose
trigger carried a little information — which is a reason to suspect the
information, not the sign, was the binding constraint. Averaging a mechanism
that is sometimes positive and sometimes negative is exactly what produces a
profit factor indistinguishable from the random control at 0.751.

**Why I believe it more than the other five cards:** it is the only one that
predicts our existing result. Every other card in the backlog needs the null
result to be wrong. This card needs it to be right.

## The main risk, stated up front

**Estimating autocorrelation from 15m bars is statistically treacherous, and
this is the most likely way the card dies.**

The naive sample autocorrelation is severely biased toward zero when the data is
noisy (Lo & MacKinlay 1988). A biased estimator produces a sign that flips on
noise, and a strategy that flips its sign on noise pays the full round-trip cost
every time it flips. The failure mode is not a small loss — it is a strategy
that is measurably worse than either fixed sign.

Therefore this card specifies a **variance-ratio estimator over a long window**
rather than a simple lag-1 correlation, and the failure condition is about
estimator stability rather than about profit. The gate's parameter-sensitivity
criterion is the other line of defence: a regime classifier that is knife-edged
will fail it.

## Rules as numbers

```
# --- regime estimate, computed on bars[0..i] only, never forward ---
lookback   = 200              # bars, must cover ~4 days at 15m
q          = 5                # aggregation period for the variance ratio
rets       = diff(close) over the lookback window
sigma2_1   = variance(rets,  ddof=1)
sigma2_q   = variance(aggregated q-period returns over the same window, ddof=1)
VR(q)      = sigma2_q / (q * sigma2_1)

# VR > 1 => trending. VR < 1 => mean-reverting. The sign of (VR - 1) is the state.
# Classify only when the estimate is far enough from 1.0 to not be estimation
# noise; otherwise stand aside and take no trade.
edge_q     = 0.10             # VR must be > 1.10 or < 0.90 to act
eps_atr    = 0.25             # re-entry threshold, in ATR units

IF   flat
AND |VR(q) - 1| > edge_q
THEN side = buy  IF VR(q) > 1        # trending: take continuation
     side = sell IF VR(q) < 1        # reversion: fade it
AND (close - ema(close, 20)) / ATR(14) has the same sign as side * eps_atr
THEN enter on the next bar's open
```

The final `eps_atr` condition is a filter, not a threshold on the regime: it
avoids entering on a bar that has not yet moved far enough to be worth the
round trip. It is deliberately expressed in ATR units — see P-002 for why raw
price units are a measurement defect in this sample.

| param | default | grid to test |
|---|---|---|
| `lookback` | 200 | {100, 200, 400} |
| `q` | 5 | {4, 5, 10} |
| `edge_q` | 0.10 | {0.05, 0.10, 0.20} |
| `eps_atr` | 0.25 | {0.15, 0.25, 0.40} |

**Expected trades: ~1,500** across the 5 symbols — comfortably above the gate's
500 minimum, which matters because the `edge_q` stand-aside rule will cut the
firing rate substantially from the 1,984 that `sma-cross` produced.

## When to use

- **Regime:** only when the variance ratio is confidently off 1.0. The strategy
  is designed to be flat most of the time, and standing aside is a position, not
  a failure.
- **Horizon:** 96-bar time exit = 24 hours, owned by the simulator. The regime
  estimate is recomputed each bar, so the position can be held through a
  regime change — the simulator does not read a signal while a position is
  open, so a mid-trade regime flip will be acted on only at exit.
- **Sizing:** risk engine. Note the signal would prefer a wider stop in high-vol
  regimes; the fixed 2×ATR stop cannot express that, and this is a known
  limitation of testing it under v1.

## When not to use

- **When the variance-ratio estimate is near 1.0.** The `edge_q` stand-aside is
  the whole design. Removing it to increase trade count converts the card into
  the fixed-sign strategy that already failed.
- **In a market where the autocorrelation is genuinely constant.** Then this is
  strictly worse than a fixed sign, because it pays estimation risk for no
  benefit. There is no way to know in advance, which is why the failure
  condition is written against the fixed-sign comparison.
- **Confusion risk:** a variance-ratio value near 1.0 on a choppy market, and a
  slow-moving trend filter, produce superficially similar "mostly flat"
  behaviour. They are distinguishable by *why* the strategy is flat: this one
  is flat because the estimate is uninformative, not because price has not
  moved. Check the VR distribution before concluding the card did nothing.

## Result under v1

Measured with `node research/regime-audit.mjs` (15m, 400d, 5 symbols, n=955
de-clustered samples). **No strategy file exists; `code: none`.**

The decisive quantity is sign agreement of the VR(5) classification across a
full 200-bar window — the shortest interval at which the two windows share no
bars:

| persistence measure | agreement | coin |
|---|---|---|
| consecutive classified bars | **40.5%** | 50% |
| sign agreement at lag 200 (disjoint windows) | **53.0%** | 50% |

**The sign does not persist.** It agrees with itself one window later barely
more often than a coin, and on the consecutive measure it agrees *less* often
than a coin. This card's primary failure condition — *"the estimated
correlation sign changes more often than it holds over a 200-bar window"* — is
met exactly.

Two findings that would have been reported as a result if the samples had not
been de-clustered, and are recorded here so they are not rediscovered:

1. **On overlapping samples the trend state looks excellent.** Raw sampling
   (n=51,576 from 192,000 bars, 200-bar windows overlapping 199/200) gave the
   trending state a mean +20-bar return of +0.083% at **t = +8.99**. De-clustered
   to disjoint windows the same state reads **t = −1.38**. The entire apparent
   effect was sample overlap. This is the most dangerous error class in this repo
   and it produced a t-statistic that looked like a discovery.
2. **The surviving difference runs backwards.** De-clustered, the reverting
   state returns *more* than the trending state (+0.273% vs −0.159%, difference
   t = −2.88) — the opposite of the card's mechanism. **This is not a new
   hypothesis.** The classifier is measurably near-noise (53% self-agreement),
   the samples number ~680, and it is one comparison out of many. Dressing a
   backwards sign in a mechanism is the exact failure this repo exists to catch,
   so it is recorded and discarded rather than promoted to a card.

## What we learned

- **Measure a card's central claim before writing its strategy.** The mechanism
  here was a claim about serial dependence, and that claim was falsifiable with
  no P&L, no exit model, and no costs. A gate run would have produced 20
  criterion lines and answered none of them as directly as one agreement
  statistic.
- **De-cluster every statistic before quoting a t-statistic.** Overlapping
  windows inflate n and shrink the standard error, and the inflation is
  indistinguishable from signal once it crosses ±2. A t of 8.99 became −1.38
  purely from disjointing the samples. This applies to the event statistics in
  `research/events.mjs` too, and to anything else computed on a trailing window.
- **Always compare an event against the unconditional baseline, never against
  zero.** The first run of `research/events.mjs` reported a volatility-expansion
  effect at t = +2.10 and +2.17. It had no baseline: those were *raw* returns
  against a window where drift was itself +0.044% to +0.120% per horizon. With
  the baseline subtracted the same events read t = +0.18 and −0.21. A positive
  number that is smaller than the market's own drift is a negative signal
  wearing a positive sign.
- **A near-noise classifier can still produce a t-stat above 2 by chance.**
  53% self-agreement means the state carries almost no information, and any
  conditional comparison built on it should be believed only after it survives
  a multiple-comparison correction. Ours would not.
- **The backlog's one "design hole" card is now closed, and it closed honestly.**
  Five triggers had been varied and the sign zero times. The answer turned out to
  be that the sign is not a free parameter to be estimated — it is not stable
  enough to estimate, so the entire family of "flip the sign" ideas is closed
  off, which is what the card predicted would be the more informative outcome.

## Why it failed

The sign of the estimator is not stable enough to trade on. Measured across
disjoint 200-bar windows, VR(5) agrees with its own sign one window later
**53.0%** of the time — three points above a coin — and on the consecutive
measure it agrees **40.5%** of the time, *below* a coin. A classifier that
cannot predict its own state one window ahead cannot select a side, and a
strategy that flips its sign on estimation noise pays the full round trip on
every flip, which is worse than either fixed sign.

That is this card's own primary failure condition, met exactly, and it is the
death the card named as most likely. The secondary condition was never reached
because no strategy was ever written — which is the outcome the sequencing was
chosen to produce.

## Why it was proposed

Cited numbers, not intuition: `_control_alwayslong` PF 0.837 (2,278 trades) and
`sweep-reversal` PF 0.64 (1,565 trades) are the two fixed signs, and both lose.
`sma-cross` at PF 1.013 over 1,984 trades is the only trigger that beat the
random control band of 0.751–0.837 at all, and it still failed with a Sharpe
t-stat of −1.02.

The specific observation is that **five triggers were varied and the sign was
varied zero times.** That is a gap in the experimental design, not a market
fact, and it is the cheapest hole in the repo to close.

## What would falsify it

**The primary condition below is the one that fired.** Kept verbatim as the
pre-registration record, because a falsification that is edited after the fact
is not evidence of anything.

- **Primary:** the estimated sign changes more often than it holds over a
  200-bar window. The regime is not knowable in advance and the card is dead.
  → **FIRED. Measured 53.0% self-agreement at lag 200; 40.5% consecutive.**
- **Secondary, and the more informative failure:** profit factor lands at or
  below the better fixed-sign variant (1.013). This would say the trigger
  information was never there and the null result was correct — closing off the
  entire family of "flip the sign" ideas, which is worth more than a pass.
  → Not reached; no strategy was written. The family is closed anyway, because
  the primary condition already established the sign is not estimable.
- **Most informative single gate criterion to watch:** parameter sensitivity.
  A regime classifier that is profitable at one `edge_q` and not at its
  neighbours is a fitted artifact, and this card is exactly the kind that
  invites one.
