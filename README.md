# TradingView research + paper execution

Three layers, deliberately separated:

- **`research/`** — tests hypotheses and measures edge. **Cannot place orders.**
- **`execution/`** — reads charts and places paper orders, behind a risk gate.
- **`frontend/`** — the command centre. Reads the evidence, spawns the CLIs,
  streams state over SSE. It sees both layers and merges neither.

TradingView is the **eyes**, not the hands.

Read [`AGENT.md`](./AGENT.md) for operating instructions. Read
[`strategies/PLAYBOOK.md`](./strategies/PLAYBOOK.md) before writing a hypothesis.
This file is the human-facing overview; [`strategies/`](./strategies/) is the
knowledge base of what we have tried and what it taught us.

---

## Setup

Everything below is one prompt. Paste it into your agent (OpenCode, Claude Code,
or anything with shell access) from the repo root. It installs the MCP server,
registers it with whichever harness you're running, launches TradingView, and
proves the whole stack works before it hands back.

```
Set up this repository end to end. Work from the repo root and do not guess —
run each step, read its output, and stop and report if a step fails.

1. Confirm the toolchain.
   - node --version must be >= 20 (this repo has zero runtime dependencies).
   - If not, stop and tell me which Node version to install. Do not install it.

2. Install the TradingView MCP server globally, pinned:
     npm i -g tradingview-mcp@1.0.1
   Both the server and the TradingView Desktop build it bundles (38.2.2) are
   pinned deliberately: this repo drives undocumented internal TradingView APIs
   that break without notice.

3. Resolve the server entry point. Do not hardcode a path:
     npm root -g
   The entry point is <that output>/tradingview-mcp/src/server.js. Confirm the
   file exists before writing any config.

4. Detect which agent harness I am running, then register the MCP server in
   that harness's config, merging rather than overwriting the existing file:
     - OpenCode   -> ~/.config/opencode/opencode.jsonc  (key: mcp.tradingview)
     - Claude Code-> ./.mcp.json                        (key: mcpServers.tradingview)
   Entry to write, with the resolved path substituted:
     { "type": "local",
       "command": ["node", "<resolved path to tradingview-mcp/src/server.js>"],
       "enabled": true,
       "timeout": 120000 }
   The 120s timeout is required: a cold TradingView start exceeds the default.
   If both configs exist, write to the one matching the running harness and tell
   me which you chose. Preserve every other server already in the file. Back the
   file up before editing it.

5. Launch TradingView with the DevTools Protocol and guarantee a chart tab:
     npm run tv:launch
   Both halves are required and the second is the one that gets forgotten — see
   the two traps below. This step is expected to take up to 30 seconds.

6. Prove the MCP server answers, without needing a chart:
     npm run mcp:handshake
   Expect "78 tools" and YES on all eight key tools. If the server path cannot be
   resolved, the global install in step 2 did not land.

7. Prove the repo itself is sound:
     npm run verify
   Expect 25 passed, 0 failed: 12 selftests plus 13 architectural invariants,
   including 422 checks over the 15 strategy cards. Any failure here is a real
   defect — report it, do not work around it.

8. Optional:  npm run web
   Starts the command centre on http://127.0.0.1:7878. Zero dependencies,
   node:http only. It reads the evidence files and spawns the CLIs — it does not
   place orders, and it does not need TradingView running.

9. Optional, and slow — only if I ask:  npm run research:all
   Fetches ~17 MB of cached OHLCV for 5 symbols. Say how long it will take
   before starting. Takes about 25 minutes for all 10 strategies.

10. Optional, and slower:  npm run research:all:v2
   Runs the same 10 strategies through the v2 robustness protocol. Also ~25
   minutes, and the walk-forward and cost sweep are the slow parts.

Then report back, in this order:
  a. the Node version and the resolved tradingview-mcp path
  b. which harness config you edited, and the exact entry you wrote
  c. the mcp:handshake and verify result lines
  d. anything that failed, with the error text

Do not attempt a paper order. Do not run anything in execution/ beyond what is
written above. Finally, tell me I must restart my agent session before the new
MCP server appears in the tool list.
```

### The two traps

Both are why `npm run tv:launch` is a script and not a command you type by hand.

1. **CDP alone is not enough.** TradingView must be running with
   `--remote-debugging-port=9222` **and** have a real chart tab open. On startup
   the app restores your last tab; if that saved layout was deleted server-side
   it 404s and shows an error page. The MCP then attaches to the error renderer
   and *every* tool reports `api_available: false` with no error of its own.
   `launch-tv.ps1` handles both halves.
2. **`tv scroll` and `tv range` (get) are broken** in `tradingview-mcp@1.0.1`
   (`"evaluate is not defined"`). Only `range --from --to` works.

Also: the new-tab search box searches your **saved layouts**, not symbols.

### Manual equivalent

If you'd rather not hand an agent your shell, the same five commands are:

```bash
npm i -g tradingview-mcp@1.0.1
npm root -g                                    # -> the server path to register
npm run tv:launch
npm run mcp:handshake
npm run verify
```

Register the server with your harness by hand — OpenCode wants
`~/.config/opencode/opencode.jsonc`, Claude Code wants `./.mcp.json` — using the
JSON block in step 4 of the prompt above, then restart the agent.

---

## Verify everything

```bash
npm run verify
```

Runs 12 selftests (including 422 checks over the 15 strategy cards) and 13
architectural invariants, including `research/ never imports execution/`,
`research/ cannot reach TradingView`, and — the one that matters — every tested
strategy card reconciled against its actual run record.

The invariant worth knowing about is the last one. It also fails if any v1 run
record cites a stale `protocol_hash`, which is what a corrected hash function or
an edited threshold looks like from the outside.

## The pipeline

```
Agent ──{side, thesis}──▶ Risk Engine ──▶ Risk Gate ──▶ Execution ──▶ TradingView
                            (pure, ATR-sized)  (pure, pre-click)     (only impure part)
```

The signal decides **direction only**. Size, stop and leverage are computed by
the risk engine, which is the same code the backtest uses. The gate runs before
any click; if it blocks, nothing is clicked.

## Layout

```
package.json     verify.mjs     AGENT.md     README.md
config/          risk.json, audit.jsonl (git-ignored, created on demand)
research/        data, risk-engine, harness, evidence, gate, gate-v2, run,
                 run-v2, leakage, events, regime-audit, robustness, protocol,
                 registry, strategies/, data/, registry-v2/
                 protocol.v1.json + protocol.v2.json — the two frozen contracts
                 EVALUATION_PROTOCOL.md — why the frozen thresholds are what
                 they are, beside the JSON the gate actually reads
execution/       paper-trade, launch-tv.ps1, ensure-chart, mcp-handshake
frontend/        server.mjs + lib/ + worker/ — the command centre
                 (node:http, zero deps; `npm run web` → 127.0.0.1:7878)
strategies/      the knowledge base — 15 cards: 11 falsified (2 of them
                 negative controls), 1 queued, 1 proposed, 2 blocked,
                 0 champion (there is none)
```

`config/audit.jsonl`, `research/registry/state.json`,
`research/registry-v2/state.json` and `frontend/data/` are git-ignored on
purpose: all four are runtime state, and none of it is evidence. The run records
in `research/registry/*/runs.jsonl` and `research/registry-v2/*/runs.jsonl`
*are* evidence and are tracked.

## The knowledge base

Every hypothesis — tested, proposed, or blocked — is a markdown **card** under
[`strategies/cards/`](./strategies/). Code lives in `research/strategies/`;
knowledge lives in `strategies/`. A strategy file is thirty lines of arithmetic
and cannot hold *why* a rule exists or *when* it should be trusted.

`strategies/validate.mjs` enforces the format and runs in `npm run verify`, so
the rules are checked rather than merely written down. A card that misquotes its
own result fails the build.

```bash
node strategies/validate.mjs     # 422 checks across 15 cards
```

Start with [`strategies/PLAYBOOK.md`](./strategies/PLAYBOOK.md) (how to think),
then [`strategies/BACKLOG.md`](./strategies/BACKLOG.md) (what to test next), then
[`strategies/cards/proposed/`](./strategies/cards/proposed/) (the frontier).

## Research findings

Data: **BTC · ETH · DOGE · SOL · ZEC · 15m · 400 days · 38,401 bars each · 0 gaps**
(192,005 bars, Binance). One dataset, one hash, one protocol hash.

Hypotheses were written as numbers, not concepts. E.g.:

```
IF   bar.high  > max(high of previous 20 bars)     took liquidity
AND  bar.close < that prior high                   rejected it
AND  bar.volume > 2.0 * mean(volume of last 50)   participation
THEN short next bar
```

Every row is the latest run in `research/registry/<id>/runs.jsonl`. `t` is the
Sharpe t-statistic — the number that says whether the sample supports the point
estimate beside it.

| strategy | trades | PF | Sharpe | t | maxDD% | return% | unmet | gate |
|---|---|---|---|---|---|---|---|---|
| sma-cross | 1984 | 1.013 | −0.023 | −1.02 | 56.9 | −1.3 | 20 | fail |
| trend-pullback | 1557 | 0.972 | −0.016 | −0.63 | 42.6 | −6.7 | 19 | fail |
| donchian | 1645 | 0.917 | −0.044 | −1.78 | 56.2 | −28.8 | 19 | fail |
| vol-normalized-breakout ³ | 2583 | 0.935 | −0.038 | −1.93 | 54.6 | −34.0 | 19 | fail |
| long-with-stop ¹ | 2278 | 0.837 | −0.028 | −1.34 | 71.4 | −55.2 | 20 | fail |
| sweep-reversal | 1565 | 0.641 | −0.138 | −5.46 | 71.8 | −71.5 | 20 | fail |
| vol-expansion | 686 | 0.691 | −0.076 | −1.99 | 48.6 | −36.2 | 20 | fail |
| sideways-liquidity-reversal ² | 165 | 0.355 | −0.260 | −3.34 | 27.6 | −27.2 | 19 | fail |
| *control: always long* | *2278* | *0.837* | *−0.028* | *−1.34* | *71.4* | *−55.2* | *20* | *fail* |
| *control: random* | *2270* | *0.751* | *−0.057* | *−2.72* | *74.3* | *−72.9* | *21* | *fail* |

**These two columns were regenerated on 2026-09-28** and are on the current
portfolio basis: N symbols are N equal-weight sub-accounts, `return%` is the
**mean** of the per-symbol returns and `maxDD%` is the drawdown **of the averaged
curve**. Both are far smaller in magnitude than the pre-regeneration figures
they replace (e.g. `sma-cross` was −99.4% / 82.8%, now −1.3% / 56.9%), because the
old numbers compared a 5×-geared compounded numerator against a 1× worst-single-
symbol drawdown. The trading statistics beside them — trades, PF, Sharpe, t — are
per-run quantities and did not move, and every row still reads `fail`. Pre- and
post-regeneration records sit in the same archive under one protocol hash, so
read the **latest** record per strategy; the older ones are retained history, not
current results.

¹ `long-with-stop` is a strict duplicate of the `always long` control — same
`{ side: "buy" }` on every flat bar, identical metrics. It is not a distinct
hypothesis, which is why the tested count is seven and not eight.

² `sideways-liquidity-reversal` trades 165 times, so it fails the ≥500 minimum
on sample size alone. Its t is not the worst in the table — `sweep-reversal`
sits lower at −5.46 — but its de-clustering story is the most honest: the
trailing-window statistic it was built on measured t = −1.38, not the +8.99 the
raw overlapping samples claimed (AGENT.md §6.14).

³ `vol-normalized-breakout` (P-002) has the **fewest unmet criteria in the
table — 19, tied with `trend-pullback`, `donchian` and
`sideways-liquidity-reversal` — and still fails.** That is the most informative
row here. It is not a new trigger: the trigger is donchian's and the exit is the
protocol's, and the only change is the denominator a price distance is divided by.
Normalising the units of a breakout and changing the breakout both look like
progress on a PF of 0.9. Neither is. (It was at 18 before the walk-forward fix
above; that fix cost it this one criterion, and the fix was accepted rather than
reverted — see defect 3.)

**No demonstrated edge.** Sharpe −0.26 to −0.016 across ~11,000 trades is a large
sample measuring approximately zero.

**The two italic rows are the important ones.** They are negative controls — a
signalless long and a random side — and they score **PF 0.837 and 0.751**, not
1.0, because 15 bps per round trip is charged on both sides of a churn-heavy
stream. That band, not 1.0, is the line a real edge has to clear. So the best
hypothesis here, `sma-cross` at 1.013, is **0.18 above a coin flip**, with a
t-stat of −1.02 that cannot distinguish the two.

The drawdowns are a consequence of a 1%-risk, 10x-leverage envelope applied to
a zero-expectancy signal: negative expectancy compounds to ruin. Read the
profit factor for the signal and the drawdown for the envelope, never the
reverse.

## Why the gate fails, and what "fail" means

Every row above says `fail`. That is the gate working, not the gate broken, and
the distinction is worth being precise about — it is the most common misreading
of this table.

**The failure is a measurement, not a defect.** Two negative controls, a
signalless long and a random side, score PF 0.837 and 0.751. They contain no
information at all. So a hypothesis in this repo has to clear roughly 0.8 before
its profit factor means anything, and the best one here is 1.013 — 0.18 of
profit factor above a coin flip, at a t-statistic of −1.02 that cannot
distinguish the two. Nothing in the data clears the bar.

**Most of those 20 unmet criteria are the same fact counted twenty times.** Once
expectancy is zero or negative, everything downstream of profitability fails with
it: profit factor, Sharpe, t-statistic, LCB, holdout Sharpe, degradation, cost
survival, and the benchmark comparisons. Five more are structural. A 1%-risk,
10×-leverage envelope crossed with 1,000–2,600 trades drives any
non-positive-expectancy stream through a 20% ruin circuit breaker almost
regardless of the signal, so `maxDD < 35%`, `P(dd breach) < 25%`, `account
survived` and `symbols ruined` were never going to pass. That is what produces the
large book drawdowns in the table. (The range is no longer uniform, and the 35%
bar did not move: on the regenerated equal-weight basis the ten rows span
**27.6–74.3%**, deepest being the `random` control; the eight *hypotheses* with a
real sample span **42.6–71.8%**. The only row under the bar is
`sideways-liquidity-reversal` at 27.6% — which has 165 trades and fails the ≥500
minimum instead, so it never reaches the drawdown question. Under the superseded
5×-geared / worst-symbol basis the same ten ran 80–84%.)

**No threshold was moved to produce this**, and making it mean that took a fix.

### Three defects this investigation found

1. **The protocol hash was blind to every threshold it exists to protect.**
   `protocol.mjs` canonicalised with `JSON.stringify(p, Object.keys(p).sort())`.
   When the replacer is an array it acts as a key whitelist applied at *every*
   level of nesting, not just the top — so a whitelist of top-level names
   matched no nested key, and every nested object serialised to `{}`. The
   protocol hashed to 454 characters of its real 1,414, with `criteria:{}`,
   `costs:{}` and `risk:{}` all empty. Relaxing `MIN_PF` from 1.3 to 0.01,
   zeroing fees, or raising risk per trade from 1% to 100% **all produced the
   identical hash**. All 17 run records cited that blind hash, so the
   tamper-evidence claimed here was not in force for a single threshold. Fixed
   with a real recursive canonicalisation, and `protocol.mjs` now has 21
   selftests that fail if any of twelve different threshold edits goes
   undetected. The v1 hash moved from `1e42a7d31d851b9b` to `ab8d990e445b2927`,
   which is why every run was re-recorded.

2. **`beats hold in <reg>` never compared against holding.**
   ```js
   const beat = bh.calmar == null ? r.pnl > 0 : (r.trades > 0 && r.pnl > 0);
   ```
   Both arms reduce to `r.pnl > 0`. The check named itself after a benchmark,
   printed `hold <return>%` as its bar, and was documented below as "must not be
   beaten anywhere it trades" — while the code only asked whether the strategy
   made any money. A strategy making **$1** per regime passed all three checks
   against a buy-and-hold that returned **+9999%** in each. The gate was *more
   lenient* than advertised. It now compares the strategy's regime return
   against the regime-matched benchmark's, and the selftests reproduce the old
   false pass plus a same-value *loses* case.

3. **The gate's walk-forward was not the walk-forward.**
   `harness.walkForward()` is exported, self-tested, and was never called by the
   runner. The `MIN_WF` criterion was fed by an inline splitter that cut the
   pooled five-symbol trade stream into four chunks and scored each as
   `summedPnl / 1000` — five accounts' P&L divided by one account's equity, used
   for nothing but its sign. Wiring in the tested implementation runs it on the
   primary symbol alone, with a per-fold warm-up: a different population *and* a
   different denominator, one account divided by the equity actually traded.

   **The measured effect.** The `walk-forward consistency %` **value** changed on
   **7 of the 11** strategies. Only one crossed the bar, and it crossed
   downward: `vol-normalized-breakout` went **50 → 0**, taking it from **18 → 19**
   unmet criteria. The bar itself, `MIN_WF ≥ 50`, is **unchanged** — the old 50
   and the new 0 are both real numbers measured two different ways, and only one
   of them was ever the criterion.

   **No overall verdict flipped anywhere.** Every one of the eleven strategies was
   already `fail` on other criteria, so the change moved unmet counts and
   nothing else. It also moved strictly in one direction: the old number was read
   off a denominator with no referent, so it was free to pass, and the new one
   can only lose a criterion, never win one back.

   **The owner reviewed this and chose not to revert it.** The old 50 was a sign
   test masquerading as a percentage — a strategy down −33.98% on the regenerated
   equal-weight basis and ruined on 4 of its 5 symbols was handed a *passing* 50,
   because the pooled splitter only asked whether the sum of five accounts' P&L
   was positive in each fold, and it was: four losing accounts outnumbered one
   losing account that lost less. Reverting would mean reinstating a meaningless
   50 on a ruined book. `strategies/cards/tested/vol-normalized-breakout.md`
   records the before/after table so the next reader does not "fix" it back.

   Note that the protocol hash cannot see any of this: it covers **thresholds**,
   not **computation**, so these values moved under an unchanged
   `ab8d990e445b2927`. That limitation is documented, not redesigned — see the
   "WHAT THE HASH ACTUALLY COVERS" blocks in `gate.mjs`, `evidence.mjs` and
   `registry.mjs`.

`npm run verify` now enforces the fourth thing: any v1 run citing a stale
`protocol_hash` fails the build. A corrected hash function is indistinguishable
from an edited threshold from the outside, so the build now says so.

**What was deliberately not changed:** the thresholds, and the fact that nothing
passes. Relaxing a bar to go green is the exact thing the hash exists to stop.

## The gate

v1 is `research/gate.mjs` reading `research/protocol.v1.json`. Nothing is an
edge until it clears all 21:

| Criterion | Bar | What it prevents |
|---|---|---|
| trades | ≥ 500 | conclusions from a handful of trades |
| symbols | ≥ 5 | one lucky instrument |
| directional regimes | ≥ 3 of bull/bear/sideways | a strategy that only works while the market does one thing |
| volatility regimes | ≥ 2 of high/low | ditto, on the axis that actually drives intraday behaviour |
| profit factor | > 1.3 | one outsized winner carrying the rest |
| Sharpe | > 1.0 | — |
| **Sharpe t-stat** | > 2.0 | a big Sharpe the sample cannot support |
| **Sharpe LCB (95%)** | > 0.3 | a big Sharpe *estimated from few trades* |
| max drawdown | < 35% | — |
| walk-forward consistency | ≥ 50% | tuning to the sample |
| P(dd ≥ 20%) | < 25% | surviving only the lucky orderings |
| holdout trades | ≥ 60 | conclusions from an empty test window |
| holdout Sharpe | > 0.5 | in-sample-only edge |
| degradation (test ÷ train) | ≥ 0.25 | an edge that evaporates out of sample |
| parameter sensitivity | ≥ 30% of grid profitable | a spike that only exists at one exact setting |
| cost survival | ≥ 40% of the cost grid | an edge that dies at 2× fees |
| max survivable cost | ≥ 25 bps (fee+slip) | ditto |
| symbols passing on their own merits | ≥ 60%, and ≥ 2 | a single-symbol coincidence |
| calmar vs regime-matched hold | must beat holding | buying risk, not edge |
| per-regime vs holding | must not be beaten anywhere it trades | a bull-window artefact |
| survived | account must not be ruined | trading on from a wiped account |

Directional and volatility regimes are separate axes on purpose: a single
trend-based label files a choppy-market strategy as "sideways" and fails it for
the wrong reason.

The full reasoning, and the five ways a backtest lies that each criterion
targets, is in [`research/EVALUATION_PROTOCOL.md`](./research/EVALUATION_PROTOCOL.md).
The JSON is the source of truth — if the two ever disagree, the JSON wins and
the prose is stale.

## v2, the robustness protocol

`research/protocol.v2.json` + `research/gate-v2.mjs` + `research/robustness.mjs`,
results in `research/registry-v2/`. **v1 is untouched**: every v1 threshold is
restated at its exact v1 value, no v1 number changes, and the two generations
never share a results archive or a leaderboard.

```bash
npm run research:all:v2
```

v2 exists because two of v1's robustness criteria are weaker than their names
claim, and both weaknesses are structural rather than incidental.

**v1's Monte Carlo cannot reach an edge.** It reshuffles the *order* of a fixed
P&L set, and the sum of a fixed P&L set is a constant — so its `finalEquity` is
a constant that carries no information, and expectancy, profit factor and
Sharpe are mathematically unreachable by that method. It measures the path
(drawdown depth, breach probability, losing streaks) and nothing else.
`bootstrapMonteCarlo` resamples **outcomes** with replacement instead, in blocks
of `ceil(n^(1/3))` so trade clustering survives, and reports P(profitable),
P(Sharpe > 0) and the full Sharpe distribution.

**v1's walk-forward never re-optimises.** It partitions time into four windows
and asks how many were profitable. `anchoredWalkForward` re-picks parameters on
train inside every fold — expanding train, forward test, test window never seen
during selection — and reports OOS/IS efficiency, mean fold Sharpe, and a Welch
t on the per-fold OOS−IS Sharpe gap where *more negative means worse*.

Plus three things neither version had:

| | |
|---|---|
| **deflated Sharpe** | Bailey & López de Prado. The repo has tried 15 cards and 74 parameter variants; `sma-cross`'s best PF is 1.013. `E[max Sharpe over N trials]` is what pure luck produces at that search size — **2.31 for the 74 variants actually searched** — and the DSR asks whether the observed Sharpe survives that correction. Computed against the **largest** honest trial count, not the smallest. |
| **fill perturbation** | `costStress` scales costs *deterministically* ("what if fees were 2×?"). This asks "what if my fills are worse than modelled, randomly, on some trades?" — size jitter plus extra adverse slippage, and reports the drawdown distribution under it. |
| **slippage sweep** | A fine-grained fee×slippage grid locating the break-even round trip, where v1's 1×/2×/5× can step straight over the cliff and report "survives nothing". |

### The seven v2 criteria

| Criterion | Bar | What it prevents |
|---|---|---|
| anchored walk-forward consistency | ≥ 60% | an edge live in only some quarters |
| walk-forward fold coverage | ≥ 100% | **100% consistency achieved by going silent** — raised from 75% on 2026-09-28, which still permitted one entirely dead fold of four |
| OOS/IS efficiency ratio | ≥ 0.40 | in-sample-only parameters |
| mean OOS fold Sharpe | ≥ 0.30 | folds that are individually worthless |
| bootstrap P(profitable) | ≥ 90% | an edge that depends on the realised trade order |
| bootstrap P(Sharpe > 0) | ≥ 90% | a Sharpe 1 resample in 10 would also produce |
| deflated Sharpe | ≥ 0.95 | the best of many trials read as an edge |
| P(dd ≥ 20%) under fill error | < 25% | a drawdown that exists only at modelled fills |

(That is eight rows. "Seven" is a number this document used before the coverage
criterion existed; it is counted from `protocol.v2.json` = 25 criteria, of which
18 are v1's restated unchanged and 7 are new, plus 1 added during review.)

`evaluateGateV2` reports the v1 group and the v2 group **separately**, so a v2
failure can never be presented as a v1 one.

### Three things v2 got wrong first

An independent review of this code found real defects, including one confirmed
silent pass. All three are recorded here because each one is a mistake a reader
would otherwise make too.

1. **The walk-forward filtered out the folds that went silent.** Consistency,
   mean fold Sharpe and the efficiency ratio were all computed only over folds
   that produced trades. A signal that trades for the first 1,900 bars and is
   then silent for the last 1,100 — about 37% of the sample — reported
   **consistency 100%, mean OOS Sharpe 2.72, efficiency 1.31**, and cleared every
   walk-forward criterion with perfect marks while being unable to trade for more
   than a third of the out-of-sample period. That is precisely the failure the
   anchored walk-forward exists to detect. Fixed by adding `fold coverage` as a
   gated criterion in its own right, and a selftest that reproduces the silent
   signal.

2. **The bootstrap compounded five accounts into one 5×-geared account.**
   `evidence.mjs` already states the rule for the equity curve — path properties
   must not be pooled across symbols — and the first version of the bootstrap
   broke it, concatenating five independent 1,000-equity accounts and compounding
   all of their fractional returns into one curve with no 1/N weighting. The
   symptom was arithmetically impossible as a portfolio statistic: pooled median
   drawdown **99.5%** when the *worst* single symbol was 80.6% and the best was
   34.4%. An equal-weight book cannot be deeper than its worst component.

   The first fix over-corrected into a different wrong model: one shared account
   of 1,000 running five symbols at 1/N of its equity each, P&L divided by N and
   compounded into a single curve. That is a levered account, not a portfolio,
   and it errs in **both** directions rather than conservatively — where symbols
   draw down together it pays `(1 − x/N)^N` for N shocks of size `x` where the
   real book pays `x`, and where one symbol's drawdown is offset by another's
   gain in the same window the shared equity base flatters it. Measured on the
   cached dataset (`vol-normalized-breakout`, 2,583 pooled trades, 500 block
   resamples, seed 12345): the 1/N account reports a median portfolio drawdown of
   **70.47%**, the equal-weight book **67.11%**, and the mean of the per-symbol
   drawdowns **78.13%**.

   **What it is now: equal-weight additive.** `bootstrapMonteCarlo` resamples
   **within** each symbol (so a block never straddles a boundary), hands
   `equalWeightPath` one leg per sub-account, and averages the N equity curves
   pointwise. Total return is the mean of the per-symbol returns; drawdown is taken
   on the averaged curve, which keeps the *ordering* of the paths — the only
   thing a drawdown measures. Drawdowns are never summed, N full accounts are
   never compounded into one, and events sharing a timestamp settle as one step so
   an offsetting `+50%`/`−50%` pair cannot invent a mid-step peak. The mean of the
   per-symbol drawdowns is still reported, as the diagnostic
   `maxDrawdownP50PctComponentsMean`, so the difference from the book's own figure
   is visible rather than asserted. `protocol.v2.json` carries the model, the
   reasoning and both numbers. The selftest pins it with five *identical*
   accounts, whose portfolio drawdown must equal one account's.

3. **The deflated-Sharpe threshold contradicted the standard the code argues
   for.** `robustness.mjs` spends a paragraph explaining that the bar must be
   0.95 and that a lower bar is wrong — and the frozen threshold was 0.0. Since
   `DSR > 0` only asks that the Sharpe beat E[max of N trials], which at N=74 is
   **2.31 per trade**, the criterion was a constant 0 for every strategy in the
   repo: a discriminator that discriminates nothing. The threshold is now 0.95
   and matches `survivesMultipleTesting`.

Also fixed: the `beats hold in <reg>` comparison divided 5 symbols' pooled P&L
by **one** account's equity while the benchmark beside it was a per-symbol
*mean*, making the strategy side 5× too large — so `sma-cross` in a bull stretch
where it earned 39.7% against a 4.9% hold was being scored as 198.6% and would
have passed a comparison it should have lost. That was a bug in the *fix* for
defect 2 above, caught by the units not lining up.

And one dead-code leftover of the pre-existing kind: `verify.mjs` briefly
contained `superseded >= 0` on a difference of two counts — a tautology that can
never fail, the exact defect class removed from `harness.mjs` in this same
change. Now `> 0`.

### What v2 found

**All 10 strategies fail 7 of the 8 new v2 criteria — the eighth, fold coverage,
passes, because all ten keep trading to the end of the sample. That is the
honest answer, and it arrives faster than v1 does.** Three numbers do the work:

```
bootstrap P(profitable)     0.0–0.3% for all ten strategies   (bar: 90%)
bootstrap P(Sharpe > 0)     0.0–0.6% for all ten              (bar: 90%)
deflated Sharpe             0.0000 for all ten                (bar: 0.95)
```

`P(profitable) = 0.0%` is the sharpest statement in this repo. It is the chance
that 2,000 block-bootstrap resamplings of the actual trade stream would each have
finished ahead of where it started. For `sma-cross` — the best hypothesis here,
1,984 trades, the only PF above 1.0 — **not one of 2,000 resamples made money.**
A strategy whose profitability survives no resampling of its own outcomes is not
a strategy with a weak edge; it is a description of one particular ordering of
one particular set of trades.

The deflated Sharpe is 0.0000 for every strategy because every observed Sharpe
here is ≤ 0, and E[max Sharpe over 74 trials] is **2.31 per trade**. Nothing is
close, and a criterion that only asked for `> 0` would also have read 0.0000 for
every strategy while pretending to be a measurement.

**One result is worth reading twice: OOS/IS efficiency is `n/a` for nine of ten
strategies, not a small number.** The ratio is undefined when mean in-sample
Sharpe is not positive, and the report carries the reason in the field itself
(`undefined: mean in-sample Sharpe is -0.366, so OOS/IS retention has no
meaning`) rather than printing a bare `n/a` that reads like a bug.
`sideways-liquidity-reversal` is the exception and the warning: it returns
**−229**, the ratio of a large negative in-sample Sharpe by a larger negative
out-of-sample one. That number is not a near-miss, it is a sign error waiting to
be quoted as a ratio. A criterion that produces −229 on a losing strategy is a
criterion whose units need stating, which is why the null explains itself.

v2 changes no conclusion. It reaches the same verdict as v1 by a shorter route,
and it says in one line what v1 takes twenty criteria to establish.

## What is not proven

- Any strategy is profitable
- That these results generalise beyond one 400-day window
- That a passing strategy would survive live execution
- That the anchored walk-forward actually searched anything, for the **4 of 10
  strategies that declare no parameter grid.** `donchian`, `long-with-stop`,
  `trend-pullback` and `vol-expansion` have one variant, so their folds cannot
  re-optimise and the test reduces to v1's fold count. The run reports
  `reoptimised: false` with that explanation rather than letting the word
  "walk-forward" imply a search that never happened.

**The portfolio basis is no longer on that list, because it was fixed.** It used
to be an open inconsistency: `agg.totalReturnPct` compounded the five symbols
**sequentially** (`(1+r₁)(1+r₂)…`) while `agg.maxDrawdownPct` reported the *worst
single symbol* — a 5×-geared numerator over a 1× denominator, with no shared
referent. For `sma-cross` that reported **−99.4%** return on an **82.8%**
drawdown where the equal-weight book makes about **−1.3%** on **56.9%**, and
`gate.mjs` then divided exactly those two numbers to get its calmar criterion.

Every portfolio figure in the repo is now **equal-weight additive** and defined
once: N symbols are N independent sub-accounts, the book equity at each step is
the **arithmetic mean** of the N curves, total return is the **mean of the
per-symbol returns** (never the product), and max drawdown is the drawdown **of
that averaged curve** (never the worst sleeve, never the mean of the drawdowns,
never a sum). It is implemented in `gate.mjs` (`equalWeightBook` /
`equalWeightPath`), in `evidence.mjs` for `agg` and the benchmark, and in
`robustness.mjs` for the v2 bootstrap, and the three are cross-checked against
each other by selftest so they cannot drift apart. Calmar now divides a return
and a drawdown read off the **same** curve, so its units always match. The old
worst-symbol figure is still reported, as `worstSymbolDrawdownPct`, so both are
readable.

**The recorded v1 numbers were regenerated on 2026-09-28 on that equal-weight
basis** — all 11 strategies, with the older records retained rather than
overwritten — and the results table and the strategy cards were re-synced to
match. This was a correctness fix, not a threshold change, and it was the right
call even though it moved recorded numbers: a table that quoted a −99.4% return
was quoting an artifact of a portfolio model that cannot exist. The residual
limitation is that pre- and post-fix records share one protocol hash, so a
leaderboard view can show duplicate rows; no gate uses the hash for promotion,
and see the "WHAT THE HASH ACTUALLY COVERS" note in `registry.mjs`.

The platform is the deliverable. All seven distinct tested hypotheses are
falsified — plus P-001, killed at the measurement stage before a line of trading
code was written — and the two controls confirm the instrument would have caught
a false positive.

## The next move

v1 is **frozen and stays frozen**. It is a discovery filter, not a scoreboard,
and the milestone is *one hypothesis that survives v1* — not a passing
indicator sweep.

v2 does not relax that, and it is not a way to get a pass either: it is strictly
harsher on these ten, and its verdict is reported as a second opinion, never
substituted for v1's.

Two cards have been closed without ever writing a strategy, which is the shape
this backlog is starting to take:

- **P-001, serial-correlation sign flip** — one self-agreement statistic killed
  it in about a minute of compute. No P&L, no exit model, no costs.
- **P-002, vol-normalized breakout** — got all the way to a full gate run and
  still missed 19 criteria. Normalising the units of a breakout is not the same
  as changing the breakout.

Next is
[P-003, selectivity on a falsified trigger](./strategies/cards/proposed/selectivity-on-falsified-trigger.md).

## Paper trading

```powershell
npm run tv:launch
node execution/paper-trade.mjs propose buy DOGEUSD --thesis "..." --dry-run
```

Governed by `config/risk.json`; every action and refusal lands in
`config/audit.jsonl`. Set `"kill_switch": true` to stop everything — that is the
fastest stop available.

Cancelling is **manual** — the order line is canvas-drawn and probing for it is
unsafe. Two clicks: the order line's `x`, then **Cancel order**.

## Compatibility

Drives undocumented internal TradingView APIs that break without notice. Both
`tradingview-mcp` (1.0.1) and TradingView Desktop (38.2.2) are pinned for that
reason. Node ≥ 20. Windows and macOS are the tested platforms; the DevTools
port is 9222.

TradingView's ToU restricts automated data collection. Personal, educational
and research use only. Do not redistribute data obtained through this.
