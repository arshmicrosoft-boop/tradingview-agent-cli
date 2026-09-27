---
id: P-000
name: <short noun phrase>
slug: <kebab-case>
status: proposed
code: none
---

# <name>

## Hypothesis

```yaml
name: <short noun phrase>

market_mechanism: >
  <the behaviour of this market that would make this pattern work, stated as a
  fact about how it trades — not as a description of the pattern>

why_should_it_exist: >
  <who is on the other side, and why are they forced to be? If the honest
  answer is "nobody", write that instead>

expected_regime: >
  <when it should work, and separately when it should not>

required_data: >
  <OHLCV | OHLCV + volume | OHLCV + funding rate | ...>

failure_condition: >
  <the specific observation that would prove the mechanism is not real, as
  opposed to the parameters being wrong>
```

## Rules as numbers

Every term must be a number you can print.

```
IF   <condition over bars up to and including i>
AND  <condition>
THEN <buy | sell> on the next bar's open
```

Parameters and defaults — these become the `grid`:

| param | default | grid to test |
|---|---|---|
| | | |

## When to use

- **Regime:** <what must be true for this to be the right tool>
- **Horizon:** <how long it is meant to be held, how often it fires>
- **Sizing:** <handled by the risk engine, not by the signal — note any
  parameter the signal wishes it had>

## When not to use

- <the conditions that make this the wrong tool>
- **Confusion risk:** <the pattern this gets mistaken for, and how to tell
  them apart>

## Why it was proposed

<what observation in the existing results motivated this card. Cite the specific
number. A hypothesis with no ancestor in the data is a guess, and should be
labelled as one.>

## What would falsify it

<restate `failure_condition` in one sentence, plus: which gate criteria it is
most likely to fail, and which would be the most informative failure.>
