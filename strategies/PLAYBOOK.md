# Playbook

How to think about this. Read before writing a hypothesis.

---

## 1. The instrument is calibrated. The variable is now the experiment.

Everything that could be checked about the measuring apparatus has been checked.

```
evaluation protocol    frozen, hashed
evaluator integrity    negative controls can never pass (research/controls.mjs)
leakage protection     future-access, future-append, warmup discipline
controls               both rejected, 0 passes, both traded 2000+ times
strategy registry      every run recorded with protocol + dataset + strategy hash
strategy knowledge     14 cards, format enforced by strategies/validate.mjs
```

So a strategy that fails did not fail because the ruler was wrong. **Do not go
looking for a bug in the gate when a strategy fails** — that is what the
negative controls are for, and they are green.

**The controls also set the bar.** They score PF 0.837 and 0.751, not 1.0. A
signalless trade stream loses to costs. So the line a real edge has to clear is
not "better than nothing" but "0.45 of profit factor above a coin flip", and
the best hypothesis in the repo clears it by 0.18 and fails.

This changes what your next hour should be spent on. Not on the framework. On
the experiment.

---

## 2. What a failed test actually told us

Five distinct hypotheses, ~9,700 trades, profit factor 0.64 to 1.01. Read that
correctly:

- **A large sample measuring approximately zero.** This is not weak evidence of
  no edge. With ~2,000 trades per strategy, PF 0.64 and PF 1.01 are both
  measured precisely. The honest reading is that these triggers carry no
  directional information in this sample.
- **Both signs lost.** `alwayslong` (pure long) and `sweep-reversal` (pure
  short) are the two worst and one of the mildest respectively. Five of the six
  were long-only, and the sixth was short-only. **No sign was ever varied while
  holding the trigger fixed.** That is a hole in the experiment design, not a
  market fact.
- **The exit model was held constant for all five.** Fixed 2×ATR stop, fixed
  96-bar time exit. A rule can be unprofitable purely because of the exit it
  was forced to wear.
- **Trade counts were high (1,557–2,278) for a 23% win rate.** Under a 2×ATR
  stop, a 23% win rate needs an average win of ~3.3× the average loss. Nothing
  in these results supports that, and nothing suggests the win rate is
  depressed by a bad parameter.

**The one genuinely interesting signal in the whole set:** the winner rate
clustered tightly at 16–23% across wildly different triggers. That tightness is
a property of the *exit model*, not of the triggers. Every strategy was stopped
at the same distance and timed out at the same horizon, so they all paid the
same tax. It tells you almost nothing about the triggers, and everything about
the envelope.

---

## 3. The trap

```
Strategy fails
  ↓
Add more data
  ↓
Add more indicators
  ↓
Change the metrics
  ↓
Eventually something passes
```

That last step is called overfitting, and it is what ends most quant research.
The failure mode is not dishonesty — it is that each individual step feels like
reasonable diligence. Adding an indicator is a hypothesis. Changing a metric is
an investigation. The problem is that doing either *after* seeing which one makes
the P&L go up converts a test into a search.

**The defence is sequencing.** A hypothesis is written down, with its failure
condition, before it is implemented. If the result surprises you, you record the
surprise — you do not go shopping for a different formulation.

`validate.mjs` enforces the part that is mechanically enforceable: the six
fields, in the card, before the code, and the card's own numbers against the
run that produced them. It cannot enforce that the mechanism was genuinely
believed rather than reverse-engineered from a P&L curve. That part is on you,
and the reason this file exists.

---

## 4. Writing a hypothesis that can fail

### Start from a constraint someone is under

A mechanism needs a counterparty. Ask: **when this signal fires, who is
entering, and what forces them to be wrong?**

- Stops sit where the crowd can see them → the breakout buyer is providing
  exit liquidity to someone who must sell regardless of price
- A forced liquidation is not a view → the taker of the other side is
  mechanically unable to wait
- A rebalance happens on a schedule → the flow arrives on time and is
  price-insensitive
- An options hedger must offset delta → the hedge is a function of price, not
  a judgement

If you cannot name the counterparty, you do not have a mechanism. You have a
pattern.

### Prefer asymmetric, forced, or scheduled flows

| Flow type | Why it is useful |
|---|---|
| **Forced** (liquidation, margin, risk limit) | the participant has no discretion to wait |
| **Scheduled** (funding, expiry, rebalance) | arrives on time, price-insensitive |
| **Structural** (structurally short one side) | persistent, and often under-modelled |
| **Discretionary** (human opinions) | the hardest and least persistent; treat claims about it sceptically |

The one category that is usually *absent* from a crypto backtest and usually
present in live markets is the forced one. That is not an accident, and it is
the strongest structural argument for the v2 data list.

### Prefer a mechanism that predicts a *sign flip*

The most robust finding in applied work is that the sign of short-horizon
autocorrelation is state-dependent: trending markets reward continuation,
chopping markets reward reversion, and which one you are in is observable in
advance. It also explains our own null result better than anything else — we
tested a fixed sign five times and a varying one zero times.

### Write the failure condition first

> A strategy that could not fail does not need to be tested.

Two good failure conditions:
- "If the advantage is real, it should be larger on the pair with the highest
  correlation and smaller on the least correlated. If the spread does not order
  that way, the mechanism is wrong."
- "If this is reversion, the reversal should be faster after a large move than
  a small one. If expectancy is flat in move size, the trade is noise."

Two bad ones:
- "If it doesn't make money" — that is the gate, and it is already measured.
- "If it doesn't work at the right parameters" — which makes it a parameter
  search wearing a hypothesis costume.

---

## 5. Choosing what to test next

Rank by three things, in this order:

1. **Is it representable under v1?** A mechanism you cannot express is a v2
   requirement, not a test. Check `PLAYBOOK §6` before writing the code.
2. **How much does it disagree with what already failed?** A hypothesis that is
   a small variation on a falsified trigger teaches you little. One that
   attacks a different assumption teaches you a lot even if it also fails.
3. **How many trades will it produce?** Below ~300 the gate will reject it on
   sample size regardless of quality. Design the card knowing the expected
   trade count; a rule that fires once a week cannot be tested here at all.

**A failed hypothesis is worth more than a lucky one.** It narrows the space.
`BACKLOG.md` records what each failure ruled out, so the same ground is not
covered twice.

---

## 6. What v1 cannot express — check before you code

The frozen protocol has three hard structural limits. A hypothesis that runs
into one is `blocked`, and that is a documented v2 requirement rather than a
failure to be embarrassed about.

| limit | consequence |
|---|---|
| **Exits are fixed by the simulator** — 2×ATR stop, 96-bar time out, and a signal is only read when flat | No strategy can say "cut here", "let this run", or "hold until the trend ends". Any hypothesis whose edge lives in exit placement is **untestable in v1** |
| **One symbol, one position** | Cross-sectional strategies (long strongest / short weakest, dollar-neutral) have no representation. Note that a market-neutral strategy's benchmark is ~0% instead of the +696% that buy-and-hold returned over this window — this is the single most valuable untestable shape |
| **OHLCV only** | Funding, open interest, order book, and intrabar structure are all invisible. Most *forced* flows are invisible for the same reason |

Adding a capability to the framework **because a strategy needs it** is the
failure mode this section exists to prevent. The legitimate trigger is
narrower: a hypothesis that already has a written, believed mechanism, and which
the current protocol has no way to express. Then bump the version, archive the
results separately, and never mix the generations.

---

## 7. One quote, because it is the whole thing

> "The purpose of computing is not to compute numbers, but to understand."

We have enough numbers. PF 0.84 with 2,278 trades is not a weak signal — it is a
precise measurement of a specific absence. The work now is understanding *why*,
and the only way to find that out is to test one mechanism at a time, against a
standard that was decided before you saw the answer.
