#!/usr/bin/env node
/**
 * p003-ladder.mjs — the pre-registered selectivity ladder from card P-003.
 *
 *   node research/p003-ladder.mjs
 *   node research/p003-ladder.mjs --no-ruin
 *
 * WHAT THIS IS
 * A research INSTRUMENT, not a strategy. It cannot and should not be run
 * through the gate, and a profitable result is not an edge. The card is
 * explicit: "a diagnostic that happens to make money is still a diagnostic."
 * So it deliberately lives in research/ and not research/strategies/ — putting
 * it there would invite `npm run research --strategy …` to record it as a
 * challenger, which is the exact mistake the card warns against.
 *
 * THE QUESTION
 * sma-cross returned PF 1.013 with a Sharpe t-stat of −1.02 and an LCB of
 * −0.067. A tight interval around zero is consistent with two different worlds:
 *
 *   (1) the trigger carries nothing, or
 *   (2) the trigger carries something that a single-sign, always-on, unfiltered
 *       application has averaged to nothing.
 *
 * A pooled profit factor over 1,984 trades cannot separate them. A pre-registered
 * selectivity ladder on the IDENTICAL trigger can.
 *
 * THE 2x2 THAT MAKES IT ANSWERABLE
 * The trigger is held bit-identical to T-001 and only the FILTER is varied, in
 * two filter families, each against a signalless control carrying the same
 * filter:
 *
 *              trigger = sma-cross (f>s)        trigger = pseudo-random side
 *   family 1   gap = (fast-slow)/ATR(14)        |gap| = |fast-slow|/ATR(14)
 *   family 2   VR(q) sign flip (P-001)          |VR(q) - 1|
 *
 * Hold the filter, swap the trigger. If a ladder lifts expectancy on BOTH, the
 * filter is selecting on trendiness that every stream has, and the apparent
 * edge is a property of the filter rather than of the trigger. That is the
 * single most important number this instrument produces, and it is why the
 * control arm is not optional: "a filter that lifts expectancy on a random
 * stream will lift it on any stream, and without a control arm the slope is
 * uninterpretable."
 *
 * WHY THE CONTROL USES |gap| AND NOT gap
 * In the strategy arm gap > 0 whenever the trigger fires, so `gap >= 0` is
 * "no filter" and L0 reproduces T-001 exactly. In the control arm the side is
 * random, so the signed form `gap >= 0` would silently become a trend gate and
 * the L0 baseline would not be the raw random control. Taking the magnitude
 * makes selectivity mean the same thing in both arms — "how far apart the
 * averages are relative to noise" — and makes L0 the true signalless stream.
 * Both are the same ladder applied to the same quantity.
 *
 * REPRODUCTION GATE
 * L0 (q=0) MUST reproduce T-001: 1,984 trades, PF 1.013, and the raw control
 * 2,270 trades, PF 0.751. If it does not, the harness differs from the one the
 * recorded runs used and the ladder is measuring THAT difference instead of
 * selectivity. The card makes this non-optional, so it is checked, loudly.
 *
 * SIM CONFIG is copied from research/run.mjs, which overrides the harness
 * DEFAULTS — maxHoldBars 96 (not the harness default 40), warmup 250, and
 * ruin detection at 20% of equity. Note ruin TRUNCATES an arm, and truncation
 * cuts arms at different points, so --no-ruin re-runs every arm as a
 * sensitivity. A slope that only exists under truncation is a truncation
 * artifact.
 *
 * Reads cached OHLCV from research/data/. Reaches no network and no TradingView.
 */

import { load } from "./data.mjs";
import { simulate, metrics } from "./harness.mjs";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "DOGEUSDT", "SOLUSDT", "ZECUSDT"];
const LADDER = [0.00, 0.10, 0.25, 0.50, 1.00];

// Verbatim from research/run.mjs:254. Do not "simplify" these against harness
// DEFAULTS — maxHoldBars is 96 there and 40 in the harness, and only 96
// reproduces the recorded runs.
const SIM_CFG = { equity: 1000, riskPct: 0.01, maxHoldBars: 96, warmup: 250, ruinEquityPct: 0.2 };

// The recorded T-001 and control figures this instrument must reproduce.
const T001 = { trades: 1984, pf: 1.013 };
const CTRL = { trades: 2270, pf: 0.751 };

const to = Math.floor(Date.parse("2026-09-27T00:00:00Z") / 1000);
const from = to - 400 * 86400;

// ------------------------------------------------------------------ filters

const sma = (bars, i, n) => { let s = 0; for (let k = i - n + 1; k <= i; k++) s += bars[k].close; return s / n; };

/** Gap in ATR units. The magnitude the T-001 boolean discarded. */
const gapOf = (ctx) => {
  const { bars, i, cfg = {}, atr: a } = ctx;
  const fast = cfg.fast ?? 20, slow = cfg.slow ?? 50;
  if (i < slow + 1 || !(a > 0)) return null;
  return (sma(bars, i, fast) - sma(bars, i, slow)) / a;
};

/**
 * Variance ratio per P-001. Memoised on the bar index within a single bars
 * series, so the O(lookback) window is paid once per bar rather than once per
 * ladder level. Every window ends at `i` — bars[0..i] only, never forward.
 */
const vrMemo = new WeakMap();
function varianceRatio(bars, i, lookback, q) {
  let memo = vrMemo.get(bars);
  if (!memo) { memo = new Map(); vrMemo.set(bars, memo); }
  const key = `${i}|${lookback}|${q}`;
  if (memo.has(key)) return memo.get(key);
  let out = null;
  if (i >= lookback + q) {
    const rets = [];
    for (let k = i - lookback + 1; k <= i; k++) rets.push(bars[k].close - bars[k - 1].close);
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const m1 = mean(rets);
    const s1 = rets.reduce((a, r) => a + (r - m1) ** 2, 0) / Math.max(1, rets.length - 1);
    const agg = [];
    for (let k = 0; k + q < rets.length; k += q) {
      let s = 0; for (let j = k; j < k + q; j++) s += rets[j]; agg.push(s);
    }
    const ma = mean(agg);
    const sq = agg.reduce((a, r) => a + (r - ma) ** 2, 0) / Math.max(1, agg.length - 1);
    if (s1 > 0) out = sq / (q * s1);
  }
  memo.set(key, out);
  return out;
}

/** P-001 regime state: +1 trending, −1 mean-reverting, null inside the noise band. */
const regimeOf = (ctx, edge) => {
  const { bars, i, cfg = {} } = ctx;
  const lookback = cfg.lookback ?? 200, q = cfg.q ?? 5;
  const vr = varianceRatio(bars, i, lookback, q);
  if (vr == null || Math.abs(vr - 1) <= edge) return null;
  return vr > 1 ? 1 : -1;
};

/** P-001 re-entry filter: |close - ema20| / ATR, signed, must agree with side. */
function agrees(ctx, side, eps) {
  const { bars, i, cfg = {}, atr: a } = ctx;
  if (!(a > 0)) return false;
  const d = (bars[i].close - ema(bars, i, cfg.fast ?? 20)) / a;
  return side > 0 ? d >= eps : -d >= eps;
}

const emaMemo = new WeakMap();
function ema(bars, i, n) {
  let memo = emaMemo.get(bars);
  if (!memo) { memo = new Map(); emaMemo.set(bars, memo); }
  const key = `${i}|${n}`;
  if (memo.has(key)) return memo.get(key);
  // Bounded by i: a smoothing seed from the start of the whole series would be
  // a whole-series cache, which AGENT.md §6.11 flags as a lookahead leak.
  const k = Math.max(0, i - 200);
  let e = bars[k].close;
  const alpha = 2 / (n + 1);
  for (let j = k + 1; j <= i; j++) e = bars[j].close * alpha + e * (1 - alpha);
  memo.set(key, e);
  return e;
}

// The four arms. `trigger` is sma-cross in the A/C arms and signalless in B/D,
// so the ONLY difference between an arm and its control is what decides the side.
const ARMS = {
  "A/gap  sma-cross ": (ctx) => { const g = gapOf(ctx); if (g == null) return null;
                                  return g >= (ctx.cfg.qLevel ?? 0) ? { side: "buy" } : null; },
  "B/gap  random    ": (ctx) => { const g = gapOf(ctx); if (g == null) return null;
                                  if (Math.abs(g) < (ctx.cfg.qLevel ?? 0)) return null;
                                  const seed = (ctx.bars[ctx.i].time * 2654435761) >>> 0;
                                  return (seed % 1000) / 1000 < (ctx.cfg.buyProbability ?? 0.5)
                                    ? { side: "buy" } : { side: "sell" }; },
  "C/VR   sma-cross ": (ctx) => { const reg = regimeOf(ctx, ctx.cfg.qLevel ?? 0.10);
                                  if (reg == null) return null;
                                  const side = reg;                       // trending: continue
                                  return agrees(ctx, side, ctx.cfg.epsAtr ?? 0.25) ? { side: side > 0 ? "buy" : "sell" } : null; },
  "D/VR   random    ": (ctx) => { const reg = regimeOf(ctx, ctx.cfg.qLevel ?? 0.10);
                                  if (reg == null) return null;
                                  const seed = (ctx.bars[ctx.i].time * 2654435761) >>> 0;
                                  const side = (seed % 1000) / 1000 < (ctx.cfg.buyProbability ?? 0.5) ? 1 : -1;
                                  return agrees(ctx, side, ctx.cfg.epsAtr ?? 0.25) ? { side: side > 0 ? "buy" : "sell" } : null; },
};

// -------------------------------------------------------------------- run

async function runArm(signal, qLevel, cfg) {
  const pooled = [];
  let signalErrors = 0, firstSignalError = null, ruined = false;
  for (const symbol of SYMBOLS) {
    const { bars } = await load({ provider: "binance", symbol, tf: "15m", from, to, limit: 60000 });
    if (!bars || bars.length < 1000) throw new Error(`${symbol}: only ${bars?.length ?? 0} bars — refusing to report a ladder on a short sample`);
    const sim = simulate({ bars, signal, cfg: { ...cfg, qLevel } });
    pooled.push(...sim.trades);
    signalErrors += sim.signalErrors;
    if (sim.firstSignalError && !firstSignalError) firstSignalError = sim.firstSignalError;
    if (sim.ruined) ruined = true;
  }
  // Drawdown is meaningless for a ladder (curves are never pooled — AGENT.md
  // §6.1), so metrics() gets a flat curve. The readout is expectancy per trade.
  const m = metrics({ trades: pooled, equityCurve: [{ equity: cfg.equity }], initialEquity: cfg.equity });
  return { ...m, ruined, signalErrors, firstSignalError };
}

/** OLS coefficient of expectancy on log(trades) — the card's pre-registered slope. */
function slope(points) {
  const pts = points.filter((p) => p.trades > 0 && p.expectancy != null);
  if (pts.length < 2) return null;
  const xs = pts.map((p) => Math.log(p.trades));
  const ys = pts.map((p) => p.expectancy);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const num = xs.reduce((a, x, j) => a + (x - mx) * (ys[j] - my), 0);
  const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  return den > 0 ? num / den : null;
}

const fmt = (v, w = 9, d = 4) => (v == null || !isFinite(v) ? "n/a".padStart(w) : v.toFixed(d).padStart(w));
const bar = (s) => console.log(s);

// ------------------------------------------------------------------- main

const noRuin = process.argv.includes("--no-ruin");
const cfg = noRuin ? { ...SIM_CFG, ruinEquityPct: null } : SIM_CFG;

console.log("=".repeat(78));
console.log("P-003  selectivity ladder  —  a diagnostic, NOT a strategy");
console.log(`sim: equity ${cfg.equity}  risk ${cfg.riskPct}  hold ${cfg.maxHoldBars}  warmup ${cfg.warmup}  ruin ${cfg.ruinEquityPct ?? "off"}`);
console.log(`data: ${SYMBOLS.length} symbols x 15m x 400d (cached)  ladder ${LADDER.join(", ")}`);
console.log("=".repeat(78));

const results = {};
for (const [name, signal] of Object.entries(ARMS)) {
  results[name] = [];
  for (const q of LADDER) {
    const t0 = Date.now();
    const r = await runArm(signal, q, cfg);
    results[name].push({ level: q, ...r });
    if (r.signalErrors) console.log(`  !! ${name} signalErrors=${r.signalErrors} first=${r.firstSignalError}`);
    console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${name} level ${q.toFixed(2)} -> ${r.trades} trades, expectancy ${r.expectancy}`);
  }
}

// --- reproduction gate
bar("");
const a0 = results["A/gap  sma-cross "][0], b0 = results["B/gap  random    "][0];
const reproOk = a0.trades === T001.trades && Math.abs(a0.profitFactor - T001.pf) < 0.005;
const ctrlOk = b0.trades === CTRL.trades && Math.abs(b0.profitFactor - CTRL.pf) < 0.005;
bar("REPRODUCTION GATE  (non-optional: otherwise the ladder measures the harness)");
bar(`  T-001 sma-cross   recorded ${T001.trades} trades PF ${T001.pf}   |   got ${a0.trades} trades PF ${a0.profitFactor}   ${reproOk ? "MATCH" : "*** MISMATCH ***"}`);
bar(`  control random    recorded ${CTRL.trades} trades PF ${CTRL.pf}   |   got ${b0.trades} trades PF ${b0.profitFactor}   ${ctrlOk ? "MATCH" : "*** MISMATCH ***"}`);
if (!reproOk || !ctrlOk) {
  bar("");
  bar("  Refusing to interpret a ladder that does not reproduce its own baseline.");
  bar("  Fix the harness/config first — a slope measured against the wrong");
  bar("  baseline is a number about the harness, not about selectivity.");
  process.exit(1);
}

// --- ladders
bar("");
for (const [name, rows] of Object.entries(results)) {
  bar(`${name}   level   trades    expect/trade      PF   win%   maxDD%`);
  bar(`${" ".repeat(16)}${"-".repeat(58)}`);
  for (const r of rows) {
    bar(`${" ".repeat(10)}${r.level.toFixed(2).padStart(5)}  ${String(r.trades).padStart(7)}  ${fmt(r.expectancy, 12, 5)}  ${String(r.profitFactor).padStart(6)}  ${fmt(r.winRate, 5, 1)}  ${fmt(r.maxDrawdownPct, 7, 1)}`);
  }
  bar("");
}

// --- slopes and the verdict
const slopeA = slope(results["A/gap  sma-cross "]);
const slopeB = slope(results["B/gap  random    "]);
const slopeC = slope(results["C/VR   sma-cross "]);
const slopeD = slope(results["D/VR   random    "]);

bar("SLOPES  (expectancy regressed on log(trades); a positive slope means tightening selectivity raised per-trade expectancy)");
bar(`  gap family   sma-cross ${fmt(slopeA, 12, 6)}   control ${fmt(slopeB, 12, 6)}   difference ${fmt(slopeA - slopeB, 12, 6)}`);
bar(`  VR  family   sma-cross ${fmt(slopeC, 12, 6)}   control ${fmt(slopeD, 12, 6)}   difference ${fmt(slopeC - slopeD, 12, 6)}`);
bar("");

function verdict(s, c, label) {
  if (s == null || c == null) return `${label}: undefined (too few points)`;
  const rises = s > 0, ctrlRises = c > 0;
  const excess = s - c;
  if (rises && excess > 0) return `${label}: OUTCOME (1) — expectancy rises and the control does not rise by the same amount. The trigger is informative and FREQUENCY WAS THE COST. This buys permission to test filters. It does not buy a position.`;
  if (!rises && ctrlRises && Math.abs(excess) < Math.abs(c) * 0.5) return `${label}: CASE (a) — the trigger is noise. The ladder lifts the signalless control by about as much, so the filter is selecting on trendiness that every stream has. No filter rescues this trigger. Most informative failure in the set.`;
  if (!rises && !ctrlRises) return `${label}: CASE (b) — expectancy does not rise and the control does not either. This filter selects on nothing at all. Weaker and far less general than (a).`;
  return `${label}: MIXED — expectancy ${rises ? "rises" : "does not rise"} but the control ${ctrlRises ? "also rises" : "does not rise"}; excess ${excess.toFixed(6)}. Read the two numbers, not this label.`;
}

bar("VERDICT");
bar(`  ${verdict(slopeA, slopeB, "gap family")}`);
bar("");
bar(`  ${verdict(slopeC, slopeD, "VR  family")}`);
bar("");
bar("Reminder: this instrument CANNOT pass the gate by design (the gate needs");
bar("trades >= 500 AND PF > 1.3, and the ladder's whole point is the tight end).");
bar("A profitable arm is a diagnostic finding about frequency, not an edge, and");
bar("needs a second independent run before anyone writes a card to trade it.");
