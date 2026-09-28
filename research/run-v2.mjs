#!/usr/bin/env node
/**
 * run-v2.mjs — evaluate a strategy under the frozen v2 protocol.
 *
 *   node research/run-v2.mjs --strategy sma-cross --tf 15m
 *   node research/run-v2.mjs --all
 *
 * This file cannot place an order. It imports evidence.mjs, robustness.mjs,
 * gate.mjs, gate-v2.mjs and protocol.mjs. paper-trade.mjs is never loaded, and
 * there is no code path from here to TradingView.
 *
 * It reads the SAME evidence bundle v1 does (evidence.mjs) and applies the v2
 * verdict on top, so any difference between a v1 and a v2 verdict is a
 * difference in the GATE, never a difference in the data.
 *
 * Results go to research/registry-v2/. The 15 cards in strategies/ cite v1 runs
 * and are not rewritten: v2 informs the next hypothesis, it does not
 * retroactively alter falsified evidence.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { collectEvidence, windowFor, simCfgFor } from "./evidence.mjs";
import {
  anchoredWalkForward, bootstrapMonteCarlo, fillPerturbation, deflatedSharpe, slippageSweep,
  fractionalReturns,
} from "./robustness.mjs";
import { evaluateGateV2, CRITERIA_V2 } from "./gate-v2.mjs";
import { PROTOCOL, PROTOCOL_V2, datasetHash, strategyHash } from "./protocol.mjs";
import { record, currentState } from "./registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (argv, f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

/** Every strategy the repo knows how to run, from disk — never a hardcoded list. */
export function allStrategyIds() {
  const dir = join(HERE, "strategies");
  return readdirSync(dir).filter((f) => f.endsWith(".mjs")).map((f) => f.replace(/\.mjs$/, ""));
}

/**
 * How many hypotheses has this repo actually tried?
 *
 * The deflated Sharpe needs a trial count, and there are three defensible ones.
 * Reporting only the smallest would be the flattering choice, so all three are
 * reported and the LARGEST is used for the verdict:
 *
 *   cards        how many hypothesis cards exist          (the paper trail)
 *   strategies   how many strategies have run             (the distinct bets)
 *   variants     sum of every declared parameter grid    (the real search size)
 *
 * A strategy with no grid still consumed one evaluation, so it counts as 1.
 */
export async function countTrials() {
  const cardsFile = join(HERE, "..", "strategies", "registry.json");
  let cards = 0;
  try { cards = (JSON.parse(readFileSync(cardsFile, "utf8")).cards ?? []).length; } catch { cards = 0; }
  const ids = allStrategyIds();
  let variants = 0;
  const perStrategy = {};
  for (const id of ids) {
    const mod = await import(`./strategies/${id}.mjs`);
    const g = mod.grid;
    const n = g ? Object.values(g).reduce((a, arr) => a * arr.length, 1) : 1;
    perStrategy[id] = n;
    variants += n;
  }
  return { cards, strategies: ids.length, variants, perStrategy };
}

// Shared with run.mjs via evidence.mjs. See the note there: restating the
// window in both runners is the same drift risk evidence.mjs was created to
// remove, one layer up.
export const v2Window = windowFor;
export const v2SimCfg = simCfgFor;

export async function runV2({ strategy, tf, days, simCfg, from, to, trials }) {
  const T = trials ?? await countTrials();
  const R = PROTOCOL_V2.robustness;

  const ev = await collectEvidence({ strategy, tf, days, simCfg, from, to });

  // --- the five v2 robustness measurements
  const wf = anchoredWalkForward({
    bars: ev.primary, signal: ev.signal, cfg: { ...simCfg },
    grid: ev.grid || {}, folds: R.walk_forward.folds, warmup: R.walk_forward.warmup_bars,
    objective: R.walk_forward.objective,
  });

  const mc = bootstrapMonteCarlo({
    trades: ev.allTrades, initialEquity: ev.initialEquity,
    runs: R.bootstrap.runs, seed: R.bootstrap.seed, method: R.bootstrap.method,
    ddThresholdPct: PROTOCOL_V2.monte_carlo.dd_threshold_pct,
  });

  // Deflated against the LARGEST honest trial count, not the smallest.
  const nTrials = Math.max(T.variants, PROTOCOL_V2.robustness.deflated_sharpe.min_trials_floor);
  const { fracs } = fractionalReturns(ev.allTrades, ev.initialEquity);
  const dsr = deflatedSharpe({ sharpe: ev.agg.sharpe, trades: ev.agg.trades, nTrials, fracs });

  const fill = fillPerturbation({
    trades: ev.allTrades, initialEquity: ev.initialEquity, runs: R.bootstrap.runs,
    seed: R.bootstrap.seed, sizeJitterPct: R.fill_perturbation.size_jitter_pct,
    extraSlippageBps: R.fill_perturbation.extra_slippage_bps,
    ddThresholdPct: R.fill_perturbation.dd_threshold_pct, method: R.bootstrap.method,
  });

  const sweep = slippageSweep({
    bars: ev.primary, signal: ev.signal, cfg: { ...simCfg },
    baseFeeBps: PROTOCOL_V2.costs.fee_bps, baseSlipBps: PROTOCOL_V2.costs.slippage_bps,
    feeSteps: R.slippage_sweep.fee_steps_bps, slipSteps: R.slippage_sweep.slip_steps_bps,
    mode: R.slippage_sweep.mode,
  });

  const verdict = evaluateGateV2({
    evidence: ev,
    robustness: { wf, mc, dsr, fill },
  });

  const trialsReport = { ...T, usedForDeflation: nTrials };

  const recordEntry = record({
    strategyId: strategy, version: Number(arg(process.argv, "--version", 1)),
    protocolHash: PROTOCOL_V2.protocol_hash,
    datasetHash: datasetHash(ev.primary),
    strategyHash: strategyHash(String(ev.signal)),
    metrics: ev.agg, verdict, archive: "v2",
    notes: `${PROTOCOL_V2.protocol} ${days}d ${tf} across ${ev.symbolCount} symbols; `
      + `v1 ${verdict.v1Passed ? "pass" : "fail"} / v2 ${verdict.v2Passed ? "pass" : "fail"}; `
      + `trials ${trialsReport.usedForDeflation}; leakage ${ev.leakage.pass ? "clean" : "FAILED"}`,
  });

  return {
    strategy, tf, days, protocol: { id: PROTOCOL_V2.protocol, hash: PROTOCOL_V2.protocol_hash },
    v1Protocol: { id: PROTOCOL.protocol, hash: PROTOCOL.protocol_hash },
    run: recordEntry,
    registry: currentState(PROTOCOL_V2.protocol_hash, "v2"),
    data: { symbols: ev.loaded.map((d) => d.symbol), barsPerSymbol: ev.loaded[0].bars, totalBars: ev.loaded.reduce((a, d) => a + d.bars, 0) },
    aggregate: ev.agg, regimes: ev.regimes, volRegimes: ev.volRegimes,
    benchmark: ev.bench, benchmarkByRegime: ev.benchByRegime, perSymbol: ev.perSymbol,
    v1monteCarlo: ev.mc, v1walkForward: ev.wf, holdout: ev.holdout, stress: ev.stress, leakage: ev.leakage,
    robustness: { wf, mc, dsr, fill, sweep },
    trials: trialsReport,
    criteria: CRITERIA_V2, verdict,
  };
}

function report(r) {
  console.log(JSON.stringify(r, null, 2));
  const v = r.verdict;
  console.log(`\n=== ${r.strategy} @ ${r.tf} :: ${v.passed ? "PASSES G2" : "FAILS G2"} `
    + `(v1 ${v.v1Passed ? "pass" : `fail (${v.groups.v1.failedCount})`} / v2 ${v.v2Passed ? "pass" : `fail (${v.groups.v2.failedCount})`}) ===\n`);
  console.log("--- v1 group (frozen, unchanged thresholds) ---");
  for (const c of v.groups.v1.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(40)} ${String(c.actual).padEnd(14)} ${c.expected}`);
  console.log("--- v2 group (robustness) ---");
  for (const c of v.groups.v2.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(40)} ${String(c.actual).padEnd(14)} ${c.expected}`);
  const b = r.robustness;
  console.log(`\n  anchored WF: consistency ${b.wf.consistency}%, efficiency ${b.wf.efficiencyRatio}, mean OOS Sharpe ${b.wf.meanOosSharpe}, stationarity t ${b.wf.stationarityT}`);
  console.log(`  bootstrap (${b.mc.method}): P(profitable) ${b.mc.pProfitable}%, P(Sharpe>0) ${b.mc.pSharpePositive}%, Sharpe p05/p50/p95 ${b.mc.sharpeP05}/${b.mc.sharpeP50}/${b.mc.sharpeP95}`);
  console.log(`  deflated Sharpe: ${b.dsr.dsr} (observed ${b.dsr.sharpe} vs null max ${b.dsr.expectedMaxSharpe} over ${b.dsr.nTrials} trials; skew ${b.dsr.skewness}, kurtosis ${b.dsr.kurtosis})`);
  console.log(`  fill error: P(dd breach) ${b.fill.pBreach}%, p95 drawdown ${b.fill.maxDrawdownP95Pct}%`);
  console.log(`  slippage sweep (${b.sweep.mode}, ${b.sweep.points} points): break-even ${b.sweep.breakEvenRoundTripBps} bps round trip (base ${b.sweep.baseRoundTripBps} bps), ${b.sweep.profitable} profitable`);
  if (!v.passed) console.log(`\n  VERDICT: not an edge. Unmet: ${v.failedNames.join(", ")}`);
}

const argv = process.argv.slice(2);
if (process.argv[1] && process.argv[1].endsWith("run-v2.mjs")) {
  const tf = arg(argv, "--tf", "15m");
  const days = Number(arg(argv, "--days", 400));
  const simCfg = v2SimCfg(argv);
  const { from, to } = v2Window(days, argv);
  const trials = await countTrials();

  const todo = argv.includes("--all") ? allStrategyIds() : [arg(argv, "--strategy", "sma-cross")];
  console.error(`${PROTOCOL_V2.protocol} ${PROTOCOL_V2.protocol_hash} — trials counted: `
    + `${trials.cards} cards / ${trials.strategies} strategies / ${trials.variants} grid variants`);

  const out = [];
  for (const s of todo) {
    try {
      const r = await runV2({ strategy: s, tf, days, simCfg, from, to, trials });
      out.push(r);
      if (todo.length === 1) report(r);
    } catch (e) {
      console.error(`${s}: ${e.message}`);
    }
  }

  if (out.length > 1) {
    console.log("\n=== v2 SUMMARY ===");
    const cell = (x, w, d = 3) => {
      const s = x == null ? "n/a" : typeof x === "number" ? (Number.isFinite(x) ? x.toFixed(d) : "-") : String(x);
      return s.padEnd(w);
    };
    console.log(
      cell("strategy", 29) + cell("trades", 7, 0) + cell("PF", 7) + cell("Sharpe", 8)
      + cell("DSR", 8, 4) + cell("P(prof)", 9, 1) + cell("P(S>0)", 9, 1)
      + cell("wfCons", 8, 1) + cell("eff", 9) + cell("OOS-SR", 8) + "  G1    G2");
    for (const r of out) {
      const a = r.aggregate, b = r.robustness;
      console.log(
        cell(r.strategy, 29) + cell(a.trades, 7, 0) + cell(a.profitFactor, 7) + cell(a.sharpe, 8)
        + cell(b.dsr.dsr, 8, 4) + cell(b.mc.pProfitable, 9, 1) + cell(b.mc.pSharpePositive, 9, 1)
        + cell(b.wf.consistency, 8, 1) + cell(b.wf.efficiencyRatio, 9) + cell(b.wf.meanOosSharpe, 8)
        + "  " + (r.verdict.v1Passed ? "pass " : "fail ") + "  " + (r.verdict.v2Passed ? "pass" : "fail"));
    }
    console.log(`\n  v1 ${PROTOCOL.protocol} hash ${PROTOCOL.protocol_hash}  |  v2 ${PROTOCOL_V2.protocol} hash ${PROTOCOL_V2.protocol_hash}`);
    console.log(`  deflated Sharpe is computed against ${trials.variants} trials, the largest honest count.`);
    console.log(`  P(prof) / P(S>0) are percentages from the outcome bootstrap. eff is OOS/IS Sharpe retention,`);
    console.log(`  undefined when mean in-sample Sharpe is not positive. DSR is the deflated Sharpe ratio.`);
  }
}
