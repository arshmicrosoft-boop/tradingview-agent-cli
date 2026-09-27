/**
 * registry.mjs — champion / challenger.
 *
 * Every evaluation run is recorded, whatever the outcome. The champion is the
 * best strategy that has actually PASSED the gate under the current protocol.
 * A challenger only replaces the champion by beating it under the SAME
 * protocol — a different protocol_hash is not a comparison, it is a different
 * experiment, and the record says so.
 *
 * Layout:  research/registry/<strategy_id>/runs.jsonl
 *          research/registry/state.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REG = join(HERE, "registry");

function ensure() { if (!existsSync(REG)) mkdirSync(REG, { recursive: true }); }
function dirFor(id) { const d = join(REG, id); if (!existsSync(d)) mkdirSync(d, { recursive: true }); return d; }

function readJsonl(p) {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/** Record one evaluation. */
export function record({ strategyId, version = 1, protocolHash, datasetHash, strategyHash, metrics, verdict, notes = "" }) {
  ensure();
  const entry = {
    ts: new Date().toISOString(),
    strategy_id: strategyId,
    version,
    protocol_hash: protocolHash,
    dataset_hash: datasetHash,
    strategy_hash: strategyHash,
    trades: metrics?.trades ?? null,
    profit_factor: metrics?.profitFactor ?? null,
    sharpe: metrics?.sharpe ?? null,
    max_drawdown_pct: metrics?.maxDrawdownPct ?? null,
    total_return_pct: metrics?.totalReturnPct ?? null,
    tstat: verdict?.tstat ?? null,
    sharpe_lcb: verdict?.sharpeLcb ?? null,
    passed: !!verdict?.passed,
    failed: verdict?.failedNames ?? [],
    notes,
  };
  appendFileSync(join(dirFor(strategyId), "runs.jsonl"), JSON.stringify(entry) + "\n");
  return entry;
}

export function runsFor(strategyId) {
  return readJsonl(join(REG, strategyId, "runs.jsonl"));
}

export function allStrategies() {
  if (!existsSync(REG)) return [];
  return readdirSafe(REG);
}
function readdirSafe(d) {
  try {
    return readdirSync(d).filter((e) => {
      try { return existsSync(join(d, e, "runs.jsonl")); } catch { return false; }
    });
  } catch { return []; }
}

/**
 * The champion is the best PASSING run under the CURRENT protocol hash.
 * Runs under a different protocol are kept for the record but are not
 * comparable, so they can never become champion.
 */
export function currentState(protocolHash) {
  ensure();
  const rows = [];
  for (const id of allStrategies()) {
    for (const r of runsFor(id)) rows.push({ ...r, strategy_id: id });
  }
  const comparable = rows.filter((r) => r.protocol_hash === protocolHash);
  const passing = comparable.filter((r) => r.passed);

  const rank = (r) => ({
    sharpe: Number(r.sharpe ?? -99),
    pf: Number(r.profit_factor ?? 0),
    trades: Number(r.trades ?? 0),
  });

  passing.sort((a, b) => {
    const A = rank(a), B = rank(b);
    if (B.sharpe !== A.sharpe) return B.sharpe - A.sharpe;
    if (B.pf !== A.pf) return B.pf - A.pf;
    return B.trades - A.trades;
  });

  const champion = passing[0] ?? null;
  const challengers = comparable
    .filter((r) => !r.passed)
    .sort((a, b) => Number(b.sharpe ?? -99) - Number(a.sharpe ?? -99));

  const state = {
    protocol_hash: protocolHash,
    champion: champion ? {
      strategy_id: champion.strategy_id, version: champion.version,
      sharpe: champion.sharpe, profit_factor: champion.profit_factor,
      trades: champion.trades, ts: champion.ts,
    } : null,
    top_challengers: challengers.slice(0, 5).map((r) => ({
      strategy_id: r.strategy_id, sharpe: r.sharpe, profit_factor: r.profit_factor,
      trades: r.trades, unmet: r.failed.length, ts: r.ts,
    })),
    total_runs: rows.length,
    runs_under_this_protocol: comparable.length,
    incomparable_runs: rows.length - comparable.length,
  };
  writeFileSync(join(REG, "state.json"), JSON.stringify(state, null, 2));
  return state;
}

if (process.argv[1] && process.argv[1].endsWith("registry.mjs")) {
  const { PROTOCOL } = await import("./protocol.mjs");
  const state = currentState(PROTOCOL.protocol_hash);
  console.log(JSON.stringify(state, null, 2));
  if (!state.champion) {
    console.log("\n  NO CHAMPION. Nothing has passed the gate under " + PROTOCOL.protocol);
    console.log("  Every run so far is a rejected challenger.");
  }
}
