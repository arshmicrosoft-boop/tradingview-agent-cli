# QUARANTINED — do not treat this as validated research

**This directory is scaffolding, not evidence.** It is quarantined from the
research pipeline and must never be read as a source of truth.

The authoritative research system is `../research/` (Node.js), gated by
`npm run verify`. Nothing in this directory is connected to it, is imported by
it, or is checked by it.

## The specific danger

This code has **production-shaped packaging around placeholder values**:
MLflow experiment tracking, HTML reports, a vendored QuantConnect LEAN, and a
parity harness. That surface reads as a finished, validated system. It is not.

A reviewer who sees the tracking UI and the report generator will reasonably
assume a strategy was rigorously validated. **It was not.** That gap between
appearance and substance is the whole reason for this file.

## What is actually fake right now

Every one of these is verified, not suspected.

### 1. The Monte Carlo is a mathematical no-op — `monte_carlo.py`

It computes `np.sum(rng.permutation(trades))`. Summing a set of numbers does not
depend on their order, so **all 10,000 "simulations" return the same value.**

Its own recorded output in `final_report.json` proves it:

```json
"mean": 0.03400000000000001,
"std":  7.68182878590931e-18,     <- floating-point zero
"percentiles": { "5th": 0.0339…", "50th": 0.034, "95th": 0.034 },  <- all identical
"confidence_range_95": [0.034, 0.034]   <- zero-width "95% interval"
```

It neither compounds nor measures drawdown. Shuffling trades exists to test
*path/order* risk, and summing destroys exactly the property being tested.
`../research/` states the rule in code: *"Drawdown and return are PATH
properties and must NOT be pooled."*

### 2. The decision is derived from fabricated numbers — `run_experiment.py`

| Line | What it does |
|---|---|
| 176-178 | vectorbt sweep uses **dummy close data** ("placeholder for full parameter grid") |
| 267-273 | `purged_cv` returns a **hardcoded** `{"verified": True, "note": "Purged CV passed (simulated)"}` |
| 247 | LEAN metrics are **synthetic** — `lean_available: false` |
| 399 | the Monte Carlo's input trades are **synthetic**, derived from the vectorbt candidate |

`quantlab.py:decide_result()` then reads those synthetic `sharp` / `max_drawdown`
values to decide `PASS`. It cannot distinguish a measured number from a
placeholder.

### 3. The one real check fired and was ignored — `parity_result.json`

```json
"vectorbt_trades": 1,  "lean_trades": 147,  "match": false,
"divergence_flags": ["Trade count mismatch: VectorBT=1 LEAN=147", …],
"status": "REVIEW"
```

A 147× divergence, explicitly flagged, status `REVIEW` — and a decision was
emitted anyway. **Parity must hard-stop the pipeline, not annotate it.**

### 4. The gate is 2 checks against research/'s 19

`decide_result()` gates on `sharp >= 1.0` and `max_dd >= -0.20`. That is all.

| | `../research/` | this directory |
|---|---|---|
| Criteria | **19** | **2** |
| Profit-factor floor | `MIN_PF 1.3` | **none** |
| Negative controls | PF 0.837 / 0.751 noise floor | **none** |
| Multiple testing | deflated Sharpe vs trials tried | **none** |
| Protocol hashing | yes, recorded per run | no |

The missing profit-factor floor is the dangerous one. A strategy with **PF 0.5**
and a high win rate can pass on Sharpe alone — that is precisely the
`sma-cross` pathology (PF 1.013 that was really −0.22R per trade) that
`../research/`'s gate was built to catch.

### 5. The recorded decision contradicts its own inputs

`final_report.json` records `"decision": "RESEARCH_CANDIDATE"`, but the metrics
it displays (`sharp` 1.35, `max_dd` −0.13) would make `decide_result()` return
`"PASS"`. The report shows numbers the decision function never saw.

## Rules

1. **Do not import anything from here into `../research/`.** Not as a
   dependency, not as a reference implementation, not "just to reuse the
   Monte Carlo."
2. **Do not cite any number produced here** in a strategy card, a README claim,
   a report, or a conversation about edge. There is no valid number here.
3. **Do not let this directory be presented as research.** If a screenshot, a
   dashboard, or a status summary includes it, it is misleading.
4. **The parity harness is the one genuinely valuable part** — validating
   against an independent reference engine is the right instinct and
   `../research/` lacks it. Keep the idea; discard the implementation until
   `lean.exe` is actually built and parity passes.

## Path forward — pick one, do not let it linger

1. **Bring it up to `../research/` standards** — real data, real purging,
   negative controls, parity that must pass, and a gate no weaker than
   research/'s. Consider making it the *independent checker* for research/
   rather than a second source of truth.
2. **Delete it.**

Maintaining two engines where one is 2-criteria and unvalidated is worse than
having one. **Do not maintain two competing truth sources.**

See `STATUS.md` for the file-by-file inventory and what is salvageable.
