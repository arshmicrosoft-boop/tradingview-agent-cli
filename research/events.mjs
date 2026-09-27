/**
 * events.mjs — event-outcome measurement. NOT a strategy, and deliberately not.
 *
 * PURPOSE
 * Every strategy tested so far has been evaluated as a trade: entry rule, 2xATR
 * stop, 96-bar time exit, costs charged. That answers "can I make money trading
 * this?" and it cannot answer "is there any information here at all?", because a
 * bad exit and a bad signal produce the same loss. This file separates the two.
 *
 * It does three things, in this order, and stops before any strategy exists:
 *
 *   1. DETECT primitive events using bars[0..i] only. No lookahead, ever.
 *   2. MEASURE the forward outcome of each event under SEVERAL different
 *      success labels, because "success" is a modelling choice, not a fact:
 *        - forward return over k bars
 *        - MFE/MAE in ATR units
 *        - "+2R before -1R" (the label a stop/target rule implies)
 *   3. COMPARE every event against the UNCONDITIONAL baseline over the same
 *      horizon. This is the step that makes the numbers mean anything.
 *
 * ON (3), which is the whole point of the file
 * A raw statistic like "sweeps return +0.08% with a 51% win rate" is
 * uninterpretable on its own. If the market returns +0.10% over the same window
 * then that sweep is a NEGATIVE signal expressed in a positive-looking number.
 * Every figure below is therefore reported as EXCESS over the unconditional
 * mean for the same bar index, and every excess carries a t-statistic. An event
 * with no information shows excess ~0 regardless of how attractive its raw
 * return looks.
 *
 * ON CLUSTERING — why events are de-duplicated
 * Forward-return windows overlap heavily. Consecutive sweeps two bars apart
 * share most of their forward path, so counting both inflates N and shrinks the
 * standard error, manufacturing significance out of autocorrelated data. Only one
 * event per `clusterBars` window is counted, which is also what the harness's
 * "one position at a time" does. Ignoring this is the easiest way to publish a
 * fake edge.
 *
 * This file reads the future on purpose. That is legitimate HERE and only here:
 * we are measuring what happened, not deciding what to trade. Event DETECTION is
 * lookahead-free and that is the line that matters — a detection rule that
 * peeked would bias which events get counted.
 */
import { loadMany } from "./data.mjs";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "DOGEUSDT", "SOLUSDT", "ZECUSDT"];

// ------------------------------------------------------------------ helpers

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function stdev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}

/** t-stat of a sample mean against zero. */
function tstat(a) {
  if (a.length < 3) return { t: 0, mean: mean(a), se: 0 };
  const m = mean(a);
  const se = stdev(a) / Math.sqrt(a.length);
  return { t: se > 0 ? m / se : 0, mean: m, se };
}

/** Wilder-free simple ATR over a trailing window (adequate for normalisation). */
function atrSeries(bars, period = 14) {
  const out = new Array(bars.length).fill(null);
  for (let i = period; i < bars.length; i++) {
    let s = 0;
    for (let k = i - period + 1; k <= i; k++) {
      s += Math.max(
        bars[k].high - bars[k].low,
        Math.abs(bars[k].high - bars[k - 1].close),
        Math.abs(bars[k].low - bars[k - 1].close)
      );
    }
    out[i] = s / period;
  }
  return out;
}

// ------------------------------------------------------- event detection
// Every detector reads bars[0..i]. Nothing below indexes past i.

const DETECTORS = {
  // Price trades through the prior N-bar extreme and closes back inside.
  sweep_low: (b, i, p) => {
    let lo = Infinity;
    for (let k = i - p.lookback; k < i; k++) if (b[k].low < lo) lo = b[k].low;
    return b[i].low < lo && b[i].close > lo;
  },
  sweep_high: (b, i, p) => {
    let hi = -Infinity;
    for (let k = i - p.lookback; k < i; k++) if (b[k].high > hi) hi = b[k].high;
    return b[i].high > hi && b[i].close < hi;
  },
  // Close through the prior extreme, no reclaim required.
  breakout_up: (b, i, p) => {
    let hi = -Infinity;
    for (let k = i - p.lookback; k < i; k++) if (b[k].high > hi) hi = b[k].high;
    return b[i].close > hi;
  },
  breakout_dn: (b, i, p) => {
    let lo = Infinity;
    for (let k = i - p.lookback; k < i; k++) if (b[k].low < lo) lo = b[k].low;
    return b[i].close < lo;
  },
  // One bar much wider than the recent norm.
  vol_expansion: (b, i, p) => {
    const a = atrSeries(b, p.atrPeriod)[i];
    return a > 0 && (b[i].high - b[i].low) > p.volMult * a;
  },
  // Trailing range is tight.
  compression: (b, i, p) => {
    let hi = -Infinity, lo = Infinity;
    for (let k = i - p.rangeLen + 1; k <= i; k++) {
      if (b[k].high > hi) hi = b[k].high;
      if (b[k].low < lo) lo = b[k].low;
    }
    return (hi - lo) / b[i].close < p.squeeze;
  },
};

// ------------------------------------------------------------- measurement

const HORIZONS = [5, 10, 20, 48];

function measure(bars, i, atr, horizon, side) {
  // side: +1 long (did price go up?), -1 short, 0 both directions
  const entry = bars[i].close;
  const fwd = i + horizon;
  if (fwd >= bars.length) return null;
  const a = atr[i];
  if (!a || a <= 0) return null;

  const exit = bars[fwd].close;
  let mfe = 0, mae = 0;
  for (let k = i + 1; k <= fwd; k++) {
    if (side >= 0) {
      mfe = Math.max(mfe, (bars[k].high - entry) / a);
      mae = Math.min(mae, (bars[k].low - entry) / a);
    }
    if (side <= 0) {
      mfe = Math.max(mfe, (entry - bars[k].low) / a);
      mae = Math.min(mae, (entry - bars[k].high) / a);
    }
  }
  const rRet = (side === 0 ? exit - entry : side * (exit - entry)) / entry;
  // +2R before -1R, R = 1 ATR. Resolved on the FIRST bar that touches either.
  let r2 = null;
  for (let k = i + 1; k <= fwd; k++) {
    if (side >= 0 && bars[k].high >= entry + 2 * a) { r2 = 1; break; }
    if (side <= 0 && bars[k].low <= entry - 2 * a) { r2 = 1; break; }
    if (side >= 0 && bars[k].low <= entry - 1 * a) { r2 = -1; break; }
    if (side <= 0 && bars[k].high >= entry + 1 * a) { r2 = -1; break; }
  }
  return { rRet, mfe, mae, r2 };
}

// ------------------------------------------------------------------- main

const P = {
  lookback: 20, rangeLen: 50, squeeze: 0.02, volMult: 2.0, atrPeriod: 14,
};
const CLUSTER = 20; // bars; >= max horizon so windows do not overlap

const to = Math.floor(Date.parse("2026-09-27T00:00:00Z") / 1000);
const from = to - 400 * 86400;

const loaded = await loadMany({ symbols: SYMBOLS, tf: "15m", from, to, limit: 400 * 96 });
const ok = loaded.filter((x) => x.ok);
for (const f of loaded.filter((x) => !x.ok)) console.error(`  ${f.symbol}: ${f.error}`);

const names = Object.keys(DETECTORS);
// accumulators: name -> horizon -> {rets:[], mfe:[], mae:[], r2win, r2n, count}
const acc = {};
for (const nm of names) {
  acc[nm] = {};
  for (const h of HORIZONS) acc[nm][h] = { rets: [], mfe: [], mae: [], r2: [], n: 0 };
}
const base = {};
for (const h of HORIZONS) base[h] = { drift: [] };

for (const d of ok) {
  const bars = d.data.bars;
  const atr = atrSeries(bars, P.atrPeriod);
  // per-detector de-cluster state, plus one marker PER HORIZON for the
  // baseline. A single shared marker is wrong: the first horizon to record at a
  // given bar blocks the rest, so only one horizon ever fills.
  const lastSeen = { __base: {} };
  for (const h of HORIZONS) lastSeen.__base[h] = -Infinity;
  for (const nm of names) lastSeen[nm] = -Infinity;

  for (let i = P.rangeLen + 2; i < bars.length; i++) {
    if (!atr[i]) continue;
    // Unconditional baseline, de-clustered on the SAME 20-bar grid as the
    // events so every event is compared against a like-for-like distribution.
    for (const h of HORIZONS) {
      if (i - lastSeen.__base[h] < CLUSTER) continue;
      const m = measure(bars, i, atr, h, 0);
      if (m) base[h].drift.push(m.rRet);
      lastSeen.__base[h] = i;
    }
    for (const nm of names) {
      if (i - lastSeen[nm] < CLUSTER) continue;
      if (!DETECTORS[nm](bars, i, P)) continue;
      lastSeen[nm] = i;
      // a sweep_low is a long candidate; sweep_high / breakout_dn are shorts
      const side = (nm === "sweep_low" || nm === "breakout_up") ? 1
                 : (nm === "sweep_high" || nm === "breakout_dn") ? -1
                 : 0;
      for (const h of HORIZONS) {
        const m = measure(bars, i, atr, h, side);
        if (!m) continue;
        const a = acc[nm][h];
        a.rets.push(m.rRet); a.mfe.push(m.mfe); a.mae.push(m.mae);
        if (m.r2 !== null) a.r2.push(m.r2);
        a.n++;
      }
    }
  }
}

// ------------------------------------------------------------------ report

const pc = (x) => (x >= 0 ? "+" : "") + (x * 100).toFixed(3) + "%";

console.log("\n=== EVENT OUTCOME MEASUREMENT (15m, 400d, 5 symbols) ===");
console.log("All figures are EXCESS over the unconditional mean at the same horizon.");
console.log("No costs, no stops. This is signal quality only, before any execution assumption.\n");

console.log("BASELINE (unconditional forward return, de-clustered):");
for (const h of HORIZONS) {
  const b = base[h].drift;
  const mu = mean(b), sd = stdev(b);
  console.log(`  +${String(h).padStart(2)} bars: drift ${pc(mu).padStart(8)}  sd ${(sd * 100).toFixed(3)}%  n=${b.length}` +
    `   (a short's drift is exactly the negative of this)`);
}

for (const nm of names) {
  console.log(`\n--- ${nm} ---`);
  for (const h of HORIZONS) {
    const a = acc[nm][h];
    if (a.rets.length < 30) { console.log(`  +${h}: n=${a.rets.length} (too few)`); continue; }
    const side = (nm === "sweep_low" || nm === "breakout_up") ? 1
               : (nm === "sweep_high" || nm === "breakout_dn") ? -1 : 0;
    // Excess is measured against the single unconditional drift for this
    // horizon. A short event's excess is computed against the same drift with
    // the sign flipped, which is what "excess" means for a short.
    const drift = mean(base[h].drift);
    const excess = a.rets.map((r) => (side < 0 ? -r : r) - drift);
    const t = tstat(excess);
    const mfe = mean(a.mfe), mae = mean(a.mae);
    const r2 = a.r2.length ? a.r2.filter((x) => x > 0).length / a.r2.length : NaN;
    // For a bidirectional event (side 0) MFE and MAE are the same quantity with
    // opposite signs BY CONSTRUCTION - max(up, down) and min(up, down). Printing
    // them would be reporting an identity as a measurement.
    const twoSided = side === 0;
    console.log(
      `  +${String(h).padStart(2)}: n=${String(a.rets.length).padStart(4)}  ` +
      `excess ${pc(t.mean).padStart(9)}  t=${t.t.toFixed(2).padStart(6)}  ` +
      (twoSided
        ? `excursion ${mfe.toFixed(2)}R (two-sided, no direction)`
        : `MFE ${mfe.toFixed(2)}R  MAE ${mae.toFixed(2)}R`) +
      `  P(+2R before -1R) ${isNaN(r2) ? " n/a " : (r2 * 100).toFixed(1).padStart(5) + "%"}`
    );
  }
}
console.log("\nDe-clustered at 20 bars (one event per window) so overlapping forward");
console.log("paths cannot inflate significance. |t| < 2 means no detectable information.\n");
