# QUARANTINE NOTICE — backtesting/ framework (SCAFFOLD, NOT VALIDATED RESEARCH)

Status: QUARANTINED — do NOT treat as a validated research source of truth.

Confirmed defects (per audit against Node gate):
- P1: monte_carlo.py is broken (np.sum of permutations = invariant; std ≈ 0; 95% CI zero-width).
- P2: Synthetic/fabricated values throughout pipeline (dummy price data in VectorBT sweep, hardcoded Purged CV PASS, synthetic LEAN metrics).
- P3: Parity divergence (147x trade count mismatch, opposite PnL direction) flagged as REVIEW but pipeline continues to emit PASS/RESEARCH_CANDIDATE.
- P4: Gate has only 2 checks (Sharpe ≥ 1.0, Max DD ≥ -0.20) vs Node gate (19 checks: MIN_PF 1.3, deflated Sharpe, negative controls, protocol hash, MIN_WF_COVERAGE=100). No profit-factor floor — dangerous for PF=0.5 passing on Sharpe alone.
- P5: Internal inconsistency: final_report.json records "RESEARCH_CANDIDATE" but displays PASS-level metrics (sharp 1.35, max_dd -0.13) that decide_result() never evaluated.

Requirements before un-quarantine:
- Fix monte_carlo.py (use path-dependent metrics like drawdown, not sum).
- Replace synthetic sweep with real data + real validation.
- Implement full gate: MIN_PF 1.3, MIN_WF_COVERAGE=100, protocol hashing, deflated Sharpe, negative controls.
- Make parity divergence a HARD STOP, not a warning.
- Resolve final_report.json / decide_result() inconsistency.
