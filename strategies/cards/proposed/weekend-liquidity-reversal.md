---
id: P-004
name: weekend liquidity-window reversal
slug: weekend-liquidity-reversal
status: proposed
code: none
---

# weekend liquidity-window reversal

**The lowest-ranked v1-representable card in the backlog, deliberately.** The
mechanism is plausible and it is cheap to write down, which is exactly why it is
last: it is a calendar effect, and a calendar effect is the easiest kind of thing
in this repo to fit by accident.

The framing matters more than the rule. `research/gate.mjs` treats timestamp
dependence as an **ADVISORY rather than a disqualifier** — deliberately, and for
a reason that is stated in `research/leakage.mjs:128-133`: reading the current
bar's timestamp is legitimate ("trade only on Tuesdays" is a real strategy), but
a signal that only works *because of* the specific timestamps it was tuned on is
fitted to the clock, not the market. Reading a future bar is mechanically
inexcusable; this one is reviewable by a human, so it is recorded and surfaced
rather than auto-rejected.

**Therefore: a result here that only works on Saturday nights is more likely a
fit than a mechanism, and the correct response is to discard it even if the gate
is technically satisfied.** Test it last. Treat a pass as a hypothesis to be
disbelieved, not an edge to be traded.

---

## Hypothesis

```yaml
name: weekend liquidity-window reversal

market_mechanism: >
  Crypto has no official close, but liquidity is not uniform across the clock.
  Weekend and Asian-hours books are structurally thinner: fewer market makers
  quoting, wider spreads, less resting depth, and a smaller set of participants
  able to absorb size. A move through a thin book overshoots relative to the
  value that actually moved, because the price impact per unit of flow is
  higher when depth is lower. As makers requote — which happens when depth
  returns, i.e. at the session boundary — the overshoot decays.

why_should_it_exist: >
  The counterparty is the taker who must execute now regardless of price: the
  participant with a scheduled or forced reason to transact in a specific
  window, and who therefore pays the elevated impact of a thin book. That
  participant is not making a view, so the resulting price is not information.
  This is the strongest form the argument can take, and it is still weaker than
  it looks. The same weekend flow is equally available to every other taker in
  that window, including us, and we are not early. The reason to believe the
  overshoot decays is that requoting is mechanical rather than discretionary —
  but the honest counter is that the crowd reads the same thinness we do, and
  the decay may be fully anticipated and priced in by the time a bar closes.
  I do not know how to settle that from a chart, which is part of why this card
  is ranked last rather than first.

expected_regime: >
  Should work only in windows where realised volume is a small fraction of its
  own trailing baseline, and only on moves that are large relative to ATR. Should
  NOT work in high-volume windows — and that is a testable prediction, not a
  caveat: the same trigger fired during liquid hours should be indistinguishable
  from noise. A version of this rule that works equally well at all hours is not
  this hypothesis, it is a generic reversion claim we have already falsified.

required_data: >
  OHLCV only. Volume is required, not optional: "thin" is proxied as the
  session's share of a 30-day volume baseline. Note the proxy is circular —
  volume is low on weekends *because* it is the weekend, so "thin" and
  "weekend" are close to the same variable wearing two names.

failure_condition: >
  If thin-book overshoot-and-requote is the mechanism, then three things must
  hold together. (1) Reversion magnitude must scale with the size of the
  overshoot; if expectancy is flat in overshoot size, the edge is noise.
  (2) It must be absent in thick-book windows using the identical trigger, not
  merely weaker. (3) It must not be a function of the hour boundary specifically:
  shifting the session mask by a few bars and re-measuring should reproduce the
  result, because the mechanism is depth, not the clock. If the effect appears
  only at the exact hours named here and evaporates when the mask is shifted,
  the mechanism is wrong and the calendar is the signal.
```

## Rules as numbers

```
# --- parameters (default -> grid) -------------------------------------------
session_bars        = 4      # {4, 8}        length of the thin-book session, 15m bars
thin_share_max      = 0.20   # {0.10, 0.20, 0.30}  session volume / trailing volume
baseline_bars       = 2880   # {2880, 5760}  30d / 60d trailing volume baseline
overshoot_atr_min   = 1.00   # {0.75, 1.00, 1.50}  |close-open| in ATR(14) units

# --- session mask (UTC) ------------------------------------------------------
# Saturday 00:00 through Monday 00:00, plus 00:00-08:00 on every day.
# This mask is the hypothesis, not a parameter. It is not swept.

# --- per bar i ---------------------------------------------------------------
thin(s, i)  = sum(volume, i-session_bars .. i)
            / sum(volume, i-baseline_bars  .. i)        <= thin_share_max

up_move(i)  = (close(i) - open(i)) / atr(14, i)        >= overshoot_atr_min
dn_move(i)  = (open(i) - close(i)) / atr(14, i)        >= overshoot_atr_min

IF   in_session_mask(time(i)) AND thin(s, i) AND up_move(i)
THEN sell s on the next bar's open
IF   in_session_mask(time(i)) AND thin(s, i) AND dn_move(i)
THEN buy  s on the next bar's open

# The simulator reads a signal only when flat: 1 open position, one symbol.
# No exit is specified here and none can be. See the note below.
```

**The exit is the mechanism, and we cannot specify it.** The thesis is that the
overshoot decays *as makers requote*, which happens when depth returns — at the
session boundary. The simulator owns the exit: 2×ATR(14) stop and a fixed max
hold of 96 bars, which at 15m is 24 hours. A trade opened on Saturday night
cannot survive to Monday under a 24-hour hold, so the simulator time-exits the
position before the requote it is waiting for. The card is therefore
*representable but poorly matched to the exit envelope*, which is a second,
independent reason to rank it last. A shorter session mask makes this worse; a
longer one improves the fit and is untestable here.

## When to use

- **Regime:** thin-book sessions only — session volume ≤ 20% of its own 30-day
  baseline — and only on moves ≥ 1×ATR(14) within the session. Outside that,
  do not fire.
- **Horizon:** intended to be held until the overshoot decays, which is the
  session boundary — hours, not days. Expected to fire ~800 times across the
  five symbols over the 400-day window. **If the realised count lands materially
  below ~500, stop: the gate requires ≥ 500 trades and will reject on sample
  size before it ever looks at quality.** A state-conditional trigger is the
  usual way a card quietly fails on arithmetic rather than on merit.
- **Sizing:** 1% of $1000 equity risked per trade, 2×ATR(14) stop, 10× max
  leverage — all owned by the risk engine. The signal would like a smaller size
  in thin books, because the 15bps round trip (10 fee + 5 slippage) is a much
  larger fraction of a thin-book move than of a liquid one. It cannot ask.

## When not to use

- **Never as a first test.** Ranked last on purpose; see the header.
- **Never on a result that came from a shifted or swept hour mask.** The mask is
  not a parameter. If it is ever swept, the card is no longer this card.
- **Never alongside any other calendar claim.** Do not combine this with a
  "Tuesdays work" filter to lift the count. That is the search, not the test.
- **Confusion risk:** this is easy to mistake for P-001 (serial-correlation sign
  flip) or for a plain mean-reversion trigger. The two are separable in one
  number: P-001 flips the *sign* of the trade with a measurable state variable;
  this card keeps the sign fixed and conditions only on *when*. If the state
  variable cannot be computed in advance, the honest result is that the effect
  is not measurable and this card is dead.

## Why it was proposed

The ancestor is a negative one, and it should be stated first: the only pure
reversion trigger we have run is the **worst result in the entire set** —
`sweep-reversal`, 1,565 trades, PF 0.64, Sharpe −0.138, max DD 82.7%. We have
already measured reversion in this sample and it lost, hard. P-004 is not a new
reversion idea; it is a reversion idea with a state condition attached, and the
justification for the state condition is that unconditional reversion failed.

The supporting observation is the noise floor. The negative controls measured PF
0.837 (`_control_alwayslong`) and PF 0.751 (`_control_random`), so ~0.75–0.84 is
what a trade stream with no information scores here — not 1.0. Every tested
strategy sits at 0.64–1.013, i.e. at or barely above that floor. `sma-cross` at
PF 1.013 with a Sharpe t-stat of −1.02 is a precise measurement of nothing. If
P-004 has a real mechanism, it should clear **0.84 by a margin that survives
500+ trades**, not land at 1.02.

Where the hypothesis goes beyond the data: nothing in our results measures
session liquidity, session boundaries, or time-of-day return structure. The
weekend/Asian-hours claim is imported from market-structure knowledge, not from
anything in this repo, and `thinness` is being proxied by a variable that is
itself a clock. That is the whole overfit exposure, stated plainly.

## What would falsify it

**One sentence:** if the reversion does not scale with overshoot size, and is
not absent in thick-book windows, the thin-book mechanism is not real.

**Gate criteria it is most likely to fail:** parameter sensitivity (≥ 30%) and
per-symbol pass rate (≥ 60%) are both at risk, because a weekend-window rule has
almost no room in a grid — any movement of the mask or the thinness threshold
plausible on five symbols' worth of weekend bars is likely to change the
result qualitatively. Expect a calendar-dependence ADVISORY on the run as well;
that is expected and is not itself the failure.

**The most informative failure:** PF landing at or below 0.84 across 800+ trades.
That is a clean, well-powered null — same-day, same-symbol, same-cost answer to
the question — and it is worth considerably more than a pass at 1.05, which this
card is structurally capable of producing by accident.
