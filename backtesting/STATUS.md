# STATUS — inventory of the quarantined backtesting stack

Assessed 2026-09-28. Read `QUARANTINED.md` first; it explains why nothing here
counts as evidence.

## Environment

| | |
|---|---|
| Interpreter | `backtesting/.venv` — Python 3.12 (gitignored, ~980 MB) |
| Backtester | `vectorbt[rust]` 1.1.1 |
| Other | numpy 2.5.3, pandas 3.0.6, scipy 1.18.1, numba 0.67, pyarrow 25, scikit-learn 1.9.1 |
| Reference engine | `backtesting/Lean/` — vendored QuantConnect LEAN, C# (gitignored, ~275 MB) |
| LEAN build toolchain | `backtesting/.dotnet/` — .NET 8.0.425 SDK (gitignored, ~714 MB) |
| Tracking | MLflow — `mlflow.db`, `mlruns/` (gitignored) |

All three heavy directories are gitignored. A bare `git add -A` would otherwise
have staged ~1.97 GB across ~100k files.

## File-by-file

| File | Verdict | Notes |
|---|---|---|
| `quantlab.py` | **decision logic, unsound** | `decide_result()` gates on 2 synthetic metrics. Also: recorded `RESEARCH_CANDIDATE` contradicts the numbers it displays, which imply `PASS`. |
| `run_experiment.py` | **pipeline, mostly placeholder** | L176-178 dummy data; L267-273 hardcoded `purged_cv: True`; L247 synthetic LEAN metrics; L399 synthetic MC trades; L421 `/tmp/report.json` placeholder path. |
| `monte_carlo.py` | **broken — delete** | Order-invariant sum ⇒ zero variance. See `QUARANTINED.md` §1. |
| `parity_tests.py` | **valuable idea, failing implementation** | Correct shape: entries/exits/timestamps/trade-count/pnl-direction compared against LEAN. Fails 147× because LEAN is unbuilt. **This is the salvageable part.** |
| `example_backtest.py` | demo | vectorbt smoke test. |
| `parity_result.json` | **evidence of failure** | `status: REVIEW`, `difference: 147`. |
| `final_report.json`, `report.json` | **do not cite** | Decision derived from the values in §2 of `QUARANTINED.md`. |
| `mlflow.db`, `mlruns/`, `__pycache__/` | generated | gitignored. |
| `experiments/btc_vwap.yaml` | scaffold config | `data.hash: abc123`. Diverges from `../experiments/btc_vwap.yaml`. |
| `docs/research_artifacts.md` | unverified | Present; contents not audited. |

## The LEAN blocker

`run_experiment.py:78` fails with `"lean.exe / dotnet launcher not found"`.
`Lean/` is **source, not a built binary**. The .NET 8 SDK is now present
(`.dotnet/`), so a `dotnet build` of the LEAN CLI should make parity runnable
for the first time. Until it does, `lean_trades: 147`, `lean_sharpe: 1.35` and
`lean_max_drawdown: -0.13` in `final_report.json` are **hardcoded stand-ins**,
not measurements.

## Known conflicts with the rest of the repo

- Two divergent copies of the same experiment config:
  `backtesting/experiments/btc_vwap.yaml` (`vwap_length` 30, `atr_stop` 1.5) vs
  `../experiments/btc_vwap.yaml` (`vwap_length` 50, `atr_stop` 2).
- `backtesting/README.md` describes only the venv and gave no indication that
  the pipeline's outputs are synthetic.

## What would make this shippable

1. Real market data via `../research/data` (which is hash-fingerprinted and
   gap-checked) — not dummy closes.
2. Delete `monte_carlo.py` or replace it with `../research/robustness.mjs`'s
   block bootstrap, which compounds and measures drawdown.
3. `dotnet build` LEAN, then make parity a **hard gate**: a non-zero
   `divergence_flags` must abort before any decision is emitted.
4. Replace `purged_cv: True` with a real purged cross-validation (with embargo
   — `../research/` needs this too; see the Phase 2 plan).
5. Adopt `../research/`'s gate, or make this the **independent checker** for
   research/ rather than a second evaluator. Two gates, one of them 2-criteria
   and unvalidated, is the failure mode to avoid.
6. Add negative controls. Any backtest engine that cannot demonstrate it
   rejects a known-bad strategy is not measuring anything.
