---
id: T-008
name: volatility-normalized breakout
slug: vol-normalized-breakout
status: falsified
# Was P-002 in the backlog. Renumbered to T-008 on promotion to cards/tested/,
# because strategies/validate.mjs requires the id prefix to match the directory
# (P -> cards/proposed, T -> cards/tested) and the card now carries run data.
backlog_id: P-002
code: research/strategies/vol-normalized-breakout.mjs
protocol: v1
protocol_hash: 31ca181720e76199
tested_at: 2026-09-27
dataset: BTC/ETH/DOGE/SOL/ZEC · 15m · 400d · 38,401 bars each · leakage clean
trades: 2583
win_rate_pct: 21.4
profit_factor: 0.935
sharpe: -0.038
max_drawdown_pct: 54.55
total_return_pct: -33.98
gate: fail
unmet: 20
---

# volatility-normalized breakout

**The most efficient negative in the repo: a measurement instrument that cost one
grid and closed a whole family.** The card's stated purpose was to correct a
specification defect named independently by two falsified cards — thresholds
expressed in raw price units on a market whose volatility varies ~10× across the
window. It turns out the units were never the constraint.

The result it was designed to produce is the flat `k` ladder below, which is the
card's own pre-registered "most informative failure". The price of finding it was
one run and twelve grid points.

It also uncovered two defects that had nothing to do with the hypothesis: an
unsatisfiable internal control (see *Why it failed*, item 1) and a harness bug
that had been voiding the gate's parameter-sensitivity criterion for every
strategy ever recorded.

## Hypothesis

```yaml
name: ATR-normalized channel breakout

market_mechanism: >
  What decides whether a breakout holds is the size of the move relative to
  current noise, and current noise varies roughly 10x across this window. A fixed
  price distance is therefore a moving bar: X price units asks a lot of a quiet
  week and almost nothing of a violent one. Every strategy tested so far
  expressed its thresholds in raw price units, so the identical rule silently
  became a harder test in high volatility and an easier one in low volatility,
  and the run recorded no way to tell which regime produced any given trade.

why_should_it_exist: >
  There is no counterparty argument for the normalization itself, and inventing
  one would be dishonest. Dividing a distance by ATR is arithmetic, not a trade.
  What the card has instead is an opponent: the raw-price form, whose implicit
  claim that difficulty is constant across the window is false by construction.

expected_regime: >
  If the unit defect is the binding constraint, the high-ATR segment should
  improve relative to donchian's PF 0.92, and it should improve with FEWER
  trades. It should not change the side of the book, and should not lift the win
  rate, because win rate is a property of the shared 2xATR/96-bar exit rather
  than of the trigger.

required_data: >
  OHLCV only. ATR(14) is derived from the same bars already in the dataset.

failure_condition: >
  If the ATR-normalized and raw-price forms produce materially the same profit
  factor across the entire k grid, then the units were never the constraint, the
  losses live in the trigger or in the shared exit, and every idea in the backlog
  that assumes difficulty scales with volatility can be set aside at once. That
  negative is worth considerably more than the twelve grid points cost.
```

## Rules as numbers

```
lookback = 20          # bars
atr_len  = 14          # held fixed, not swept
k        = 0.25        # ATR multiples

hi       = max(high[i-lookback .. i-1])        # a LEVEL: raw price units
dist_up  = (high[i] - hi) / atr[i]             # a DISTANCE: normalized

IF   high[i] > hi
AND  dist_up >= k
THEN buy on the next bar's open

lo       = min(low[i-lookback .. i-1])
dist_dn  = (lo - low[i]) / atr[i]

IF   low[i] < lo
AND  dist_dn >= k
THEN sell on the next bar's open
```

No exit — the simulator owns it: 2×ATR(14) stop, 96-bar time out.

Grid tested: `k ∈ {0.10, 0.25, 0.50, 1.00}` × `lookback ∈ {10, 20, 40}`.

## When to use

- **Regime:** none. That is the finding, and it is the useful one.
- **Horizon:** inherits the protocol exit — 2×ATR(14) stop, 96-bar max hold.
- **Do not deploy this.** It is a measurement instrument and the measurement
  came back negative.

## When not to use

- **Do not cite its parameter sensitivity as evidence about anything else.**
  Every `sensitivity 0%` recorded before 2026-09-27 was vacuous — see
  *What we learned*.
- **Do not read the `k = 0.00` arm as a result about `donchian`.** The arm as
  specified cannot reproduce it; only the corrected arm can.
- **Do not compare a recorded `walk-forward consistency %` to a freshly computed
  one** without checking which computation produced it. Two different
  populations and two different denominators have both fed that field; see
  *Accepted methodology change* below.
- **Do not compare this card's portfolio return or drawdown to a
  pre-regeneration archive figure.** The portfolio basis changed and this card
  has been refreshed onto the new one; see *Portfolio basis* below.

## Result under v1

20 criteria unmet. The information is not in the criterion list, it is in the
ladder.

### Accepted methodology change: the walk-forward criterion is now measured

**The walk-forward recomputation took this card from 18 unmet to 19**, because
the gate's `walk-forward consistency %` criterion was recomputed on a corrected
basis. (The card now reads 20 unmet, because a later regeneration failed a
different criterion; see *Basis note* below.) That change was accepted
deliberately. It is not a threshold nudge and not a regression, and it is
recorded here so the next reader does not "fix" it back.**

What the criterion used to read. v1 computed it with an inline splitter that cut
the **pooled** five-symbol trade stream into four chunks and scored each fold as
`summedPnl / 1000`. That is a sum of five accounts' P&L divided by one account's
equity — five books over one book, a percentage with no referent. It was used
for nothing but its **sign**, which is why the units never surfaced as a
symptom. The implementation that has tests, `harness.walkForward()`, was never
called by the runner at all, so the code with coverage and the code that decided
the verdict were different code.

What it reads now. `harness.walkForward()` on the **primary symbol (BTCUSDT)
only**, with a per-fold warm-up so indicators are primed inside the fold. This is
a different population *and* a different denominator: one account, divided by
the equity actually being traded.

The measured effect, on this card:

| | before | after |
|---|---|---|
| `walk-forward consistency %` | **50** | **0** |
| meaning of the number | 2 of 4 pooled folds positive by sign | 0 of 4 folds profitable on BTCUSDT |
| bar (`MIN_WF`) | ≥ 50 | ≥ 50 |
| criterion met | yes | **no** |
| unmet criteria | 18 | **19** |
| overall verdict | fail | fail |

**The old 50 is the interesting half.** A strategy that was down **−33.98%**
over the sample on the equal-weight basis — **−99.61%** on the superseded 5×-geared
basis — and ruined on **4 of its 5 symbols** was handed a *passing* 50,
because the pooled splitter only asked whether the sign of a five-account P&L
sum was positive in each fold — and it was, because four losing accounts
outnumbered one losing account that lost less. The new 0 is the honest reading:
not one of the four BTCUSDT folds was profitable. Both numbers are real; they
answer different questions, and only one of them was ever the criterion.

Three things a reader should take from this:

- **The direction was strictly stricter.** The new measurement can only lose a
  criterion, never win one back — the old number was measured on a denominator
  that had no referent and so was free to read anything.
- **No verdict flipped.** This card's verdict was already `fail` on other
  criteria, so the change moved an unmet count and nothing else. Across the
  whole re-run the criterion's *value* moved on 7 of 11 strategies, and no
  overall verdict flipped anywhere.
- **The owner reviewed it and chose not to revert it**, on the grounds that the
  old number was a sign test masquerading as a percentage. Reverting would mean
  reinstating a meaningless 50 on a ruined book.

The value `50 -> 0` is stable across the archive regeneration; this card cites
no other strategy's aggregate numbers, because those are also being regenerated.

**This did not move a threshold, and the protocol hash cannot see it.**
`protocol.mjs:53` hashes the protocol JSON only, so `protocol_hash` covers
**thresholds**, not **computation**; `verify.mjs:155` checks only that the latest
run per strategy cites the current hash. A metric can therefore change under an
unchanged `ab8d990e445b2927` — the hash that was current when the walk-forward
criterion was recomputed — without `npm run verify` failing. The card's
`protocol_hash` field has since moved to `31ca181720e76199`, but only because a
*threshold* was added on 2026-09-29, not because of this change; the recomputation
itself moved nothing that the hash could see, and the thresholds the card pins are
exactly the thresholds that ran. The limitation itself is documented in the "WHAT
THE HASH ACTUALLY COVERS" blocks in `gate.mjs`, `evidence.mjs` and `registry.mjs`;
see also the root `README.md` §"Why the gate fails" defect 3.

### Portfolio basis: equal-weight additive

**Every portfolio figure in this repo is read off one equal-weight book, and the
archives and cards are written on that basis.** The rule, in full:

- **Return** is the **mean of the N per-symbol returns** — additive, 1/N of
  capital per symbol, nothing rebalanced. It is *never* the compounded product
  `(Π (1+r_s) - 1)`, which is the return of a **5×-geared** book.
- **Max drawdown** is the drawdown of the **pointwise-averaged equal-weight
  equity curve**. It is *never* the worst single symbol, which is a 1×
  single-sleeve figure.
- **Calmar** is that return over that drawdown — both halves off the same curve,
  so the units always match.

It applies to `evidence.agg`, the benchmark, the per-regime benchmark and the v2
bootstrap alike.

**This is a bug fix, and the recorded v1 numbers were allowed to move as a
result.** The previous basis compared a 5×-geared numerator against a 1×
drawdown — mismatched units, which inflated the calmar criterion on every
verdict in both v1 and v2. Because the drawdown half is now the *book's* and not
the worst *sleeve's*, `max_drawdown_pct` reports a **smaller** number than the
old worst-symbol figure on the same run. That is not a loosened threshold: it is
the same `< 35%` bar applied to the thing the strategy actually deploys. The old
figure is retained alongside it as `worstSymbolDrawdownPct` so both are readable.

**A reader must therefore not mix pre- and post-change portfolio numbers**, and
the archives have been regenerated to the new basis. As of 2026-09-28 this card's
front-matter `total_return_pct` (−33.98) and `max_drawdown_pct` (54.55) are the
**regenerated equal-weight figures for the same run**; the pre-regeneration
values they replace were −99.61% and 83.97%. Nothing in this card's *finding*
depends on them — the verdict is `fail` either way, and the argument rests on
the profit-factor ladder and the trade counts, which are per-run quantities and
are unaffected by the portfolio basis.

**Basis note (2026-09-29).** The v1 archive was regenerated again, under a
protocol carrying a 19th threshold constant — `MIN_WF_COVERAGE: 100`, the
walk-forward fold coverage criterion, which passes on all ten cards — and with
the `beats hold in <reg>` benchmark corrected to compound rather than sum, which
lifted the bull-regime hold bar from 0.88% to 630.63%. The compounding
correction is the whole of the movement on this card: it withdraws the
`beats hold in bull` pass recorded above, so `unmet` moves 19 → 20, and
`protocol_hash` moves to `31ca181720e76199`. The walk-forward recomputation
described above is unaffected — it still reads 0, still against a `MIN_WF` bar
of 50, and it is a separate concern from the coverage criterion added alongside
it. Trades, profit factor, Sharpe, `total_return_pct` (−33.98) and
`max_drawdown_pct` (54.55) are unchanged per-run quantities on the same
equal-weight basis, and the verdict is still `fail`.

`harness.monteCarlo` was converted on the same basis. It was a 5×-geared pooled
replay: it compounded five independent 1,000-equity accounts into one curve with
no 1/N weighting, so it could end at a **negative balance** and report
**> 100%** "drawdowns" with no referent — a portfolio cannot be deeper than
100% or, arithmetically, negative. It is now a **5-sleeve equal-weight book**:
trades are grouped by their `symbol` field, each sleeve replays alone at 1/N,
the sleeves are averaged pointwise, and a trade never migrates between sleeves
(the shuffle is within-symbol only). A sleeve that runs out of capital absorbs
its own loss, so the book can never report a drawdown above 100%.

**The k ladder** (400d, 15m, 5 symbols; all arms ruin the account):

| k | bidirectional PF | trades | long-only PF | trades |
|---|---|---|---|---|
| 0.00 | 0.899 | 2801 | 0.917 | 1645 |
| 0.10 | 0.914 | 2754 | 0.919 | 1644 |
| 0.25 | **0.935** | 2583 | 0.917 | 1587 |
| 0.50 | 0.908 | 2452 | 0.932 | 1620 |
| 1.00 | 0.929 | 2101 | 0.960 | 1456 |

**The ladder is flat.** Bidirectional spread is 0.027 across a 10× range in `k`;
long-only spread is 0.043. `donchian` scores 0.917 and the normalized form at
every setting scores 0.90–0.96. Requiring a *larger* move in ATR units removed
trades — 2801 → 2101, and 1645 → 1456 — exactly as the filter should — and the
profit factor did not move. The card's pre-registered most-informative failure
is what happened.

| criterion | bar | actual |
|---|---|---|
| trades | ≥ 500 | 2583 ✅ |
| profit factor | > 1.3 | **0.935** |
| sharpe | > 1.0 | −0.038 |
| sharpe t-stat | > 2.0 | −1.93 |
| max drawdown | < 35% | 54.55% |
| max survivable cost | ≥ 25 bps | **0 bps** |
| account survived | yes | **RUINED** |
| beats hold in bull | required | **failed** — 28.10% vs hold 630.63% |

Buy&hold returned +696.23% over the same window. This returned −33.98%.

Two details worth keeping. The family sits at PF 0.90–0.96, which is *above* the
random control (0.751) and above always-long (0.837) but below 1.0 — so the
Donchian breakout carries a little information and still loses, which is a more
precise statement than "no signal". The second detail has since been withdrawn:
with 874 bull-regime trades this card returned 28.10% against a hold bar of
630.63%, so `beats hold in bull` **failed** — it had read *passed* under the
superseded non-compounding bar of 0.88%, and it was the only criterion on this
card that the 2026-09-29 benchmark correction took away. Neither fact makes the
strategy tradeable, and with the second one gone the loss is no longer locatable
somewhere other than direction.

## Why it failed

1. **The card's mandatory control was unsatisfiable as written.** The card
   requires a `k = 0.00` arm that "must reproduce donchian exactly: PF 0.92,
   1,645 trades, 19.7% win rate", and says to stop if it does not. It could not,
   in three independent ways: the card triggers on `high[i] > hi` where
   `donchian` uses `close[i] > hi` (strictly looser); the card specifies a short
   arm where `donchian` is long-only; and both differences push the arm to fire
   more often, so no implementation honouring the card's own rules can return
   1,645 trades.

   The resolution was to expose trigger basis and side as config rather than
   bend the rules until the control passed. The corrected arm
   (`k=0, close, long`) reproduces `donchian` **exactly** — 1645 trades, PF
   0.917, 19.7% win, matching both the registry and a live `donchian.mjs` run —
   which validates the ATR implementation. The card's literal form at `k=0`
   returns 2801 trades and PF 0.899, as the spec difference predicts.

2. **The unit hypothesis itself is wrong.** This is the real result.
   Normalizing the denominator by ATR changes nothing measurable. The losses are
   not in the threshold's units. They live in the trigger and in the shared
   exit, exactly as the card's failure condition said they would if the ladder
   came back flat.

3. **The shared exit is now the prime suspect for the whole family.** Win rate
   sits at 18.5–21.5% across every arm, with a 2×ATR stop and a +1R-sized
   average winner that a 19% hit rate cannot support. Six structurally unrelated
   triggers have now produced that same tight 16–23% band. `registry.json`
   records P-005 as blocked partly on exit placement, and this run strengthens
   that: the exit, not the entry, may be what the whole backlog is measuring.

## What we learned

- **A flat ladder is worth more than a noisy improvement.** The card said so in
  advance, and it is right: the flat result removes an entire family of ideas
  that assume difficulty scales with volatility, at the cost of one grid.
- **Every `parameter sensitivity` figure recorded before 2026-09-27 was void.**
  `simulate()` built its context object without a `cfg` key, so the strategy ran
  on hardcoded defaults and `holdoutEvaluate`'s cartesian product produced N
  identical runs. Sensitivity reported 0% for all 14 runs — indistinguishable
  from "no variant was profitable". Headline PF/Sharpe/trades were never
  affected (defaults applied either way; re-running `sweep-reversal` after the
  fix reproduced 1565 / 0.641 / −0.138 exactly), but every card citing
  sensitivity as evidence of non-robustness was citing an unmeasured quantity.
  Fixed, with a selftest that asserts a `cfg`-keyed probe signal produces
  different runs for different parameters.
- **A criterion that can only fail for the right reason is not a test.** 0%
  sensitivity was reported identically whether the grid varied or not, and that
  ambiguity survived 14 runs. A check whose two failure modes are
  indistinguishable needs a probe.
- **Verify the control before the hypothesis.** The card ordered this correctly.
  Had the ATR code been wrong, the flat ladder would have read as a clean
  negative for the wrong reason — the exact failure `SCHEMA.md §failure_condition`
  exists to prevent.
- **A control that cannot be reproduced is a card defect, not a market finding.**
  It is tempting to treat "k=0 didn't match" as evidence about the strategy. It
  was evidence about the specification, and separating the two took one extra
  config axis.
