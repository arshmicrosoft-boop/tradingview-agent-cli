#!/usr/bin/env node
/**
 * run.mjs — evaluate a strategy under the frozen v1 protocol, then record it.
 *
 *   node research/run.mjs --strategy sweep-reversal --tf 15m
 *   node research/run.mjs --all
 *
 * This file cannot place an order: it imports evidence.mjs, gate.mjs and
 * protocol.mjs. paper-trade.mjs is never loaded.
 *
 * Evidence gathering lives in evidence.mjs so that v1 and v2 judge the SAME
 * measurements. This file decides, records and reports — nothing else.
 */

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectEvidence, SYMBOLS, windowFor, simCfgFor } from "./evidence.mjs";
import { resolveExperiment, simCfgFromExperiment, experimentFingerprint } from "./experiment.mjs";
import { evaluateGate, CRITERIA } from "./gate.mjs";
import { PROTOCOL, datasetHash, universeHash, strategyHash } from "./protocol.mjs";
import { record, currentState } from "./registry.mjs";

const arg = (argv, f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

// The data window and simulator config live in evidence.mjs, shared with
// run-v2.mjs. They must not be restated here, or v1 and v2 could quietly
// evaluate different windows and the difference would look like a gate
// difference rather than the bug it is.
export const v1Window = windowFor;
export const v1SimCfg = simCfgFor;

/** Every strategy implementation on disk, from the directory rather than a list. */
export function allStrategyIds() {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "strategies");
  return readdirSync(dir).filter((f) => f.endsWith(".mjs")).map((f) => f.replace(/\.mjs$/, ""));
}

// Exported so the command centre in frontend/ can call a backtest in-process on
// a worker thread instead of parsing this file's stdout. Purely additive: the
// CLI block below is unchanged and still gates on the filename suffix.
export async function runOne({ strategy, tf, days, simCfg }) {
  const { to, from } = v1Window(days);
  console.error(`fetching ${SYMBOLS.length} symbols x ${tf} (${days}d)...`);

  const ev = await collectEvidence({ strategy, tf, days, simCfg, from, to });

  const verdict = evaluateGate({
    metrics: ev.agg, mc: ev.mc, wf: ev.wf, regimes: ev.regimes, volRegimes: ev.volRegimes,
    bench: ev.bench, benchByRegime: ev.benchByRegime, symbolCount: ev.symbolCount,
    ruined: ev.ruinSymbols > 0, ruinSymbols: ev.ruinSymbols, holdout: ev.holdout,
    stress: ev.stress, perSymbol: ev.perSymbol,
    leakagePass: ev.leakage.pass, leakageAdvisories: ev.leakage.advisoryDetail,
    initialEquity: ev.initialEquity,
  });

  const recordEntry = record({
    strategyId: strategy, version: Number(arg(process.argv, "--version", 1)),
    protocolHash: PROTOCOL.protocol_hash,
    // The dataset hash covers EVERY symbol loaded, not just the primary one.
    // It was `datasetHash(ev.primary)` — a single symbol — so dropping four of
    // five symbols left the hash unchanged, which is the same
    // unbound-input class this changeset is closing.
    datasetHash: universeHash(ev.loaded.map((d) => ({ symbol: d.symbol, bars: d.bars }))),
    strategyHash: strategyHash(String(ev.signal)),
    // What was actually run, not just what the protocol claims. If a future
    // unbound input appears, a record can no longer silently claim the
    // protocol it was not run under.
    experimentFingerprint: experimentFingerprint(resolveExperiment(process.argv.slice(2))),
    metrics: ev.agg, verdict,
    notes: `${days}d ${tf} across ${ev.symbolCount} symbols; leakage ${ev.leakage.pass ? "clean" : "FAILED"}`,
  });

  return {
    strategy, tf, days,
    run: recordEntry,
    registry: currentState(PROTOCOL.protocol_hash),
    protocol: { id: PROTOCOL.protocol, hash: PROTOCOL.protocol_hash },
    data: { symbols: ev.loaded.map((d) => d.symbol), barsPerSymbol: ev.loaded[0].bars, totalBars: ev.loaded.reduce((a, d) => a + d.bars, 0) },
    perSymbol: ev.perSymbol, aggregate: ev.agg, regimes: ev.regimes, volRegimes: ev.volRegimes,
    benchmark: ev.bench, benchmarkByRegime: ev.benchByRegime,
    monteCarlo: ev.mc, walkForward: ev.wf, walkForwardPooled: ev.wfPooled,
    holdout: ev.holdout, stress: ev.stress, leakage: ev.leakage,
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
  // The experiment is resolved from the protocol FIRST, before anything runs.
  // `resolveExperiment` throws if any flag departs from protocol.v1.json, so a
  // run cannot be produced that the protocol does not describe. tf/days/simCfg
  // are now read off the resolved experiment rather than defaulted here.
  const X = resolveExperiment(argv);
  const tf = X.timeframe;
  const days = X.period_days;
  const simCfg = simCfgFromExperiment(X);

  // The strategy list is read from disk, not hardcoded. The literal list
  // omitted `ma-cross-bb-flip`, which has a strategy file, records in both
  // archives, and no card — so `npm run research:all` could never clear its
  // staleness, and nothing reported the gap. run-v2.mjs already did this.
  const todo = argv.includes("--all")
    ? allStrategyIds()
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
