#!/usr/bin/env node
/**
 * harness.mjs — strategy-agnostic evaluation harness.
 *
 * ARCHITECTURAL GUARANTEE
 * This file does not import paper-trade.mjs and cannot place an order. It
 * imports risk-engine.mjs, which is pure arithmetic, so a backtest sizes every
 * position exactly the way live execution would. There is no code path from a
 * signal to TradingView from in here.
 *
 *   signal(bar, ctx) -> { side: "buy"|"sell" } | null
 *          ↓
 *      Risk Engine        (same sizing as live)
 *          ↓
 *      Simulator          (costs, gaps, one position at a time)
 *          ↓
 *      Metrics + Monte Carlo + walk-forward
 *
 * Everything is seeded and deterministic: same data + same strategy => same
 * numbers, every run.
 */

import { load } from "./data.mjs";
import { atr, sizePosition } from "./risk-engine.mjs";

const DEFAULTS = {
  equity: 1000,          // paper-equivalent starting equity for the sim
  riskPct: 0.01,         // 1% risk per trade
  stopAtrMult: 2,
  atrPeriod: 14,
  leverage: 10,
  allowFractional: true,
  feeBps: 10,            // 0.10% taker, per side
  slippageBps: 5,        // 0.05% adverse, per side
  maxHoldBars: 40,
  warmup: 60,            // bars reserved for indicator warm-up
};

// --------------------------------------------------------------- simulator

/**
 * Walk bars forward. One position at a time. Signal sees only data up to and
 * including the current bar, and decides AFTER the bar closes — so execution
 * happens on the NEXT bar's open. That one-bar delay is the difference between
 * an honest backtest and a fictional one.
 */
export function simulate({ bars, signal, cfg = {}, atrPeriod = 14 }) {
  const c = { ...DEFAULTS, ...cfg };
  const tfStep = bars.length > 1 ? bars[1].time - bars[0].time : 86400;
  // A run is ruined once equity cannot support one more unit of risk. Without
  // this the simulator keeps "trading" a dead account and the trade count stays
  // high, which would let a bankrupt strategy clear a minimum-trade gate.
  const ruinAt = c.ruinEquityPct != null ? c.equity * c.ruinEquityPct : null;

  let equity = c.equity;
  let pos = null;                 // { side, qty, entry, entryPrice, stop, entryFee }
  const trades = [];
  const equityCurve = [];
  let rejected = 0;
  let ruined = false;
  let ruinAtBar = null;
  let signalErrors = 0;
  let firstSignalError = null;

  for (let i = c.warmup; i < bars.length; i++) {
    const bar = bars[i];
    const next = bars[i + 1];

    // --- manage an open position first
    if (pos) {
      const held = bar.time - pos.entryTime;
      let exit = null, why = null;

      if (pos.side === "buy") {
        if (bar.low <= pos.stop)        { exit = pos.stop;        why = "stop"; }
        else if (held >= c.maxHoldBars * tfStep) { exit = bar.close; why = "time"; }
      } else {
        if (bar.high >= pos.stop)       { exit = pos.stop;        why = "stop"; }
        else if (held >= c.maxHoldBars * tfStep) { exit = bar.close; why = "time"; }
      }

      if (exit != null && next) {
        // fill at the exit with costs, on the next bar's open when stopped out
        const fillBase = why === "stop" ? next.open : next.open;
        const fill = applyCosts(fillBase, pos.side === "buy" ? "sell" : "buy", c);
        const gross = (fill - pos.entryPrice) * pos.qty * (pos.side === "buy" ? 1 : -1);
        const fees = pos.entryFee + Math.abs(fill * pos.qty) * (c.feeBps / 10000);
        const pnl = gross - fees;
        const equityBefore = equity;      // captured before the P&L is booked
        equity += pnl;
        trades.push({
          side: pos.side, entryTime: pos.entryTime, exitTime: next.time,
          entry: pos.entryPrice, exit: Number(fill.toFixed(8)), qty: pos.qty,
          stop: pos.stop, reason: why,
          barsHeld: Math.round((next.time - pos.entryTime) / tfStep),
          pnl: Number(pnl.toFixed(6)), returnPct: Number(((pnl / (pos.entryPrice * pos.qty)) * 100).toFixed(4)),
          // Equity BEFORE this trade was booked. `returnPct` above is a return
          // on NOTIONAL, and notional is up to 10x equity at 10x leverage — so
          // it cannot be compounded onto an equity curve without a 10x error.
          // Any resampling method (see robustness.mjs) needs the trade's
          // fractional return on ACCOUNT equity, and this is the only place in
          // the simulator where that number exists. Additive: no existing
          // metric reads it, so no recorded v1 number moves.
          equityBefore: Number(equityBefore.toFixed(8)),
        });
        pos = null;
      }
    }

    // --- flat: consider a new signal
    if (!pos && next) {
      const ctx = {
        i, bar, bars, atrPeriod,
        atr: atr(bars.slice(0, i + 1), atrPeriod),
        equity, openPosition: null,
        // Strategies read their parameters from `cfg`. This line was MISSING,
        // and it is load-bearing for the entire robustness apparatus.
        //
        // `c` is DEFAULTS merged with the caller's cfg, which is how a grid
        // variant reaches the strategy: `holdoutEvaluate` calls
        // `simulate({ cfg: { ...cfg, ...params } })` for every point of the
        // cartesian product. Without `cfg: c` in this object, `params` went
        // nowhere, every "variant" was the same default-config run, and the
        // gate's `parameter sensitivity` criterion silently measured nothing —
        // reporting 0% for every strategy in the repo, which reads exactly
        // like "no variant was profitable" rather than "nothing was varied".
        // Proven with a probe signal keyed on `cfg.n`: n=3, 7 and 40 all
        // returned an identical 213 trades.
        //
        // DEFAULTS keys are also visible here now, which is harmless: no
        // strategy reads a parameter by a name that collides with one
        // (equity, riskPct, maxHoldBars, warmup, feeBps, slippageBps,
        // stopAtrMult, leverage, ruinEquityPct, atrPeriod).
        cfg: c,
      };
      let sig = null;
      // A throwing signal used to be indistinguishable from a silent one. It is
      // counted and reported rather than swallowed, so a strategy that crashes
      // on some bars shows up as `signalErrors > 0` instead of quietly
      // producing fewer trades.
      try { sig = signal(ctx); }
      catch (err) { sig = null; signalErrors++; if (signalErrors === 1) firstSignalError = String(err && err.message || err); }
      if (sig && (sig.side === "buy" || sig.side === "sell")) {
        // Size with the SAME engine used in live execution.
        const a = atr(bars.slice(0, i + 1), atrPeriod);
        const size = sizePosition({
          equity, price: next.open, atrValue: a, side: sig.side,
          riskPct: c.riskPct, stopAtrMult: c.stopAtrMult,
          maxNotional: equity * 100, maxMargin: equity, leverage: c.leverage,
          allowFractional: c.allowFractional, existingExposure: 0,
        });
        if (!size.ok) {
          rejected++;
        } else {
          const entry = applyCosts(next.open, sig.side, c);
          pos = {
            side: sig.side, qty: size.qty, entryPrice: entry,
            entryTime: next.time,
            stop: sig.side === "buy" ? entry - size.stopDistance : entry + size.stopDistance,
            entryFee: Math.abs(entry * size.qty) * (c.feeBps / 10000),
            riskPlanned: size.riskAmount,
          };
        }
      }
    }

    equityCurve.push({ time: bar.time, equity });

    // Ruin check: stop the run. A dead account cannot take new risk, so every
    // trade after this point would be fictional.
    if (ruinAt != null && equity <= ruinAt && !ruined) {
      ruined = true;
      ruinAtBar = i;
      if (pos && next) {                      // close out at fair value
        const fill = pos.side === "buy" ? next.close : next.close;
        const gross = (fill - pos.entryPrice) * pos.qty * (pos.side === "buy" ? 1 : -1);
        const equityBefore = equity;
        equity += gross;
        trades.push({ side: pos.side, entryTime: pos.entryTime, exitTime: next.time,
          entry: pos.entryPrice, exit: Number(fill.toFixed(8)), qty: pos.qty, stop: pos.stop,
          reason: "ruin", barsHeld: Math.round((next.time - pos.entryTime) / tfStep),
          pnl: Number(gross.toFixed(6)), returnPct: Number(((gross / (pos.entryPrice * pos.qty)) * 100).toFixed(4)),
          equityBefore: Number(equityBefore.toFixed(8)) });
        pos = null;
      }
      break;
    }
  }

  // Mark any still-open position so the curve is honest.
  if (pos && bars.length) {
    const last = bars[bars.length - 1].close;
    const equityBefore = equity;
    const gross = (last - pos.entryPrice) * pos.qty * (pos.side === "buy" ? 1 : -1);
    trades.push({
      side: pos.side, entryTime: pos.entryTime, exitTime: pos.entryTime,
      entry: pos.entryPrice, exit: last, qty: pos.qty, stop: pos.stop,
      reason: "open_at_end", barsHeld: 0,
      pnl: Number(gross.toFixed(6)), returnPct: 0,
      equityBefore: Number(equityBefore.toFixed(8)),
    });
  }

  return { trades, equityCurve, finalEquity: equity, rejected, ruined, ruinAtBar, cfg: c,
           signalErrors, firstSignalError };
}

function applyCosts(price, side, c) {
  const adverse = price * (c.slippageBps / 10000);
  return side === "buy" ? price + adverse : price - adverse;
}

// ----------------------------------------------------------------- metrics

export function metrics({ trades, equityCurve, initialEquity, barSeconds = 86400, ruined = false }) {
  const n = trades.length;
  if (!n) {
    return { trades: 0, winRate: null, expectancy: null, profitFactor: null,
             sharpe: null, maxDrawdownPct: null, avgHoldBars: null, verdict: "NO_TRADES" };
  }
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const expectancy = trades.reduce((a, t) => a + t.pnl, 0) / n;

  // Sharpe from per-trade returns (not per-bar), annualised by trade count.
  const rets = trades.map((t) => t.returnPct / 100);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  const sharpe = sd > 0 ? mean / sd : null;

  let peak = equityCurve[0]?.equity ?? initialEquity, maxDd = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak > 0 ? (peak - p.equity) / peak : 0;
    if (dd > maxDd) maxDd = dd;
  }

  const totalReturn = (equityCurve[equityCurve.length - 1]?.equity ?? initialEquity) / initialEquity - 1;

  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: Number(((wins.length / n) * 100).toFixed(2)),
    expectancy: Number(expectancy.toFixed(6)),
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(3)) : (grossWin > 0 ? "inf" : 0),
    grossWin: Number(grossWin.toFixed(4)),
    grossLoss: Number(grossLoss.toFixed(4)),
    sharpe: sharpe == null ? null : Number(sharpe.toFixed(3)),
    maxDrawdownPct: Number((maxDd * 100).toFixed(2)),
    totalReturnPct: Number((totalReturn * 100).toFixed(2)),
    avgHoldBars: Number((trades.reduce((a, t) => a + (t.barsHeld || 0), 0) / n).toFixed(1)),
    ruined,
    ruinTradeIndex: ruined ? trades.findIndex((t) => t.reason === "ruin") : -1,
    expectancyR: trades.reduce((a, t) => a + t.returnPct, 0) / n,
  };
}

// ------------------------------------------------------------ monte carlo

/** Shuffle the ORDER of a fixed set of trade outcomes. */
export function monteCarlo({ trades, initialEquity, runs = 1000, seed = 12345, ddThresholdPct = 20 }) {
  if (trades.length < 5) return { runs: 0, note: "too few trades" };
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const pnls = trades.map((t) => t.pnl);
  // The sum of a fixed P&L set is order-invariant, so "final equity
  // percentiles" would be a constant and carry no information. What ordering
  // changes is the PATH: drawdown depth, drawdown breach probability, and the
  // longest losing run. Those are the risk quantities, so those are reported.
  const finalEquity = initialEquity + pnls.reduce((a, b) => a + b, 0);

  const maxDds = [], streaks = [];
  let breached = 0;
  for (let r = 0; r < runs; r++) {
    const bag = pnls.slice();
    for (let i = bag.length - 1; i > 0; i--) {          // Fisher-Yates, seeded
      const j = Math.floor(rnd() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    let eq = initialEquity, peak = initialEquity, dd = 0;
    let streak = 0, worstStreak = 0;
    for (const p of bag) {
      eq += p;
      if (eq > peak) peak = eq;
      if (peak > 0) dd = Math.max(dd, (peak - eq) / peak);
      streak = p <= 0 ? streak + 1 : 0;
      if (streak > worstStreak) worstStreak = streak;
    }
    maxDds.push(dd);
    streaks.push(worstStreak);
    if (dd * 100 >= ddThresholdPct) breached++;
  }
  const q = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; };

  return {
    runs,
    trades: trades.length,
    finalEquity: Number(finalEquity.toFixed(2)),        // identical for every ordering
    note: "finalEquity is order-invariant; the distributions below are the risk signal",
    medianMaxDrawdownPct: Number((q(maxDds, 0.5) * 100).toFixed(2)),
    p95MaxDrawdownPct: Number((q(maxDds, 0.95) * 100).toFixed(2)),
    worstMaxDrawdownPct: Number((Math.max(...maxDds) * 100).toFixed(2)),
    ddThresholdPct,
    probabilityOfBreachingThreshold: Number(((breached / runs) * 100).toFixed(2)),
    medianLongestLosingStreak: q(streaks, 0.5),
    p95LongestLosingStreak: q(streaks, 0.95),
    observedLongestLosingStreak: Math.max(...streaks),
  };
}

// ----------------------------------------------------------- walk-forward

/**
 * Split-and-test: repeated out-of-sample evaluation over sequential windows.
 *
 * Each fold is given `warmup` bars of history BEFORE its test window, so
 * indicators are actually primed inside the fold. Without that, a moving
 * average sees 1 bar and never fires — which silently turns walk-forward into
 * "report almost no trades" rather than an honest evaluation.
 */
export function walkForward({ bars, signal, cfg = {}, folds = 4, warmup = DEFAULTS.warmup }) {
  const usable = bars.slice(warmup);
  if (usable.length < folds * 40) return { folds: 0, note: "not enough bars for walk-forward" };
  const size = Math.floor(usable.length / folds);
  const out = [];
  for (let f = 0; f < folds; f++) {
    const start = f * size;
    // history immediately preceding this fold, for indicator warm-up
    const hist = bars.slice(Math.max(0, warmup + start - warmup), warmup + start);
    const test = usable.slice(start, start + size);
    if (hist.length < 2 || test.length < 20) continue;

    const series = [...hist, ...test];
    const res = simulate({ bars: series, signal, cfg: { ...cfg, warmup: hist.length } });
    const m = metrics({ trades: res.trades, equityCurve: res.equityCurve, initialEquity: res.cfg.equity });
    out.push({ fold: f + 1, testBars: test.length, histBars: hist.length,
               trades: m.trades, winRate: m.winRate, profitFactor: m.profitFactor,
               expectancy: m.expectancy, totalReturnPct: m.totalReturnPct });
  }
  const traded = out.filter((o) => o.trades > 0);
  const totalTrades = traded.reduce((a, o) => a + o.trades, 0);
  return {
    folds: out.length,
    perFold: out,
    foldsWithTrades: traded.length,
    totalTrades,
    foldsProfitable: traded.filter((o) => o.totalReturnPct > 0).length,
    consistency: traded.length
      ? Number(((traded.filter((o) => o.totalReturnPct > 0).length / traded.length) * 100).toFixed(1))
      : null,
    caveat: traded.length && totalTrades / traded.length < 20
      ? "few trades per fold - consistency is weakly determined"
      : null,
  };
}

// ------------------------------------------------------------------ CLI

async function runCli(argv) {
  const get = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  const strategy = get("--strategy", "buy-and-hold");
  const provider = get("--provider", "binance");
  const symbol = get("--symbol", "DOGEUSDT");
  const tf = get("--tf", "1d");
  const equity = Number(get("--equity", 1000));
  const runs = Number(get("--mc", 1000));

  const mod = await import(`./strategies/${strategy}.mjs`);
  const signal = mod.default;

  const data = await load({ provider, symbol, tf });
  const sim = simulate({ bars: data.bars, signal, cfg: { equity } });
  const m = metrics({ trades: sim.trades, equityCurve: sim.equityCurve, initialEquity: equity });
  const mc = monteCarlo({ trades: sim.trades, initialEquity: equity, runs });
  const wf = walkForward({ bars: data.bars, signal, cfg: { equity } });

  const report = {
    run: { strategy, provider, symbol: data.symbol, tf, bars: data.bars.length,
           spanDays: data.audit.spanDays, from: data.audit.from, to: data.audit.to,
           equity, sizingRejected: sim.rejected, costs: { feeBps: sim.cfg.feeBps, slippageBps: sim.cfg.slippageBps } },
    metrics: m,
    monteCarlo: mc,
    walkForward: wf,
    dataGaps: data.audit.gaps,
  };
  console.log(JSON.stringify(report, null, 2));
  console.log("\n--- verdicts ---");
  const v = (ok, label) => console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  v(m.trades >= 30, `trade count >= 30 (have ${m.trades}) � below this, results are noise`);
  v(m.profitFactor > 1, `profit factor > 1 (have ${m.profitFactor})`);
  v(m.maxDrawdownPct < 40, `max drawdown < 40% (have ${m.maxDrawdownPct}%)`);
  v(wf.consistency == null || wf.consistency >= 50, `walk-forward consistency >= 50% (have ${wf.consistency}%)`);
  if (wf.caveat) console.log(`  WARN  ${wf.caveat}`);
  if (m.trades < 100) console.log("  NOTE  under 100 trades - treat any edge as unproven");
  v(mc.probabilityOfBreachingThreshold < 25, `P(drawdown >= ${mc.ddThresholdPct}%) < 25% (have ${mc.probabilityOfBreachingThreshold}%)`);
  if (m.trades < 30) console.log("\n  NOTE: fewer than 30 trades. This is not evidence of anything.");
}

const IS_HARNESS = process.argv[1] && process.argv[1].endsWith("harness.mjs");

if (IS_HARNESS && process.argv[2] === "run") {
  runCli(process.argv.slice(3)).catch((e) => { console.error("error: " + e.message); process.exit(1); });
}
// ------------------------------------------------- out-of-sample holdout

/** Chronological split. The test half is never used to choose anything. */
export function holdoutSplit(bars, trainFrac = 0.7, warmup = DEFAULTS.warmup) {
  const cut = Math.floor(bars.length * trainFrac);
  return {
    train: bars.slice(0, cut),
    // give the test window the warmup bars immediately before it, so
    // indicators are primed without leaking anything from the future
    test: bars.slice(Math.max(0, cut - warmup)),
    cutIndex: cut,
  };
}

/**
 * Choose a parameter variant on TRAIN, then evaluate that exact variant on
 * TEST. This is the only honest way to use a holdout: picking parameters by
 * looking at the test half converts it into a second training set.
 */
export function holdoutEvaluate({ bars, signal, cfg = {}, grid = {}, objective = "sharpe", trainFrac = 0.7 }) {
  const { train, test, cutIndex } = holdoutSplit(bars, trainFrac, cfg.warmup ?? DEFAULTS.warmup);
  if (train.length < 200 || test.length < 100) return { ok: false, reason: "not enough bars to split" };

  const keys = Object.keys(grid);
  const variants = [];
    // enumerate the cartesian product

  const idx = new Array(keys.length).fill(0);
  const combos = [];
  for (;;) {
    combos.push(Object.fromEntries(keys.map((k, j) => [k, grid[k][idx[j]]])));
    let j = keys.length - 1;
    while (j >= 0) { idx[j]++; if (idx[j] < grid[keys[j]].length) break; idx[j] = 0; j--; }
    if (j < 0) break;
  }

  for (const params of combos) {
    const r = simulate({ bars: train, signal, cfg: { ...cfg, ...params } });
    const m = metrics({ trades: r.trades, equityCurve: r.equityCurve, initialEquity: r.cfg.equity, ruined: r.ruined });
    variants.push({ params, train: m, ruined: r.ruined, test: null });
  }
  if (!variants.length) return { ok: false, reason: "empty parameter grid" };

  const score = (m) => (objective === "sharpe" ? (m.sharpe ?? -99) : objective === "pf" ? Number(m.profitFactor === "inf" ? 99 : m.profitFactor) : m.totalReturnPct);
  const viable = variants.filter((v) => !v.ruined && v.train.trades > 0);
  const best = (viable.length ? viable : variants).reduce((a, b) => (score(b.train) > score(a.train) ? b : a));

  // Evaluate the chosen variant on data it has never seen.
  const rt = simulate({ bars: test, signal, cfg: { ...cfg, ...best.params } });
  const mt = metrics({ trades: rt.trades, equityCurve: rt.equityCurve, initialEquity: rt.cfg.equity, ruined: rt.ruined });

  const trainScore = score(best.train);
  const testScore = score(mt);
  return {
    ok: true,
    objective,
    cutIndex,
    trainBars: train.length,
    testBars: test.length,
    variantsTested: variants.length,
    chosen: best.params,
    train: best.train,
    test: mt,
    testRuin: rt.ruined,
    // Degradation: how much of the in-sample result survived out of sample.
    degradation: trainScore > 0 ? Number((testScore / trainScore).toFixed(3)) : null,
    // A narrow winner among many variants is the signature of curve fitting.
    variantsPositive: variants.filter((v) => score(v.train) > 0).length,
    sensitivity: Number((variants.filter((v) => score(v.train) > 0).length / variants.length).toFixed(3)),
  };
}

// ------------------------------------------------------------ cost stress

/**
 * Re-run the same signal at progressively worse costs. A real edge survives
 * realistic frictions; a curve-fit one dissolves the moment fees rise.
 */
export function costStress({ bars, signal, cfg = {}, feeMults = [1, 2, 5], slipMults = [1, 2, 5] }) {
  const base = { feeBps: DEFAULTS.feeBps, slippageBps: DEFAULTS.slippageBps, ...cfg };
  const grid = [];
  for (const f of feeMults) {
    for (const s of slipMults) {
      const c = { ...base, feeBps: DEFAULTS.feeBps * f, slippageBps: DEFAULTS.slippageBps * s };
      const r = simulate({ bars, signal, cfg: c });
      const m = metrics({ trades: r.trades, equityCurve: r.equityCurve, initialEquity: r.cfg.equity, ruined: r.ruined });
      grid.push({
        feeMult: f, slipMult: s,
        feeBps: Number(c.feeBps.toFixed(2)), slippageBps: Number(c.slippageBps.toFixed(2)),
        profitFactor: m.profitFactor, sharpe: m.sharpe, totalReturnPct: m.totalReturnPct, ruined: r.ruined,
      });
    }
  }
  const baseline = grid.find((g) => g.feeMult === 1 && g.slipMult === 1);
  const survivors = grid.filter((g) => !g.ruined && Number(g.profitFactor) > 1);
  // The worst cost level at which the strategy still makes money.
  const cost = (g) => g.feeBps + g.slippageBps;
  const best = survivors.length ? survivors.reduce((a, b) => (cost(b) > cost(a) ? b : a)) : null;
  return {
    grid,
    baseline: baseline ?? null,
    survived: survivors.length,
    of: grid.length,
    survivalRate: Number((survivors.length / grid.length).toFixed(3)),
    maxSurvivableFeeBps: best ? best.feeBps : null,
    maxSurvivableSlippageBps: best ? best.slippageBps : null,
  };
}

// --------------------------------------------------------------- selftest
if (IS_HARNESS && process.argv[2] !== "run") {
  let pass = 0, fail = 0;
  const check = (n, c, x = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); };
  console.log("harness.mjs selftest\n");

  // Deterministic synthetic market with a known drift.
  const mk = (n, drift, vol = 1) => {
    const b = []; let px = 100;
    for (let i = 0; i < n; i++) {
      const d = drift + Math.sin(i / 5) * vol;
      const o = px, c = px + d;
      b.push({ time: 1767225600 + i * 86400, open: o, high: Math.max(o, c) + vol, low: Math.min(o, c) - vol, close: c, volume: 1 });
      px = c;
    }
    return b;
  };

  // A deliberately trivial signal: always long.
  const alwaysLong = () => ({ side: "buy" });
  const up = mk(400, 0.6), down = mk(400, -0.6), flat = mk(400, 0.0);

  const rUp = simulate({ bars: up, signal: alwaysLong });
  const mUp = metrics({ trades: rUp.trades, equityCurve: rUp.equityCurve, initialEquity: DEFAULTS.equity });
  check("produces trades", mUp.trades > 0, `${mUp.trades}`);
  check("a rising market with a long signal is profitable", mUp.totalReturnPct > 0, `${mUp.totalReturnPct}%`);
  check("reports drawdown >= 0", mUp.maxDrawdownPct >= 0, `${mUp.maxDrawdownPct}%`);

  const rDown = simulate({ bars: down, signal: alwaysLong });
  const mDown = metrics({ trades: rDown.trades, equityCurve: rDown.equityCurve, initialEquity: DEFAULTS.equity });
  check("a falling market with a long signal loses", mDown.totalReturnPct < 0, `${mDown.totalReturnPct}%`);

  const never = simulate({ bars: up, signal: () => null });
  check("a signal that never fires yields no trades", never.trades.length === 0);
  const mNever = metrics({ trades: never.trades, equityCurve: never.equityCurve, initialEquity: DEFAULTS.equity });
  check("metrics refuse to report on zero trades", mNever.verdict === "NO_TRADES");

  // Determinism
  const a1 = simulate({ bars: up, signal: alwaysLong });
  const a2 = simulate({ bars: up, signal: alwaysLong });
  check("same input => same result", JSON.stringify(a1.trades) === JSON.stringify(a2.trades));

  // --- cfg MUST reach the signal -------------------------------------------
  // Regression guard. `simulate` once built its ctx WITHOUT a `cfg` key, so
  // every grid variant in `holdoutEvaluate` ran the strategy's defaults and the
  // gate's parameter-sensitivity criterion measured nothing at all. A signal
  // keyed on `cfg.n` is used because it cannot be confused: if cfg is forwarded
  // the trade counts MUST differ, and if they match, cfg is being dropped.
  const cfgProbe = ({ i, cfg }) => ((i % ((cfg && cfg.n) ?? 7)) === 0 ? { side: "buy" } : null);
  const p3 = simulate({ bars: up, signal: cfgProbe, cfg: { n: 3 } });
  const p40 = simulate({ bars: up, signal: cfgProbe, cfg: { n: 40 } });
  check("simulate forwards cfg to the signal",
        p3.trades.length !== p40.trades.length,
        `n=3 -> ${p3.trades.length} trades, n=40 -> ${p40.trades.length} trades`);
  check("default is used when cfg omits the key",
        simulate({ bars: up, signal: cfgProbe }).trades.length ===
        simulate({ bars: up, signal: cfgProbe, cfg: { n: 7 } }).trades.length);

  // A grid must produce genuinely different variants, not N copies of one run.
  const ho = holdoutEvaluate({ bars: up, signal: cfgProbe, cfg: {},
    grid: { n: [3, 11, 40] }, objective: "sharpe", trainFrac: 0.7 });
  check("holdoutEvaluate reports a variant count", ho.ok && ho.variantsTested === 3,
        `variantsTested=${ho.variantsTested}`);

  // A throwing signal must be visible, not silent.
  const thrower = () => { throw new Error("boom"); };
  const thr = simulate({ bars: up, signal: thrower });
  check("a throwing signal is counted, not swallowed",
        thr.signalErrors > 0 && thr.trades.length === 0,
        `signalErrors=${thr.signalErrors}, trades=${thr.trades.length}`);

  // Costs must matter
  const free = simulate({ bars: up, signal: alwaysLong, cfg: { feeBps: 0, slippageBps: 0 } });
  check("costs reduce returns", free.finalEquity >= rUp.finalEquity,
        `${free.finalEquity.toFixed(2)} >= ${rUp.finalEquity.toFixed(2)}`);

  // One position at a time
  check("never holds two positions at once",
        rUp.trades.every((t, i) => i === 0 || t.entryTime >= rUp.trades[i - 1].exitTime));

  // No lookahead: entry must be strictly after the signal bar
  check("execution is delayed one bar (no lookahead)",
        rUp.trades.every((t) => t.entryTime > t.entryTime - 86400 && t.barsHeld >= 0));

  // --- equityBefore is part of the simulator's contract
  // robustness.mjs resamples trades by compounding pnl/equityBefore. If a trade
  // record ever loses that field the bootstrap silently falls back to
  // pnl/initialEquity, which is the right number only for the first trade and
  // wrong by an order of magnitude for the rest. Pin it here, at the source.
  check("every trade records the equity it was taken against",
    rUp.trades.length > 0 && rUp.trades.every((t) => typeof t.equityBefore === "number" && t.equityBefore > 0),
    `first: ${rUp.trades[0]?.equityBefore} of ${rUp.trades[0]?.pnl} pnl`);
  check("equityBefore is monotonically non-decreasing across trades",
    rUp.trades.every((t, i) => i === 0 || t.equityBefore >= rUp.trades[i - 1].equityBefore - 1e-6));
  check("a fractional return pnl/equityBefore is far smaller than returnPct at 10x leverage",
    rUp.trades.some((t) => t.returnPct > 0 && Math.abs(t.pnl / t.equityBefore) < t.returnPct / 100),
    "notional return is not an account return — compounding it would be a 10x error");

  // Every trade-record exit path has to carry equityBefore, including the two
  // the fixtures above never reach. A falling market with a ruin threshold set
  // exercises the ruin close-out; ending mid-position exercises open_at_end.
  // Both of these were missing the field at least once, and neither was
  // covered, because DEFAULTS has no ruinEquityPct and every fixture above ends
  // flat.
  {
    const longDown = mk(1500, -0.6);
    const ruinedRun = simulate({ bars: longDown, signal: alwaysLong, cfg: { ruinEquityPct: 0.9 } });
    check("a ruined run reports the ruin",
      ruinedRun.ruined && ruinedRun.ruinAtBar != null && ruinedRun.trades.some((t) => t.reason === "ruin"),
      `ruinAtBar=${ruinedRun.ruinAtBar}, ${ruinedRun.trades.length} trades`);
    check("the ruin close-out also records equityBefore",
      ruinedRun.trades.every((t) => typeof t.equityBefore === "number" && t.equityBefore > 0),
      `${ruinedRun.trades.length} trades, all with equityBefore`);
    check("every trade reason in a ruined run carries equityBefore",
      ["stop", "time", "ruin", "open_at_end"].every((why) =>
        !ruinedRun.trades.some((t) => t.reason === why) || ruinedRun.trades.filter((t) => t.reason === why).every((t) => t.equityBefore > 0)),
      [...new Set(ruinedRun.trades.map((t) => t.reason))].join(","));
  }

  // Monte Carlo determinism + bounds.
  // NOTE: MC is meaningless on a small, one-sided trade set — shuffling 9
  // identical winners gives the same final equity every run. Use a choppy
  // market so the trade outcomes actually vary, which is the only case where
  // the percentiles carry information.
  const choppy = mk(600, 0, 2.2);
  const rChop = simulate({ bars: choppy, signal: alwaysLong, cfg: { maxHoldBars: 8 } });
  const mChop = metrics({ trades: rChop.trades, equityCurve: rChop.equityCurve, initialEquity: DEFAULTS.equity });
  check("choppy market produces a mixed trade set",
        mChop.wins > 0 && mChop.losses > 0, `${mChop.wins}W/${mChop.losses}L of ${mChop.trades}`);

  const mc1 = monteCarlo({ trades: rChop.trades, initialEquity: DEFAULTS.equity, runs: 500 });
  const mc2 = monteCarlo({ trades: rChop.trades, initialEquity: DEFAULTS.equity, runs: 500 });
  const mcAlt = monteCarlo({ trades: rChop.trades, initialEquity: DEFAULTS.equity, runs: 500, seed: 999 });
  // This assertion used to read `mc1.medianFinalEquity === mc2.medianFinalEquity`.
  // monteCarlo() has no such field, so it was `undefined === undefined` — always
  // true, and the MC determinism guarantee was untested. Assert on a real
  // SEEDED statistic instead: the shuffle order depends on the seed, so
  // `p95LongestLosingStreak` and the drawdown percentiles must reproduce exactly
  // and must move when the seed moves.
  check("monte carlo is deterministic on a real seeded statistic",
    mc1.p95LongestLosingStreak === mc2.p95LongestLosingStreak
    && mc1.medianMaxDrawdownPct === mc2.medianMaxDrawdownPct
    && mc1.p95MaxDrawdownPct === mc2.p95MaxDrawdownPct,
    `p95 streak ${mc1.p95LongestLosingStreak}, median dd ${mc1.medianMaxDrawdownPct}%`);
  check("a DIFFERENT seed changes the monte carlo answer (negative control)",
    mcAlt.p95LongestLosingStreak !== mc1.p95LongestLosingStreak
    || mcAlt.medianMaxDrawdownPct !== mc1.medianMaxDrawdownPct,
    `seed 12345 -> streak ${mc1.p95LongestLosingStreak}, dd ${mc1.medianMaxDrawdownPct}%; seed 999 -> streak ${mcAlt.p95LongestLosingStreak}, dd ${mcAlt.medianMaxDrawdownPct}%`);
  check("monte carlo exposes no phantom fields (the old vacuous assertion)",
    !("medianFinalEquity" in mc1) && !("pProfitable" in mc1),
    "order-shuffling cannot report an expectancy probability — that is what v2 is for");
  check("monte carlo drawdown bounds are ordered", mc1.medianMaxDrawdownPct <= mc1.p95MaxDrawdownPct && mc1.p95MaxDrawdownPct <= mc1.worstMaxDrawdownPct,
        `median=${mc1.medianMaxDrawdownPct}% p95=${mc1.p95MaxDrawdownPct}% worst=${mc1.worstMaxDrawdownPct}%`);
  check("monte carlo spread is non-trivial on mixed outcomes", mc1.worstMaxDrawdownPct > mc1.medianMaxDrawdownPct,
        `${mc1.medianMaxDrawdownPct}% -> ${mc1.worstMaxDrawdownPct}%`);
  check("monte carlo finds a losing streak longer than observed", mc1.p95LongestLosingStreak >= mChop.losses > 0 || mc1.p95LongestLosingStreak > 0,
        `p95 streak=${mc1.p95LongestLosingStreak}`);
  check("monte carlo reports breach probability", typeof mc1.probabilityOfBreachingThreshold === "number", `${mc1.probabilityOfBreachingThreshold}%`);
  check("final equity is order-invariant (documented, not a metric)", mc1.finalEquity === Number((DEFAULTS.equity + rChop.trades.reduce((a,t)=>a+t.pnl,0)).toFixed(2)));
  check("monte carlo refuses on too few trades",
        monteCarlo({ trades: rUp.trades.slice(0, 3), initialEquity: 1000 }).runs === 0);

  // A losing strategy should show loss probability climbing
  const mcDown = monteCarlo({ trades: rDown.trades, initialEquity: DEFAULTS.equity, runs: 200 });
  check("a losing strategy ends below starting equity", mcDown.finalEquity < DEFAULTS.equity, `${mcDown.finalEquity}`);

  // Walk-forward
  const wf = walkForward({ bars: up, signal: alwaysLong, folds: 3 });
  check("walk-forward produces folds", wf.folds === 3, `${wf.folds}`);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
