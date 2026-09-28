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
 *     start. So drawdown is the WORST per symbol, and return COMPOUNDS per
 *     symbol.
 */

import { loadMany } from "./data.mjs";
import { simulate, metrics, monteCarlo, walkForward, holdoutEvaluate, costStress } from "./harness.mjs";
import { labelRegimes, regimeSummary, benchmarkPerRegime } from "./gate.mjs";
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
  const perSymbol = [];
  let barOffset = 0;
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
    // regime-matched benchmark on this symbol's own bars
    const bReg = benchmarkPerRegime({ bars, regimes: reg });
    for (const [k, v] of Object.entries(bReg)) {
      if (!benchByRegime[k]) benchByRegime[k] = { returnPct: 0, maxDrawdownPct: 0, calmar: 0, symbols: 0, bars: 0 };
      benchByRegime[k].returnPct += v.returnPct;
      benchByRegime[k].maxDrawdownPct = Math.max(benchByRegime[k].maxDrawdownPct, v.maxDrawdownPct);
      benchByRegime[k].bars += v.bars;
      benchByRegime[k].symbols++;
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

  let worstDD = 0;
  for (const p of perSymbolEquity) {
    for (const s of perSymbol) if (s.symbol === p.symbol && s.maxDrawdownPct > worstDD) worstDD = s.maxDrawdownPct;
  }
  let compound = 1;
  for (const s of perSymbol) compound *= 1 + s.totalReturnPct / 100;
  const agg = { ...tradeMetrics, maxDrawdownPct: Number(worstDD.toFixed(2)),
                totalReturnPct: Number(((compound - 1) * 100).toFixed(2)),
                note: "trade metrics pooled; drawdown = worst per symbol; return = compounded per symbol" };

  // Benchmark: equal-weight buy-and-hold across the same symbols.
  const legs = ok.map((d) => {
    const b = d.data.bars;
    return (b[b.length - 1].close / b[0].close - 1) / ok.length;
  });
  let peak = 1, dd = 0;
  for (const d of ok) {
    const b = d.data.bars;
    let p = b[0].close;
    for (const x of b) { if (x.close > p) p = x.close; if (p > 0) dd = Math.max(dd, (p - x.close) / p); }
  }
  const eqRet = legs.reduce((a, b) => a + b, 0);
  const bench = {
    totalReturnPct: Number((eqRet * 100).toFixed(2)),
    maxDrawdownPct: Number((dd * 100).toFixed(2)),
    calmar: dd > 0 ? Number((eqRet / dd).toFixed(3)) : null,
    note: "equal-weight buy-and-hold across the same symbols",
  };

  const mc = monteCarlo({ trades: allTrades, initialEquity: simCfg.equity, runs: 1000 });
  mc.note = "drawdown path statistics over shuffled orderings of the pooled trade set";

  // Walk-forward. The gate's MIN_WF criterion is fed by harness.walkForward(),
  // the implementation that is exported and self-tested.
  //
  // It used to be fed by an inline splitter here that cut the POOLED 5-symbol
  // trade stream into four equal-count chunks and scored each fold as
  // `summedPnl / 1000`. That is a sum of five accounts' P&L divided by one
  // account's equity — a nonsense percentage that happened to be used only for
  // its sign. Worse, the tested walkForward() was never called by the runner at
  // all, so the one implementation with tests and the one that decided the
  // verdict were different code.
  const wfPrimary = walkForward({ bars: ok[0].data.bars, signal, cfg: { ...simCfg } });

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
    caveat: "sign test on pooled multi-symbol P&L; not used for the verdict",
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
  for (const k of Object.keys(benchByRegime)) {
    const b = benchByRegime[k];
    b.returnPct = Number((b.returnPct / b.symbols).toFixed(2));
    b.calmar = b.maxDrawdownPct > 0 ? Number((b.returnPct / b.maxDrawdownPct).toFixed(3)) : null;
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
