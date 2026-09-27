---
id: P-006
name: funding and basis crowding
slug: funding-basis-crowding
status: blocked
blocker: OHLCV only — no fundingRate, no openInterest, no basis series
code: none
---

# funding and basis crowding

**This is the missing forced flow.** `PLAYBOOK §4` sorts flows into forced,
scheduled, structural and discretionary, and says the category usually absent
from a crypto backtest and usually present in live markets is the forced one.
Funding is both forced and scheduled: it arrives on time, it does not care what
price did, and it cannot be negotiated.

It is also entirely invisible here. **OHLCV contains no trace of it.** That is a
diagnosis, not an excuse, and the rest of this card is written on that basis.

---

## Hypothesis

```yaml
name: funding and basis crowding

market_mechanism: >
  A crypto perpetual pays a funding rate between long and short holders on a
  fixed schedule — every 8 hours on Binance. The rate is set so that the
  perpetual price is pulled toward the index when the two separate, so the
  funding rate is a continuous, public, timestamped measure of how far perp
  positioning has pushed price away from spot. An extreme reading means one side
  is paying to hold, which means that side is crowded, and crowded positioning
  unwinds.

why_should_it_exist: >
  Yes, and more cleanly than anything else in this backlog. The counterparty is
  the leveraged holder who must pay regardless of price: someone who is long a
  perp paying a large funding rate is transferring wealth to shorts on a timer,
  and the rational response is to reduce, not to hold and hope. The flow is
  therefore price-insensitive and calendar-locked, which is the strongest
  possible position for a hypothesis — it does not depend on a forecast being
  correct. The honest weakness is different: the crowding is observable to
  everyone simultaneously, the rate is published in real time, and the unwinding
  that follows is exactly the trade the whole market is already positioned to
  make. The mechanism explains why the *flow exists*; it does not by itself
  explain why it would still be profitable after publication, funding itself
  already prices it in, and the unwind is precisely when being early is
  expensive.

expected_regime: >
  Should work in crowded regimes — extreme funding with open interest still
  rising, i.e. the crowd is adding, not already unwinding. Should NOT work
  after the unwind has started: once open interest is falling, the trade is late
  and the funding has usually already normalised. Should also fail when extreme
  funding is a *structural* feature of that particular symbol rather than a
  crowded-position reading, since then there may be a persistent reason for one
  side to pay. Both of those are observable in the data a v2 would have, which
  is the specific reason this is worth the data cost.

required_data: >
  OHLCV + funding rate, and optionally open interest. OHLCV alone contains no
  fundingRate field, no openInterest field, and no index or perp-vs-spot basis
  series, so the trigger is not merely unmeasured under v1 — it is undefined.
  A proxy built out of OHLCV would not be this hypothesis.

failure_condition: >
  If extreme funding marks crowding and crowding unwinds, then the unwind must
  begin after the funding extreme, not before, and the post-extreme return must
  be negative for the crowded side regardless of what price did in between. The
  clean falsifier: take the 20 most extreme funding readings in the sample, sort
  them into those where open interest was still rising into the print and those
  where it was already falling, and require the second group to do measurably
  worse. If it does not — if the return after an extreme print is the same
  either way — then funding is not measuring crowding, and the entire
  premise is wrong.
```

## Rules as numbers

```
# --- v2 only. NOT EVALUABLE UNDER v1 -----------------------------------------
# v1 has no fundingRate column, no openInterest column, and no index series.
# The conditions below cannot be computed from OHLCV. They are written so the
# v2 data requirement is specific rather than aspirational.

# --- parameters (default -> grid) -------------------------------------------
settle_hours     = 8      # Binance perp funding interval: 00:00 / 08:00 / 16:00 UTC
extreme_q        = 0.95   # {0.90, 0.95, 0.99}  quantile of trailing 90d funding
oi_z_min         = 1.50   # {1.0, 1.5, 2.0}    open-interest z-score vs 30d
basis_bps_min    = 50     # {25, 50, 100}      |perp - index| in bps
settle_cooldown  = 2      # bars. Do not trade the settlement bar itself
max_hold_settle  = 4      # {2, 4, 8}          hold cap, counted in settlements
fund_lookback_d  = 90     # trailing funding quantile window, days

# --- per symbol s, per bar i -------------------------------------------------
f(s, i)    = fundingRate for s at the most recent settlement <= time(i)
fq_hi(s,i) = quantile(f(s, ·), extreme_q, over trailing fund_lookback_d days)
fq_lo(s,i) = quantile(f(s, ·), 1 - extreme_q, same window)
oi_z(s, i) = (openInterest(s, i) - mean_30d) / sd_30d(openInterest)
bars_since_settle(i) = bars since the most recent settlement <= time(i)

IF   f(s, i) > fq_hi(s, i)          # longs are paying
AND  oi_z(s, i) > oi_z_min          # and the crowd is still adding
THEN short s on the next bar's open
IF   f(s, i) < fq_lo(s, i)          # shorts are paying
AND  oi_z(s, i) > oi_z_min
THEN long  s on the next bar's open

IF   bars_since_settle(i) < settle_cooldown
THEN no entry in s, regardless of f(s, i)

# The simulator owns the exit: 2xATR(14) stop and a fixed 96-bar max hold.
# max_hold_settle is a v2 requirement, not a v1 parameter.
```

## When to use

- **Regime:** crowded and still building. Extreme funding *and* open interest
  above its 30-day mean by more than 1.5 standard deviations. Once open
  interest turns down, the signal is late by construction and should be
  disabled, not merely sized down.
- **Horizon:** 2–8 funding settlements — 16 to 64 hours — which is two to three
  days. Funding crowding unwinds over settlements, not over bars, so this is a
  multi-day holding period wearing a 15m timeframe.
- **Timing constraint that v1 cannot honour:** the signal must be evaluated
  *between* settlements and never on the settlement bar itself, because the
  settlement prints the funding and moves the price simultaneously. 15m bars
  align with the 00:00/08:00/16:00 UTC grid, so this is achievable — but only
  if the funding series is stamped to bars correctly, which is the alignment
  problem named in the blocker.
- **Sizing:** 1% of equity risked per trade, 2×ATR(14) stop, 10× max leverage,
  1 open position. Note the mismatch: a funding-crowding trade wants a *time*
  exit at a settlement count, and the exit is owned by the simulator.

## When not to use

- **Do not proxy it with OHLCV.** The tempting substitute — "buy after a large
  down-move" — is `sweep-reversal`, which we already ran: 1,565 trades, PF 0.64,
  Sharpe −0.138, the worst result in the set. If the crowding signal is only
  reachable through price, we have already measured it and it lost.
- **Do not treat a funding extreme in isolation.** Extreme funding with falling
  open interest is a crowd that has already left. That is the single most likely
  way to run this backwards.
- **Confusion risk:** indistinguishable from a momentum signal in shape — both
  fade or follow a large recent move. The separator is the funding print itself:
  a momentum signal needs the price move to continue, this one needs it to
  stop. If the funding rate is not part of the decision, it is not this card.

## Why it was proposed

Because the shape of the whole result set is what you would expect if every
trade we ever took was selected by discretionary price action and never once by
a forced counterparty.

Six hypotheses have run. `long-with-stop` 2,278 trades PF 0.84;
`sma-cross` 1,984 PF 1.013; `donchian` 1,645 PF 0.92; `sweep-reversal` 1,565 PF
0.64; `trend-pullback` 1,557 PF 0.97; `vol-expansion` 686 PF 0.69. The negative
controls put the noise floor at 0.751 (`_control_random`) to 0.837
(`_control_alwayslong`). So every trigger we have tested scored at or barely
above a random trade stream, with Sharpe t-stats that do not distinguish from
zero — `sma-cross` at −1.02 is the tightest of them. Win rates clustered 16–23%
across all six, which is a property of the shared exit model rather than the
triggers.

Not one of those six had access to a forced, scheduled, price-insensitive flow.
**That is a diagnosis of the data, not of the triggers.** `PLAYBOOK §4` notes
that most forced flows are structurally absent from an OHLCV backtest and calls
that "not an accident, and the strongest structural argument for the v2 data
list". This card is that argument written down with rules attached.

Where it goes beyond the data: everything about the magnitude. We have no
measurement of funding rates in this sample, no distribution, no persistence, and
therefore no idea whether what remains after 15bps of round-trip cost is
tradeable. The claim that this is where the edge is, is an argument from the
shape of the flow table, not from any number in this repo.

## What would falsify it

**One sentence:** if the return after an extreme funding print is the same
whether open interest was rising into it or already falling, then funding is not
measuring crowding and the premise is wrong.

**Gate criteria it is most likely to fail:** symbol pass rate (≥ 60%) and
walk-forward consistency (≥ 50%) — both for the same reason. Funding regimes in
crypto cluster in a few violent episodes rather than distributing evenly across
400 days, so a 5-symbol sample can put a fifth of its trades inside one month.
Sample size is not the risk here; **concentration** is. Expect the trade count
to be met and the per-symbol agreement to be the thing that breaks, and treat
that as informative rather than annoying — it would mean crowding unwinds for
one symbol and not another, which is a real finding about the mechanism.

**The most informative failure:** a well-powered result that only works on one
symbol. It would mean funding is a property of that particular market's
participant mix rather than a general crowding gauge, and it would usefully
close off the whole family of funding-based hypotheses rather than just this
one.

---

## Why it is blocked

**The mechanism.** A crypto perpetual pays a funding rate between long and short
holders on a fixed 8-hour schedule. The rate is a public, timestamped measure
of how far perp positioning has pushed price away from the index, and therefore
of how crowded that positioning has become. Crowded positioning unwinds, and
the participant on the crowded side is paying a timer, not making a judgement.

**Why the mechanism is real.** It satisfies `PLAYBOOK §4`'s test for a forced,
scheduled flow, which is the category that table says is "usually absent from a
crypto backtest and usually present in live markets". The flow arrives on time
regardless of price. Nobody on the paying side has a choice about it. This is the
strongest class of counterparty we have identified and the only one where the
flow is guaranteed to exist independently of anyone's forecast being correct.

**Exactly what v1 lacks.** Not resolution — **data**. The dataset is
Binance BTCUSDT, ETHUSDT, DOGEUSDT, SOLUSDT, ZECUSDT, 15m, 400 days, 38,401 bars
each, 0 gaps across 192,005 bars. It is OHLCV and nothing else. There is no
`fundingRate` field, no `openInterest` field, no index price and therefore no
basis series, and no intrabar detail. The trigger condition is not imprecise
under v1 — it is **undefined**. No amount of care with the bars we have
produces a number that this rule needs.

**What a v2 would need to add.**

1. `fundingRate` from Binance's fapi endpoints, per symbol, at the 8-hour
   settlement resolution.
2. Optionally `openInterest`, which is what separates "crowded" from "crowded
   and still unwinding" — the distinction the failure condition turns on.
3. Optionally the perp-vs-index basis series, so basis can corroborate funding
   rather than being inferred from it.
4. **A higher-frequency series, to align the 8-hour funding settlements to 15m
   bars.** This is the part that is easy to get silently wrong: a settlement
   stamped to the wrong bar, or forward-filled across one, and the trade is
   entered on information the market already had. Alignment is a leakage
   question, and `research/leakage.mjs` should be extended to cover it rather
   than trusted to a fill routine.

**The measured cost of the absence.** A scheduled flow arrives on time
regardless of price — which is exactly the category OHLCV cannot represent. Most
forced flows are invisible to this harness, and that is a statement about the
harness, not about the market. Six hypotheses have been tested against a
dataset structurally incapable of showing us the flows most likely to contain a
counterparty, and every one of them landed between PF 0.64 and 1.013 against a
noise floor of 0.75–0.84. That is the argument for v2, and it is the whole of
it.
