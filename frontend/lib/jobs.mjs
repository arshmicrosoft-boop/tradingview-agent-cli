// Owns worker lifecycle and the backtest queue.
//
// One backtest at a time. Two of them would compete for the same CPU cores the
// SSE stream and any live chart paint need, and runOne appends to the shared
// runs.jsonl / rewrites state.json, so serialising also keeps the evidence file
// from being written by two processes at once.

import { Worker } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ROOT, CACHE, ensureCache } from "./repo.mjs";
import { publish } from "./sse.mjs";

const WORKER = path.join(ROOT, "frontend", "worker", "backtest-worker.mjs");
const DEFAULT_TO = "2026-09-27T00:00:00Z";
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "DOGEUSDT", "SOLUSDT", "ZECUSDT"];

const jobs = new Map();
let active = null;
let queue = [];

/** Cached equity curves, so revisiting a strategy does not re-simulate. */
const curveCache = new Map();

function emit(job, event, data) {
  job.events.push({ at: Date.now(), event, ...data });
  if (job.events.length > 400) job.events.splice(0, job.events.length - 400);
  publish("backtest", { id: job.id, job: job.job, event, ...data });
}

function spawn(job) {
  const worker = new Worker(WORKER, {
    workerData: { root: ROOT, symbols: SYMBOLS, to: job.to ?? DEFAULT_TO },
  });
  job.worker = worker;
  job.phase = "starting";
  job.startedAt = Date.now();

  worker.on("message", (msg) => {
    if (msg.type === "phase") {
      job.phase = msg.phase;
      job.elapsedMs = msg.elapsedMs;
      if (msg.detail) job.phaseDetail = msg.detail;
      emit(job, "phase", { phase: msg.phase, detail: msg.detail ?? null, elapsedMs: msg.elapsedMs });
    } else if (msg.type === "log") {
      job.logs.push(msg.line);
      if (job.logs.length > 500) job.logs.splice(0, job.logs.length - 500);
      emit(job, "log", { line: msg.line, elapsedMs: msg.elapsedMs });
    } else if (msg.type === "result") {
      job.result = msg.result;
      job.elapsedMs = msg.elapsedMs;
      job.status = "done";
      if (job.job === "run") cacheRunArtifact(job);
      finish(job);
    } else if (msg.type === "error") {
      job.status = "error";
      job.error = msg.message;
      job.elapsedMs = msg.elapsedMs;
      finish(job);
    }
  });

  worker.on("error", (err) => {
    job.status = "error";
    job.error = err.message;
    finish(job);
  });

  worker.on("exit", (code) => {
    if (job.status === "running") {
      job.status = code === 0 ? "done" : "error";
      if (code !== 0 && !job.error) job.error = `worker exited with code ${code}`;
    }
    finish(job);
  });

  worker.postMessage({ type: "run", job: job.job, payload: job.payload });
}

/** A full gated run's return value carries diagnostics that runs.jsonl does not
 *  (per-regime splits, walk-forward folds, Monte Carlo, cost stress, leakage,
 *  and the authoritative check list). Persist it so the detail view can render
 *  those without re-running. This is the console's own cache, not evidence. */
function cacheRunArtifact(job) {
  try {
    ensureCache();
    const r = job.result;
    const doc = {
      ts: new Date().toISOString(),
      strategy: r.strategy,
      tf: r.tf,
      days: r.days,
      run: r.run,
      aggregate: r.aggregate,
      perSymbol: r.perSymbol,
      regimes: r.regimes,
      volRegimes: r.volRegimes,
      benchmark: r.benchmark,
      benchmarkByRegime: r.benchmarkByRegime,
      monteCarlo: r.monteCarlo,
      walkForward: r.walkForward,
      holdout: r.holdout,
      stress: r.stress,
      leakage: r.leakage,
      criteria: r.criteria,
      verdict: r.verdict,
      data: r.data,
    };
    const file = path.join(CACHE, `${Date.now()}-${r.strategy}-${r.tf}.json`);
    fs.writeFileSync(file, JSON.stringify(doc));
    job.artifact = path.relative(ROOT, file);
  } catch (err) {
    emit(job, "log", { line: `artifact cache failed: ${err.message}` });
  }
}

function finish(job) {
  try {
    job.worker?.terminate();
  } catch {
    /* already gone */
  }
  job.worker = null;
  if (active === job) active = null;
  emit(job, job.status === "error" ? "failed" : job.status, { error: job.error ?? null, elapsedMs: job.elapsedMs });
  const next = queue.shift();
  if (next) {
    next.status = "running";
    spawn(next);
  } else {
    publish("backtest:idle", { at: Date.now() });
  }
}

export function submit({ job = "run", strategy, tf = "15m", days = 400, equity = 1000, riskPct = 0.01, maxHoldBars = 96, to, force = false }) {
  if (!strategy || !/^[\w.-]+$/.test(strategy)) throw new Error("invalid strategy id");

  if (job === "equity") {
    const key = `${strategy}|${tf}|${days}|${equity}|${riskPct}|${maxHoldBars}`;
    if (!force && curveCache.has(key)) return { ...curveCache.get(key), cached: true };
    if (active?.job === "equity" && active.payload.strategy === strategy) return { id: active.id, queued: false };
  }

  const rec = {
    id: randomUUID().slice(0, 8),
    job,
    strategy,
    tf,
    days,
    status: "queued",
    phase: "queued",
    logs: [],
    events: [],
    result: null,
    error: null,
    elapsedMs: 0,
    createdAt: Date.now(),
    to,
    payload: { strategy, tf, days, equity, riskPct, maxHoldBars, to },
  };
  jobs.set(rec.id, rec);

  // Prune finished jobs so a long session does not grow without bound.
  if (jobs.size > 60) {
    for (const [id, j] of jobs) {
      if (j.status !== "running" && j.status !== "queued") jobs.delete(id);
      if (jobs.size <= 40) break;
    }
  }

  if (active) {
    queue.push(rec);
    emit(rec, "queued", { behind: active.id });
    return { id: rec.id, queued: true };
  }
  rec.status = "running";
  spawn(rec);
  return { id: rec.id, queued: false };
}

export const getJob = (id) => jobs.get(id) ?? null;

export function cancel(id) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status === "queued") {
    queue = queue.filter((j) => j !== job);
    job.status = "cancelled";
    publish("backtest", { id, event: "cancelled" });
    return true;
  }
  if (job.status === "running") {
    job.status = "cancelled";
    try {
      job.worker?.postMessage({ type: "cancel" });
      job.worker?.terminate();
    } catch {
      /* noop */
    }
    job.worker = null;
    if (active === job) active = null;
    const next = queue.shift();
    if (next) {
      next.status = "running";
      spawn(next);
    }
    publish("backtest", { id, event: "cancelled" });
    return true;
  }
  return false;
}

export const activeJob = () => (active ? { id: active.id, job: active.job, strategy: active.strategy, phase: active.phase, detail: active.phaseDetail ?? null, elapsedMs: active.elapsedMs } : null);

export const snapshot = () => ({
  active: activeJob(),
  queued: queue.length,
  recent: [...jobs.values()]
    .filter((j) => j.status !== "queued")
    .slice(-12)
    .reverse()
    .map((j) => ({ id: j.id, job: j.job, strategy: j.strategy, tf: j.tf, status: j.status, phase: j.phase, elapsedMs: j.elapsedMs, ts: j.createdAt, error: j.error ?? null })),
});
