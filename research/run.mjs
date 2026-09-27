#!/usr/bin/env node
/**
 * research.mjs — run a strategy across symbols and regimes, then hold it to
 * the gate in gate.mjs.
 *
 *   node research.mjs --strategy sweep-reversal --tf 15m
 *   node research.mjs --all
 *
 * This file cannot place an order: it imports data.mjs, harness.mjs (which
 * imports the pure risk-engine) and gate.mjs. paper-trade.mjs is never loaded.
 */

import { loadMany } from "./data.mjs";
import { simulate, metrics, monteCarlo, walkForward, holdoutEvaluate, costStress } from "./harness.mjs";
import { labelRegimes, regimeSummary, benchmark, benchmarkPerRegime, evaluateGate, CRITERIA } from "./gate.mjs";
import { PROTOCOL, datasetHash, strategyHash } from "./protocol.mjs";
import { record, currentState } from "./registry.mjs";
import { auditLeakage } from "./leakage.mjs";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "DOGEUSDT", "SOLUSDT", "ZECUSDT"];

const arg = (argv, f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

// Bars per day, derived from the timeframe.
//
// The cap used to be a flat `days * 100`, which is only correct for 15m
// (96 bars/day). At 1m a day is 1440 bars, so a "30d 1m" request asked for
// 43,200 bars and silently received 3,000 — about two days — while the cache
// file kept the full-range name. A short sample wearing a long sample's name
// is how a backtest ends up reporting an edge it never measured, so the cap
// is now computed from the timeframe and the span is verified below.
const TF_SECONDS = {
  "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
  "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400, "1w": 604800,
};

function barsPerDay(tf) {
  const secs = TF_SECONDS[tf];
  if (!secs) throw new Error(`unknown timeframe "${tf}" — add it to TF_SECONDS`);
  return 86400 / secs;
}

// Exported so the command centre in frontend/ can call a backtest in-process on
// a worker thread instead of parsing this file's stdout. Purely additive: the
// CLI block below is unchanged and still gates on the filename suffix.
export async function runOne({ strategy, tf, days, simCfg }) {
  const to = Math.floor(Date.parse(arg(process.argv, "--to", "2026-09-27T00:00:00Z")) / 1000);
  const from = to - days * 86400;

  console.error(`fetching ${SYMBOLS.length} symbols x ${tf} (${days}d)...`);
  // +10% so paging does not land a handful of bars short of the range.
  const limit = Math.ceil(days * barsPerDay(tf) * 1.1);
  const loaded = await loadMany({ symbols: SYMBOLS, tf, from, to, limit });
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
    barOffset += (bars[bars.length - 1].time - bars[0].time) + 900;
  }

  allTrades.sort((a, b) => a.time - b.time);

  // Trade-level metrics (win rate, PF, Sharpe, expectancy) are valid on the
  // POOLED trade set: each trade's P&L is independent of the others.
  const tradeMetrics = metrics({
    trades: allTrades,
    equityCurve: [{ equity: simCfg.equity }],   // drawdown from this is meaningless
    initialEquity: simCfg.equity,
  });

  // Drawdown and return are PATH properties and must NOT be pooled across
  // symbols — concatenating independent curves fabricates enormous drawdowns
  // from the jump between one symbol's ending equity and the next's start.
  // So: take the WORST per-symbol drawdown, and compound the per-symbol returns.
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
  // Walk-forward over the pooled, time-ordered trade stream.
  const fold = Math.max(1, Math.floor(allTrades.length / 4));
  const wfFolds = [];
  for (let f = 0; f < 4; f++) {
    const seg = allTrades.slice(f * fold, (f + 1) * fold);
    if (!seg.length) continue;
    const pnl = seg.reduce((a, t) => a + t.pnl, 0);
    const startEq = simCfg.equity;
    wfFolds.push({ fold: f + 1, trades: seg.length, totalReturnPct: Number(((pnl / startEq) * 100).toFixed(2)) });
  }
  const wf = {
    folds: wfFolds.length, perFold: wfFolds,
    foldsProfitable: wfFolds.filter((f) => f.totalReturnPct > 0).length,
    consistency: wfFolds.length
      ? Number(((wfFolds.filter((f) => f.totalReturnPct > 0).length / wfFolds.length) * 100).toFixed(1))
      : null,
    caveat: "folds partition the pooled trade stream by time, per symbol",
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
  const verdict = evaluateGate({ metrics: agg, mc, wf, regimes, volRegimes, bench,
                                 benchByRegime, symbolCount: ok.length,
                                 ruined: ruinSymbols > 0, ruinSymbols, holdout, stress, perSymbol,
                                 leakagePass: leakage.pass, leakageAdvisories: leakage.advisoryDetail });

  // --- record the run (champion / challenger ledger)
  const recordEntry = record({
    strategyId: strategy, version: Number(arg(process.argv, "--version", 1)),
    protocolHash: PROTOCOL.protocol_hash,
    datasetHash: datasetHash(ok[0].data.bars),
    strategyHash: strategyHash(String(mod.default)),
    metrics: agg, verdict: { ...verdict, tstat: verdict.tstat, sharpeLcb: verdict.sharpeLcb },
    notes: `${days}d ${tf} across ${ok.length} symbols; leakage ${leakage.pass ? "clean" : "FAILED"}`,
  });

  return {
    strategy, tf, days,
    run: recordEntry,
    registry: currentState(PROTOCOL.protocol_hash),
    protocol: { id: PROTOCOL.protocol, hash: PROTOCOL.protocol_hash },
    data: { symbols: ok.map((d) => d.symbol), barsPerSymbol: ok[0].data.bars.length, totalBars: ok.reduce((a, d) => a + d.data.bars.length, 0) },
    perSymbol, aggregate: agg, regimes, volRegimes, benchmark: bench, benchmarkByRegime: benchByRegime,
    monteCarlo: mc, walkForward: wf, holdout, stress, leakage,
    criteria: CRITERIA, verdict,
  };
}

function report(r) {
  console.log(JSON.stringify(r, null, 2));
  const v = r.verdict;
  console.log(`\n=== ${r.strategy} @ ${r.tf} :: ${v.passed ? "PASSES GATE" : "FAILS GATE"} (${v.failedCount} unmet) ===\n`);
  for (const c of v.checks) {
    console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(34)} ${String(c.actual).padEnd(12)} ${c.expected}`);
  }
  console.log(`\n  regimes traded: bull=${r.regimes.bull.trades} bear=${r.regimes.bear.trades} sideways=${r.regimes.sideways.trades}`);
  console.log(`  benchmark buy&hold: ${r.benchmark.totalReturnPct}%  vs strategy ${r.aggregate.totalReturnPct}%`);
  if (r.holdout && r.holdout.ok) console.log(`  holdout: test sharpe ${r.holdout.test.sharpe} over ${r.holdout.test.trades} trades, degradation ${r.holdout.degradation}, sensitivity ${r.holdout.sensitivity}`);
  if (r.stress) console.log(`  cost stress: survived ${r.stress.survived}/${r.stress.of} cost levels, max ${r.stress.maxSurvivableFeeBps ?? 0}+${r.stress.maxSurvivableSlippageBps ?? 0} bps`);
  if (!v.passed) {
    console.log(`\n  VERDICT: not an edge. Unmet: ${v.failedNames.join(", ")}`);
    if (r.aggregate.trades < CRITERIA.MIN_TRADES) console.log("  NOTE: under 500 trades - any apparent edge is unproven.");
  }
}

const argv = process.argv.slice(2);
if (process.argv[1] && process.argv[1].endsWith("run.mjs")) {
  const tf = arg(argv, "--tf", "15m");
  const days = Number(arg(argv, "--days", 400));
  const simCfg = { equity: Number(arg(argv, "--equity", 1000)), riskPct: Number(arg(argv, "--risk", 0.01)),
                 maxHoldBars: Number(arg(argv, "--hold", 96)), warmup: 250, ruinEquityPct: 0.2 };

  const todo = argv.includes("--all")
    ? ["long-with-stop", "sma-cross", "donchian", "sweep-reversal", "trend-pullback", "vol-expansion"]
    : [arg(argv, "--strategy", "sweep-reversal")];

  const out = [];
  for (const s of todo) {
    try {
      const r = await runOne({ strategy: s, tf, days, simCfg });
      out.push(r);
      if (todo.length === 1) report(r);
    } catch (e) {
      console.error(`${s}: ${e.message}`);
    }
  }

  if (out.length > 1) {
    console.log("\n=== SUMMARY (all strategies) ===");
    console.log("strategy            trades  win%    PF     Sharpe  maxDD%  ret%     wf%   GATE");
    for (const r of out) {
      const a = r.aggregate;
      console.log(
        `${r.strategy.padEnd(19)} ${String(a.trades).padEnd(7)} ${String(a.winRate).padEnd(7)} ` +
        `${String(a.profitFactor).padEnd(6)} ${String(a.sharpe).padEnd(7)} ${String(a.maxDrawdownPct).padEnd(7)} ` +
        `${String(a.totalReturnPct).padEnd(8)} ${String(r.walkForward.consistency).padEnd(5)} ${r.verdict.passed ? "PASS" : "fail"}`
      );
    }
    console.log(`\n  benchmark buy&hold: ${out[0].benchmark.totalReturnPct}%`);
    console.log("  gate requires: " + Object.entries(CRITERIA).map(([k, v2]) => `${k}=${v2}`).join(" "));
  }
}
