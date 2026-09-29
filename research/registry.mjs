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

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, rmSync } from "node:fs";
import { seal, verifyChain } from "./chain.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Two archives, one per protocol generation.
 *
 *   v1 -> research/registry/       the only archive the 15 cards cite
 *   v2 -> research/registry-v2/    its own results, never mixed with v1
 *
 * This is `strategies/README.md`'s rule made mechanical: "it runs as a separate
 * generation with its own results archive, never mixed with v1". Mixing them
 * would let a v2 run and a v1 run sit in one leaderboard, and they are not
 * comparable — a different protocol_hash is a different experiment.
 */
const ARCHIVES = {
  v1: join(HERE, "registry"),
  v2: join(HERE, "registry-v2"),
};

const REG = (archive) => {
  const dir = ARCHIVES[archive ?? "v1"];
  if (!dir) throw new Error(`unknown archive "${archive}" — use ${Object.keys(ARCHIVES).join(" or ")}`);
  return dir;
};

function ensure(dir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); return dir; }
function dirFor(id, archive) { return ensure(join(REG(archive), id)); }

function readJsonl(p) {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/** Record one evaluation. `archive` defaults to v1. */
export function record({ strategyId, version = 1, protocolHash, datasetHash, strategyHash, metrics, verdict, notes = "", archive = "v1" }) {
  const dir = dirFor(strategyId, archive);
  const entry = {
    ts: new Date().toISOString(),
    archive: archive ?? "v1",
    strategy_id: strategyId,
    version,
    protocol_hash: protocolHash,
    // WHAT THE HASH DOES NOT COVER, before you compare two records that share
    // one. It is computed over the protocol JSON only, so it is
    // tamper-evidence for THRESHOLDS and nothing else. The pipeline is outside
    // it, which means `total_return_pct`, `max_drawdown_pct` and every criterion
    // value in `failed_detail` can MOVE between two records on the SAME hash
    // without `npm run verify` noticing. Two records on one hash means "same
    // thresholds", NOT "same measurement". See the CRITERIA comment in
    // gate.mjs for the full statement; the archive already contains two
    // strategies with two records each on one hash and different failed lists.
    dataset_hash: datasetHash,
    strategy_hash: strategyHash,
    trades: metrics?.trades ?? null,
    profit_factor: metrics?.profitFactor ?? null,
    sharpe: metrics?.sharpe ?? null,
    // These two are the EQUAL-WEIGHT BOOK figures, both read off one averaged
    // equity curve: `total_return_pct` is the MEAN of the per-symbol returns
    // and `max_drawdown_pct` is the max drawdown of that same averaged curve.
    // They were, until the equal-weight rework, the compounded five-symbol
    // product and the worst single symbol respectively — the two halves of
    // different books, which is what the calmar wrong-PASS was built on. A
    // record written before that change and one written after are not
    // comparable even though the hash is the same.
    max_drawdown_pct: metrics?.maxDrawdownPct ?? null,
    total_return_pct: metrics?.totalReturnPct ?? null,
    tstat: verdict?.tstat ?? null,
    sharpe_lcb: verdict?.sharpeLcb ?? null,
    passed: !!verdict?.passed,
    failed: verdict?.failedNames ?? [],
    // Criterion VALUES, not just names.
    //
    // A drift check that diffs only `failed` cannot see a criterion whose value
    // changed while it kept failing either way — which is exactly what happened
    // here: rewiring the walk-forward criterion from the pooled splitter to the
    // self-tested `harness.walkForward` changed consistency from 25 to 0 on four
    // strategies, and the diff reported "no metric drift" because the recorded
    // fields are trades/PF/Sharpe/drawdown/return, none of which moved. Storing
    // the values means the next such change is visible without re-reading code.
    failed_detail: (verdict?.checks ?? [])
      .filter((c) => !c.ok)
      .map((c) => `${c.name}=${c.actual} (bar ${c.expected})`),
    notes,
  };
  // Seal the record into the strategy's hash chain before writing. See
  // research/chain.mjs: each record carries rec_hash over its own body and
  // prev_hash over the record before it, anchored on the pre-chain history.
  // This is what makes an in-place edit of an archived line detectable — the
  // protocol hash covers thresholds, and nothing covered the numbers.
  const existing = readJsonl(join(dir, "runs.jsonl"));
  Object.assign(entry, seal(existing, entry));
  appendFileSync(join(dir, "runs.jsonl"), JSON.stringify(entry) + "\n");
  return entry;
}

export function runsFor(strategyId, archive = "v1") {
  return readJsonl(join(REG(archive), strategyId, "runs.jsonl"));
}

export function allStrategies(archive = "v1") {
  const root = REG(archive);
  if (!existsSync(root)) return [];
  return readdirSafe(root);
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
export function currentState(protocolHash, archive = "v1", { write = true } = {}) {
  ensure(REG(archive));
  const rows = [];
  for (const id of allStrategies(archive)) {
    for (const r of runsFor(id, archive)) rows.push({ ...r, strategy_id: id });
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
    archive: archive ?? "v1",
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
  // `write: false` is used by the selftest, which must not overwrite a real
  // leaderboard with a state derived from a deliberately wrong hash.
  if (write) writeFileSync(join(REG(archive), "state.json"), JSON.stringify(state, null, 2));
  return state;
}

if (process.argv[1] && process.argv[1].endsWith("registry.mjs")) {
  const { PROTOCOL, PROTOCOL_V2 } = await import("./protocol.mjs");
  const which = process.argv.includes("--v2") ? "v2" : "v1";
  const p = which === "v2" ? PROTOCOL_V2 : PROTOCOL;
  const state = currentState(p.protocol_hash, which);
  console.log(JSON.stringify(state, null, 2));
  if (!state.champion) {
    console.log("\n  NO CHAMPION. Nothing has passed the gate under " + p.protocol);
    console.log("  Every run so far is a rejected challenger.");
  }
}

// --------------------------------------------------------------- selftest
if (process.argv[1] && process.argv[1].endsWith("registry.mjs") && process.argv.includes("--selftest")) {
  let pass = 0, fail = 0;
  const check = (n, c, x = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); };
  console.log("registry.mjs selftest\n");

  // The v1 and v2 archives must not be able to see each other's runs. That is
  // the whole reason there are two directories: a v2 result must never appear
  // in a v1 leaderboard, or "best challenger" would rank incomparable numbers.
  const probe = "zz-selftest-probe";
  record({ strategyId: probe, protocolHash: "deadbeefdeadbeef", metrics: { trades: 1, profitFactor: 1, sharpe: 0, maxDrawdownPct: 0, totalReturnPct: 0 }, verdict: { passed: false, failedNames: [] }, archive: "v2" });
  check("a v2 run is invisible to the v1 archive", !allStrategies("v1").includes(probe));
  check("a v2 run is visible in the v2 archive", allStrategies("v2").includes(probe));
  check("record() defaults to the v1 archive", (() => {
    record({ strategyId: "zz-selftest-probe-v1", protocolHash: "deadbeefdeadbeef", metrics: {}, verdict: { passed: false, failedNames: [] } });
    return allStrategies("v1").includes("zz-selftest-probe-v1") && !allStrategies("v2").includes("zz-selftest-probe-v1");
  })());
  check("an unknown archive name is refused, not silently written to v1",
    (() => { try { record({ strategyId: "zz-x", archive: "v9" }); return false; } catch { return true; } })());
  check("a run under a different protocol hash is never a champion", (() => {
    // Read the archive without going through currentState(), which WRITES
    // state.json. The selftest must not overwrite the real v2 leaderboard with
    // a state computed for a hash that has no runs.
    const rows = allStrategies("v2").flatMap((id) => runsFor(id, "v2"));
    const s = currentState("0000000000000000", "v2", { write: false });
    return s.champion === null && s.runs_under_this_protocol === 0 && rows.length >= 1;
  })(), "queried under a hash that has no runs, without writing state.json");

  // Clean up the probes so a selftest run leaves no evidence behind.
  for (const a of ["v1", "v2"]) {
    for (const id of allStrategies(a)) {
      if (id.startsWith("zz-selftest-probe")) rmSync(join(ARCHIVES[a], id), { recursive: true, force: true });
    }
  }
  check("selftest probes are cleaned up",
    !allStrategies("v1").some((x) => x.startsWith("zz-")) && !allStrategies("v2").some((x) => x.startsWith("zz-")));

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
