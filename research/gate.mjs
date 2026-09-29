#!/usr/bin/env node
import { PROTOCOL } from "./protocol.mjs";

/**
 * gate.mjs — the research gate.
 *
 * A strategy is not "an edge" because it made money on one symbol in one regime.
 * This encodes the bar that has to be cleared, and answers it mechanically.
 *
 *   MIN_TRADES      500     in-sample trade count
 *   MIN_SYMBOLS     5       BTC ETH DOGE SOL ZEC
 *   MIN_REGIMES     3       bull / bear / sideways, each with trades
 *   MIN_PF          1.3     profit factor
 *   MIN_SHARPE      1.0     Sharpe on per-trade returns
 *   MAX_DD          35      max drawdown %
 *   MIN_WF          50      % of walk-forward folds profitable
 *   MIN_WF_COVERAGE 100     % of walk-forward folds that traded at all
 *   MAX_MC_BREACH   25      % chance of breaching the drawdown threshold
 *
 * Regime is labelled from the data, not asserted: a bar is BULL/BEAR if the
 * slope of a long moving average over a long window agrees with the sign of
 * its displacement, and everything else is SIDEWAYS. SIDEWAYS is the
 * majority state for most assets, so a strategy that only works in a trend is
 * exposed here rather than hidden by an in-sample average.
 */

// Criteria are LOADED from protocol.v1.json, not defined here. The protocol is
// hashed, and the hash is recorded on every run, so a threshold cannot be
// relaxed after seeing results without it showing up in the run record.
//
// WHAT THE HASH ACTUALLY COVERS — read this before trusting a run record.
//
// The hash is computed over the protocol JSON only (`protocol.mjs:53`,
// `sha256(canonicalize(protocolJson))`). It is tamper-evidence for
// THRESHOLDS: if a MIN_* value, a cost, a risk parameter, a symbol list or a
// Monte Carlo seed changes, the hash changes, and `verify.mjs:155` fails
// because the latest run no longer cites the current one.
//
// It is NOT tamper-evidence for COMPUTATION. The pipeline code is not in the
// hash and not in the verify check, so a change to how a metric is MEASURED
// leaves the hash untouched and `npm run verify` stays green. This is not
// theoretical: the archive contains two strategies — `sideways-liquidity-
// reversal` and `_control_random` — with two records each on the SAME hash
// `1e42a7d31d851b9b` and DIFFERENT failed lists, because the walk-forward
// criterion was rewired between the two runs.
//
// So `protocol.v1.json`'s claim that "you should not be able to move a
// threshold after seeing results without it being visible" is TRUE, and
// narrower than it reads. A metric changing under a fixed hash is a documented
// limitation of the current scheme, not a bug in it. Fixing it would mean
// hashing the pipeline (or the metric definitions) and versioning the
// protocol — a deliberate design change that is out of scope here. Until then,
// treat two records on one hash as "same thresholds, possibly different
// arithmetic", and compare the recorded criterion VALUES
// (`failed_detail` in registry.mjs), not just the pass/fail names.
export const CRITERIA = PROTOCOL.criteria;

/**
 * Label every bar with TWO independent regimes.
 *
 *   directional : bull | bear | sideways   (from long-MA slope)
 *   volatility  : high | low               (from realised-vol percentile)
 *
 * These are deliberately separate. A single trend-based label hides the case
 * that matters most here: a strategy that only works in choppy markets gets
 * filed under "sideways" and fails a directional 3-regime check for entirely
 * the wrong reason. Volatility regime is what actually drives most intraday
 * crypto behaviour.
 *
 * Warmup bars are `null` (unknown) in BOTH dimensions — defaulting them to a
 * real regime would invent exposure that never existed and flatter any
 * strategy that happens to trade early.
 */
export function labelRegimes(bars, {
  trendLen = 200, slopeLen = 50, bullSlope = 0.004, bearSlope = -0.004,
  volLen = 100, volHighPct = 0.70,
} = {}) {
  const n = bars.length;
  const directional = new Array(n).fill(null);
  const volatility = new Array(n).fill(null);
  if (n < trendLen + slopeLen + 2) return { directional, volatility };

  const sma = new Array(n).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += bars[i].close;
    if (i >= trendLen) sum -= bars[i - trendLen].close;
    if (i >= trendLen - 1) sma[i] = sum / trendLen;
  }
  for (let i = trendLen + slopeLen; i < n; i++) {
    const a = sma[i - slopeLen], b = sma[i];
    if (a == null || b == null) continue;
    const slope = (b - a) / a;
    directional[i] = slope > bullSlope ? "bull" : slope < bearSlope ? "bear" : "sideways";
  }

  // Realised volatility: stdev of log returns over volLen, classified against
  // the median of its OWN history so the split is scale-free per symbol.
  const rv = new Array(n).fill(null);
  for (let i = volLen; i < n; i++) {
    let s = 0, s2 = 0, m = 0;
    for (let k = i - volLen + 1; k <= i; k++) {
      const r = Math.log(bars[k].close / bars[k - 1].close);
      m += r; s += r; s2 += r * r;
    }
    const mean = s / volLen;
    const varr = Math.max(0, s2 / volLen - mean * mean);
    rv[i] = Math.sqrt(varr);
  }
  const known = rv.filter((x) => x != null).sort((a, b) => a - b);
  if (!known.length) return { directional, volatility };
  const cut = known[Math.floor(known.length * volHighPct)];
  for (let i = 0; i < n; i++) if (rv[i] != null) volatility[i] = rv[i] >= cut ? "high" : "low";

  return { directional, volatility };
}

/**
 * Bucket trades by the regime label of their entry bar.
 * Generic over the label set, so it serves both the directional axis
 * (bull/bear/sideways) and the volatility axis (high/low) without change.
 */
export function regimeSummary(trades, labels, barTimes) {
  const idx = new Map(barTimes.map((t, i) => [t, i]));
  const by = {};
  for (const l of new Set(labels.filter((x) => x != null))) by[l] = { trades: 0, pnl: 0 };
  for (const t of trades) {
    const i = idx.get(t.entryTime);
    const r = i == null ? null : labels[i];
    if (!r) continue;
    if (!by[r]) by[r] = { trades: 0, pnl: 0 };
    by[r].trades++;
    by[r].pnl += t.pnl;
  }
  return by;
}

// ------------------------------------------------- THE equal-weight book
//
// This is the ONLY portfolio definition any gate criterion is allowed to use,
// and it is deliberately the boring one: N sleeves, 1/N of the capital in
// each, returns ADDED, nothing rebalanced, no compounding across sleeves.
// Return and drawdown are read off the SAME averaged curve, so both halves of a
// calmar are always the same book.
//
// THE BUG THIS REPLACES, precisely. evidence.mjs used to report
//
//     agg.totalReturnPct  = (Π_s (1 + r_s) - 1) * 100    <- a 5x-GEARED book:
//                                                            the product of five
//                                                            FULL-account returns
//     agg.maxDrawdownPct = max_s DD_s                    <- a 1x, SINGLE-sleeve
//                                                            drawdown
//
// and `stratCalmar` below divided the first by the second. The numerator was
// the return of a five-times-geared portfolio and the denominator was a
// one-times drawdown. The units did not match; the ratio was inflated by
// roughly the leverage, in the strategy's favour, on every single verdict in
// BOTH v1 and v2 (gate-v2.mjs passes `evidence.agg` straight into this gate).
//
// Falsified on synthetic evidence: five symbols each returning +20% with a 15%
// drawdown, against a hold benchmark of calmar 2.0.
//
//     geared numerator    return 148.83  calmar 9.922   PASS
//     equal-weight book   return  20.00  calmar 1.333   FAIL
//
// Same book, opposite verdict, decided purely by which return definition was
// used. It stayed hidden only because all eleven strategies in the repo lose
// so much money that even the inflated numerator is still negative. On real
// data the geared book reported -99.77% for `_control_alwayslong` where the
// equal-weight book returns -55.22%, and -99.36% for `sma-cross` where the
// equal-weight book returns -1.32%.
//
// The repo's own rule already said so, at the top of evidence.mjs, and the code
// was not obeying it: "Drawdown and return are PATH properties and must NOT be
// pooled across symbols." Pooling a return across symbols by compounding is
// the same error in a different costume.

/**
 * Average N sleeves pointwise into one book.
 *
 * `seriesList` is index-aligned: `seriesList[k][i]` is sleeve k's value at
 * index i, or `null` where sleeve k has no observation. A `null` is forward-
 * filled from that sleeve's own last known value, and back-filled from its own
 * first, because that is what actually happens to a sleeve: an account that
 * was ruined stops reporting but its capital does not come back, and the bars
 * before a sleeve's first point are flat by construction. Dropping a dead
 * sleeve instead of carrying it would delete its losses and shrink the book.
 */
export function equalWeightPath(seriesList) {
  const nSleeves = seriesList.length;
  if (!nSleeves) return [];
  const len = Math.max(...seriesList.map((s) => s.length));
  const filled = seriesList.map((s) => {
    const out = new Array(len);
    let last = null;
    for (let i = 0; i < len; i++) {
      const v = i < s.length ? s[i] : null;
      if (v != null) last = v;
      out[i] = last;
    }
    const first = out.find((v) => v != null);
    if (first == null) return new Array(len).fill(0);
    for (let i = 0; i < len; i++) if (out[i] == null) out[i] = first;
    return out;
  });
  const book = new Array(len).fill(0);
  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (let k = 0; k < nSleeves; k++) sum += filled[k][i];
    book[i] = sum / nSleeves;
  }
  return book;
}

/** Return, max drawdown and calmar of ONE path, both measured on that path. */
export function pathStats(series, base) {
  const b = base ?? series[0];
  if (!series.length || !(b > 0)) {
    return { totalReturnPct: 0, maxDrawdownPct: 0, calmar: null, base: b ?? null };
  }
  let peak = b, dd = 0;
  for (const v of series) {
    if (v > peak) peak = v;
    if (peak > 0) dd = Math.max(dd, (peak - v) / peak);
  }
  const ret = series[series.length - 1] / b - 1;
  return {
    totalReturnPct: Number((ret * 100).toFixed(2)),
    maxDrawdownPct: Number((dd * 100).toFixed(2)),
    calmar: dd > 0 ? Number((ret / dd).toFixed(3)) : null,
    base: b,
    final: series[series.length - 1],
  };
}

/** The whole portfolio statistic, in one call, from index-aligned sleeves. */
export function equalWeightBook(seriesList, { base = null } = {}) {
  const book = equalWeightPath(seriesList);
  return { ...pathStats(book, base ?? book[0] ?? null), nSymbols: seriesList.length, points: book.length };
}

/**
 * Benchmark buy-and-hold ON THE SAME BARS, per regime.
 *
 * The previous version compared total return in a single window, which is
 * regime-biased: in a 400-day bull run, "beat buy-and-hold" mostly measures
 * "did you sit in a bull market without a stop". The fix is two-fold:
 *
 *   1. compare REGIME-MATCHED — what did holding do in *this* stretch?
 *   2. compare RISK-ADJUSTED  — return alone rewards reckless leverage
 *
 * `calmar` (return / max drawdown) is the risk-adjusted figure used, because it
 * is meaningful when Sharpe is computed per-trade and so is not comparable
 * across different trade counts.
 *
 * THE BASIS IS AN EQUAL-WEIGHT BOOK OVER ALL N SYMBOLS, and only that is true
 * on both sides. The strategy side is `evaluateGate`'s `pooledPnl /
 * (initialEquity * N)`: the POOLED `regimes[r].pnl` divided by the equity of
 * the whole book, so it is a per-symbol-equity return with a symbol that did
 * not trade in the regime contributing 0. The benchmark side is a COMPOUNDED
 * per-symbol path (buy and hold compounds; it is not a sum of one-bar returns),
 * which evidence.mjs averages pointwise over ALL N symbols — a symbol with no
 * bars in that regime is padded with a flat 1.0x path of the right length so
 * the divisor is N and not "the number of symbols that happened to have the
 * regime". Both sides are then equal-weight over the same N-symbol population
 * and in the same equity units, which is what makes the `>` meaningful.
 *
 * What is deliberately NOT claimed: that the two numbers are computed by the
 * same arithmetic. The strategy side is a mean of per-symbol MONEY returns; the
 * benchmark side is a mean of per-symbol COMPOUNDED paths. They agree as
 * equal-weight averages over the same population, not as identical functions.
 * The earlier comment in this slot asserted "same arithmetic on both sides"
 * and that a symbol absent from a regime contributed a flat-1.0 sleeve; both
 * were false, and the second was false structurally — `benchmarkPerRegime`
 * only emits keys for regimes present in `labels`, so before the N-padding
 * above no sleeve was pushed at all for a missing symbol.
 *
 * The version before that reported, per regime, the BAR-WEIGHTED MEAN of the
 * per-contiguous-leg returns — a per-leg average, not a cumulative return over
 * the regime. With a recurring regime (bull/bear/sideways alternate dozens of
 * times across 400 days) that number is far smaller than what the sleeve
 * actually earned in total, so the strategy was being compared against a
 * benchmark it was almost always going to beat. `legMeanReturnPct` and
 * `worstLegDrawdownPct` are kept below as diagnostics; they are NOT what any
 * criterion reads.
 */
export function benchmarkPerRegime({ bars, regimes, initialEquity }) {
  const dir = regimes.directional || regimes;      // index-aligned to `bars`
  const n = bars.length;
  const labels = new Set(dir.filter((x) => x != null));

  // COMPOUNDED equity path per regime, in units of 1.0, index-aligned. Buy and
  // hold COMPOUNDS: holding through n one-bar returns MULTIPLIES them, it does
  // not add them. Summing one-bar returns instead understates the benchmark by
  // roughly Σr²/2 per step, and that gap is unbounded over a long trending
  // regime. Measured on the cached 400d/15m 5-symbol data, the bull benchmark is
  // +0.88% as a sum of one-bar returns and +630.63% compounded. A gate
  // comparing a strategy against the +0.88% version was comparing it against a
  // number no holder could have earned, which is a false PASS.
  //
  // THE ACCUMULATOR MUST SURVIVE A REGIME GAP, and this is the subtle part.
  // `path[l] = new Array(n).fill(1)` alone is not enough: `path[r][i-1]` is 1.0
  // at the first bar of every new leg, so a per-index `path[r][i-1] * (1 + ret)`
  // silently RESETS to 1.0x at each gap. Bull/bear/sideways alternate dozens of
  // times across 400 days, so that is dozens of resets, and the result is
  // leg-mean behaviour wearing a compound's clothes — measured at 0.89%, i.e.
  // the bug unchanged. Hence `run[l]`: one running multiple per regime that is
  // only ever advanced, never cleared, and every bar of every regime carries
  // the current value forward. A gap is FLAT (the path holds), which is what
  // "flat outside the regime" has to mean once the arithmetic is multiplicative.
  // Flat-and-holding is also what makes the LAST element of the array the
  // regime's total return: `pathStats` reads `series[series.length-1]`, and a
  // path that snapped back to 1.0 on out-of-regime bars would report ~0 for any
  // regime the sample did not end in.
  const path = {}, run = {}, barsIn = {}, legs = {}, legRet = {}, legBars = {}, legDd = {};
  for (const l of labels) {
    path[l] = new Array(n).fill(1);
    run[l] = 1;
    barsIn[l] = 0; legs[l] = 0; legRet[l] = 0; legBars[l] = 0; legDd[l] = 0;
  }

  // A regime RECURS. Each CONTIGUOUS run is one leg, tracked for the
  // diagnostics below; the REPORTED return compounds across all of them.
  let cur = null;
  for (let i = 1; i < n; i++) {
    const r = dir[i];                              // positional, NOT by timestamp
    const prevClose = bars[i - 1].close, close = bars[i].close;
    const ret = prevClose > 0 ? close / prevClose - 1 : 0;

    // Every regime's path holds its value across this bar unless this bar is
    // in that regime. This is the "flat outside the regime" line.
    for (const l of labels) path[l][i] = run[l];

    if (r) {
      if (!cur || cur.regime !== r) {
        if (cur) {
          const lr = cur.first > 0 ? cur.last / cur.first - 1 : 0;
          legRet[cur.regime] += lr; legBars[cur.regime] += cur.bars; legs[cur.regime]++;
          legDd[cur.regime] = Math.max(legDd[cur.regime] ?? 0, cur.dd);
        }
        cur = { regime: r, first: bars[i - 1].close, last: close, peak: close, dd: 0, bars: 0 };
      }
      cur.last = close;
      if (close > cur.peak) cur.peak = close;
      if (cur.peak > 0) cur.dd = Math.max(cur.dd, (cur.peak - close) / cur.peak);
      cur.bars++;
      if (path[r]) { run[r] *= 1 + ret; path[r][i] = run[r]; barsIn[r]++; }
    } else {
      cur = null;                                  // warmup/other bar breaks the run
    }
  }
  if (cur) {
    const lr = cur.first > 0 ? cur.last / cur.first - 1 : 0;
    legRet[cur.regime] += lr; legBars[cur.regime] += cur.bars; legs[cur.regime]++;
    legDd[cur.regime] = Math.max(legDd[cur.regime] ?? 0, cur.dd);
  }

  const out = {};
  for (const l of labels) {
    const st = pathStats(path[l], 1);
    out[l] = {
      // This symbol's own COMPOUNDED return over every bar the regime
      // occupied, in percent. evidence.mjs averages these paths over the whole
      // book and OVERWRITES the three fields above on the averaged curve; this
      // per-symbol value is the sleeve's own, kept for auditing.
      returnPct: st.totalReturnPct,
      // This symbol's own path drawdown. The AUTHORITATIVE portfolio drawdown
      // can only be the drawdown of the AVERAGED path, and that is computed by
      // evidence.mjs once every symbol's path is in; a book is never deeper
      // than its worst component, so this is an upper bound on it.
      maxDrawdownPct: st.maxDrawdownPct,
      calmar: st.calmar,
      bars: barsIn[l], runs: legs[l],
      // Diagnostics, read by no criterion.
      legMeanReturnPct: legBars[l] > 0 ? Number(((legRet[l] / legBars[l]) * 100).toFixed(2)) : 0,
      worstLegDrawdownPct: Number(((legDd[l] ?? 0) * 100).toFixed(2)),
      path: path[l],
    };
  }
  return out;
}

/** Overall buy-and-hold on the same bars, for reference. */
export function benchmark({ bars, initialEquity }) {
  const first = bars[0].close, last = bars[bars.length - 1].close;
  let peak = first, dd = 0;
  for (const b of bars) {
    if (b.close > peak) peak = b.close;
    if (peak > 0) dd = Math.max(dd, (peak - b.close) / peak);
  }
  const ret = last / first - 1;
  return {
    totalReturnPct: Number((ret * 100).toFixed(2)),
    maxDrawdownPct: Number((dd * 100).toFixed(2)),
    calmar: dd > 0 ? Number((ret / dd).toFixed(3)) : null,
    note: "SINGLE-symbol buy-and-hold on the given bars, no costs, no stop — NOT the equal-weight book. evidence.mjs builds the book with equalWeightBook instead; this helper is not on the gate path.",
  };
}

/**
 * The verdict. Returns every criterion with pass/fail, not just a boolean.
 *
 * Benchmark comparison is now risk-adjusted AND regime-matched:
 *   - calmar (return / max drawdown) must beat regime-matched buy-and-hold
 *   - the strategy must be at least as good as holding in the regimes it trades
 * A strategy that only wins in one regime fails; one that wins everywhere but
 * is 5x the drawdown also fails.
 */
export function evaluateGate({
  metrics, mc, wf, regimes, volRegimes, bench, benchByRegime,
  symbolCount, ruined = false, ruinSymbols = 0,
  holdout = null, stress = null, perSymbol = null, leakagePass = true, leakageAdvisories = [],
  initialEquity = null,
}) {
  const C = CRITERIA;
  // Sharpe alone is not evidence. Two corrections:
  //   t-stat  = S * sqrt(n)              -> is the number significant?
  //   LCB     = S - 1.96 * SE            -> how much of it survives estimation
  //                                          error? A Sharpe from 20 trades has a
  //                                          huge standard error, so a point
  //                                          estimate of 3.0 is far less certain
  //                                          than it looks. n and S^2 both widen SE.
  const tstat = metrics.sharpe != null && metrics.trades > 1
    ? Number((metrics.sharpe * Math.sqrt(metrics.trades)).toFixed(2)) : null;
  const sharpeLcb = metrics.sharpe != null && metrics.trades > 1
    ? Number((metrics.sharpe - 1.96 * Math.sqrt((1 + (metrics.sharpe ** 2) / 2) / metrics.trades)).toFixed(3))
    : null;

  const lcbOk = (sharpeLcb ?? -99) > C.MIN_SHARPE_LCB;

  // Denominator for the per-regime comparison. The runner always passes this
  // explicitly; the fallback is the protocol's own starting equity, because a
  // silently-invented denominator here would make the criterion unfalsifiable.
  //
  // THE POPULATION MUST MATCH ON BOTH SIDES, and this is a computation fix, not
  // a threshold change. `pooledEquity = eqBase * N` is right for the strategy
  // side: `regimes[reg].pnl` is POOLED, and every symbol that did not trade in
  // the regime contributes 0 to the numerator, so dividing by all N makes it an
  // equal-weight mean over the whole book. The benchmark side is
  // `benchByRegime[reg].returnPct` — the mean of the N per-symbol COMPOUNDED
  // buy-and-hold paths. evidence.mjs pads a symbol that has no bars in a regime
  // with a flat 1.0x path so its divisor is N too, not "the number of symbols
  // where the regime was observed". Same N, same equity units, both equal
  // weight; the `> hold` test below is a comparison of two equal-weight books.
  //
  // It was NOT the same N before. `benchmarkPerRegime` only returns keys for
  // regimes present in its `labels` set, and evidence.mjs only pushed a sleeve
  // for regimes that appeared, so a symbol missing a regime contributed nothing
  // and the benchmark's divisor was that symbol's absence — invisible on the
  // current 5/5 data, and wrong for any symbol set that is not perfectly
  // balanced. An earlier version of this comment described the padding as
  // something `benchmarkPerRegime` already did; it did not, and does not.
  const eqBase = initialEquity ?? 1000;
  const nSymbols = Math.max(1, symbolCount ?? 1);
  const pooledEquity = eqBase * nSymbols;

  const checks = [
    ["trade count",      metrics.trades,            `>= ${C.MIN_TRADES}`,  metrics.trades >= C.MIN_TRADES],
    ["sharpe t-stat",    tstat,                     `> ${C.MIN_TSTAT}`,    (tstat ?? -99) > C.MIN_TSTAT],
    ["sharpe LCB (95%)", sharpeLcb,                 `> ${C.MIN_SHARPE_LCB}`, lcbOk],
    ["symbols tested",   symbolCount,                `>= ${C.MIN_SYMBOLS}`, symbolCount >= C.MIN_SYMBOLS],
    ["directional regimes traded",
      Object.entries(regimes).filter(([, r]) => r.trades > 0).length,
      `>= ${C.MIN_REGIMES}`,
      Object.entries(regimes).filter(([, r]) => r.trades > 0).length >= C.MIN_REGIMES],
    ["volatility regimes traded",
      Object.entries(volRegimes || {}).filter(([, r]) => r.trades > 0).length,
      `>= ${C.MIN_VOL_REGIMES}`,
      Object.entries(volRegimes || {}).filter(([, r]) => r.trades > 0).length >= C.MIN_VOL_REGIMES],
    ["profit factor",    metrics.profitFactor,      `> ${C.MIN_PF}`,      Number(metrics.profitFactor) > C.MIN_PF],
    ["sharpe",           metrics.sharpe,            `> ${C.MIN_SHARPE}`,  Number(metrics.sharpe) > C.MIN_SHARPE],
    ["max drawdown %",   metrics.maxDrawdownPct,    `< ${C.MAX_DD}`,      metrics.maxDrawdownPct < C.MAX_DD],
    ["walk-forward consistency %", wf.consistency,  `>= ${C.MIN_WF}`,     (wf.consistency ?? 0) >= C.MIN_WF],
    // A strategy with no opinion for an out-of-sample fold must not be able to
    // score 100% consistency across the folds that did fire. harness.walkForward
    // now divides by every fold (a silent fold counts as non-profitable) and
    // reports foldCoveragePct; this criterion fails the strategy outright rather
    // than letting a 3-of-4 result clear the >= 50 consistency bar. Mirrors
    // MIN_WF_COVERAGE in protocol.v2.json. Verified: a signal trading 3 of 4
    // folds reports consistency 75 (which still clears MIN_WF=50) and coverage
    // 75, so only this criterion catches it.
    ["walk-forward fold coverage %", wf.foldCoveragePct, `>= ${C.MIN_WF_COVERAGE}`,
      (wf.foldCoveragePct ?? 0) >= C.MIN_WF_COVERAGE],
    ["P(dd breach) %",   mc.probabilityOfBreachingThreshold, `< ${C.MAX_MC_BREACH}`, mc.probabilityOfBreachingThreshold < C.MAX_MC_BREACH],
  ];

  // --- out-of-sample
  if (holdout && holdout.ok) {
    checks.push(["holdout trades",  holdout.test.trades, `>= ${C.MIN_TEST_TRADES}`, holdout.test.trades >= C.MIN_TEST_TRADES]);
    checks.push(["holdout sharpe",  holdout.test.sharpe, `> ${C.MIN_TEST_SHARPE}`, (holdout.test.sharpe ?? -99) > C.MIN_TEST_SHARPE]);
    checks.push(["holdout not ruined", holdout.testRuin ? "RUINED" : "ok", "survived", !holdout.testRuin]);
    checks.push(["degradation test/train", holdout.degradation, `>= ${C.MIN_DEGRADATION}`,
                 (holdout.degradation ?? -99) >= C.MIN_DEGRADATION]);
  } else {
    checks.push(["holdout performed", holdout?.reason ?? "missing", "required", false]);
  }

  // --- parameter sensitivity
  if (holdout && holdout.ok) {
    checks.push(["parameter sensitivity", holdout.sensitivity, `>= ${C.MIN_SENSITIVITY}`,
                 holdout.sensitivity >= C.MIN_SENSITIVITY]);
  }

  // --- cost stress
  if (stress) {
    checks.push(["cost survival rate %", Number((stress.survivalRate * 100).toFixed(1)), `>= ${C.MIN_COST_SURVIVAL * 100}`,
                 stress.survivalRate >= C.MIN_COST_SURVIVAL]);
    const maxCost = stress.maxSurvivableFeeBps != null
      ? Number((stress.maxSurvivableFeeBps + stress.maxSurvivableSlippageBps).toFixed(1)) : 0;
    checks.push(["max survivable cost (fee+slip bps)", maxCost, `>= ${C.MIN_COST_BPS}`, maxCost >= C.MIN_COST_BPS]);
  } else {
    checks.push(["cost stress performed", "missing", "required", false]);
  }

  // --- data leakage is disqualifying: a leaking result is not a result
  if (!leakagePass) checks.push(["no data leakage (future/warmup/whole-sample)", "LEAK DETECTED", "clean", false]);
  // Soft: recorded, never silently dropped, but not a hard disqualifier.
  for (const a of (leakageAdvisories || [])) {
    checks.push([`ADVISORY no calendar dependence (${a.check})`, a.detail, "review by hand", true]);
  }

  // --- risk-adjusted, regime-matched benchmark
  //
  // BOTH SIDES OF THIS DIVISION ARE THE SAME BOOK.
  //
  // `metrics` is `evidence.agg`, and both numbers below are read off the ONE
  // equal-weight book curve that evidence.mjs builds by averaging the N symbol
  // equity curves pointwise (see `equalWeightBook` in this file):
  //
  //   metrics.totalReturnPct    the book curve's final/initial - 1, which is
  //                             exactly the MEAN of the N per-symbol returns
  //   metrics.maxDrawdownPct   the book curve's own max drawdown, NOT the
  //                             worst single symbol
  //
  // They used to be a compounded 5x-geared numerator over a 1x single-symbol
  // denominator. Same falsifying book, opposite verdict: five symbols at +20%
  // with 15% drawdown scored 9.922 before and 1.333 now, against a hold
  // benchmark of 2.0.
  //
  // `bench.calmar` is built the same way in evidence.mjs from the averaged
  // buy-and-hold curve, so "> hold" is a comparison of like with like.
  const stratCalmar = metrics.maxDrawdownPct > 0
    ? metrics.totalReturnPct / metrics.maxDrawdownPct : null;
  const benchCalmar = bench?.calmar ?? null;
  checks.push(["calmar (return/drawdown)", stratCalmar?.toFixed(3) ?? "n/a",
    `> hold ${benchCalmar?.toFixed(3) ?? "n/a"}`,
    stratCalmar != null && benchCalmar != null && stratCalmar > benchCalmar]);

  /**
   * Per-regime: must beat HOLDING in every regime it trades.
   *
   * This previously read
   *
   *     const beat = bh.calmar == null ? r.pnl > 0 : (r.trades > 0 && r.pnl > 0);
   *
   * Both arms reduce to `r.pnl > 0`, so the check never compared against
   * holding at all — it only asked whether the strategy made any money. A
   * strategy making $1 per regime passed all three checks while buy-and-hold
   * returned +9999% in each. The name, the `expected` string and the README all
   * claimed a benchmark comparison; the code did none.
   *
   * The fix compares like with like. `regimes[reg].pnl` is a sum of money and
   * `bh.returnPct` is a percentage, so they cannot be subtracted directly. What
   * CAN be compared is the regime's return on the equity the book was exposed
   * to: the strategy's equal-weight regime return, against the benchmark's
   * equal-weight regime return for the same stretch. Both sides are
   * equal-weight over the SAME N symbols (see the `pooledEquity` comment
   * above), so this is a `>` between two numbers of the same kind and the same
   * population — the benchmark side being a COMPOUNDED path, because buy and
   * hold compounds, not a sum of one-bar returns. When the benchmark has
   * no drawdown in this regime (an equal-weight book that never fell below its
   * running peak), there is no risk-adjusted figure to compare, so the bar
   * degrades to "the strategy must be profitable there" — which is still a
   * real test, and is now labelled as what it is.
   */
  if (benchByRegime) {
    for (const [reg, r] of Object.entries(regimes)) {
      if (r.trades <= 0) continue;
      const bh = benchByRegime[reg];
      if (!bh) continue;
      if (bh.calmar == null) {
        // The equal-weight hold book had no drawdown in this regime: nothing to
        // compare risk-adjusted, so require profitability and SAY that is the
        // weaker bar being applied. (`calmar` is null exactly when the averaged
        // book path never closed below its running peak.)
        checks.push([`beats hold in ${reg} (no hold drawdown, profit required)`,
          `pnl ${r.pnl.toFixed(2)}`, "> 0", r.pnl > 0]);
        continue;
      }
      const stratReturn = r.pnl > 0 ? r.pnl / pooledEquity : null;
      const beat = stratReturn != null && stratReturn * 100 > bh.returnPct;
      checks.push([`beats hold in ${reg}`, `return ${stratReturn != null ? (stratReturn * 100).toFixed(2) + "%" : "n/a"}`,
        `> hold ${bh.returnPct}%`, beat]);
    }
  }

  // --- multiple market universes: a strategy must not pass by fitting one coin.
  // Each symbol gets a lightweight independent verdict. A strategy that only
  // works on DOGE has not found an edge, it has found a coincidence.
  if (perSymbol && perSymbol.length) {
    const assessed = perSymbol.map((s) => ({
      symbol: s.symbol,
      passed: !s.ruined && Number(s.profitFactor) > 1 && Number(s.sharpe) > 0,
      profitFactor: s.profitFactor, sharpe: s.sharpe, trades: s.trades, ruined: s.ruined,
    }));
    const passing = assessed.filter((a) => a.passed);
    const rate = passing.length / assessed.length;
    checks.push([`symbols passing on their own merits ${passing.length}/${assessed.length}`,
      Number((rate * 100).toFixed(0)), `>= ${C.MIN_SYMBOL_PASS_RATE * 100}%`,
      rate >= C.MIN_SYMBOL_PASS_RATE]);
    // A single-symbol survivor is a red flag even if the rate is fine.
    if (passing.length <= 1 && assessed.length > 1) {
      checks.push(["more than one symbol works", passing.length, ">= 2", false]);
    }
  }

  // A ruined account is disqualifying, regardless of how good the trade stats look.
  if (ruined || ruinSymbols > 0) {
    checks.push(["account survived (no ruin)", ruined ? "RUINED" : "ok", "survived", !ruined]);
    if (ruinSymbols > 0) checks.push(["symbols ruined", ruinSymbols, "0", ruinSymbols === 0]);
  }

  const failed = checks.filter((c) => !c[3]);
  return {
    passed: failed.length === 0,
    tstat, sharpeLcb,
    checks: checks.map(([name, actual, expected, ok]) => ({ name, actual, expected, ok })),
    failedCount: failed.length,
    failedNames: failed.map((c) => c[0]),
  };
}

// --------------------------------------------------------------- selftest
if (process.argv[1] && process.argv[1].endsWith("gate.mjs")) {
  let pass = 0, fail = 0;
  const check = (n, c, x = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); };
  console.log("gate.mjs selftest\n");

  const mk = (n, fn, vol = 0) => Array.from({ length: n }, (_, i) => {
    const c = fn(i);
    return { time: 1767225600 + i * 900, open: c, high: c + 1 + vol, low: c - 1 - vol, close: c, volume: 100 };
  });

  // --- two-axis regime labelling
  const bull = mk(600, (i) => 100 * Math.exp(i / 500));
  const bear = mk(600, (i) => 100 * Math.exp(-i / 500));
  const flat = mk(600, () => 100);
  const rB = labelRegimes(bull), rR = labelRegimes(bear), rF = labelRegimes(flat);
  const share = (a, v) => a.filter((x) => x === v).length / a.filter((x) => x != null).length;

  check("warmup bars unknown in BOTH axes",
        rB.directional.slice(0, 250).every((x) => x === null) &&
        rB.volatility.slice(0, 100).every((x) => x === null));
  check("rising series -> bull", share(rB.directional, "bull") > 0.8, `${(share(rB.directional,"bull")*100).toFixed(0)}%`);
  check("falling series -> bear", share(rR.directional, "bear") > 0.8, `${(share(rR.directional,"bear")*100).toFixed(0)}%`);
  check("flat series -> sideways", share(rF.directional, "sideways") > 0.8, `${(share(rF.directional,"sideways")*100).toFixed(0)}%`);

  // Volatility axis must actually vary on a volatile series
  const choppy = mk(600, (i) => 100 + Math.sin(i / 3) * 5 + (i % 97 === 0 ? 40 : 0));
  const rC = labelRegimes(choppy);
  check("volatility axis splits into high and low",
        share(rC.volatility, "high") > 0.05 && share(rC.volatility, "low") > 0.05,
        `high=${(share(rC.volatility,"high")*100).toFixed(0)}% low=${(share(rC.volatility,"low")*100).toFixed(0)}%`);
  check("volatility axis is INDEPENDENT of direction",
        rC.directional.some((x) => x === "sideways") && rC.volatility.some((x) => x === "high"));

  // --- regime-matched benchmark
  const bb = benchmarkPerRegime({ bars: bull, regimes: rB });
  check("a pure uptrend is 100% one regime", Object.keys(bb).length === 1, Object.keys(bb).join(","));
  check("benchmark reports calmar", bb[Object.keys(bb)[0]].calmar !== undefined);
  const bbC = benchmarkPerRegime({ bars: choppy, regimes: rC });
  check("a mixed series yields multiple benchmark regimes", Object.keys(bbC).length >= 2, Object.keys(bbC).join(","));

  // ==================================================================
  // REGRESSION: the regime benchmark COMPOUNDS, and it is this that the
  // `beats hold in <reg>` bar is measured against.
  //
  // The bar used to be a running SUM of one-bar returns,
  //     path[r][i] = path[r][i-1] + ret
  // which is not a return at all: buy and hold over n bars multiplies the
  // one-bar returns, it does not add them. On the cached 400d/15m 5-symbol
  // data that made the bull bar +0.88% where the compounded figure is
  // +630.63%, so the criterion was comparing a strategy against a number no
  // holder could earn — 6 of 11 archived strategies passed `beats hold in bull`
  // on it. Compounding is a computation fix; no threshold moved.
  {
    // +1%/bar for 500 bars, all one regime (long enough to clear the 200-bar
    // trend warmup). Sum says +500%; compound says 1.01^500 - 1 = 148.2% less
    // a little — they differ by a factor of three, which is the defect in one
    // line. The labels are supplied directly so the fixture tests the
    // arithmetic and not the labeller.
    const ramp = mk(500, (i) => 100 * Math.pow(1.01, i));
    const rRamp = { directional: new Array(500).fill("bull") };
    const bRamp = benchmarkPerRegime({ bars: ramp, regimes: rRamp });
    const got = bRamp.bull;
    const compounded = (Math.pow(1.01, 499) - 1) * 100;
    const summed = 499;
    check("a regime benchmark COMPOUNDS its one-bar returns, it does not sum them",
      Math.abs(got.returnPct - compounded) < 0.5 && Math.abs(got.returnPct - summed) > 50,
      `reported ${got.returnPct}% vs compounded ${compounded.toFixed(2)}% vs summed ${summed}%`);

    // A RECURRING regime must compound across the gap between legs. A per-index
    // `path[r][i-1] * (1 + ret)` resets to 1.0x at every leg boundary, which
    // reproduces the bug (measured 0.89% on the real data instead of 630.63%),
    // so the path has to hold flat across a gap rather than restart.
    //
    // Each leg contributes 100 compounding steps, not 99: the first in-regime
    // bar carries the return from the bar before it, which is how the real
    // regime path works. (`runs` is not asserted — a leg terminated by a
    // WARMUP/null bar is not counted by the diagnostics, which is pre-existing
    // behaviour of the leg counters and not what this check is about.)
    const L = 500;
    const legs = Array.from({ length: L }, (_, i) => {
      const c = 100 * Math.pow(1.01, i);
      return { time: 1767225600 + i * 900, open: c, high: c, low: c, close: c, volume: 100 };
    });
    // label bull for [200,300) and [400,500): two legs with a real gap between
    const dirTwo = new Array(L).fill(null);
    for (let i = 200; i < 300; i++) dirTwo[i] = "bull";
    for (let i = 400; i < 500; i++) dirTwo[i] = "bull";
    const bLegs = benchmarkPerRegime({ bars: legs, regimes: { directional: dirTwo } });
    const bullLegs = bLegs.bull;
    const bothLegs = (Math.pow(1.01, 200) - 1) * 100;      // 100 + 100 steps
    const onlyOneLeg = (Math.pow(1.01, 100) - 1) * 100;     // what a reset would report
    check("a RECURRING regime compounds across the gap between legs, not once per leg",
      bullLegs != null && Math.abs(bullLegs.returnPct - bothLegs) < 0.5
        && Math.abs(bullLegs.returnPct - onlyOneLeg) > 100,
      `reported ${bullLegs?.returnPct}% vs both legs ${bothLegs.toFixed(2)}% vs one leg only ${onlyOneLeg.toFixed(2)}%`);

    // The path must be flat-and-holding outside the regime, which is also what
    // makes its LAST element the regime's total return. `pathStats` reads
    // series[series.length-1]; a path that snapped back to 1.0 on out-of-regime
    // bars would report ~0 for any regime the sample did not end in.
    const pathTail = bullLegs?.path ?? [];
    check("the regime path HOLDS flat across a gap instead of snapping back to 1.0x",
      pathTail.length > 0 && Math.abs(pathTail[pathTail.length - 1] - (1 + bullLegs.returnPct / 100)) < 0.01,
      `last=${pathTail[pathTail.length - 1]?.toFixed(4)} (1 + returnPct/100 = ${(1 + bullLegs.returnPct / 100).toFixed(4)})`);
  }

  // ==================================================================
  // REGRESSION: the equal-weight book, and the calmar wrong-PASS it closes.
  //
  // The falsifying case, run end to end: five identical sleeves, each +20%
  // with a 15% drawdown, against a hold benchmark of calmar 2.0. Both
  // definitions below describe THE SAME BOOK. Only the return definition
  // differs, and the verdict flips on it.
  //
  //     geared:    (1.2^5 - 1) = 148.83%  /  15%  =  9.922  -> PASS
  //     equal-wt:  mean of five 20%s   =  20.00%  /  15%  =  1.333  -> FAIL
  //
  // The geared number is the return of a 5x-leveraged portfolio divided by a
  // 1x drawdown. It passed because the numbers had nothing to do with each
  // other. It only failed to change any recorded verdict because every
  // strategy in the repo is a catastrophic loser.
  {
    const sleeves = Array.from({ length: 5 }, () => {
      const s = [];
      for (let i = 0; i <= 20; i++) s.push(1000);
      s[10] = 850;                                   // 1000 -> 850 is a 15% dip
      for (let i = 11; i <= 20; i++) s[i] = 900 + (i - 10) * 30;   // recover to 1200
      s[20] = 1200;                                  // +20% total
      return s;
    });
    const bookSt = equalWeightBook(sleeves, { base: 1000 });
    check("the equal-weight book return is the MEAN of the sleeve returns, not their product",
      bookSt.totalReturnPct === 20, `${bookSt.totalReturnPct}% (geared would be ${Number(((Math.pow(1.2, 5) - 1) * 100).toFixed(2))}%)`);
    check("the equal-weight book drawdown is the AVERAGED curve's, not the worst sleeve's",
      Math.abs(bookSt.maxDrawdownPct - 15) < 0.01, `${bookSt.maxDrawdownPct}%`);
    check("numerator and denominator come off the SAME curve (calmar = 20/15)",
      Math.abs(bookSt.calmar - 20 / 15) < 0.001, `calmar ${bookSt.calmar}`);

    // The gate is handed exactly what evidence.mjs now builds.
    const bookMetrics = { trades: 900, profitFactor: 1.8, sharpe: 1.6, maxDrawdownPct: bookSt.maxDrawdownPct, totalReturnPct: bookSt.totalReturnPct };
    const base = {
      metrics: bookMetrics,
      mc: { probabilityOfBreachingThreshold: 6 }, wf: { consistency: 80, foldCoveragePct: 100 },
      regimes: { bull: { trades: 300, pnl: 3000 }, bear: { trades: 300, pnl: 2000 }, sideways: { trades: 300, pnl: 2500 } },
      volRegimes: { high: { trades: 400, pnl: 40 }, low: { trades: 500, pnl: 37 } },
      bench: { calmar: 2.0 },
      benchByRegime: { bull: { calmar: 1.0, returnPct: 50 }, bear: { calmar: 1.0, returnPct: -5 }, sideways: { calmar: 0.5, returnPct: 2 } },
      symbolCount: 5,
      holdout: { ok: true, test: { trades: 300, sharpe: 1.1 }, testRuin: false, degradation: 0.7, sensitivity: 0.6 },
      stress: { survivalRate: 0.7, maxSurvivableFeeBps: 30, maxSurvivableSlippageBps: 15 },
      initialEquity: 1000,
    };
    const gBook = evaluateGate(base);
    check("five sleeves at +20% / 15% DD against hold calmar 2.0 now FAIL on calmar",
      gBook.failedNames.some((f) => /calmar/i.test(f)),
      `calmar ${(bookMetrics.totalReturnPct / bookMetrics.maxDrawdownPct).toFixed(3)} vs hold 2.000`);

    // And the geared construction, which is what used to run, PASSES. If this
    // ever stops being true the probe above has stopped testing anything.
    const geared = { ...base, metrics: { ...base.metrics, totalReturnPct: Number(((Math.pow(1.2, 5) - 1) * 100).toFixed(2)) } };
    const gGeared = evaluateGate(geared);
    check("the 5x-geared construction of the SAME book PASSES (this is the wrong-PASS)",
      !gGeared.failedNames.some((f) => /calmar/i.test(f)),
      `calmar ${(geared.metrics.totalReturnPct / geared.metrics.maxDrawdownPct).toFixed(3)} vs hold 2.000`);

    // A book is never deeper than its worst component — the property that makes
    // the equal-weight drawdown the honest one.
    const lopsided = [
      [1000, 1000, 1000, 1000, 1000, 500, 1000],
      [1000, 1000, 1000, 1000, 1000, 1000, 1200],
    ];
    check("a book is never deeper than its worst sleeve",
      equalWeightBook(lopsided, { base: 1000 }).maxDrawdownPct <= 50,
      `book ${equalWeightBook(lopsided, { base: 1000 }).maxDrawdownPct}% vs worst sleeve 50%`);

    // A sleeve that stops reporting (a ruined account) keeps its capital in the
    // book rather than being deleted from the average.
    const carried = equalWeightBook([[1000, 1000, 400, 400, 400, 400], [1000, 1000, 1000, 1000, 1000, 1200]], { base: 1000 });
    check("a ruined sleeve's capital stays in the book (forward-filled, not dropped)",
      carried.final === 800, `book ends at ${carried.final} (a dropped sleeve would say 1100)`);
  }

  // --- gate verdicts
  // --- baseline "good" evidence, including the new holdout/stress results
  //
  // The per-regime P&L has to be consistent with the benchmark it is compared
  // against, IN THE SAME UNITS. `regimes[*].pnl` is pooled over all 5 symbols
  // and the denominator is 5 x 1000, so 3000 is 60%, 2000 is 40% and 2500 is
  // 50% — beating benchmarks of 50%, -5% and 2%. The original fixture used
  // 40/25/12 against benchmarks of 50/-5/2, which only passed because the
  // criterion compared against nothing at all.
  const good = {
    metrics: { trades: 900, profitFactor: 1.8, sharpe: 1.6, maxDrawdownPct: 18, totalReturnPct: 70 },
    mc: { probabilityOfBreachingThreshold: 6 }, wf: { consistency: 80, foldCoveragePct: 100 },
    regimes: { bull: { trades: 300, pnl: 3000 }, bear: { trades: 300, pnl: 2000 }, sideways: { trades: 300, pnl: 2500 } },
    volRegimes: { high: { trades: 400, pnl: 40 }, low: { trades: 500, pnl: 37 } },
    bench: { calmar: 1.0 },
    benchByRegime: { bull: { calmar: 1.0, returnPct: 50 }, bear: { calmar: 1.0, returnPct: -5 }, sideways: { calmar: 0.5, returnPct: 2 } },
    symbolCount: 5,
    holdout: { ok: true, test: { trades: 300, sharpe: 1.1 }, testRuin: false, degradation: 0.7, sensitivity: 0.6 },
    stress: { survivalRate: 0.7, maxSurvivableFeeBps: 30, maxSurvivableSlippageBps: 15 },
    initialEquity: 1000,
  };
  const g0 = evaluateGate(good);
  check("strong evidence PASSES", g0.passed === true, g0.failedNames.join("; "));
  check("  ...and reports a t-stat", typeof g0.tstat === "number", `t=${g0.tstat}`);

  // --- the headline false positive: few trades, high Sharpe
  const fewBig = { ...good, metrics: { trades: 20, profitFactor: 3.0, sharpe: 3.0, maxDrawdownPct: 8, totalReturnPct: 40 } };
  const fb = evaluateGate(fewBig);
  check("20 trades at Sharpe 3.0 FAILS", fb.passed === false);
  check("  ...on trade count (it IS significant, just tiny)",
        fb.failedNames.includes("trade count"), `n=20 < ${CRITERIA.MIN_TRADES}`);
  check("  ...its LCB shows how uncertain the estimate is",
        (fb.sharpeLcb ?? 9) < fewBig.metrics.sharpe, `LCB ${fb.sharpeLcb} vs point ${fewBig.metrics.sharpe}`);

  // 1000 trades at Sharpe 1.2 should be trusted where the above is not
  const manySmall = { ...good, metrics: { trades: 1000, profitFactor: 1.4, sharpe: 1.2, maxDrawdownPct: 15, totalReturnPct: 40 } };
  const ms = evaluateGate(manySmall);
  check("1000 trades at Sharpe 1.2 clears the t-stat", (ms.tstat ?? 0) > CRITERIA.MIN_TSTAT, `t=${ms.tstat}`);

  // --- holdout gates
  check("a failed holdout FAILS", evaluateGate({ ...good, holdout: { ok: true, test: { trades: 300, sharpe: -0.2 }, testRuin: false, degradation: 0.05, sensitivity: 0.6 } }).passed === false);
  check("  ...specifically on holdout sharpe",
        evaluateGate({ ...good, holdout: { ok: true, test: { trades: 300, sharpe: -0.2 }, testRuin: false, degradation: 0.7, sensitivity: 0.6 } })
          .failedNames.some((f) => /holdout sharpe/i.test(f)));
  check("a holdout that ruins FAILS",
        evaluateGate({ ...good, holdout: { ok: true, test: { trades: 300, sharpe: 1.0 }, testRuin: true, degradation: 0.7, sensitivity: 0.6 } }).passed === false);
  check("a missing holdout FAILS", evaluateGate({ ...good, holdout: null }).passed === false);
  check("total in-sample degradation FAILS",
        evaluateGate({ ...good, holdout: { ok: true, test: { trades: 300, sharpe: 0.9 }, testRuin: false, degradation: 0.01, sensitivity: 0.6 } }).passed === false);

  // --- parameter sensitivity
  const narrow = evaluateGate({ ...good, holdout: { ...good.holdout, sensitivity: 0.05 } });
  check("a narrow parameter peak FAILS", narrow.passed === false);
  check("  ...specifically on sensitivity", narrow.failedNames.some((f) => /sensitivity/i.test(f)));
  check("a broad plateau PASSES sensitivity",
        evaluateGate({ ...good, holdout: { ...good.holdout, sensitivity: 0.8 } }).passed === true);

  // --- cost stress
  check("a strategy that dies at 2x cost FAILS",
        evaluateGate({ ...good, stress: { survivalRate: 0.11, maxSurvivableFeeBps: 10, maxSurvivableSlippageBps: 5 } }).passed === false);
  check("  ...specifically on cost survival",
        evaluateGate({ ...good, stress: { survivalRate: 0.11, maxSurvivableFeeBps: 10, maxSurvivableSlippageBps: 5 } })
          .failedNames.some((f) => /cost survival/i.test(f)));
  check("surviving only trivial costs FAILS the cost floor",
        evaluateGate({ ...good, stress: { survivalRate: 0.9, maxSurvivableFeeBps: 10, maxSurvivableSlippageBps: 5 } }).passed === false);
  check("a missing cost stress FAILS", evaluateGate({ ...good, stress: null }).passed === false);

  // --- walk-forward fold coverage (MIN_WF_COVERAGE)
  // The loophole this closes: consistency used to be scored only over the folds
  // that fired, so a strategy with no opinion for one fold of four reported 100.
  // harness.walkForward now divides by every fold, which turns that into 75 --
  // and 75 still clears MIN_WF=50. Only the coverage bar rejects it, so the bar
  // has to exist.
  const oneDeadFold = { ...good, wf: { consistency: 75, foldCoveragePct: 75, foldsSilent: 1 } };
  check("a strategy silent for one out-of-sample fold FAILS",
        evaluateGate(oneDeadFold).passed === false);
  check("  ...specifically on fold coverage, not on consistency",
        evaluateGate(oneDeadFold).failedNames.some((f) => /fold coverage/i.test(f)));
  check("  ...and consistency alone would have let it through (75 >= 50)",
        evaluateGate(oneDeadFold).failedNames.every((f) => !/consistency/i.test(f)));
  check("trading in every fold PASSES coverage",
        evaluateGate({ ...good, wf: { consistency: 75, foldCoveragePct: 100, foldsSilent: 0 } }).passed === true);
  check("partial coverage below the bar FAILS",
        evaluateGate({ ...good, wf: { consistency: 100, foldCoveragePct: 75 } }).passed === false);
  check("a missing coverage figure FAILS rather than defaulting to a pass",
        evaluateGate({ ...good, wf: { consistency: 100 } }).passed === false);

  // --- previously-established gates must still hold
  const weak = { ...good, metrics: { trades: 120, profitFactor: 1.1, sharpe: 0.3, maxDrawdownPct: 22, totalReturnPct: 5 },
                 mc: { probabilityOfBreachingThreshold: 40 }, wf: { consistency: 25 } };
  check("weak evidence FAILS", evaluateGate(weak).passed === false);
  check("single directional regime FAILS",
        evaluateGate({ ...good, regimes: { bull: { trades: 900, pnl: 90 }, bear: { trades: 0, pnl: 0 }, sideways: { trades: 0, pnl: 0 } } }).passed === false);
  check("single volatility regime FAILS",
        evaluateGate({ ...good, volRegimes: { high: { trades: 900, pnl: 70 }, low: { trades: 0, pnl: 0 } } }).passed === false);
  check("a ruined run FAILS", evaluateGate({ ...good, ruined: true }).passed === false);
  const worseDD = evaluateGate({ ...good, metrics: { ...good.metrics, maxDrawdownPct: 90, totalReturnPct: 71 } });
  check("same return with worse drawdown FAILS on calmar", worseDD.failedNames.some((f) => /calmar/i.test(f)));
  check("losing in a traded regime FAILS",
    evaluateGate({ ...good, regimes: { ...good.regimes, bear: { trades: 300, pnl: -50 } } }).passed === false);

  // --- REGRESSION: "beats hold in <reg>" used to compare against nothing.
  //
  // The old line was
  //     const beat = bh.calmar == null ? r.pnl > 0 : (r.trades > 0 && r.pnl > 0);
  // Both arms reduce to `r.pnl > 0`, so the criterion only asked "did the
  // strategy make any money", while its name, its `expected` string and the
  // README all claimed a comparison against buy-and-hold. The fixture below is
  // the false pass, verbatim: a strategy that makes $1 in every regime, against
  // a benchmark that returned +9999% in every regime. It passed before.
  {
    const richHold = {
      ...good,
      regimes: { bull: { trades: 300, pnl: 1 }, bear: { trades: 300, pnl: 1 }, sideways: { trades: 300, pnl: 1 } },
      benchByRegime: {
        bull: { calmar: 1.0, returnPct: 9999 }, bear: { calmar: 1.0, returnPct: 9999 },
        sideways: { calmar: 0.5, returnPct: 9999 },
      },
    };
    const g = evaluateGate(richHold);
    check("a $1 strategy does NOT beat a +9999% buy-and-hold", g.passed === false);
    check("  ...and it fails on the per-regime comparison specifically",
      g.failedNames.filter((f) => /beats hold/.test(f)).length === 3,
      g.failedNames.filter((f) => /beats hold/.test(f)).join("; "));

    // A strategy that genuinely out-earns holding in each regime still passes,
    // so the fix is a comparison and not a blanket tightening.
    const beatsHold = evaluateGate({
      ...good,
      regimes: { bull: { trades: 300, pnl: 900 }, bear: { trades: 300, pnl: 900 }, sideways: { trades: 300, pnl: 900 } },
      benchByRegime: {
        bull: { calmar: 1.0, returnPct: 5 }, bear: { calmar: 1.0, returnPct: 5 }, sideways: { calmar: 0.5, returnPct: 2 },
      },
    });
    check("a strategy that really does beat holding everywhere PASSES", beatsHold.passed === true,
      beatsHold.failedNames.join("; "));

    // A regime where the benchmark rose 50% and the strategy made 0.1% must fail.
    const nearMiss = evaluateGate({
      ...good,
      regimes: { ...good.regimes, bull: { trades: 300, pnl: 1 } },
      benchByRegime: { ...good.benchByRegime, bull: { calmar: 1.0, returnPct: 50 } },
    });
    check("profit of $1 against a 50% hold FAILS in that regime",
      nearMiss.failedNames.some((f) => /beats hold in bull/.test(f)));

    // The degenerate case: a benchmark regime with no drawdown has no
    // risk-adjusted figure to beat, so the bar must degrade to profitability
    // and the check must SAY so rather than silently pretending to compare.
    const noDd = evaluateGate({
      ...good,
      regimes: { bull: { trades: 300, pnl: -5 }, bear: { trades: 300, pnl: 40 }, sideways: { trades: 300, pnl: 40 } },
      benchByRegime: { bull: { calmar: null, returnPct: 80 }, bear: { calmar: 1.0, returnPct: 5 }, sideways: { calmar: 0.5, returnPct: 2 } },
    });
    check("a regime with no benchmark drawdown falls back to requiring profit",
      noDd.failedNames.some((f) => /no hold drawdown/.test(f)));
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
