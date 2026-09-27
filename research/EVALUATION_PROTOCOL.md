# Evaluation Protocol v1 — FROZEN

**Status:** frozen. Machine-readable source of truth: [`research/protocol.v1.json`](research/protocol.v1.json)
**Hash:** `1e42a7d31d851b9b` (recompute with `node research/protocol.mjs`)

This document explains *why* the protocol is the way it is. The JSON is what the
gate actually reads — if they ever disagree, the JSON wins and this file is stale.

---

## What a protocol is for

A protocol is a decision made **before** seeing the results, about what counts as
success. Without one, "this strategy works" is unfalsifiable: after seeing the
P&L you can always invent a criterion it happens to satisfy, and always find a
reason the one it fails is unimportant.

The hash exists so that this cannot happen quietly. Change a threshold and the
hash changes, and every run recorded under the old hash becomes visibly
incomparable rather than silently re-used as supporting evidence.

---

## The five ways a backtest lies

Every criterion below targets one of them.

| # | The lie | What catches it |
|---|---------|-----------------|
| 1 | *It peeked at the future* | `leakage.mjs` — future-index access, whole-sample statistics, append-invariance |
| 2 | *It only works on one coin* | per-symbol verdicts, `MIN_SYMBOL_PASS_RATE` ≥ 60%, more than one symbol required |
| 3 | *It's just the market's beta, dressed up* | regime-matched buy-and-hold benchmark in bull/bear/sideways + Calmar |
| 4 | *It dies at realistic costs* | cost stress across a 9-level fee×slippage grid, survivable-cost requirement |
| 5 | *It got lucky* | Monte Carlo ruin, Sharpe t-stat, Sharpe LCB, walk-forward consistency, holdout degradation |

### 1. Data leakage

`auditLeakage` runs three hard checks:

- **futureAccess** — the simulator refuses to hand a signal a bar index beyond
  the current bar, so a signal that tries throws and is caught. A throw is
  treated as a leak, not as a bug to be papered over.
- **futureAppend** — a strategy's *past* behaviour must not change when future
  bars are appended. This catches "the mean of the whole series", which is
  invisible to future-index checks because it never indexes forward.
- **warmupDiscipline** — no trades may come from a series shorter than the
  configured warmup.

One check is deliberately **soft**: `timestampIndependence`. Reading the current
bar's timestamp is legitimate — "only trade Tuesdays" is a real strategy. But a
signal that works *because of* the specific timestamps it was tuned on is fitted
to the clock rather than the market. That is recorded as an **ADVISORY** and
surfaced in the verdict, not used as a disqualifier. Reading a future bar is
mechanically inexcusable; calendar dependence is a judgement call a human
should make.

### 2. Per-symbol universes

Each symbol gets an independent verdict (`profitFactor > 1 && sharpe > 0 &&
not ruined`). A strategy must clear **60%** of symbols, and at least **2**.

This exists because a single-symbol result is indistinguishable from a
coincidence. Requiring 2 independent symbols is a weak form of evidence
independence, and it is deliberately weak — strong enough to kill the common
failure, weak enough not to pretend to be a statistical test.

### 3–4. Benchmark and cost

Buy-and-hold is computed **on the same bars, in the same regime slices**, and
the strategy must beat it risk-adjusted (Calmar ≥ 1) in bull, bear, *and*
sideways. Beating the index in one regime and losing in two is beta, not edge.

Costs are stressed over `fee × slippage ∈ {1,2,5}³` — nine levels. The strategy
must survive a realistic level, and its maximum survivable cost must exceed a
configurable minimum (default 20 bps combined). A strategy that dies at 5 bps
is not tradeable.

### 5. Robustness

Sharpe must clear **0.5** with a **t-stat ≥ 2**, and the **95% lower confidence
bound** must be positive. A Sharpe of 0.8 that could easily be 0.1 does not
count. Drawdown must be bounded, walk-forward consistency ≥ 50%, and the
holdout must not degrade by more than 50% versus train.

---

## Negative controls — the part most harnesses skip

Two strategies exist that have *no possible edge*:

- `_control_random` — seeded pseudo-random, fully deterministic
- `_control_alwayslong` — unconditional buy-and-hold, no exit logic

They are deterministic, so they reproduce exactly. `research/controls.mjs`
asserts that **no control has ever passed the gate**, and that each control
actually traded — a control that never trades would be rejected vacuously and
prove nothing about the gate's ability to reject a real claim.

**If a control is ever promoted to champion, the gate is defective, not the
control.** This is the single most informative test in the repository: it
examines the *evaluator* rather than another strategy, and it runs in seconds.

Current status: both controls rejected, 0 passed, both traded 2000+ times.

---

## Champion / challenger

Every run is appended to `research/registry/<id>/runs.jsonl` with its
`protocol_hash`, `dataset_hash`, and `strategy_hash`. The champion is the best
run that has actually **passed** under the current protocol hash. Runs under a
different protocol hash are retained for the record but can never become
champion — they are a different experiment, not a comparison.

Current status: **no champion.** Four recorded runs, zero passes.

---

## Honesty rules

1. Thresholds are read from the protocol JSON, not from code. There is no
   second copy to quietly edit.
2. A run under a new protocol hash does not inherit the old champion's
   evidence.
3. A criterion that fails is reported by name, never summarised away.
4. If the gate is wrong, the gate is fixed. Thresholds are not lowered to
   admit a strategy.
5. Criteria changes require a protocol version bump and a new hash.

---

## Changing this protocol

Do not, to make a strategy pass. If the protocol is genuinely wrong, bump the
version, record why, and re-run **every** registered strategy under the new
hash — because comparability with prior results is exactly what the hash is
for.
