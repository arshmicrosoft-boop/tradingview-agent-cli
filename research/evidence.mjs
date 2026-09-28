#!/usr/bin/env node
/**
 * evidence.mjs — the strategy-agnostic evidence bundle.
 *
 * ARCHITECTURAL GUARANTEE
 * This file cannot place an order. It imports data.mjs and harness.mjs (which
 * imports the pure risk-engine). paper-trade.mjs is never loaded, and there is
 * no code path from here to TradingView.
 *
 * WHY THIS FILE EXISTS
 *
 * v1 and v2 must judge the SAME evidence, or a verdict difference between them
 * is uninterpretable — you cannot tell whether v2 is stricter or the run was
 * simply different. So the evidence gathering lives here once, and gate.mjs
 * (v1) and gate-v2.mjs (v2) are two different verdicts computed over one
 * identical bundle.
 *
 * It is also where the two pooling rules that matter are enforced:
 *
 *   - Trade-level metrics (win rate, PF, Sharpe, expectancy) are valid on the
 *     POOLED trade set, because each trade's P&L is independent of the others.
 *   - Drawdown and return are PATH properties and must NOT be pooled across
 *     symbols. Concatenating independent curves fabricates enormous drawdowns
 *     out of the jump between one symbol's ending equity and the next symbol's
 *     start. So neither is pooled: both are read off ONE equal-weight book
 *     curve, built by averaging the N per-symbol curves pointwise. The code now
 *     obeys the rule it states — it did not for most of the life of this file,
 *     see "THE EQUAL-WEIGHT BOOK" in gate.mjs for exactly how it did not and
 *     what the wrong-PASS looked like.
 *
 * WHAT THE PROTOCOL HASH DOES AND DOES NOT COVER
 *
 * `protocol.mjs` hashes the protocol JSON only. That makes it tamper-evidence
 * for THRESHOLDS — and it is genuinely good at that, after the canonicalisation
 * fix described in protocol.mjs. It is NOT tamper-evidence for COMPUTATION. The
 * pipeline is not in the hash, and `verify.mjs` only checks that the latest run
 * cites the current one, so a change to how a metric is MEASURED leaves the hash
 * untouched and `npm run verify` stays green. The walk-forward rewiring
 * described below is a live instance of exactly that. `sideways-liquidity-
 * reversal` and `_control_random` each carry two records on the SAME hash
 * `1e42a7d31d851b9b` with different failed lists. Two records on one hash means
 * "same thresholds, possibly different arithmetic" — never "same measurement".
 * See the CRITERIA comment in gate.mjs for the full statement.
 */

import { loadMany } from "./data.mjs";
import { simulate, metrics, monteCarlo, walkForward, holdoutEvaluate, costStress } from "./harness.mjs";
import { labelRegimes, regimeSummary, benchmarkPerRegime, equalWeightBook, equalWeightPath, pathStats } from "./gate.mjs";
import { auditLeakage } from "./leakage.mjs";

export const SYMBOLS = ["BTCUSDT", "ETHUSDT", "DOGEUSDT", "SOLUSDT", "ZECUSDT"];

// Bars per day, derived from the timeframe.
//
// The cap used to be a flat `days * 100`, which is only correct for 15m
// (96 bars/day). At 1m a day is 1440 bars, so a "30d 1m" request asked for
// 43,200 bars and silently received 3,000 — about two days — while the cache
// file kept the full-range name. A short sample wearing a long sample's name
// is how a backtest ends up reporting an edge it never measured, so the cap is
// now computed from the timeframe and the span is verified below.
const TF_SECONDS = {
  "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
  "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400, "1w": 604800,
};

export function barsPerDay(tf) {
  const secs = tfSeconds(tf);
  return 86400 / secs;
}

export function tfSeconds(tf) {
  const secs = TF_SECONDS[tf];
  if (!secs) throw new Error(`unknown timeframe "${tf}" — add it to TF_SECONDS`);
  return secs;
}

// ------------------------------------------------------------- time alignment
//
// Curves are aligned by TIME, never by index. Three reasons, all of them real
// in this repo:
//
//   1. a symbol whose account was ruined early has a SHORTER curve than a
//      survivor, because simulate() breaks out of the loop on ruin;
//   2. a symbol with a few missing bars has a different bar COUNT from the
//      others at the same timeframe;
//   3. the per-regime benchmark path is index-aligned to that symbol's own
//      bars, so it has to be resampled before it can be averaged at all.
//
// Averaging by index would compare bar 900 of one symbol with bar 900 of
// another and quietly average two different instants into a number that means
// nothing.

/** Sorted union of every curve's timestamps. */
export function timeAxis(curves) {
  const t = new Set();
  for (const c of curves) for (const p of c.points) t.add(p.time);
  return [...t].sort((a, b) => a - b);
}

/**
 * Resample each curve onto a shared axis as a plain number array, with `null`
 * wherever that curve has no observation. The gaps are resolved downstream by
 * `equalWeightPath`, which forward-fills from the curve's own last known value
 * (a ruined sleeve's capital does not come back) and back-fills from its own
 * first (the bars before a sleeve starts are flat).
 */
export function alignByTime(curves, axis) {
  return curves.map((c) => {
    const out = new Array(axis.length).fill(null);
    let j = 0, last = null;
    for (let i = 0; i < axis.length; i++) {
      while (j < c.points.length && c.points[j].time <= axis[i]) {
        last = c.points[j].value; j++;
      }
      out[i] = last;
    }
    return out;
  });
}

/**
 * The data window and simulator config, shared by both runners.
 *
 * These used to be duplicated in run.mjs and run-v2.mjs. evidence.mjs exists so
 * that v1 and v2 judge the SAME evidence and cannot drift apart; duplicating
 * even the window in both runners reintroduces exactly that risk one layer up,
 * and it would show up as an unexplained v1/v2 verdict difference rather than
 * as a bug in either file.
 */
export function windowFor(days, argv = []) {
  const arg = (a, f, d) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : d; };
  const to = Math.floor(Date.parse(arg(argv, "--to", "2026-09-27T00:00:00Z")) / 1000);
  return { to, from: to - days * 86400 };
}

export function simCfgFor(argv = []) {
  const arg = (a, f, d) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : d; };
  return {
    equity: Number(arg(argv, "--equity", 1000)),
    riskPct: Number(arg(argv, "--risk", 0.01)),
    maxHoldBars: Number(arg(argv, "--hold", 96)),
    warmup: 250,
    ruinEquityPct: 0.2,
  };
}

/**
 * Simulate one strategy across every symbol and gather every measurement v1's
 * gate consumes. Returns a bundle; it does NOT evaluate a gate and does NOT
 * write to any registry. Deciding and recording are the caller's job.
 */
export async function collectEvidence({ strategy, tf = "15m", days = 400, simCfg, from, to }) {
  const loaded = await loadMany({ symbols: SYMBOLS, tf, from, to, limit: Math.ceil(days * barsPerDay(tf) * 1.1) });
  const ok = loaded.filter((x) => x.ok);
  const failed = loaded.filter((x) => !x.ok);
  for (const f of failed) console.error(`  ${f.symbol}: ${f.error}`);
  if (!ok.length) throw new Error("no data loaded");

  // Refuse to run on a truncated sample. A cache entry can be named for the
  // full range while holding a fraction of it (that is exactly what a stale
  // cache plus a too-small fetch limit produces). Reporting metrics over a
  // 2-day slice as though it were 30 days is worse than not running at all.
  for (const d of ok) {
    const bars = d.data.bars;
    if (!bars.length) continue;
    const spanSec = bars[bars.length - 1].time - bars[0].time;
    const wantSec = to - from;
    if (spanSec < wantSec * 0.9) {
      throw new Error(
        `${d.symbol} ${tf}: got ${bars.length} bars spanning ${(spanSec / 86400).toFixed(1)}d ` +
        `but ${(wantSec / 86400).toFixed(1)}d was requested — delete research/data/${d.symbol} cache ` +
        `and re-run rather than reporting a short sample as a full one`
      );
    }
  }

  const mod = await import(`./strategies/${strategy}.mjs`);
  const signal = mod.default;
  // A strategy may declare the parameter grid it should be tested across.
  // Without one, sensitivity is measured over a single point, which the gate
  // correctly treats as unproven rather than as "robust".
  const grid = mod.grid || null;

  const allTrades = [];
  const perSymbolEquity = [];        // keep curves SEPARATE per symbol
  const regimes = { bull: { trades: 0, pnl: 0 }, bear: { trades: 0, pnl: 0 }, sideways: { trades: 0, pnl: 0 } };
  const volRegimes = { high: { trades: 0, pnl: 0 }, low: { trades: 0, pnl: 0 } };
  const benchByRegime = {};
  const benchPaths = [];             // regime -> one COMPOUNDED path per symbol
  const perSymbol = [];
  let barOffset = 0;
  // Shared bar axis, so per-regime benchmark paths (which are index-aligned to
  // each symbol's OWN bars, and the symbols do not have identical bar counts)
  // can be put on a common index before being averaged.
  const barAxis = timeAxis(ok.map((d) => ({ points: d.data.bars })));
  const barAxisIndex = new Map(barAxis.map((t, i) => [t, i]));
  // Spacing is derived from the data, not hardcoded to 900s. The offset exists
  // only to stop the five symbols' exit times colliding in the POOLED, time-
  // ordered trade list; a fixed 900 was correct only for 15m, and at any other
  // timeframe the symbols' windows would overlap, the pooled ordering would be
  // wrong, and the block bootstrap would resample an interleaving that never
  // happened. Unreachable under the frozen 15m protocol, and wrong the moment
  // --tf is anything else.
  const barStep = (bars) => (bars.length > 1 ? bars[1].time - bars[0].time : tfSeconds(tf));

  for (const d of ok) {
    const bars = d.data.bars;
    const reg = labelRegimes(bars);
    const sim = simulate({ bars, signal, cfg: { ...simCfg } });
    const m = metrics({ trades: sim.trades, equityCurve: sim.equityCurve, initialEquity: sim.cfg.equity });

    for (const t of sim.trades) allTrades.push({ ...t, symbol: d.symbol, time: t.exitTime + barOffset });
    perSymbolEquity.push({ symbol: d.symbol, curve: sim.equityCurve });

    const rs = regimeSummary(sim.trades, reg.directional, bars.map((b) => b.time));
    for (const k of Object.keys(regimes)) { regimes[k].trades += rs[k].trades; regimes[k].pnl += rs[k].pnl; }
    const vs = regimeSummary(sim.trades, reg.volatility, bars.map((b) => b.time));
    for (const k of Object.keys(volRegimes)) { volRegimes[k].trades += vs[k].trades; volRegimes[k].pnl += vs[k].pnl; }

    // Regime-matched buy-and-hold on this symbol's own bars. `v.path` is a
    // COMPOUNDED equity path in units of 1.0, flat at 1.0x outside the regime,
    // so it is directly comparable with the strategy's pooled regime P&L over
    // the same account equity. Resampled onto the shared bar axis, then
    // averaged over all N symbols below.
    const bReg = benchmarkPerRegime({ bars, regimes: reg });
    for (const [k, v] of Object.entries(bReg)) {
      if (!benchByRegime[k]) {
        benchByRegime[k] = { returnPct: 0, maxDrawdownPct: 0, calmar: 0, symbols: 0, bars: 0, runs: 0, legMeanReturnPct: 0, worstLegDrawdownPct: 0 };
        benchPaths[k] = [];
      }
      const onAxis = new Array(barAxis.length).fill(null);
      for (let j = 0; j < bars.length; j++) {
        const i = barAxisIndex.get(bars[j].time);
        if (i != null) onAxis[i] = v.path[j];
      }
      benchPaths[k].push(onAxis);
      benchByRegime[k].bars += v.bars;
      benchByRegime[k].runs += v.runs;
      benchByRegime[k].symbols++;
      benchByRegime[k].worstLegDrawdownPct = Math.max(benchByRegime[k].worstLegDrawdownPct, v.worstLegDrawdownPct);
      benchByRegime[k].legMeanReturnPct += v.legMeanReturnPct;
    }

    perSymbol.push({
      symbol: d.symbol, bars: bars.length, trades: m.trades, winRate: m.winRate,
      profitFactor: m.profitFactor, sharpe: m.sharpe, maxDrawdownPct: m.maxDrawdownPct,
      totalReturnPct: m.totalReturnPct, ruined: sim.ruined, ruinBar: sim.ruinAtBar,
    });
    barOffset += (bars[bars.length - 1].time - bars[0].time) + barStep(bars);
  }

  allTrades.sort((a, b) => a.time - b.time);

  const tradeMetrics = metrics({
    trades: allTrades,
    equityCurve: [{ equity: simCfg.equity }],   // drawdown from this is meaningless
    initialEquity: simCfg.equity,
  });

  // ==================================================================
  // THE EQUAL-WEIGHT BOOK. One basis, and every criterion uses it.
  //
  //   returnPct      the MEAN of the N per-symbol total returns (equal weight,
  //                  additive) — which is algebraically identical to the final
  //                  value of the averaged curve over the initial value, and
  //                  is measured as exactly that, off the curve
  //   maxDrawdownPct the max drawdown OF THE AVERAGED CURVE
  //
  // What this replaced:
  //   returnPct      = (Π_s (1 + r_s) - 1) * 100  <- the product of five
  //                                             FULL-account returns, i.e. the
  //                                             return of a 5x-GEARED book
  //   maxDrawdownPct = max_s DD_s                  <- a 1x, SINGLE-sleeve drawdown
  // and gate.mjs divided one by the other. Numerator 5x-geared, denominator 1x:
  // mismatched units, inflating the calmar criterion on every verdict in both
  // v1 and v2. See the "THE EQUAL-WEIGHT BOOK" block in gate.mjs, including the
  // falsifying five-symbols-at-+20% case (calmar 9.922 before, 1.333 after).
  //
  // A book is never deeper than its worst component, so `maxDrawdownPct` now
  // reports a SMALLER number than the old worst-single-symbol figure. That is
  // not a loosened threshold; it is the same 35% bar applied to the thing the
  // strategy actually deploys. `worstSymbolDrawdownPct` is kept below so the
  // old number is still visible for comparison.
  const eqCurves = perSymbolEquity.map((p) => ({
    points: p.curve.map((x) => ({ time: x.time, value: x.equity })),
  }));
  const book = equalWeightBook(alignByTime(eqCurves, timeAxis(eqCurves)), { base: simCfg.equity });
  let worstSymbolDD = 0;
  for (const s of perSymbol) if (Number(s.maxDrawdownPct) > worstSymbolDD) worstSymbolDD = Number(s.maxDrawdownPct);

  const agg = { ...tradeMetrics, maxDrawdownPct: book.maxDrawdownPct,
                totalReturnPct: book.totalReturnPct,
                calmar: book.calmar,
                worstSymbolDrawdownPct: Number(worstSymbolDD.toFixed(2)),
                note: "trade metrics pooled; return = MEAN of the N per-symbol returns (equal-weight, additive) and drawdown = max drawdown of the pointwise-AVERAGED equity curve — both read off the same equal-weight book" };

  // ---------------------------------------------------------------------
  // The benchmark is the SAME KIND OF BOOK, so "> hold" is apples-to-apples.
  //
  // Each sleeve is normalised to 1.0 at its own first close and the sleeves are
  // averaged pointwise. That average IS an equal-weight buy-and-hold book with
  // no rebalancing: its final value is the mean of the N per-symbol returns, and
  // its max drawdown is the drawdown of the book. Both halves come off that one
  // curve, exactly as the strategy's do.
  //
  // It used to be: mean of the per-symbol returns over a drawdown that was the
  // WORST single symbol. Same mismatched-basis defect as `agg`, in the
  // denominator, on the other side of the comparison.
  const holdCurves = ok.map((d) => ({
    points: d.data.bars.map((b) => ({ time: b.time, value: b.close / d.data.bars[0].close })),
  }));
  const holdBook = equalWeightBook(alignByTime(holdCurves, timeAxis(holdCurves)), { base: 1 });
  const bench = {
    totalReturnPct: holdBook.totalReturnPct,
    maxDrawdownPct: holdBook.maxDrawdownPct,
    calmar: holdBook.calmar,
    note: "equal-weight buy-and-hold book over the same symbols: each sleeve normalised to 1.0, sleeves averaged pointwise, and BOTH the return and the drawdown read off that one averaged curve",
  };

  const mc = monteCarlo({ trades: allTrades, initialEquity: simCfg.equity, runs: 1000 });
  // SAME BASIS AS `agg` ABOVE, and now for the same structural reason.
  //
  // This call passes the POOLED five-symbol trade set, so it is the one caller in
  // the repo that exercises `harness.monteCarlo` as a PORTFOLIO rather than as a
  // single account. It used to replay those pooled trades against a SINGLE
  // `initialEquity`, so its equity path was the return of five FULL accounts
  // compounded into one 1000-unit account: a 5x-GEARED book, and the same class
  // of defect as the calmar numerator above. Two criteria were therefore on two
  // bases — `P(dd breach) %` read the geared path while `max drawdown %` read
  // the equal-weight book.
  //
  // `harness.monteCarlo` is now the SAME equal-weight additive model: it groups
  // the trades by their `symbol` field into N sleeves, replays each sleeve
  // against its own account of `initialEquity`, and measures the drawdown of
  // the arithmetic mean of the N curves. A trade never migrates between
  // sleeves — the shuffle is within-symbol only — and a sleeve that runs out of
  // trades is forward-filled from its own last value. A book is therefore never
  // deeper than its worst sleeve and can never report a drawdown above 100%,
  // which the geared path could and did.
  //
  // WHAT THE SHUFFLE STILL DOES, precisely, so the field is not over-read: it
  // reorders a FIXED set of P&L outcomes within each symbol. The sum is
  // order-invariant, so `finalEquity` is a constant and `probabilityOfBreaching-
  // Threshold` and the drawdown percentiles describe the PATH under reordering
  // only. This is still not an expectancy test — that is what
  // `robustness.bootstrapMonteCarlo` resamples outcomes for — and it still
  // cannot report P(profitable). What changed is the portfolio the path belongs
  // to, not the resampling method.
  //
  // MEASURED, on the real cached dataset (vol-normalized-breakout, 2583 pooled
  // trades, 5 symbols, seed 12345): the geared replay ended at an equity of
  // -500.64, a negative account balance no real book can report, with a median
  // drawdown of 168.41%, a p95 of 270.37% and a worst of 363.73%. The
  // equal-weight book ends at 699.87 with a median drawdown of 54.58% and a
  // worst of 92.63% — and that 54.58% is the number `agg.maxDrawdownPct`
  // reports (54.55%) to within 0.03pp, which is the whole point: the two
  // criteria are on one basis and they now say the same thing.
  // On sma-cross (1984 pooled trades) the same change moves the median drawdown
  // from 87.18% to 38.69% and P(dd breach) from 100% to 98.4%.
  //
  // The old figures were not conservative errors to be offset by a threshold;
  // they were numbers with no referent. No threshold was moved to accommodate
  // the change.
  mc.note = "order-shuffle WITHIN each symbol: N independent sub-accounts of "
    + `${simCfg.equity}, book equity = arithmetic mean of the N curves at every step, drawdown of that `
    + "averaged curve — the same equal-weight book `agg` uses, so `P(dd breach) %` and `max drawdown %` "
    + "are finally on one basis. A trade never moves between symbols and a book is never deeper than its "
    + "worst sleeve, so the drawdown cannot exceed 100%. Still an order-shuffle of a FIXED P&L set, not an "
    + "outcome resample: `finalEquity` is order-invariant and this still cannot report P(profitable) — "
    + "that is robustness.bootstrapMonteCarlo's job.";

  // Walk-forward. The gate's MIN_WF criterion is fed by harness.walkForward(),
  // the implementation that is exported and self-tested.
  //
  // THE CRITERION MEASURES THE PRIMARY SYMBOL ONLY. `ok[0]` is BTCUSDT. That is
  // a change from what v1 originally did, and it moved real numbers — see the
  // `wfPooled` caveat below for the measured impact on all 11 strategies, and
  // for why the change is accepted as the more correct measurement rather than
  // reverted. A reader must not assume a recorded v1 walk-forward figure is
  // comparable to a freshly computed one without checking that caveat.
  //
  // It used to be fed by an inline splitter here that cut the POOLED 5-symbol
  // trade stream into four equal-count chunks and scored each fold as
  // `summedPnl / 1000`. That is a sum of five accounts' P&L divided by one
  // account's equity — a nonsense percentage that happened to be used only for
  // its sign. Worse, the tested walkForward() was never called by the runner at
  // all, so the one implementation with tests and the one that decided the
  // verdict were different code.
  const wfPrimary = walkForward({ bars: ok[0].data.bars, signal, cfg: { ...simCfg } });
  wfPrimary.symbolScope = "primary symbol only (ok[0]) — NOT the five-symbol book described by `agg`, and NOT the pooled figure reported as `wfPooled`";

  // The same statistic computed on the POOLED trade stream, kept because it
  // covers all five symbols rather than the primary one. Reported as `wfPooled`
  // and never used for the verdict.
  const fold = Math.max(1, Math.floor(allTrades.length / 4));
  const wfFolds = [];
  for (let f = 0; f < 4; f++) {
    const seg = allTrades.slice(f * fold, (f + 1) * fold);
    if (!seg.length) continue;
    const pnl = seg.reduce((a, t) => a + t.pnl, 0);
    wfFolds.push({ fold: f + 1, trades: seg.length, totalReturnPct: Number(((pnl / simCfg.equity) * 100).toFixed(2)) });
  }
  const wfPooled = {
    folds: wfFolds.length, perFold: wfFolds,
    foldsProfitable: wfFolds.filter((f) => f.totalReturnPct > 0).length,
    consistency: wfFolds.length
      ? Number(((wfFolds.filter((f) => f.totalReturnPct > 0).length / wfFolds.length) * 100).toFixed(1))
      : null,
    // READ THIS BEFORE COMPARING ANY TWO WALK-FORWARD NUMBERS IN THIS REPO.
    //
    // This is a sign test on the POOLED five-symbol P&L stream. It is NOT what
    // the `walk-forward consistency %` criterion reads, and it has never been.
    // The criterion reads `wf` (above), which is `harness.walkForward` run on
    // the PRIMARY symbol only.
    //
    // A recorded v1 `walk-forward consistency %` therefore does NOT describe
    // this object, and neither does this object describe the criterion. The
    // difference is not cosmetic:
    //
    //   * POPULATION. `wf` is one symbol (BTCUSDT). This is all five. The
    //     criterion's value is a statement about one account, not about the
    //     book that `agg` describes.
    //   * DENOMINATOR. Each fold here is `summedPnl / 1000` — the P&L of FIVE
    //     accounts divided by ONE account's equity, a sum of five books over
    //     one book. It was only ever used for its SIGN, so the units never
    //     showed. `wf` divides each fold by the equity actually being traded.
    //
    // MEASURED IMPACT of the rewiring, across all 11 strategies: the value
    // CHANGED ON 7 OF 11, and `vol-normalized-breakout` crossed the MIN_WF=50
    // bar, 50 -> 0. No overall verdict flipped, because that strategy's verdict
    // was already false on other criteria, and every strategy in the repo is
    // far below the bar regardless.
    //
    // WHERE THE OLD 50 CAME FROM, so the change is legible rather than
    // arbitrary: the pooled splitter handed a strategy that was down -99.61%
    // over the sample and ruined on 4 of 5 symbols a PASSING 50, because it
    // measured sign-of-P&L per fold on a sum that was still positive per fold.
    // The new 0 is 0 of 4 folds profitable on BTCUSDT. Both numbers are real;
    // they answer different questions, and only one of them is the criterion.
    caveat: "sign test on POOLED five-symbol P&L (sum of 5 accounts / one account's equity; sign only); the walk-forward consistency criterion reads `wf` = harness.walkForward on the PRIMARY symbol, a different population AND a different denominator. 7 of 11 strategies' values changed when the criterion was rewired; vol-normalized-breakout went 50 -> 0 against MIN_WF=50. Not used for the verdict.",
  };

  // --- out-of-sample + parameter sensitivity, run on the primary symbol
  const primary = ok[0].data.bars;
  const holdout = holdoutEvaluate({
    bars: primary, signal, cfg: simCfg,
    grid: grid || { _probe: [1] }, objective: "sharpe", trainFrac: 0.7,
  });
  // --- cost stress on the primary symbol
  const stress = costStress({ bars: primary, signal, cfg: simCfg, feeMults: [1, 2, 5], slipMults: [1, 2, 5] });
  // --- data leakage audit on the primary symbol
  const leakage = auditLeakage({ simulate, metrics, bars: primary, signal, cfg: simCfg, warmup: simCfg.warmup });

  const ruinSymbols = perSymbol.filter((s) => s.ruined).length;

  // --- per-regime benchmark, on the SAME equal-weight basis as the strategy
  // side: an equal-weight average over ALL N symbols, with `ok.length` as the
  // divisor. The strategy side is `pooledPnl / (initialEquity * N)` in gate.mjs,
  // where a symbol that did not trade in the regime contributes 0 to the
  // numerator, so N is the only divisor that gives both sides the same
  // population. A symbol with no bars in the regime contributes a flat 1.0x
  // path — the same 0% contribution, seen from the benchmark side.
  //
  // The padding is not optional. `benchmarkPerRegime` only emits a key for a
  // regime present in its own `labels`, so the loop above pushed NO sleeve at
  // all for a symbol missing that regime, and `equalWeightPath` divides by the
  // array it is handed. Without the pad the divisor is the number of symbols
  // that happened to have the regime, which is N only while the symbol set is
  // perfectly balanced. On the current 5-symbol data every symbol has all three
  // regimes, so both divisors agree today; that is a property of this dataset,
  // not a guarantee, and it is why the pad is explicit rather than assumed.
  //
  // `legMeanReturnPct` and `worstLegDrawdownPct` are the pre-fix numbers, kept
  // so the size of the correction is auditable. `worstLegDrawdownPct` is NOT
  // used as the criterion's denominator: a book is never deeper than its worst
  // component, and the gate needs the book's own drawdown.
  const N = ok.length;
  for (const k of Object.keys(benchByRegime)) {
    const b = benchByRegime[k];
    const sleeves = benchPaths[k] || [];
    const padded = Array.from({ length: N }, (_, i) => sleeves[i] ?? new Array(barAxis.length).fill(1));
    const bookPath = equalWeightPath(padded);
    const st = pathStats(bookPath, 1);
    b.returnPct = st.totalReturnPct;
    b.maxDrawdownPct = st.maxDrawdownPct;
    b.calmar = st.calmar;
    b.legMeanReturnPct = Number((b.legMeanReturnPct / Math.max(1, b.symbols)).toFixed(2));
    b.symbolsAveragedOver = N;
    b.symbolsWithRegime = b.symbols;
    b.note = "equal-weight buy-and-hold book over ALL N symbols, per regime: each symbol's COMPOUNDED regime path, missing symbols padded flat at 1.0x, sleeves averaged pointwise, return and drawdown both off that averaged curve";
  }

  return {
    strategy, tf, days,
    signal, grid, mod,
    loaded: ok.map((d) => ({ symbol: d.symbol, bars: d.data.bars.length })),
    allTrades, perSymbol, perSymbolEquity,
    regimes, volRegimes, benchByRegime, bench,
    agg, mc, wf: wfPrimary, wfPooled, holdout, stress, leakage, ruinSymbols,
    primary, symbolCount: ok.length, initialEquity: simCfg.equity,
  };
}
