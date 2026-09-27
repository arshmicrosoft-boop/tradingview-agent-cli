---
id: P-005
name: cross-sectional relative value
slug: cross-sectional-relative-value
status: blocked
blocker: one symbol and one open position — no representation of two simultaneous legs
code: none
---

# cross-sectional relative value

**Two things are true about this card and they point in the same direction: it
is the most likely thing in the backlog to work, and v1 cannot express it at
all.** It is `blocked` for that reason and not because the mechanism is doubtful.
A blocked card is a documented v2 requirement — it carries more information than
an untested card, because the mechanism is written, believed, and pinned to a
specific missing capability.

Read `PLAYBOOK §6` before touching any of this. The rule there is narrow on
purpose: adding a capability to the framework *because a strategy needs it* is
the failure mode the section exists to prevent. The legitimate trigger is
narrower — a hypothesis that already has a written, believed mechanism and that
the current protocol has no way to express. That is the only claim being made
here, and it is why the answer is "bump to v2", not "patch v1".

---

## Hypothesis

```yaml
name: cross-sectional relative value

market_mechanism: >
  The five majors are highly correlated but not perfectly, and the residual
  part of their relative moves decays. A pair that has moved apart from its own
  recent joint path tends to close part of that gap, because arbitrageurs who
  trade the spread are the participant whose position requires the correlation
  to hold rather than a view on direction.

why_should_it_exist: >
  Yes, and for a structural reason rather than a behavioural one. A relative
  value position has two counterparties at once, and neither is discretionary:
  the market maker quoting both legs of a pair, and the rebalance that must
  trade the underweight when the pair drifts. Both transact because the
  structure requires it, not because they have formed a view, and neither can
  wait. The honest caveat is the same one that applies to every arbitrage
  argument — the decay is real but it is also small, and it is competed away.
  Whether what remains after 15bps of round-trip cost (10 fee + 5 slippage) is
  measurable in a 400-day, five-symbol sample is exactly the open question, and
  it is a question about size, not about direction.

expected_regime: >
  Should work in all three regimes, and this is the point: a dollar-neutral pair
  has directional beta near zero, so it does not care whether the window is bull,
  bear or sideways. It needs dispersion between the symbols, not a trend.
  Should NOT work when cross-sectional dispersion collapses, because a pair with
  no spread to close has no reversion to trade — and dispersion is observable
  in advance, so this is a filterable condition, not an excuse.

required_data: >
  OHLCV only. The data requirement is the easy part — this is the one blocked
  card that needs no new data. It is the SHAPE of the harness that cannot hold
  it: v1 simulates one symbol with one open position, long or short, and has no
  concept of a second simultaneous leg, a net exposure, or a pair.

failure_condition: >
  If residual mean reversion between the majors is the mechanism, the decay must
  scale with the size of the residual move and must not depend on which pair is
  chosen. Concretely: per-trade expectancy must be higher after a large
  dislocation than after a small one, and the result must hold for more than one
  symbol pair. If the spread only works for the BTC/ZEC pair, or if expectancy
  is flat in dislocation size, the effect is a pair-specific artefact of a
  400-day sample and not a mechanism.
```

## Rules as numbers

```
# --- v2 only. NOT EXECUTABLE UNDER v1 ---------------------------------------
# v1 is one symbol, one open position. There is no state in which this rule can
# be evaluated. It is written here so the v2 requirement is specific, not vague.

# --- parameters (default -> grid) -------------------------------------------
universe        = {BTCUSDT, ETHUSDT, DOGEUSDT, SOLUSDT, ZECUSDT}   # fixed
lookback_bars   = 384    # {192, 384, 768}   trailing return, 15m bars
rebalance_bars  = 24     # {12, 24, 48}      bars between re-ranks
n_legs          = 2      # exactly one long, one short — not a grid
gross_exposure  = 1.00   # |long| + |short| = 1.0 x equity, always
net_tolerance   = 0.05   # |long| + |short| = 0 within 5% of equity
drift_trigger   = 0.10   # re-rank early if gross drifts > 10% of equity
min_disp_bps    = 40     # {20, 40, 80}  cross-sectional spread gate, bps
bench_regimes   = {bull, bear, sideways} vs a 0%-return NEUTRAL benchmark
                                       # NOT vs buy-and-hold

# --- per symbol s, at rebalance boundary i -----------------------------------
r(s, i)     = close(i, s) / close(i - lookback_bars, s) - 1
rank(s, i)  = ordinal position of r(s, i) across the 5 symbols, 1 = weakest
disp(i)     = max_s r(s, i) - min_s r(s, i)              >= min_disp_bps

IF   disp(i) >= min_disp_bps
AND  rank(s, i) = 5
THEN long  s at notional +0.50 * equity
IF   disp(i) >= min_disp_bps
AND  rank(s, i) = 1
THEN short s at notional -0.50 * equity
IF   rank(s, i) in {2, 3, 4}
THEN no position in s

IF   bars_since_last_rebalance >= rebalance_bars
OR   |gross| > (1 + drift_trigger) * gross_exposure * equity
THEN re-rank all five symbols and resize the two legs

# --- invariants asserted every bar, not signals ------------------------------
ASSERT  |sum(leg notionals)| <= net_tolerance * equity
ASSERT  |long| + |short| = gross_exposure * equity
ASSERT  number of simultaneous positions <= 2
```

## When to use

- **Regime:** any. The distinguishing property is that this strategy does not
  need a directional regime, which is precisely what makes it attractive here.
  It does need cross-sectional dispersion — gated at ≥ 40 bps between the
  strongest and weakest trailing return — because a collapsed spread leaves
  nothing to trade.
- **Horizon:** rebalance every 24 bars (6 hours at 15m) or on a 10% gross
  drift. Intended holding period is days, not bars.
- **Sizing:** per-leg notional, 50/50 by construction, gross capped at 1.0×
  equity with net forced to zero within 5%. **The signal cannot be expressed as
  a percentage of equity and a stop distance**, which is what every v1 strategy
  supplies. A relative-value position has no directional stop; it has a spread
  that has gone too far in the wrong direction. This is the second, subtler
  reason v1 cannot hold this card, and it is the one the headline blocker does
  not mention.

## When not to use

- **Do not approximate it in v1 with a single symbol.** A long-BTC-only version
  is not a degraded cross-sectional strategy; it is a directional BTC strategy
  with a different trigger, and it inherits the regime-matched buy-and-hold
  benchmark that makes the whole idea interesting in the first place.
- **Do not run it in v1 alongside v1 results.** A separate generation, its own
  results archive, its own protocol hash. Mixing generations is how a protocol
  gets quietly destroyed.
- **Confusion risk:** pairs trading and long/short mean reversion on a single
  symbol look alike and are not. The tell is the second leg: if you cannot name
  the instrument on the other side and why *it* must be wrong, you have written
  a directional trade.

## Why it was proposed

The mechanism is ordinary. **The reason the card matters is structural, and it
is the single largest handicap in our results.**

Every directional strategy we tested had to beat **buy-and-hold in the same
regime**. Over this window buy-and-hold returned **+696.23%** — a benchmark no
directional strategy in the table came close to — and
`research/gate.mjs:115` says so directly: the benchmark is regime-biased, and
"beat buy-and-hold" in a 400-day bull run mostly measures whether you were long.
A dollar-neutral pair has directional beta near zero, so the benchmark it must
beat is ~0%.

Read the numbers next to that. Five falsified strategies, PF 0.64 to 1.013, all
of them with max drawdown 80–83% and total return −95% to −99.9% — every one of
them ran into the ruin circuit breaker at 20% equity. `sma-cross` is the closest
thing to a result in the set at PF 1.013 and Sharpe −0.023 with a t-stat of
−1.02, and it passed 1 of 5 symbols alone against a 60% bar. **All five were
falsified while carrying the same structural handicap, at the same time, and
none of them can be re-run to remove it.**

Where this goes beyond the data: the claim that the handicap is what suppressed
the results is a hypothesis, not a measurement. A cross-sectional strategy in
this sample might also have produced PF 0.7 — a real but small edge, eaten by 15
bps. What can be said without speculating is that **the five null results are
not independent evidence about triggers**, because all five were handicapped
identically, and the one hypothesis in the backlog that escapes the handicap
cannot be tested at all.

## What would falsify it

**One sentence:** if per-trade expectancy does not rise with the size of the
cross-sectional dislocation, and does not reproduce across more than one symbol
pair, residual mean reversion is not the mechanism.

**Gate criteria it is most likely to fail:** cost survival (≥ 40%) above all
everything else. Relative-value edges are small by construction and 15bps of
round-trip cost is the dominant term in the P&L. Walk-forward consistency
(≥ 50%) is the second risk, because a rank-and-fade rule will look good in one
dispersion regime and dead in the other. Neither is knowable in advance.

**The most informative failure:** a result that clears every bar only in the
sideways regime. That would mean the pair worked by avoiding a directional
benchmark rather than by trading relative decay — which is the same win wearing
a neutral costume, and would not be the result this card claims.

---

## Why it is blocked

**The mechanism.** The five majors are highly correlated but not perfectly. The
residual part of their relative moves decays, and the participants who close
that residual — a market maker quoting both legs, a pair rebalance that must
trade the underweight — are structurally obliged to act, not discretionary.

**Why the mechanism is real and not a pattern.** There is a named counterparty
on both legs, and neither can wait. That satisfies the test in `PLAYBOOK §4`:
name the participant who is forced to be wrong. This is the only card in the
backlog that clears that bar *and* escapes the regime-matched buy-and-hold
benchmark at the same time.

**Exactly what v1 lacks.** The simulator is one symbol with one open position,
long or short. There is no representation of "long BTC, short SOL". Concretely,
v1 has no:

1. **Multiple simultaneous positions.** A position list, not a position.
2. **Net and gross exposure accounting.** Sizing is a single notional derived
   from equity × 1% risk ÷ 2×ATR stop distance. A pair needs a per-leg notional
   with an explicit constraint that net ≈ 0 and gross is capped — an exposure
   model, not a stop-distance model.
3. **A benchmark regime-matched to a *neutral* position** rather than to
   holding. The existing benchmark is buy-and-hold, which is the right benchmark
   for a directional strategy and a structurally unfair one for a
   dollar-neutral one. This is not a metric tweak; it is a different question,
   and changing it inside v1 would invalidate every existing comparison.

**What a v2 would need to add.** A portfolio position model — multiple
concurrent positions, per-symbol sizing, net and gross exposure tracking with
assertions — and a neutral benchmark (a 0%-return cash position, or an
equity-beta-matched index) evaluated per regime. Plus an exit model that can
express a spread-level stop, because a relative-value position has no
directional price stop to place.

**Why this is a v2 trigger and not a patch.** The rule in `PLAYBOOK §6` is that
a capability gets added when a hypothesis that already has a mechanism genuinely
cannot be expressed — not when a strategy wants to pass. The correct move is a
separate generation with its own protocol hash and its own results archive,
never mixed with v1. Patching v1 to fit a hypothesis is how a protocol gets
quietly destroyed, and it is the specific outcome this card is written to
prevent.
