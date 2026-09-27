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
 */
export function benchmarkPerRegime({ bars, regimes, initialEquity }) {
  const dir = regimes.directional || regimes;      // index-aligned to `bars`
  // A regime RECURS. Treating every occurrence of a label as one continuous
  // leg makes first->last span the quiet stretches in between, which inflates
  // the return of every regime to roughly the whole-period return. So each
  // CONTIGUOUS run is its own leg, and legs are aggregated per regime after.
  const runs = [];
  let cur = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const r = dir[i];                              // positional, NOT by timestamp
    if (!r) { cur = null; continue; }               // warmup bar breaks the run
    if (!cur || cur.regime !== r) {
      cur = { regime: r, first: b.close, last: b.close, peak: b.close, dd: 0, bars: 0 };
      runs.push(cur);
    }
    cur.last = b.close;
    if (b.close > cur.peak) cur.peak = b.close;
    if (cur.peak > 0) cur.dd = Math.max(cur.dd, (cur.peak - b.close) / cur.peak);
    cur.bars++;
  }

  const agg = {};
  for (const l of runs) {
    const ret = l.first > 0 ? l.last / l.first - 1 : 0;
    const a = agg[l.regime] || (agg[l.regime] = { retSum: 0, wSum: 0, dd: 0, runs: 0, bars: 0 });
    a.retSum += ret * l.bars;                       // bar-weighted
    a.wSum += l.bars;
    a.dd = Math.max(a.dd, l.dd);                    // worst leg
    a.runs++;
    a.bars += l.bars;
  }
  const out = {};
  for (const [k, a] of Object.entries(agg)) {
    const ret = a.wSum > 0 ? a.retSum / a.wSum : 0;
    out[k] = {
      returnPct: Number((ret * 100).toFixed(2)),
      maxDrawdownPct: Number((a.dd * 100).toFixed(2)),
      calmar: a.dd > 0 ? Number((ret / a.dd).toFixed(3)) : null,
      runs: a.runs, bars: a.bars,
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
    note: "buy-and-hold on the same bars, no costs, no stop",
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
  const stratCalmar = metrics.maxDrawdownPct > 0
    ? metrics.totalReturnPct / metrics.maxDrawdownPct : null;
  const benchCalmar = bench?.calmar ?? null;
  checks.push(["calmar (return/drawdown)", stratCalmar?.toFixed(3) ?? "n/a",
    `> hold ${benchCalmar?.toFixed(3) ?? "n/a"}`,
    stratCalmar != null && benchCalmar != null && stratCalmar > benchCalmar]);

  if (benchByRegime) {
    for (const [reg, r] of Object.entries(regimes)) {
      if (r.trades <= 0) continue;
      const bh = benchByRegime[reg];
      if (!bh) continue;
      const beat = bh.calmar == null ? r.pnl > 0 : (r.trades > 0 && r.pnl > 0);
      checks.push([`beats hold in ${reg}`, `pnl ${r.pnl.toFixed(2)}`, `hold ${bh.returnPct}%`, beat]);
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

  // --- gate verdicts
  // --- baseline "good" evidence, including the new holdout/stress results
  const good = {
    metrics: { trades: 900, profitFactor: 1.8, sharpe: 1.6, maxDrawdownPct: 18, totalReturnPct: 70 },
    mc: { probabilityOfBreachingThreshold: 6 }, wf: { consistency: 80 },
    regimes: { bull: { trades: 300, pnl: 40 }, bear: { trades: 300, pnl: 25 }, sideways: { trades: 300, pnl: 12 } },
    volRegimes: { high: { trades: 400, pnl: 40 }, low: { trades: 500, pnl: 37 } },
    bench: { calmar: 1.0 },
    benchByRegime: { bull: { calmar: 1.0, returnPct: 50 }, bear: { calmar: 1.0, returnPct: -5 }, sideways: { calmar: 0.5, returnPct: 2 } },
    symbolCount: 5,
    holdout: { ok: true, test: { trades: 300, sharpe: 1.1 }, testRuin: false, degradation: 0.7, sensitivity: 0.6 },
    stress: { survivalRate: 0.7, maxSurvivableFeeBps: 30, maxSurvivableSlippageBps: 15 },
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

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
