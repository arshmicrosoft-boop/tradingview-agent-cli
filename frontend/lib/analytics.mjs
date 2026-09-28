// Derived analytics over the repo's evidence files. Read-only: nothing in here
// writes to research/, config/ or strategies/.
//
// The distinction that matters throughout: runs.jsonl is EVIDENCE and carries a
// fixed 18-field summary, while verdict.checks (actual / expected / ok per
// criterion) only exists in a run's in-memory return value. So the 12 criteria
// the gate emits unconditionally can be reconstructed exactly from the summary's
// `failed[]` list, and everything conditional is reported as unknown rather than
// guessed. Run a backtest through the console and its full check list is cached
// in frontend/data/runs, which fills the rest in without inventing anything.

import fs from "node:fs";
import path from "node:path";
import { P, CACHE, readJson, readJsonl } from "./repo.mjs";

/** The criteria evaluateGate always emits, in gate order. A name absent from a
 *  run's `failed[]` therefore passed, and a name present in it failed. */
export const CORE_CHECKS = [
  "trade count",
  "sharpe t-stat",
  "sharpe LCB (95%)",
  "symbols tested",
  "directional regimes traded",
  "volatility regimes traded",
  "profit factor",
  "sharpe",
  "max drawdown %",
  "walk-forward consistency %",
  "P(dd breach) %",
];

/** Emitted conditionally. Rendered as pass/fail only when a cached full verdict
 *  exists; otherwise unknown. Order follows evaluateGate. */
export const CONDITIONAL_CHECKS = [
  "holdout trades",
  "holdout sharpe",
  "holdout not ruined",
  "degradation test/train",
  "holdout performed",
  "parameter sensitivity",
  "cost survival rate %",
  "max survivable cost (fee+slip bps)",
  "cost stress performed",
  "no data leakage (future/warmup/whole-sample)",
  "calmar (return/drawdown)",
  "beats hold in bull",
  "beats hold in bear",
  "beats hold in sideways",
  "symbols passing on their own merits",
  "more than one symbol works",
  "account survived (no ruin)",
  "symbols ruined",
];

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function runDir(strategyId) {
  return path.join(P.registryDir, strategyId);
}

export function latestRuns() {
  const out = [];
  let ids = [];
  try {
    ids = fs
      .readdirSync(P.registryDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((id) => fs.existsSync(path.join(runDir(id), "runs.jsonl")));
  } catch {
    return out;
  }
  for (const id of ids) {
    const rows = readJsonl(path.join(runDir(id), "runs.jsonl"));
    if (!rows.length) continue;
    const latest = rows[rows.length - 1];
    out.push({
      strategyId: id,
      runCount: rows.length,
      isControl: id.startsWith("_control"),
      latest,
      history: rows,
    });
  }
  return out.sort((a, b) => (b.latest.sharpe ?? -99) - (a.latest.sharpe ?? -99));
}

/** Every strategy that has code, whether or not it has ever been run. */
export function strategyCatalog() {
  let files = [];
  try {
    files = fs
      .readdirSync(P.strategyDir)
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => f.replace(/\.mjs$/, ""));
  } catch {
    return [];
  }
  const runs = new Map(latestRuns().map((r) => [r.strategyId, r]));
  return files.map((id) => {
    const r = runs.get(id);
    return {
      id,
      isControl: id.startsWith("_control"),
      runCount: r?.runCount ?? 0,
      everRun: Boolean(r),
      sharpe: r?.latest.sharpe ?? null,
      profitFactor: r?.latest.profit_factor ?? null,
    };
  });
}

/** Cached full run artifacts, newest last. Keyed by strategyId. */
export function cachedVerdicts() {
  const out = new Map();
  let files = [];
  try {
    files = fs.readdirSync(CACHE).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const doc = readJson(path.join(CACHE, f));
      if (!doc?.strategy || !doc?.verdict) continue;
      const prev = out.get(doc.strategy);
      if (!prev || (prev.ts ?? "") <= (doc.ts ?? "")) out.set(doc.strategy, doc);
    }
  } catch {
    /* no cache yet */
  }
  return out;
}

function checkState(name, failedSet, fullChecks) {
  if (fullChecks) {
    const hit = fullChecks.find((c) => c.name === name);
    if (hit) return hit;
  }
  if (CORE_CHECKS.includes(name)) {
    return { name, ok: !failedSet.has(name), actual: failedSet.has(name) ? "failed" : "passed", expected: "-", known: true };
  }
  return null;
}

export function buildHeatmap() {
  const cache = cachedVerdicts();
  const rows = latestRuns();
  const columns = [...CORE_CHECKS];

  const body = rows.map((r) => {
    const failedSet = new Set(r.latest.failed ?? []);
    const full = cache.get(r.strategyId)?.verdict?.checks ?? null;
    const cells = columns.map((name) => {
      const st = checkState(name, failedSet, full);
      return st ? { name, ok: st.ok, actual: st.actual, expected: st.expected, known: true } : { name, ok: null, known: false };
    });
    return {
      strategyId: r.strategyId,
      isControl: r.isControl,
      sharpe: r.latest.sharpe,
      profitFactor: r.latest.profit_factor,
      maxDrawdownPct: r.latest.max_drawdown_pct,
      passed: r.latest.passed,
      unmet: failedSet.size,
      ts: r.latest.ts,
      cells,
    };
  });

  // Extra criteria only some runs have detailed verdicts for.
  const extras = new Set();
  for (const [, doc] of cache) {
    for (const c of doc.verdict?.checks ?? []) if (!CORE_CHECKS.includes(c.name)) extras.add(c.name);
  }
  for (const r of rows) for (const n of r.latest.failed ?? []) if (!CORE_CHECKS.includes(n)) extras.add(n);

  const detail = {};
  for (const r of rows) {
    const failedSet = new Set(r.latest.failed ?? []);
    const full = cache.get(r.strategyId)?.verdict?.checks ?? null;
    const list = [];
    for (const c of full ?? []) {
      list.push({ name: c.name, ok: c.ok, actual: c.actual, expected: c.expected, known: true });
    }
    for (const name of CORE_CHECKS) {
      if (full?.some((c) => c.name === name)) continue;
      list.push({ name, ok: !failedSet.has(name), actual: failedSet.has(name) ? "failed" : "passed", expected: "-", known: true });
    }
    for (const name of failedSet) {
      if (list.some((c) => c.name === name)) continue;
      if (full?.some((c) => c.name === name)) continue;
      list.push({ name, ok: false, actual: "failed", expected: "-", known: true });
    }
    detail[r.strategyId] = list;
  }

  return {
    columns,
    extraColumns: [...extras],
    rows: body,
    detail,
    cachedVerdictCount: cache.size,
  };
}

export function protocol() {
  const doc = readJson(P.protocol);
  if (!doc) return null;
  return {
    ...doc,
    protocol_hash: doc.__hash ?? null,
    criteriaKeys: Object.keys(doc.criteria ?? {}),
  };
}

export function riskConfig() {
  return readJson(P.risk, {});
}

export function registryState() {
  return readJson(P.state, { champion: null, top_challengers: [], total_runs: 0 });
}

/** Normalise the six audit.jsonl record shapes into one row model. The file is
 *  append-only and its schema widened over time, so every field is optional. */
export function auditTrail(limit = 200) {
  const rows = readJsonl(P.audit);
  return rows
    .map((r) => ({
      time: r.time ?? null,
      action: r.action ?? "UNKNOWN",
      symbol: r.symbol ?? null,
      side: r.side ?? (r.action === "SELL" ? "sell" : r.action === "BUY" ? "buy" : null),
      qty: r.qty ?? null,
      type: r.type ?? null,
      gate: r.gate ?? null,
      gateCode: r.gate_code ?? null,
      gateDetail: r.gate_detail ?? null,
      approved: r.approved ?? null,
      result: r.result ?? null,
      reason: r.reason ?? null,
      thesis: r.thesis ?? null,
      price: num(r.price),
      atr: num(r.atr),
      engineQty: num(r.engine_qty),
      engineStop: num(r.engine_stop),
      engineNotional: num(r.engine_notional),
      bindingCap: r.binding_cap ?? null,
      raw: r,
    }))
    .slice(-limit)
    .reverse();
}

export function openOrdersFromAudit() {
  const rows = readJsonl(P.audit);
  const live = new Set();
  for (const r of rows) {
    if (r.action === "BUY" || r.action === "SELL") live.add(`${r.action}:${r.symbol}`);
    if (r.action === "CANCEL" || /FILLED_CLOSE|ORDER_CANCELLED/.test(r.result ?? "")) {
      live.delete(`${r.action === "CANCEL" ? "BUY" : r.action}:${r.symbol}`);
    }
  }
  return [...live];
}

/** Downsample an OHLCV cache file for the price chart. Reads the raw cache
 *  directly rather than going through data.mjs, which would re-validate and
 *  potentially refetch. */
export function priceSeries({ symbol, tf = "15m", points = 400 }) {
  let files = [];
  try {
    files = fs.readdirSync(P.dataDir).filter((f) => f.startsWith(`binance-${symbol}-${tf}`) && f.endsWith(".json"));
  } catch {
    return null;
  }
  if (!files.length) return null;
  // Prefer the file with the widest span (the one with from-to in its name).
  files.sort((a, b) => b.length - a.length);
  const doc = readJson(path.join(P.dataDir, files[0]));
  const bars = doc?.bars ?? [];
  if (!bars.length) return null;
  const step = Math.max(1, Math.floor(bars.length / points));
  const out = [];
  for (let i = 0; i < bars.length; i += step) {
    const b = bars[i];
    out.push({ t: b.time, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume });
  }
  const last = bars[bars.length - 1];
  if (out.length && out[out.length - 1].t !== last.time) {
    out.push({ t: last.time, o: last.open, h: last.high, l: last.low, c: last.close, v: last.volume });
  }
  return { symbol: doc.symbol ?? symbol, tf, source: files[0], totalBars: bars.length, gaps: (doc.gaps ?? []).length, bars: out };
}

export function datasetCoverage() {
  let files = [];
  try {
    files = fs.readdirSync(P.dataDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files
    .map((f) => {
      const doc = readJson(path.join(P.dataDir, f));
      if (!doc?.bars?.length) return null;
      const b = doc.bars;
      return {
        file: f,
        symbol: doc.symbol,
        tf: doc.tf,
        bars: b.length,
        from: b[0].time,
        to: b[b.length - 1].time,
        days: Number(((b[b.length - 1].time - b[0].time) / 86400).toFixed(1)),
        gaps: (doc.gaps ?? []).length,
        bytes: fs.statSync(path.join(P.dataDir, f)).size,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.tf.localeCompare(b.tf));
}
