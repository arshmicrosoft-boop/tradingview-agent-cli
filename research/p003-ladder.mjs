#!/usr/bin/env node
/**
 * p003-ladder.mjs — the pre-registered selectivity ladder from card P-003.
 *
 *   node research/p003-ladder.mjs
 *   node research/p003-ladder.mjs --no-ruin
 *   node research/p003-ladder.mjs --family=gap
 *   node research/p003-ladder.mjs --family=vr
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
 *
 * WHY THE LADDER IS SCORED IN R AND NOT IN DOLLARS
 * The first run of this instrument regressed DOLLAR expectancy on log(trades)
 * and printed "OUTCOME (1) — the trigger is informative". That verdict was an
 * artifact and is exactly the trap this file's header warns about. Position size
 * is 1% of *current* equity, so dollar pnl per trade is a function of the
 * equity path: any level with PF > 1 grows its equity and therefore inflates
 * its own dollar expectancy, while any level with PF < 1 shrinks toward zero.
 * Regressing that on trade count measures profit factor in dollar units, and it
 * reported a "rise" that was mostly compounding. The fix is to score every level
 * in R — pnl divided by the risk the stop implied — which is invariant to
 * position size, and to report a t-statistic instead of a bare slope.
 *
 * WHY A T-STATISTIC AND A PRECISION-WEIGHTED FIT
 * Two more ways the first run lied, both visible only in the per-point table:
 *   - The VR family contributes a 46-trade level whose mean has a standard error
 *     ~6x wider than a 1,900-trade level, yet unweighted OLS gives it equal
 *     influence. A 46-trade mean is noise; it was driving slope D.
 *   - With 5 points the regression has 3 degrees of freedom. A slope of 3.9 on
 *     that is t ≈ 0.8 — indistinguishable from zero. Reporting the coefficient
 *     alone implied a precision that does not exist.
 * So each point carries its own standard error, the fit is reported both
 * unweighted (as pre-registered) and precision-weighted, and a verdict is only
 * printed when the two agree AND the slope is statistically distinguishable
 * from zero. Otherwise the honest answer is "no power", and saying so is the
 * result.
 *
 * REPRODUCTION GATE
 * L0 (q=0) MUST reproduce T-001: 1,984 trades, PF 1.013, and the raw control
 * 2,270 trades, PF 0.751. If it does not, the harness differs from the one the
 * recorded runs used and the ladder is measuring THAT difference instead of
 * selectivity. Checked, loudly, before anything is interpreted.
 *
 * RUIN
 * run.mjs overrides the harness defaults with maxHoldBars 96, warmup 250, and
 * ruin detection at 20% of equity; ruin STOPS a run, so it truncates arms at
 * different bars and can make a tighter filter look like it has more trades
 * purely because it survived longer. --no-ruin re-runs everything without it.
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

const MIN_TRADES = 300;   // below this a per-trade mean is too noisy to fit
const T_CRIT = 2.353;     // two-sided 0.05, df=3 — the loosest bar we accept

const to = Math.floor(Date.parse("2026-09-27T00:00:00Z") / 1000);
const from = to - 400 * 86400;

// ------------------------------------------------------------------ filters

const sma = (bars, i, n) => { let s = 0; for (let k = i - n + 1; k <= i; k++) s += bars[k].close; return s / n; };

/** Gap in ATR units — the magnitude the T-001 boolean threw away. */
const gapOf = (ctx) => {
  const { bars, i, cfg = {}, atr: a } = ctx;
  const fast = cfg.fast ?? 20, slow = cfg.slow ?? 50;
  if (i < slow + 1 || !(a > 0)) return null;
  return (sma(bars, i, fast) - sma(bars, i, slow)) / a;
};

/**
 * Variance ratio per P-001, memoised on the bar index within one bars series so
 * the O(lookback) window is paid once per bar, not once per ladder level. Every
 * window ends at `i` — bars[0..i] only, never forward.
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
    for (let k = 0; k + q < rets.length; k += q) { let s = 0; for (let j = k; j < k + q; j++) s += rets[j]; agg.push(s); }
    const ma = mean(agg);
    const sq = agg.reduce((a, r) => a + (r - ma) ** 2, 0) / Math.max(1, agg.length - 1);
    if (s1 > 0) out = sq / (q * s1);
  }
  memo.set(key, out);
  return out;
}

/** P-001 regime: +1 trending, −1 mean-reverting, null inside the noise band. */
const regimeOf = (ctx, edge) => {
  const { bars, i, cfg = {} } = ctx;
  const vr = varianceRatio(bars, i, cfg.lookback ?? 200, cfg.q ?? 5);
  if (vr == null || Math.abs(vr - 1) <= edge) return null;
  return vr > 1 ? 1 : -1;
};

/** P-001 re-entry filter: (close - ema20)/ATR must agree in sign with the side. */
const emaMemo = new WeakMap();
function ema(bars, i, n) {
  let memo = emaMemo.get(bars);
  if (!memo) { memo = new Map(); emaMemo.set(bars, memo); }
  const key = `${i}|${n}`;
  if (memo.has(key)) return memo.get(key);
  // Bounded by i: a smoothing seed taken from the start of the whole series
  // would be a whole-series cache, which AGENT.md §6.11 flags as a leak.
  const k = Math.max(0, i - 200);
  let e = bars[k].close;
  const alpha = 2 / (n + 1);
  for (let j = k + 1; j <= i; j++) e = bars[j].close * alpha + e * (1 - alpha);
  memo.set(key, e);
  return e;
}

function agrees(ctx, side, eps) {
  const { bars, i, cfg = {}, atr: a } = ctx;
  if (!(a > 0)) return false;
  const d = (bars[i].close - ema(bars, i, cfg.fast ?? 20)) / a;
  return side > 0 ? d >= eps : -d >= eps;
}

/** The same pseudo-random side the recorded control used, seeded off bar time. */
const coin = (ctx) => {
  const seed = (ctx.bars[ctx.i].time * 2654435761) >>> 0;
  return (seed % 1000) / 1000 < (ctx.cfg.buyProbability ?? 0.5) ? 1 : -1;
};
const sideOf = (s) => (s > 0 ? { side: "buy" } : { side: "sell" });

// Four arms. The ONLY difference between an arm and its control is what decides
// the side; the filter is byte-identical within a family.
const ARMS = {
  gap: {
    "A sma-cross": (ctx) => { const g = gapOf(ctx); return g != null && g >= (ctx.cfg.qLevel ?? 0) ? { side: "buy" } : null; },
    "B random   ": (ctx) => { const g = gapOf(ctx); return g != null && Math.abs(g) >= (ctx.cfg.qLevel ?? 0) ? sideOf(coin(ctx)) : null; },
  },
  vr: {
    "C sma-cross": (ctx) => { const r = regimeOf(ctx, ctx.cfg.qLevel ?? 0.10); return r != null && agrees(ctx, r, ctx.cfg.epsAtr ?? 0.25) ? sideOf(r) : null; },
    "D random   ": (ctx) => { const r = regimeOf(ctx, ctx.cfg.qLevel ?? 0.10); return r != null && agrees(ctx, coin(ctx), ctx.cfg.epsAtr ?? 0.25) ? sideOf(coin(ctx)) : null; },
  },
};

// -------------------------------------------------------------------- run

/** Per-trade R multiple: pnl over the loss the stop implied. Size-invariant. */
function rMultiple(t) {
  const risk = Math.abs(t.entry - t.stop) * t.qty;
  return risk > 0 ? t.pnl / risk : null;
}

/**
 * Run one arm across the whole ladder.
 *
 * The series are loaded ONCE and the same arrays are handed to every level.
 * That is not a micro-optimisation: gapOf, varianceRatio and ema all memoise on
 * the identity of the `bars` array, so a fresh load per level threw the memo
 * away and rebuilt a 200-bar window for all 38,401 bars, five times over. The
 * per-bar series at index i still reads only bars[0..i] — sharing the array
 * across levels does not let any level see another level's data, it only stops
 * us recomputing the same number five times.
 */
async function runLadder(signal, cfg) {
  const series = [];
  for (const symbol of SYMBOLS) {
    const { bars } = await load({ provider: "binance", symbol, tf: "15m", from, to, limit: 60000 });
    if (!bars || bars.length < 1000) throw new Error(`${symbol}: only ${bars?.length ?? 0} bars — refusing to fit a ladder to a short sample`);
    series.push(bars);
  }

  const levels = [];
  for (const qLevel of LADDER) {
    const t0 = Date.now();
    const pooled = [];
    let ruined = false, signalErrors = 0, firstSignalError = null;
    for (const bars of series) {
      const sim = simulate({ bars, signal, cfg: { ...cfg, qLevel } });
      pooled.push(...sim.trades);
      signalErrors += sim.signalErrors;
      if (sim.firstSignalError && !firstSignalError) firstSignalError = sim.firstSignalError;
      if (sim.ruined) ruined = true;
    }
    const rs = pooled.map(rMultiple).filter((v) => v != null && isFinite(v));
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
    const sd = Math.sqrt(rs.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, rs.length - 1));
    const m = metrics({ trades: pooled, equityCurve: [{ equity: cfg.equity }], initialEquity: cfg.equity });
    const row = {
      level: qLevel, trades: pooled.length, rWithRisk: rs.length, meanR: mean,
      seR: sd / Math.sqrt(rs.length), expectancyR: m.expectancyR,
      profitFactor: m.profitFactor, winRate: m.winRate, ruined, signalErrors, firstSignalError,
    };
    levels.push(row);
    if (signalErrors) console.log(`  !! signalErrors=${signalErrors} first=${firstSignalError}`);
    console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] q=${qLevel.toFixed(2)} -> ${row.trades} trades, meanR ${mean.toFixed(4)} +/- ${row.seR.toFixed(4)}`);
  }
  return levels;
}

/**
 * Fit meanR on log(trades). Returns the unweighted fit (as pre-registered) and
 * a precision-weighted fit (weight = n, i.e. inverse variance of the mean), plus
 * a t-statistic on the unweighted slope. With 5 points there are 3 df, so the
 * t is the whole story — a coefficient alone says nothing.
 */
function fit(points) {
  const pts = points.filter((p) => p.trades >= MIN_TRADES && p.rWithRisk > 0);
  const dropped = points.length - pts.length;
  if (pts.length < 3) return { slope: null, t: null, wSlope: null, n: pts.length, dropped, r2: null };
  const xs = pts.map((p) => Math.log(p.trades));
  const ys = pts.map((p) => p.meanR);
  const ws = pts.map((p) => p.trades);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const sxy = xs.reduce((a, x, j) => a + (x - mx) * (ys[j] - my), 0);
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  const slope = sxx > 0 ? sxy / sxx : null;
  let t = null, r2 = null;
  if (slope != null) {
    const sse = ys.reduce((a, y, j) => a + (y - (my + slope * (xs[j] - mx))) ** 2, 0);
    const df = pts.length - 2;
    r2 = sxy * sxy / (sxx * ys.reduce((a, y) => a + (y - my) ** 2, 0));
    t = df > 0 && sxx > 0 ? slope / Math.sqrt(sse / df / sxx) : null;
  }
  const wsum = ws.reduce((a, b) => a + b, 0);
  const wmx = ws.reduce((a, w, j) => a + w * xs[j], 0) / wsum;
  const wmy = ws.reduce((a, w, j) => a + w * ys[j], 0) / wsum;
  const num = ws.reduce((a, w, j) => a + w * (xs[j] - wmx) * (ys[j] - wmy), 0);
  const den = ws.reduce((a, w, j) => a + w * (xs[j] - wmx) ** 2, 0);
  return { slope, t, wSlope: den > 0 ? num / den : null, n: pts.length, dropped, r2 };
}

const f = (v, w = 8, d = 3) => (v == null || !isFinite(v) ? "n/a".padStart(w) : v.toFixed(d).padStart(w));

// ------------------------------------------------------------------- main

const argv = process.argv.slice(2);
const noRuin = argv.includes("--no-ruin");
const famArg = argv.find((a) => a.startsWith("--family="));
const family = famArg ? famArg.split("=")[1] : "all";
const cfg = noRuin ? { ...SIM_CFG, ruinEquityPct: null } : SIM_CFG;

console.log("=".repeat(80));
console.log("P-003  selectivity ladder  —  a diagnostic, NOT a strategy");
console.log(`sim:    equity ${cfg.equity}  risk ${cfg.riskPct}  hold ${cfg.maxHoldBars}  warmup ${cfg.warmup}  ruin ${cfg.ruinEquityPct ?? "OFF"}`);
console.log(`data:   ${SYMBOLS.length} symbols x 15m x 400d (cached)   ladder ${LADDER.join(", ")}   min trades ${MIN_TRADES}`);
console.log(`score:  mean R per trade (position-size invariant), t on 3 df, critical |t| = ${T_CRIT}`);
console.log("=".repeat(80));

const results = {};
for (const fam of Object.keys(ARMS)) {
  if (family !== "all" && family !== fam) continue;
  for (const [name, signal] of Object.entries(ARMS[fam])) {
    console.log(`  ${fam}/${name}`);
    results[`${fam}/${name}`] = await runLadder(signal, cfg);
  }
}

// --- reproduction gate
const key = (fam, n) => `${fam}/${n}`;
const a0 = results[key("gap", "A sma-cross")]?.[0];
const b0 = results[key("gap", "B random   ")]?.[0];
if (a0 && b0) {
  const reproOk = a0.trades === T001.trades && Math.abs(a0.profitFactor - T001.pf) < 0.005;
  const ctrlOk = b0.trades === CTRL.trades && Math.abs(b0.profitFactor - CTRL.pf) < 0.005;
  const ok = reproOk && ctrlOk;
  console.log("\n" + "-".repeat(80));
  console.log("REPRODUCTION GATE  (non-optional: otherwise the ladder measures the harness, not selectivity)");
  console.log(`  T-001 sma-cross  recorded ${T001.trades} trades PF ${T001.pf}  |  got ${a0.trades} trades PF ${a0.profitFactor}   ${reproOk ? "MATCH" : "MISMATCH"}`);
  console.log(`  control random   recorded ${CTRL.trades} trades PF ${CTRL.pf}  |  got ${b0.trades} trades PF ${b0.profitFactor}   ${ctrlOk ? "MATCH" : "MISMATCH"}`);
  if (!ok && !noRuin) {
    console.log("\n  Refusing to interpret a ladder that does not reproduce its own baseline.");
    console.log("  A slope measured against the wrong baseline is a fact about the harness.");
    process.exit(1);
  }
  if (!ok && noRuin) {
    // Not a defect: T-001 and the control were both recorded WITH ruin enabled,
    // so this configuration is *supposed* to miss them. The mismatch is the
    // whole point of the sensitivity — it quantifies how much the truncation
    // was flattering the baseline.
    console.log("\n  Mismatch is EXPECTED here: the baseline runs were recorded with ruin");
    console.log("  enabled and this run has it off, so more of each series survives. The size");
    console.log("  of the gap is the sensitivity. Read the trends below, not the trade counts.");
  }
}

// --- ladders
for (const [name, rows] of Object.entries(results)) {
  const first = rows[0].trades, last = rows[rows.length - 1].trades;
  console.log(`\n${name}   (trades ${first} -> ${last}, ${((1 - last / first) * 100).toFixed(1)}% fewer)`);
  console.log(`${" ".repeat(11)}${"level".padStart(6)}${"trades".padStart(8)}${"meanR".padStart(10)}${"seR".padStart(9)}${"PF".padStart(8)}${"win%".padStart(7)}  notes`);
  console.log(`${" ".repeat(11)}${"-".repeat(50)}`);
  for (const r of rows) {
    const notes = [];
    if (r.trades < MIN_TRADES) notes.push("BELOW FLOOR");
    if (r.ruined) notes.push("ruin-truncated");
    console.log(`${" ".repeat(11)}${r.level.toFixed(2).padStart(6)}${String(r.trades).padStart(8)}${f(r.meanR, 10, 4)}${f(r.seR, 9, 4)}${String(r.profitFactor).padStart(8)}${f(r.winRate, 7, 1)}  ${notes.join(", ")}`);
  }
}

// --- fits
const fits = {};
for (const [name, rows] of Object.entries(results)) fits[name] = fit(rows);

// The two families use different arm names; anything that needs "the strategy
// arm" and "its control" has to ask here. Hardcoding "A sma-cross" silently
// skipped the whole VR family, which is exactly the kind of quiet omission that
// turns a pre-registered test into a selective one.
const PAIR = { gap: ["A sma-cross", "B random   "], vr: ["C sma-cross", "D random   "] };

console.log("\n" + "=".repeat(80));
console.log("SLOPES  (mean R regressed on log(trades); positive = tighter filter raised per-trade expectancy)");
for (const fam of Object.keys(ARMS)) {
  if (family !== "all" && family !== fam) continue;
  const [sName, cName] = PAIR[fam];
  const s = fits[`${fam}/${sName}`], ctrl = fits[`${fam}/${cName}`];
  if (!s || !ctrl) { console.log(`  ${fam}: missing arms`); continue; }
  console.log(`  ${fam}  control : slope ${f(ctrl?.slope)}  t ${f(ctrl?.t, 6, 2)}  weighted ${f(ctrl?.wSlope)}  r2 ${f(ctrl?.r2, 5, 2)}  (${ctrl?.n} points, ${ctrl?.dropped} below floor)`);
  if (s.slope != null && ctrl?.slope != null) {
    console.log(`  ${fam}  excess (strategy - control): ${f(s.slope - ctrl.slope)}   [${f(s.wSlope - (ctrl.wSlope ?? 0))} weighted]`);
  }
}

console.log("\n" + "-".repeat(80));
console.log("VERDICT");
for (const fam of Object.keys(ARMS)) {
  if (family !== "all" && family !== fam) continue;
  const [sName, cName] = PAIR[fam];
  const s = fits[`${fam}/${sName}`], c = fits[`${fam}/${cName}`];
  if (!s || s.slope == null) { console.log(`  ${fam}: NO POWER — too few points above the ${MIN_TRADES}-trade floor to fit a slope.`); continue; }
  const sigS = s.t != null && Math.abs(s.t) >= T_CRIT;
  const sigC = c?.t != null && Math.abs(c.t) >= T_CRIT;
  const agree = s.slope != null && c?.wSlope != null && Math.sign(s.slope) === Math.sign(c.wSlope);
  const excess = s.slope - (c?.slope ?? 0);
  if (!sigS) {
    console.log(`  ${fam}: NO RESULT. The strategy slope is ${f(s.slope)} with t = ${f(s.t, 5, 2)} on ${s.n - 2} df — indistinguishable from zero (|t| < ${T_CRIT}).`);
    console.log(`         P-003's question is not answered by this arm. A coefficient without a t-stat is not a finding.`);
  } else if (s.slope > 0 && excess > 0 && !agree) {
    console.log(`  ${fam}: OUTCOME (1) — expectancy rises on the trigger (t = ${f(s.t, 5, 2)}) and not on the control. The trigger is informative and FREQUENCY WAS THE COST.`);
    console.log(`         This buys permission to test filters. It does not buy a position, and it needs a second independent run.`);
  } else if (s.slope > 0 && agree && sigC) {
    console.log(`  ${fam}: CASE (a) — expectancy rises on BOTH the trigger (t = ${f(s.t, 5, 2)}) and the signalless control (t = ${f(c.t, 5, 2)}).`);
    console.log(`         The filter is selecting on trendiness that every stream has. The trigger is noise; no filter rescues it.`);
  } else if (s.slope <= 0) {
    console.log(`  ${fam}: TRIGGER CARRIES NOTHING along this filter. Expectancy does not improve as selectivity tightens (t = ${f(s.t, 5, 2)}).`);
  } else {
    console.log(`  ${fam}: MIXED / under-powered (strategy t = ${f(s.t, 5, 2)}, control t = ${f(c?.t, 5, 2)}). Read the table, not this label.`);
  }
}

console.log("\nReminder: this instrument CANNOT pass the gate by design — the gate needs");
console.log("trades >= 500 AND PF > 1.3, and a ladder's whole point is the tight end.");
console.log("A profitable arm is a diagnostic finding about FREQUENCY, not an edge.");
if (noRuin) console.log("This run had ruin DISABLED; compare against the default run before believing any trade count.");
else console.log("This run had ruin ENABLED; trade counts are truncation-sensitive, so check --no-ruin.");
