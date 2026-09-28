# v2 robustness suite — design

**Date:** 2026-09-27
**Status:** approved, implemented
**Supersedes:** nothing. v1 stays frozen and untouched at the threshold level.

---

## 1. The problem

`protocol.v1.json` is frozen and hash-pinned, and all 15 cards in
`strategies/` are reconciled against runs made under its hash. It is a
discovery filter with 21 criteria. Every strategy run under it fails 18–22 of
them, and that failure is **correct**: the two negative controls score PF 0.837
and 0.751, so the noise floor is roughly 0.8, not 1.0, and the best hypothesis
in the repo is 1.013. There is no edge.

The gate has a second, quieter weakness. Two of its robustness criteria are
weaker than their names claim:

- **Monte Carlo only reshuffles trade order.** The sum of a fixed P&L set is
  order-invariant, so `finalEquity` is a constant and carries no information.
  What shuffling can move is the *path* — drawdown depth, breach probability,
  losing streaks. Expectancy, profit factor and Sharpe are structurally
  unreachable by this method, so the v1 MC cannot test the thing anyone cares
  about most.
- **Walk-forward never re-optimises.** v1 partitions time into four windows and
  asks how many were profitable. It never re-picks parameters inside each fold,
  so it cannot detect a strategy whose parameters are only right for the
  average of the whole sample.

And one criterion is **not what it says it is**. `gate.mjs:285`:

```js
const beat = bh.calmar == null ? r.pnl > 0 : (r.trades > 0 && r.pnl > 0);
```

Both branches reduce to `r.pnl > 0`. The check named `beats hold in <reg>`,
whose expected string reads `hold <returnPct>%`, never compares against holding.
Proven: a strategy making **$1** in each regime passes all three checks when
buy-and-hold returned **+9999%** in each. The gate is *more lenient* than the
README states, not stricter.

## 2. Decision: a separate v2 protocol, not a v1 edit

`strategies/README.md` states the rule: v2 "runs as a separate generation with
its own results archive, never mixed with v1." So:

- `protocol.v1.json` is **not edited**. Its hash cannot move, so every existing
  run record stays valid and comparable.
- `protocol.v2.json` is new, frozen on creation, hashed separately.
- `research/registry-v2/` is a new results archive. The 15 v1 cards are **not**
  rewritten — v2 informs the next hypothesis, it does not retroactively alter
  falsified evidence.

The two bug fixes (§5) are applied to v1's code as well. This is not a
threshold change: it makes the gate *stricter*, and a stricter gate cannot
manufacture a pass. No verdict flips, which is proven by re-running all 10
strategies and diffing.

## 3. Module layout

```
research/
  evidence.mjs       NEW  collectEvidence() — the strategy-agnostic evidence bundle
  robustness.mjs     NEW  the five v2 robustness tests
  gate-v2.mjs        NEW  evaluateGateV2() — corrected v1 checks + 7 v2 criteria
  protocol.v2.json   NEW  frozen v2 thresholds
  run-v2.mjs         NEW  v2 runner, records to research/registry-v2/
  protocol.mjs       EDIT loadProtocol(id) beside the untouched PROTOCOL export
  run.mjs            EDIT consume collectEvidence(); MIN_WF fed by harness.walkForward
  gate.mjs           EDIT fix the beats-hold comparison + regression selftests
  harness.mjs        EDIT equityBefore on trade records; fix the vacuous MC test
verify.mjs           EDIT wire the robustness selftest in
```

`collectEvidence()` is extracted from `run.mjs:46-208` precisely so v1 and v2
evaluate **identical** evidence. If they each assembled their own, they would
drift, and a v1/v2 verdict difference would be uninterpretable.

## 4. The five robustness tests

All in `research/robustness.mjs`. Pure functions, no I/O, no TradingView.

### 4.1 `anchoredWalkForward`

Expanding-train, forward-test. For each of `K` folds:

1. Train = every bar before the fold's test window, minus `warmup` bars of
   history reserved for indicator priming.
2. Choose parameters by running the declared grid on **train only**, scored by
   `objective`. Never look at the test window.
3. Simulate the test window with those exact parameters.
4. Record IS metrics, OOS metrics, and the chosen parameters.

Aggregates:

| Field | Meaning |
|---|---|
| `consistency` | % of folds with positive OOS return |
| `efficiencyRatio` | mean OOS fold Sharpe ÷ mean IS fold Sharpe |
| `meanFoldSharpe`, `worstFoldSharpe` | the OOS Sharpe distribution |
| `stationarityT` | Welch t on the per-fold IS−OOS Sharpe difference |

`stationarityT` is the one that matters. A strategy that is genuinely stationary
has IS ≈ OOS per fold, so the differences are noise around zero and the t is
small. A strategy whose edge is a property of the whole sample shows a
systematically negative difference, and the t goes large. Note the sign
convention: **more negative t is worse**, because it means out-of-sample is
reliably below in-sample.

### 4.2 `bootstrapMonteCarlo`

Resamples trade **outcomes** with replacement, not order.

- `method: "iid"` — independent resampling.
- `method: "block"` — contiguous blocks of length `ceil(n^(1/3))`, which
  preserves within-block serial correlation. Trades in this repo cluster
  (consecutive bars in one trend), so iid resampling understates the tail.

Per resample, compounding `pnl / equityBefore` — the trade's *fractional*
return on account equity — produces an equity path, from which:

| Field | Meaning |
|---|---|
| `pProfitable` | P(final equity > initial) |
| `pSharpePositive` | P(Sharpe > 0) |
| `pProfitFactorAboveOne` | P(PF > 1) |
| `sharpeP05/P50/P95` | the Sharpe distribution |
| `maxDrawdownP50/P95` | the drawdown distribution |
| `pBreach` | P(maxDD ≥ threshold) |

This is the criterion v1 structurally cannot express: resampling outcomes moves
expectancy, PF and Sharpe, which reordering cannot.

### 4.3 `deflatedSharpe`

Bailey & López de Prado. The repo has tested 15 cards and its best profit
factor is 1.013. Reporting that number without asking "how large a Sharpe does
pure luck produce when you take the best of 15?" is the exact mistake this
criterion exists to prevent.

- `expectedMaxSharpe(nTrials)` — expected maximum of `nTrials` standard normals,
  via the order-statistic approximation
  `E[max] ≈ sqrt((1−γ)·Φ⁻¹(1−1/N) + γ·Φ⁻¹(1−1/(N·e)))²` with the
  Euler–Mascheroni constant γ ≈ 0.5772.
- `probabilisticSharpeRatio(S, n, skew, kurtosis)` — PSR, the probability the
  observed Sharpe exceeds the break-even level given the series' real skew and
  kurtosis, not an assumed normality. Non-normal returns are the normal case for
  trade P&L, so assuming normality here would be dishonest.
- `deflatedSharpeRatio(PSR, nTrials)` — the PSR after subtracting the trials
  penalty. **DSR > 0** means the edge survives having tried everything tried.

`nTrials` is reported two ways, because both are honest and they differ by two
orders of magnitude: the **15 cards** actually written, and the **true count of
variants evaluated** across every grid in the repo. The second is the real
number of bets placed and is the one the criterion uses.

### 4.4 `fillPerturbation`

Bootstrap with execution uncertainty layered on: per-trade size jitter
(1 + N(0, σ)) and extra random adverse slippage per fill, in addition to the
modelled fee and slippage.

This asks a question `costStress` cannot. `costStress` scales costs
*deterministically* — "what if fees were 2×?" `fillPerturbation` asks "what if my
fills are worse than modelled, randomly, on some trades?" The second is closer
to what a live account experiences.

### 4.5 `slippageSweep`

A fine-grained fee × slippage grid around the base cost, reporting break-even
cost per round trip. v1 jumps 1× / 2× / 5×, which can step straight over the
cliff and report "survives nothing" when the true break-even is 18 bps and v2's
grid would have found it.

## 5. Bug fixes

| Location | Defect | Fix |
|---|---|---|
| `gate.mjs:285` | `beats hold in <reg>` compares against nothing. Dead ternary; both arms are `pnl > 0`. A `$1` strategy passes against `+9999%` hold. | Real comparison against the regime-matched benchmark, using per-regime risk-adjusted return so leverage is not rewarded. Regression selftests reproduce the false pass and add a same-value *loses* case. |
| `harness.mjs:602` | `mc1.medianFinalEquity === mc2.medianFinalEquity` — no such field is returned, so the assertion is `undefined === undefined` and can never fail. | Assert determinism on a real seeded statistic (`p95LongestLosingStreak`), and add a negative control proving a *different* seed does change the answer. Without the negative control the test would still be vacuous. |
| `run.mjs:169-185` | The gate's `MIN_WF` criterion is fed by an inline splitter over the pooled 5-symbol trade stream, not by `harness.walkForward()` — which is exported, self-tested, and never called by the runner. | Feed the tested implementation. |

`simulate()` additionally records `equityBefore` on every trade. This is
additive and changes no existing metric. It exists because the bootstrap has to
compound *fractional* returns: `returnPct` is a return on 10×-notional, so
compounding it onto account equity is a 10× error.

## 6. v2 thresholds

Chosen a priori, before any run, and frozen into `protocol.v2.json`.

| Key | Value | Prevents |
|---|---|---|
| `MIN_WF_CONSISTENCY` | 60 | an edge live in only some quarters |
| `MIN_WF_EFFICIENCY` | 0.40 | in-sample-only parameters |
| `MIN_WF_FOLD_SHARPE` | 0.30 | folds that are individually worthless |
| `MIN_MC_PROFITABLE` | 0.90 | an edge that depends on the realised trade order |
| `MIN_MC_SHARPE_P` | 0.90 | a Sharpe that 1-in-10 resamples would also produce |
| `MIN_DEFLATED_SHARPE` | 0.0 | the best of many trials read as an edge |
| `MIN_FILL_DD_BREACH` | 25 | a drawdown that only exists at modelled fills |

`evaluateGateV2` reports the v1 group and the v2 group **separately**, so a v2
failure is never mistaken for a v1 one and the 21 v1 criteria keep their meaning.

## 7. Verification

1. `npm run verify` — every layer selftest, including the new robustness suite
   and the regression tests for both bug fixes.
2. Re-run all 10 strategies under **v1** and diff every `passed` flag and
   failed-criteria list against the current `research/registry/*/runs.jsonl`.
   Zero verdict flips is the pass condition. The two bug fixes must not turn any
   failure into a pass.
3. Run all 10 under **v2** into `research/registry-v2/`.
4. Update `README.md`: the "six" → seven error, the `beats hold` row, a v2
   section, and refreshed result tables.
