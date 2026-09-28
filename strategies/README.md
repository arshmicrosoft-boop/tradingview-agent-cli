# Strategies — the knowledge base

**Code lives in `research/strategies/`. Knowledge lives here.**

A strategy file is thirty lines of arithmetic. It cannot hold *why* the rule
exists, *when* it should be trusted, or *what its failure taught us*. Those decay
the moment you write them, and a rule with no remembered mechanism is a
description of the past.

This directory is the memory. The gate is the judge. Neither replaces the other.

---

## The workflow

```
1. HYPOTHESIS   write a card in cards/proposed/  (SCHEMA.md — no code yet)
      ↓
2. TRIAGE       the card earns a place or it does not (BACKLOG.md — needs a reason)
      ↓
3. IMPLEMENT    one file in research/strategies/  (rules as numbers, grid exported)
      ↓
4. TEST        npm run research:all   — frozen protocol v1, no exceptions
      ↓
5. RECORD      card moves to cards/tested/ and is renumbered P-00n -> T-00n,
               because it now carries run data. The verdict goes in `status:`.
      ↓
6. PROMOTE     only if the gate says pass. That has never happened.
```

**Step 2 is the one people skip, and skipping it is how you end up testing
ninety indicators instead of one mechanism.** A card with no `why_should_it_exist`
does not get implemented, no matter how good the backtest looked.

---

## Current state

| | |
|---|---|
| Cards in the base | **15** |
| Distinct hypotheses tested | **7** (not 8 — see below) |
| Hypotheses that passed v1 | **0** |
| Champion | **none** |
| Negative controls | **2** |
| Queued, representable under v1 | **1** — P-003 |
| Written, lowest priority | **1** — P-004 |
| Blocked on protocol v2 | **2** — P-005, P-006 |
| Next one | **P-003** — selectivity on a falsified trigger — *stale, see below* |

*P-003 was run on 2026-09-27 as a diagnostic and its RESULT is recorded on the
card, so its `status: queued` and `registry.json`'s `next: "P-003"` are both out
of date. Neither has been changed here: re-pointing the queue is a research
decision, not a hygiene one, and P-003's own conclusion — that it could not answer
its question as specified — does not map cleanly onto `queued` or `falsified`.
That is the one open item in the card-state model.*

### The protocol hash, and the defect that made it a fiction

Every card above cites `protocol_hash`, and `validate.mjs` fails the build if a
card's hash disagrees with its run's. That only means something if the hash can
see the thresholds.

It could not. `protocol.mjs` canonicalised with
`JSON.stringify(p, Object.keys(p).sort())`, and when the replacer is an array it
acts as a key whitelist applied at *every* level of nesting, not just the top.
A whitelist of top-level names therefore matched no nested key, and every nested
object serialised to `{}` — the protocol hashed to 454 characters of its real
1,414, with `criteria:{}`, `costs:{}` and `risk:{}` all empty. Relaxing
`MIN_PF` from 1.3 to 0.01, zeroing fees, or raising risk per trade from 1% to
100% **all produced the identical hash**. Every card in this directory was citing
a fingerprint that could not distinguish a frozen protocol from a rigged one.

`protocol.mjs` now uses a real recursive canonicalisation and carries 21
selftests, twelve of which mutate a different threshold and assert the hash
moves. The v1 hash changed from `1e42a7d31d851b9b` to `ab8d990e445b2927`, all
10 cards were re-cited, and every strategy was re-run — producing bit-identical
metrics, which is the result you want from a re-run: nothing moved except the
fingerprint.

`npm run verify` also fails if the **latest** run per strategy cites a stale
hash. Historical records are kept, deliberately: a re-run appends rather than
overwrites, and the old records are the proof that the old broken hash was in
use. Pruning them would destroy the evidence the mechanism exists to provide.

**A v2 generation now exists** — `research/protocol.v2.json`,
`research/robustness.mjs`, `research/gate-v2.mjs`, results in
`research/registry-v2/`. It restates all 18 v1 criteria at their exact v1 values,
changes none of them, and adds 7 robustness criteria. The two generations never
share an archive or a leaderboard. All 10 strategies fail all 7 of the new ones;
see the root `README.md` for what v2 measures and why v1 structurally could not.

**Read the numbers in the wrong order and you will learn the wrong thing.**
The result table in the root `README.md` is sorted by Sharpe, but Sharpe is the
*least* informative column here: every strategy ran into the ruin circuit
breaker, so max drawdown is 80–83% and total return is −95 to −99.9% for all of
them. That is the fingerprint of the risk envelope, not a measurement of skill.

Read the table in this order instead:

1. **trade count** — did it produce a sample at all?
2. **profit factor** — the actual expectancy signal.
3. **the noise floor** — see below. All seven sit at 0.36–1.01, and the bar they
   have to clear is 0.75–0.84, not 1.0.
4. *then* Sharpe / drawdown — near-zero inputs, so differences are noise.

A PF of 1.013 over 1,984 trades is a very precise measurement of nothing.

### The noise floor, and why it is not 1.0

The two negative controls ([C-001](./cards/controls/alwayslong.md),
[C-002](./cards/controls/random.md)) score **PF 0.837** and **PF 0.751**. A
trade stream with no information does not score 1.0 on this harness; it scores
*below* it, because 15 bps per round trip is charged on both sides of a
churn-heavy stream and the drift is only captured half the time by a random side.

```
_control_random      0.751   no information, half the drift
_control_alwayslong  0.837   no information, all the drift, always long
sma-cross            1.013   a trigger with a little information
gate requires        1.300
```

The margin between the best hypothesis and the controls is 0.18 of profit factor.
**This is the single most useful calibration in the repo**, and it is why
`sma-cross` is not "our best candidate" — it is a draw that landed slightly high,
with a Sharpe t-stat of −1.02 that cannot distinguish it from the controls.

### The duplicate

`long-with-stop` and `_control_alwayslong` are the same signal. Both return
`{ side: "buy" }` unconditionally; the only difference is that one exports a
`grid` and the other does not. They produce identical metrics (2,278 trades,
Sharpe −0.028, PF 0.84). One of the eight "strategies" is the negative control
wearing a different name — so the distinct hypothesis count is **seven**, and
one of those seven is deliberately meaningless.

---

## Layout

```
strategies/
  README.md          this file — index and current state
  SCHEMA.md          the card format. Required fields, and what each one is for
  TEMPLATE.md        blank card, copy this
  BACKLOG.md         the triage board. What is queued and why
  PLAYBOOK.md        how to think about this. Read before writing a hypothesis
  registry.json      machine-readable index, consumed by validate.mjs
  validate.mjs       card linter — run by `npm run verify`
  cards/
    proposed/        written, never implemented as a strategy. The frontier (5)
    tested/          run under v1, reconciled against the run archive    (8)
    controls/        negative controls — no possible edge, by construction (2)
```

### The directory is the duty, `status` is the verdict

**The directory records what was done to a card. `status:` records what the
evidence concluded.** They are different axes. T-001 carries `status: falsified`
and lives in `cards/tested/`, which reads like a contradiction and is not one: it
was run under v1, and it failed. Both facts are recorded, in the two places that
can record them.

| directory | means | statuses actually found there |
|---|---|---|
| `cards/proposed/` | never written as a gated strategy | `proposed`, `queued`, `blocked`, `falsified` |
| `cards/tested/` | run under v1, numbers reconciled against `research/registry/*/runs.jsonl` | `falsified` — 8 of 8 |
| `cards/controls/` | a negative control, no possible edge by construction | `falsified` — 2 of 2 |

**There is deliberately no `cards/falsified/` directory, and adding one would cost
more than it buys.** `falsified` is a verdict, and 11 of the 15 cards carry it;
a directory holding 73% of the base, beside three directories holding the rest,
tells you nothing you cannot read off the front matter. It would also break three
things that are load-bearing:

- `validate.mjs` keys the id prefix on the directory (`T` must live in `tested/`),
  so all eight `T-` cards would start failing the linter.
- the result keys and the reconciliation against
  `research/registry/<dir>/<slug>/runs.jsonl` are keyed on the directory too, so
  a moved card would silently stop being checked against its own run — the one
  check that makes a number written on a card worth reading.
- `cards/tested/` would be left **empty**, because no card has ever passed. A
  directory called "tested" holding nothing, with eleven falsified cards filed
  elsewhere, inverts the meaning of the only word in its name.

What the repo already does is consistent, and it predates this note. A card is
renumbered `P-00n` → `T-00n` and moved into `cards/tested/` **at the moment it
becomes a strategy with a run record** — see the header of
[T-008](./cards/tested/vol-normalized-breakout.md), which was `P-002`. P-001 and
P-003 were measured without ever becoming strategies, so they keep a `P-` id,
stay in `cards/proposed/`, and carry a verdict of their own. `AGENT.md` says the
same thing from the other end: a strategy "is then falsified or promoted
automatically by `npm run research`" — the machine writes `status:`, and nothing
in this repo moves files.
---

## How to add a hypothesis

```bash
# 1. copy the template
cp strategies/TEMPLATE.md strategies/cards/proposed/my-hypothesis.md

# 2. fill in all six required fields. validate.mjs fails if you skip one.
#    "why_should_it_exist" is the field that decides whether this is worth doing.

# 3. check it
node strategies/validate.mjs

# 4. once it has a reason, implement it
#    research/strategies/my-hypothesis.mjs
#    npm run research:all
```

`validate.mjs` is wired into `npm run verify`. A malformed card is a failing
check, same as a leaky simulator. That is deliberate: this repo's entire value
is that its rules are enforced rather than documented.

It currently runs **422 checks across 15 cards**. The checks that matter most
are not structural: every card in `cards/tested/` and `cards/controls/` is
reconciled against `research/registry/*/runs.jsonl`, so a card that quotes
`profit_factor: 1.013` when the run says `0.917` **fails the build**. Three such
mismatches existed when the linter was first switched on, which is the argument
for having it. Two more appeared while fixing the protocol hash: a stale
`protocol_hash` on all 10 cards, and `vol-normalized-breakout` still quoting
`unmet: 18` after the walk-forward criterion was rewired. Both were caught, both
would have been invisible to a human re-reading a diff.

---

## What v1 cannot do

Not every good hypothesis is testable under the frozen protocol. Three classes
are blocked, and pretending otherwise wastes a week:

**Not representable by the exit model.** The simulator owns exits — a fixed 2×ATR
stop and a fixed 96-bar time exit. A signal is only read when flat. So a strategy
cannot say "cut here", "let this one run", or "hold until the trend ends". Any
hypothesis whose edge lives in exit placement is **untestable in v1**, not
merely untested.

This is the cheapest of all the v2 changes — the data is already there, only the
simulator's exit logic has to become strategy-supplied. It is also the best
supported: win rate clustered at 16–23% across wildly different triggers, and
that tightness is a property of the *shared exit*, not of the triggers.

It is recorded in [`BACKLOG.md`](./BACKLOG.md) as a v2 requirement rather than as
a card, because a card that cannot be implemented is a documented blocker, and
writing it as a card would invite someone to try to implement it.

**Not representable by the harness shape.** The simulator is one symbol, one
position, long or short. Cross-sectional strategies — long the strongest, short
the weakest, dollar-neutral — have no representation at all. In a bull market
that is a huge advantage, because the benchmark a market-neutral strategy has to
beat is ~0% rather than the +696% that buy-and-hold returned over this window.
See [P-005](./cards/proposed/cross-sectional-relative-value.md) for why that
matters more than its mechanism does.

**Not representable by the data.** OHLCV contains no funding rate, no open
interest, no order book, no intrabar structure. Most *forced* flows are
invisible for exactly that reason. See
[P-006](./cards/proposed/funding-basis-crowding.md).

Both of these are v2 triggers. Neither is a reason to change v1 now, and
"add a feature until my strategy passes" is how protocols die. v2 happens when a
hypothesis that already has a mechanism genuinely cannot be expressed — and then
it runs as a separate generation with its own results archive, never mixed with v1.

---

## Related

- [`../AGENT.md`](../AGENT.md) — operating instructions
- [`../research/EVALUATION_PROTOCOL.md`](../research/EVALUATION_PROTOCOL.md) — the frozen standard
- [`../research/strategies/`](../research/strategies/) — the code
