// Backtest worker. Runs on a worker_thread so the minutes-long synchronous CPU
// loops in harness.mjs (and the accidentally O(n^2) one in leakage.mjs) can never
// stall the HTTP server or the SSE stream.
//
// Two jobs:
//   run     a full gated backtest via the exported runOne from research/run.mjs
//   equity  re-simulate one strategy purely to obtain an equity curve, which
//           runOne does not return but every chart wants
//
// Progress is reported as discrete phases with elapsed time, never as an
// invented percentage: runOne is a single synchronous call, so there is nothing
// honest to interpolate between its start and its return.

import { parentPort, workerData } from "node:worker_threads";

const ROOT = workerData.root;
const R = (p) => `${ROOT.replace(/\\/g, "/")}/research/${p}`;

let currentPhase = "queued";
const started = Date.now();

function phase(name, detail) {
  currentPhase = name;
  parentPort.postMessage({ type: "phase", phase: name, detail: detail ?? null, elapsedMs: Date.now() - started });
}
function log(line) {
  parentPort.postMessage({ type: "log", line, elapsedMs: Date.now() - started });
}

// runOne reads --to and --version straight off process.argv, so they are staged
// there for the duration of the call. Only one backtest runs at a time (the
// server serialises them), which is what makes this safe.
function withArgv(args, fn) {
  const saved = process.argv.slice();
  try {
    process.argv = [saved[0], saved[1], ...args];
    return fn();
  } finally {
    process.argv = saved;
  }
}

async function runBacktest({ strategy, tf, days, equity, riskPct, maxHoldBars, to }) {
  const simCfg = { equity, riskPct, maxHoldBars, warmup: 250, ruinEquityPct: 0.2 };
  const argv = ["--version", "1"];
  if (to) argv.push("--to", to);

  const { runOne } = await import(R("run.mjs"));

  // The data fetch is the only part that reports anything, via console.error.
  const realError = console.error;
  console.error = (...a) => {
    const line = a.map(String).join(" ");
    if (/^fetching/.test(line)) phase("loading-data", line);
    else if (/^\s{2}\w+:/.test(line)) log(line.trim());
    else log(line);
  };

  const result = await withArgv(argv, () => runOne({ strategy, tf, days, simCfg }));

  console.error = realError;
  return result;
}

async function equityCurve({ strategy, tf, days, equity, riskPct, maxHoldBars, points = 420 }) {
  const { simulate, metrics } = await import(R("harness.mjs"));
  const { loadMany } = await import(R("data.mjs"));

  const TF_SECONDS = { "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400 };
  const secs = TF_SECONDS[tf];
  if (!secs) throw new Error(`unknown timeframe "${tf}"`);

  const to = Math.floor(Date.parse(workerData.to ?? "2026-09-27T00:00:00Z") / 1000);
  const from = to - days * 86400;
  const limit = Math.ceil((days * 86400) / secs * 1.1);
  const symbols = workerData.symbols;

  phase("loading-data", `${symbols.length} symbols x ${tf} (${days}d)`);
  const loaded = await loadMany({ symbols, tf, from, to, limit });
  const ok = loaded.filter((x) => x.ok);
  if (!ok.length) throw new Error("no data loaded");

  const mod = await import(`${R("strategies")}/${strategy}.mjs`);
  const signal = mod.default;
  const cfg = { equity, riskPct, maxHoldBars, warmup: 250, ruinEquityPct: 0.2 };

  const series = [];
  const perSymbol = [];
  let processed = 0;

  for (const d of ok) {
    phase("simulating", `${d.symbol} ${d.data.bars.length} bars`, processed / ok.length);
    const sim = simulate({ bars: d.data.bars, signal, cfg: { ...cfg } });
    const m = metrics({ trades: sim.trades, equityCurve: sim.equityCurve, initialEquity: cfg.equity });
    perSymbol.push({ symbol: d.symbol, ...m, bars: d.data.bars.length });
    // Downsample the per-symbol curve to `points` before returning: 5 x 38k
    // points is 192k objects to JSON-encode on every chart paint.
    const step = Math.max(1, Math.floor(sim.equityCurve.length / points));
    const curve = [];
    for (let i = 0; i < sim.equityCurve.length; i += step) {
      const p = sim.equityCurve[i];
      curve.push({ t: p.time ?? i, e: Number(p.equity.toFixed(2)) });
    }
    const lastPoint = sim.equityCurve[sim.equityCurve.length - 1];
    if (lastPoint) curve.push({ t: lastPoint.time ?? sim.equityCurve.length - 1, e: Number(lastPoint.equity.toFixed(2)) });
    series.push({ symbol: d.symbol, curve, finalEquity: sim.finalEquity, ruined: sim.ruined, trades: sim.trades.length });
    processed++;
  }

  return { strategy, tf, days, series, perSymbol, initialEquity: cfg.equity };
}

parentPort.on("message", async (msg) => {
  if (msg.type === "ping") {
    parentPort.postMessage({ type: "pong" });
    return;
  }
  if (msg.type === "cancel") {
    phase("cancelled");
    parentPort.postMessage({ type: "cancelled" });
    process.exit(0);
  }
  try {
    phase("starting", msg.job);
    const out = msg.job === "equity" ? await equityCurve(msg.payload) : await runBacktest(msg.payload);
    phase("done");
    parentPort.postMessage({ type: "result", job: msg.job, payload: msg.payload, result: out, elapsedMs: Date.now() - started });
  } catch (err) {
    phase("failed", err.message);
    parentPort.postMessage({ type: "error", job: msg.job, payload: msg.payload, message: err.message, stack: err.stack, elapsedMs: Date.now() - started });
  }
});

parentPort.postMessage({ type: "ready" });
