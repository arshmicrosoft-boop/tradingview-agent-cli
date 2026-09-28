# Backlog — the triage board

**v1 is frozen. It is a discovery filter, not a scoreboard.**

The goal is not a passing strategy. The goal is **one hypothesis that survives
v1**. Everything below is ranked by what it would teach us, not by how likely it
is to work.

Cards: [`cards/proposed/`](./cards/proposed/) · Code: `research/strategies/`

---

## The board

| # | hypothesis | status | mechanism in one line | expected trades | notes |
|---|---|---|---|---|---|
| [P-001](./cards/proposed/serial-correlation-sign-flip.md) | serial-correlation sign flip | **falsified** | the sign of short-horizon autocorrelation is state-dependent, so the trade must flip with it | ~1,500 | Killed at the measurement stage — never implemented |
| [P-002 → T-008](./cards/tested/vol-normalized-breakout.md) | volatility-normalized breakout | **falsified** | thresholds measured in ATR units mean the same thing in a 10%-vol week and a 100%-vol week | ~1,200 | Implemented, renumbered T-008, run under v1 |
| [P-003](./cards/proposed/selectivity-on-falsified-trigger.md) | selectivity on a falsified trigger | **queued** | fixed triggers earn nothing per trade; the same signal filtered to high-information states may | ~600 | Diagnostic: separates "bad trigger" from "traded too much". See the note below — this status is stale |
| [P-004](./cards/proposed/weekend-liquidity-reversal.md) | weekend liquidity-window reversal | proposed | thin-book weekend moves overshoot, then revert when makers requote | ~800 | Highest overfit risk in the set. Test last |
| [P-005](./cards/proposed/cross-sectional-relative-value.md) | cross-sectional relative value | **blocked** | majors are correlated but not perfectly; relative moves decay | n/a | Needs a v2 harness. Strongest candidate in this list |
| [P-006](./cards/proposed/funding-basis-crowding.md) | funding/basis crowding | **blocked** | crowded perp positioning unwinds when funding is extreme | n/a | Needs funding + open interest. v2 data |
| — | exit-aware trend capture | **blocked** | most of the return in a trend is in the tail, and a fixed 2×ATR stop guarantees you never hold it | n/a | Cannot be expressed. Strongest v2 argument. Not a card — see below |
| — | vol-scaled trailing exit | **blocked** | ditto, expressed more simply | n/a | Same blocker. Not a card — see below |

**The noise floor for every "expected trades" figure above is a profit factor of
0.75–0.84, not 1.0** — see the two negative controls in
[`cards/controls/`](./cards/controls/). A new card has to clear 1.3, which is
0.45 of profit factor above a coin flip.

**State of the board, 2026-09-27.** Three of the six cards below have been
measured. P-001 and P-002 (now T-008) are `falsified` and the rows say so. P-003
was run as a diagnostic, its RESULT is on the card, and its `status: queued` is
therefore stale — it is still shown as queued because changing that status is a
research decision, not a repo-hygiene one. **P-004 is the highest-ranked card
that has never been run.**

Note what the measured cards have in common with each other and not with P-003:
P-001 and P-002 were implemented as strategies, so they were renumbered `T-`
and filed in [`cards/tested/`](./cards/tested/); P-003 was deliberately run
*outside* `research/strategies/` so it could never be gated, so it kept its `P-`
id and stayed in `cards/proposed/`. A `falsified` card in `cards/proposed/` is
not a contradiction — see [`README.md`](./README.md#the-directory-is-the-duty-status-is-the-verdict).

---

## P-001 — serial-correlation sign flip · **closed, falsified**

**The hole in our experiment design.** Five of six strategies were long-only;
the sixth was short-only. We varied the trigger five times and the *sign* zero
times. If the true sign of the edge is state-dependent, then a fixed sign
averages it to zero — which is exactly what the results show: PF 0.84 long,
0.64 short, 1.01 on the one strategy whose trigger was mildly informative.

The mechanism is not a guess. Short-horizon return autocorrelation in
cryptocurrency is well documented as state-dependent: gradual information
diffusion and herding produce positive autocorrelation, while liquidity-demand
shocks and overreaction produce negative. Both regimes are present in any
400-day window, and which one is active is observable in advance.

**Why I believe it more than the others:** it is the only card that explains
our existing null result instead of ignoring it.

**The main risk, stated up front:** estimating autocorrelation from 15m bars is
statistically treacherous. The naive sample autocorrelation is severely biased
toward zero when the data is noisy (Lo & MacKinlay 1988), and a biased
estimator will produce a sign that flips on noise. This is why the card
specifies a variance-ratio estimator over a long window rather than a simple
lag-1 correlation, and why the failure condition is about estimator stability.

**What would falsify it:** the estimated correlation sign changes more often
than it holds, or the strategy's PF is not materially above the best of the two
fixed-sign variants. Either means the state is not measurable in advance, and
"the edge exists but you cannot see which regime you are in" is not an edge.

---

## P-002 — volatility-normalized breakout

**Crypto volatility varies roughly 10× over a 400-day window.** A 20-bar
breakout measured in *price* is an entirely different bar depending on the week
it lands in. Every strategy we tested expressed its price thresholds in raw
price units, so the same rule silently became a harder test in high volatility
and an easier one in low volatility, with no way to tell which regime produced
any given trade.

Re-expressing the trigger in ATR units — breakout distance divided by ATR — makes
the same rule mean the same thing everywhere. This is a claim about
*measurement*, not a new indicator, and it is testable by holding the trigger
fixed and changing only the units.

**What would falsify it:** vol-normalized and raw price thresholds produce
materially the same profit factor. Then regime-dependent selectivity is not the
missing ingredient, which usefully eliminates a whole family of ideas.

---

## P-003 — selectivity on a falsified trigger

This is an **experiment design**, not a new idea, and that is why it is queued
third rather than first: it is a diagnostic.

Take `sma-cross` — a trigger we already know has no edge — and add a filter
that trades it only in high-information states. The question is not "does this
make money". The question is:

> **Is our trigger worthless, or is it a good trigger we have been applying at
> the wrong times?**

If expectancy per trade *improves* as trade count falls, the trigger carries
information and the problem was frequency. If expectancy is flat across
selectivity levels, the trigger is noise and no filter will rescue it. Both
answers are valuable; the second one closes off an enormous space of ideas that
would otherwise keep being proposed.

**What would falsify it:** per-trade expectancy is flat, or slightly *worse*,
at high selectivity. Stronger filter, worse trades, means the surviving trades
are the ones that needed the filter's context most.

---

## P-004 — weekend liquidity-window reversal

Crypto has no official close, but liquidity is not uniform. Weekend and
Asian-hours liquidity is structurally thinner, and moves through a thin book
overshoot relative to the value that moved. They then revert as makers requote.

**Lowest-ranked v1-representable card, deliberately.** This is a calendar
effect, and `research/gate.mjs` already flags timestamp dependence as an
ADVISORY rather than a disqualifier precisely because a strategy that works
*because of* the specific timestamps it was tuned on is fitted to the clock
rather than the market. A result that only works on Saturday nights is more
likely a fit than a mechanism, and the honest response to such a result is to
discard it even if the gate is technically satisfied.

Test it last, and treat a pass as a hypothesis to be disbelieved rather than an
edge to be traded.

---

## P-005 — cross-sectional relative value · **blocked on v2**

**The most likely thing to work, and the one v1 cannot express.** The simulator
is one symbol, one position, long or short — there is no representation of "long
BTC, short SOL".

The mechanism is straightforward: the five majors are highly correlated but not
perfectly, and residual relative moves between them decay. The reason this card
matters more than its mechanism does is structural. Every directional strategy
we tested had to beat **buy-and-hold in the same regime** — in a bull window
that is a benchmark of several hundred percent. A dollar-neutral pair has
directional beta near zero, so the benchmark it must beat is ~0%. This is the
single largest structural handicap in our results, and it applies to all five
falsified strategies at once.

This is a legitimate v2 trigger under the rule in `PLAYBOOK §6`: the mechanism is
written, believed, and simply cannot be expressed. It is not a reason to patch
v1, and patching v1 is how protocols get quietly destroyed. The correct move is
a separate generation with its own results archive.

**What a v2 needs:** a portfolio position model — multiple simultaneous
positions, net and gross exposure, per-symbol sizing — and a benchmark that is
regime-matched to a *neutral* position rather than to holding.

---

## P-006 — funding / basis crowding · **blocked on v2 data**

**This is the missing forced flow.** Crypto perpetuals have a funding rate
charged periodically, and it is a scheduled, price-insensitive transfer of
wealth between long and short holders. Extreme funding is a public, timestamped
measure of how crowded positioning has become, and crowded positioning unwinds.

It is also, for our purposes, entirely invisible: OHLCV contains no trace of it.
This is the clearest example of why "most forced flows are structurally absent
from an OHLCV backtest" is not an excuse but a diagnosis.

**What a v2 needs:** `fundingRate` and optionally `openInterest` from Binance's
fapi endpoints, plus a higher-frequency series to align the 8-hour funding
settlements to 15m bars.

---

## Blocked on the exit model (no v2 data required — a v2 harness change)

Two cards, both expressing the same idea: **most of the return in a trend is in
the tail, and a fixed 2×ATR stop with a fixed 96-bar time exit guarantees you
never hold it.** Every one of the five tested strategies wore the identical
exit, and the win rates clustered at 16–23% — the tight clustering across
wildly different triggers is a property of that shared exit, not of the
triggers.

The simulator reads a signal only when flat, so no strategy can express "cut
here", "let this run", or "hold until the trend ends". A hypothesis whose entire
edge is in exit placement is therefore **untestable in v1**, not untested.

I have not written these as cards, because a card you cannot implement is
better expressed as a v2 requirement with the reasoning attached. It is recorded
here, and it is the cheapest of all the v2 changes: the data is already there,
only the simulator's exit logic has to become strategy-supplied.
