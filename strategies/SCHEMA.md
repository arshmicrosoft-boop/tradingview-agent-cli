# Card schema

Every strategy, tested or proposed, is one markdown file with two mandatory
parts: **front matter** (flat key: value) and a **hypothesis block** (a fenced
`yaml` block with the six required fields).

`validate.mjs` enforces this. Missing fields are a failing check in
`npm run verify`, not a style note.

---

## Front matter

Flat `key: value` only. No nesting, no arrays — it is parsed with a regex so
that a card stays readable as plain text.

| key | required | values | meaning |
|---|---|---|---|
| `id` | yes | `T-###` / `C-###` / `P-###` | stable id. `T` tested, `C` control, `P` proposed |
| `name` | yes | free | human name |
| `slug` | yes | kebab-case | filename stem, without `.md` |
| `status` | yes | see below | where it is in the lifecycle |
| `code` | no | path or `none` | `research/strategies/<slug>.mjs`. Required for `tested` |
| `protocol` | only for `tested` | `v1` | the generation it was judged under |
| `protocol_hash` | only for `tested` | hex | makes the result comparable, or visibly not |
| `tested_at` | only for `tested` | ISO date | |
| `dataset` | only for `tested` | string | symbols · timeframe · window |
| `trades` | only for `tested` | int | |
| `win_rate_pct` | only for `tested` | number | |
| `profit_factor` | only for `tested` | number | |
| `sharpe` | only for `tested` | number | |
| `max_drawdown_pct` | only for `tested` | number | |
| `total_return_pct` | only for `tested` | number | |
| `gate` | only for `tested` | `pass` / `fail` | |
| `unmet` | only for `tested` | int | how many criteria it failed |

### Status values

| status | meaning |
|---|---|
| `proposed` | written, has a mechanism, not implemented |
| `queued` | triaged and approved for implementation |
| `testing` | code written, run not yet recorded |
| `falsified` | ran under a frozen protocol and failed |
| `promoted` | ran and **passed**. Zero cards have ever held this status |
| `blocked` | cannot be expressed under the current protocol. Must name the blocker |

**`blocked` is a real status, not a failure to be embarrassed about.** A card
marked `blocked` is a documented v2 requirement, and it carries more information
than an untested card.

### `status` is the verdict; the directory is not

`falsified`, `promoted` and `blocked` are recorded in the front matter of a card
sitting in `cards/proposed/`, `cards/tested/` or `cards/controls/`. **There is no
`cards/falsified/` directory, by design** — 11 of the 15 cards are falsified, so
such a directory would hold most of the base and say nothing the `status` field
does not already say.

The directory is load-bearing in `validate.mjs`, and it is load-bearing for what
it *means*, not for the verdict:

| directory | duty it assigns the linter | expected `status` values |
|---|---|---|
| `cards/proposed/` | hypothesis and rules sections only | `proposed`, `queued`, `blocked`, `falsified` |
| `cards/tested/` | + result keys, a `code` path, and reconciliation against `research/registry/*/runs.jsonl` | `falsified` or `promoted` — **never `tested`**, which is not a status |
| `cards/controls/` | same as `tested/` | `falsified` — a control that passed would be a bug |

So a card is renamed `P-00n` → `T-00n` and moved into `cards/tested/` at the
moment it becomes a strategy with a run record, and a card that was killed
before any strategy was written keeps its `P-` id, stays in `cards/proposed/`,
and carries `status: falsified` plus a `## Why it failed` section. Two cards
already work that way: P-001 and P-003. See the "directory is the duty" section
of [`README.md`](./README.md) for why the alternative was rejected.

---

## The hypothesis block

A fenced ` ```yaml ` block containing all six of these. Keys are required
exactly as spelled.

```yaml
name: <short noun phrase>

market_mechanism: >
  The behaviour of the market that would make this pattern work. Written as a
  fact about how this market trades, not as a description of the pattern.

why_should_it_exist: >
  WHY THAT MECHANISM IS OPERATIVE HERE. Who is on the other side of the trade,
  and what are they forced to do? If the honest answer is "no one — it should
  not exist", write that instead. A card that predicts its own failure is worth
  more than one that assumes success.

expected_regime: >
  The conditions under which it should work, and — separately — the conditions
  under which it should NOT. A strategy that works everywhere is usually a
  description of beta.

required_data: >
  Exactly the fields needed. "OHLCV" or "OHLCV + funding rate". If this needs
  something protocol v1 cannot fetch, the card is `blocked`, not `proposed`.

failure_condition: >
  The observation that would prove this hypothesis WRONG, stated before the
  test. Not "it does not profit" — that is the gate, and it is already
  measured. This field asks: what SPECIFIC result would mean the mechanism is
  not real, rather than the parameters being wrong?
```

### The two fields that carry the weight

`why_should_it_exist` is the field that decides whether a hypothesis is worth a
test. If the only answer is "this pattern has worked in the past" or "it is
widely used", there is no mechanism and the card should not be implemented. The
most productive question is: **who is losing money when this signal fires, and
why are they forced to be on the other side?**

`failure_condition` is what stops a failed test from being relabelled. Without
it, a result of 0 can always be re-read as "close, wrong parameters", and the
next version quietly becomes the first version. Write down in advance what would
prove you wrong, and honour it.

---

## Required sections

| section | required for |
|---|---|
| `## Hypothesis` | every card — contains the yaml block |
| `## Rules as numbers` | every card — the actual conditions, no prose |
| `## When to use` | every card |
| `## When not to use` | every card |
| `## Result under v1` | `tested`, `controls` |
| `## Why it failed` | `falsified`, and `proposed` cards that were dropped |
| `## What we learned` | `tested`, `controls` |

## Rules as numbers

The rules section is the bridge from knowledge to code, and it has one hard
constraint: **every term must be a number you can print.** No "smart money", no
"strong reversal", no "when the market feels like it is bottoming". If a
condition cannot be written as an inequality over observed values, it is not a
rule, and `validate.mjs` will not stop you — but the gate will correctly destroy
it, because there is nothing in the code to reproduce.

Include the parameter names and defaults, because those become the `grid` in the
strategy file. A strategy without a grid is measured at one point, and the gate
treats that as unproven rather than robust.

## When to use / when not to use

This is the operational half of the card, and it is the half that is missing
from every backtest. State it in terms a trader can act on:

- **Regime:** what conditions must hold for this to be the right tool
- **Horizon:** how long it is meant to be held, and how often it fires
- **Do not use when:** the conditions that make it the wrong tool
- **Confusion risk:** the pattern it gets mistaken for, and how to tell them apart

A falsified strategy still needs this section. Knowing that a rule is
*measurably* wrong under specified conditions is a real result, and it is
strictly more useful than not knowing.

---

## Registry

`registry.json` is the machine-readable index and is validated against the
filesystem: every entry must exist on disk, and every card on disk must appear.
Adding a card without registering it fails `npm run verify`.
