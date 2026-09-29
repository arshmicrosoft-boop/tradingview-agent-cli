# VectorBT Backtesting Setup — **QUARANTINED**

> **This is scaffolding, not research. Do not cite any number produced here.**
> Read [`QUARANTINED.md`](./QUARANTINED.md) before using anything in this
> directory, and [`STATUS.md`](./STATUS.md) for the file-by-file inventory.

The authoritative research system is [`../research/`](../README.md) (Node.js),
gated by `npm run verify` — 19 criteria, a profit-factor floor, negative
controls at PF 0.837 / 0.751, deflated Sharpe against trials tried, walk-forward
fold coverage, and a protocol hash recorded on every run.

Nothing in this directory is imported by `../research/`, connected to its
validation pipeline, or checked by it.

## Environment

```
backtesting/.venv                 Python 3.12          (gitignored, ~980 MB)
vectorbt[rust]                    1.1.1
numpy 2.5.3 · pandas 3.0.6 · scipy 1.18.1 · numba 0.67 · pyarrow 25 · scikit-learn 1.9.1
backtesting/Lean                  QuantConnect LEAN, C#  (gitignored, ~275 MB, source not built)
backtesting/.dotnet               .NET 8.0.425 SDK        (gitignored, ~714 MB)
```

Verify the environment:

```bash
backtesting/.venv/Scripts/python -c "import vectorbt; print(vectorbt.__version__)"
```

## Current state in one line

The pipeline runs and emits a polished MLflow-backed HTML report, but its
Monte Carlo is a **provable no-op** (order-invariant sum, zero variance, its own
output shows `std 7.7e-18`), its `purged_cv` is **hardcoded `True`**, its LEAN
metrics are **synthetic stand-ins**, and the one real check — parity against
LEAN — reports a **147× divergence flagged `REVIEW`** and was ignored.

`decide_result()` gates on two synthetic values (`sharp >= 1.0`,
`max_dd >= -0.20`) with no profit-factor floor, no negative controls and no
multiple-testing correction. A strategy with **PF 0.5** and a high win rate
would pass it.

## The one salvageable idea

`parity_tests.py` — validating against an **independent reference engine** — is
correct instinct and exactly what `../research/` lacks. `../research/` currently
validates only against itself: three separate implementations of its portfolio
model agreed with each other while all three shared one wrong assumption.

Keep the idea. The implementation needs `dotnet build` of the LEAN CLI and a
hard gate on divergence before it means anything.

## Rules

1. Do not import anything from here into `../research/`.
2. Do not cite any number from here in a card, README, report, or claim about edge.
3. Do not present this directory as validated research.
4. Resolve it one way or the other — upgrade it to research/'s standard, or
   delete it. **Do not maintain two competing truth sources.**

> Also tracked at repo root: `../experiments/btc_vwap.yaml` is a second,
> **divergent** copy of this experiment's config
> (`vwap_length` 50 / `atr_stop` 2, versus 30 / 1.5 in `experiments/` here).
