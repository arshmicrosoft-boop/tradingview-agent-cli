---
id: C-001
name: always long control
slug: alwayslong
status: falsified
code: research/strategies/_control_alwayslong.mjs
protocol: v1
protocol_hash: 1e42a7d31d851b9b
tested_at: 2026-09-27
dataset: BTC/ETH/DOGE/SOL/ZEC · 15m · 400d · 38,401 bars each · 0 gaps
trades: 2278
profit_factor: 0.837
sharpe: -0.028
max_drawdown_pct: 83.03
total_return_pct: -99.77
gate: fail
unmet: 20
---

# always long control

**Not a hypothesis. A ruler.** This strategy returns `{ side: "buy" }` on every
bar it is flat. It has no possible edge, and it exists to prove that the gate
rejects things that have no possible edge.

It fails. That is the entire point, and it is worth stating plainly: **a gate
that cannot reject a strategy with no information in it is not measuring
anything.** This run is the evidence that the 20 unmet criteria on the five real
strategies are measurements rather than a gate that fails everything.

## Hypothesis

```yaml
name: unconditional long exposure

market_mechanism: >
  This is the control, so the honest answer is that there is no mechanism. The
  strategy asserts that holding the asset unconditionally, rebalancing on a fixed
  clock, captures a positive drift.

why_should_it_exist: >
  It should not, and it does not. Its only reason to exist is to occupy the "long
  only" cell of the experiment grid with something known to be worthless, so that
  the cell is proven to be tested rather than assumed. The asset does have a
  positive realised drift over 400 days, which is precisely what makes this a
  useful control rather than a trivially bad one: it isolates the effect of
  *rebalancing into and out of* a position, and the cost of that rebalancing, from
  the effect of the drift itself.

expected_regime: >
  Should fail everywhere. If this ever passes, the gate is broken, the data has a
  lookahead leak, or the cost model is not being applied — all three are
  disqualifying findings about the instrument rather than about the market.

required_data: >
  OHLCV only. No strategy signal of any kind is read.

failure_condition: >
  The control passes the gate. This is the one card in the repo where a PASS is
  the alarming result. Anything above profit factor 1.0 here means the evaluator
  has rewarded a signal with zero information content, and every other number in
  the repo becomes untrustworthy.
```

## Rules as numbers

```
IF   flat
THEN buy on the next bar's open
```

No condition. No parameters. The `grid` is empty, which is correct: there is
nothing to vary.

Exit is owned by the simulator — 2×ATR stop, 96-bar time out.

## When to use

- **Regime:** never, in any market. This is not a trading rule.
- **Horizon:** a position is re-entered on the next flat bar, so the holding
  period is bounded by the stop or the 96-bar time exit and averages far below
  it, given how often the 2×ATR stop is hit first.
- **Sizing:** risk engine, as with every other strategy.

## When not to use

- **Always.** Do not trade this, and do not cite it as a baseline for anything
  except one specific claim: that buy-and-hold-with-rebalancing loses to drift
  after costs in this sample.
- **Confusion risk:** it is a strict subset of `long-with-stop`. Both return
  `{ side: "buy" }` unconditionally and produce identical metrics — 2,278
  trades, Sharpe −0.028, profit factor 0.837. The only difference is that
  `long-with-stop` exports a `grid` and this one does not. One of the six rows in
  the root result table is this control wearing a different name, which is why
  the count of distinct hypotheses is five and not six.

## Result under v1

**Failed, as it must.** 20 criteria unmet.

| criterion | bar | actual |
|---|---|---|
| profit factor | > 1.3 | **0.837** |
| sharpe | > 1.0 | −0.028 |
| sharpe t-stat | > 2.0 | −1.34 |
| sharpe LCB (95%) | > 0.3 | −0.069 |
| symbols passing alone | ≥ 60% | 1/5 |
| cost survival | ≥ 40% | failed |
| account survived | required | failed |

The full list of unmet criteria is recorded verbatim in
`research/registry/_control_alwayslong/runs.jsonl` under `failed`, which is the
authoritative copy. The card summarises; the registry decides.

## Why it failed

Because there is nothing to fail with. The signal is a constant, so the trade
stream it produces is the same stream you would get by flipping a fair coin on
the side and then paying 15 bps each way to do it.

Three things are worth separating, because conflating them is the most common
misreading of this repo:

1. **The signal failed.** There was no signal. This is not a hypothesis that was
   refuted; it is the null case, measured.
2. **The cost model worked.** 15 bps per round trip against a stream that must
   re-enter every time it exits is exactly the mechanism that produced PF 0.837
   instead of 1.0. That is the cost model doing its job.
3. **The risk envelope finished the job.** The 1%-risk, 10×-leverage
   configuration turned a mildly negative expectancy into −99.77% and a circuit
   breaker. A strategy cannot choose a better outcome once its expectancy is
   negative, and no amount of position sizing changes the sign of the edge.

So the failure is total and uninformative *about the market* — which is the
point. It is highly informative *about the instrument*, which is why it exists.

## What we learned

- **Profit factor 0.837 is the number that gives the other rows meaning.** A
  long-only strategy with no signal whatsoever lost ~16% of its gross win/loss
  ratio to costs and whipsaw. Any real strategy must clear that bar, not 1.0.
- **Sharpe −0.028 over 2,278 trades.** The absence of an edge is measured here
  with the same precision as its presence would be.
- **The risk envelope, not the signal, produced the −99.77% return.** A 1%-risk,
  10×-leverage configuration applied to a signal with negative expectancy
  compounds to ruin. This is the clearest single illustration in the repo that
  the drawdown column measures the envelope, and the profit factor measures the
  signal. Read them separately or you will misread every row in the table.
- **`long-with-stop` is a duplicate of this control.** Not a near-duplicate — the
  same signal, producing byte-identical metrics. It should not be counted as a
  distinct hypothesis, and the fact that it was is a reminder that a registry
  needs a linter.
