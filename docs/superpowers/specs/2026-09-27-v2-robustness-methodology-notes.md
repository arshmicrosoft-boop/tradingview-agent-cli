# v2 robustness suite — post-design methodology notes

**This is a sibling note, not a revision.** The design spec
[`2026-09-27-v2-robustness-design.md`](./2026-09-27-v2-robustness-design.md) is
left exactly as written. Two methodology changes were accepted *after* that spec
was signed off, and this note records them so the spec is not read as the last
word on how v1 numbers are produced.

The authoritative version of both changes lives in the code, in the blocks named
below. This note exists to make the *decisions* legible — why they were made,
what they cost, and what a reader must not conclude from them.

---

## 1. The v1 walk-forward criterion was recomputed

**Status: accepted. Not reverted. Stricter than what it replaced.**

`MIN_WF` (`walk-forward consistency %`, `gate.mjs`) was fed by an inline splitter
over the **pooled five-symbol** trade stream, scoring each fold as
`summedPnl / 1000` — five accounts' P&L over one account's equity, used only for
its **sign**. The tested implementation, `harness.walkForward()`, was never
called by the runner, so the code with coverage and the code that decided the
verdict were different code.

The criterion now reads `harness.walkForward` on the **primary symbol
(BTCUSDT) only**, with a per-fold warm-up.

| | before | after |
|---|---|---|
| `vol-normalized-breakout` value | 50 | **0** |
| bar `MIN_WF` | ≥ 50 | ≥ 50 |
| unmet criteria | 18 | **19** |
| overall verdict | fail | fail |

The `50 -> 0` is stable across the archive regeneration. The value changed on 7
of 11 strategies; no overall verdict flipped anywhere, because every strategy was
already failing on other criteria.

The old `50` is the part worth understanding: it was handed to a strategy that
was down −99.61% over the sample and ruined on 4 of its 5 symbols, because the
splitter asked only whether the sign of a five-account P&L sum was positive per
fold. The new `0` is 0 of 4 folds profitable on BTCUSDT. Both numbers are real;
only one of them was the criterion.

**The owner reviewed this and decided not to revert it.** Reverting would mean
reinstating a meaningless percentage on a ruined book, in order to make a card
read 18 instead of 19. The change is a correctness fix that moved in the strict
direction, and it is documented on the affected card so it is not mistaken for a
regression.

**Authoritative code:** the `walk-forward consistency` and `wfPooled` blocks in
`research/evidence.mjs`; `gate.mjs` `MIN_WF`; root `README.md`
§"Why the gate fails" defect 3.

### Why the protocol hash does not show this

`protocol.mjs:53` hashes the protocol JSON only. The hash therefore covers
**thresholds** and **not computation**, and `verify.mjs:155` checks only that the
latest run per strategy cites the current hash. A metric can change under an
unchanged `protocol_hash` without `npm run verify` going red.

This is a known, already-documented limitation — see the "WHAT THE HASH ACTUALLY
COVERS" blocks in `gate.mjs`, `evidence.mjs` and `registry.mjs` — and is
cross-referenced here rather than restated. The consequence for this change is
only that the walk-forward recomputation is **not** detectable by the hash; it is
not a claim that the hash is blind to the threshold it exists to protect, which
was a separate and separately fixed defect.

---

## 2. The portfolio basis is now equal-weight additive

**Status: accepted as a bug fix. Recorded v1 numbers were allowed to change.**

- **Return** = mean of the N per-symbol returns (additive, 1/N per symbol, no
  rebalancing). Never the compounded product, which is a 5×-geared book.
- **Max drawdown** = drawdown of the pointwise-averaged equal-weight equity
  curve. Never the worst single symbol, which is a 1× single-sleeve figure.
- **Calmar** = that return / that drawdown, both off the same curve.

Scope: `evidence.agg`, the benchmark, the per-regime benchmark, and the v2
bootstrap.

The old basis compared a 5×-geared numerator against a 1× drawdown. Because the
drawdown half is now the book's rather than the worst sleeve's,
`max_drawdown_pct` reports a **smaller** number on the same run — the same
`< 35%` bar applied to the thing the strategy actually deploys, not a loosened
bar. `worstSymbolDrawdownPct` is retained so the old figure stays visible.

**The archives are being regenerated to the new basis.** A reader must not mix
pre- and post-change portfolio numbers, and cards carrying pre-change
front-matter figures are labelled as such.

`harness.monteCarlo` was converted on the same basis: it was a 5×-geared pooled
replay that could end at a negative balance and report >100% drawdowns with no
referent, and is now a 5-sleeve equal-weight book (trades grouped by `symbol`,
shuffled within-symbol only, sleeves averaged pointwise).

**Authoritative code:** the "THE EQUAL-WEIGHT BOOK" block in `gate.mjs`; the
corresponding block in `research/evidence.mjs`.

---

## What did *not* change

- No v1 or v2 threshold was moved.
- No verdict was flipped from fail to pass. Nothing passes.
- No card's finding, hypothesis, ladder, or falsification was revised.

The specification above is unchanged and continues to describe the v2 suite.
