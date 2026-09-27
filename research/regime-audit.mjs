/**
 * regime-audit.mjs — P-001's measurement half, run BEFORE writing its strategy.
 *
 * WHY THIS FILE EXISTS INSTEAD OF A STRATEGY
 * P-001 claims the sign of short-horizon return autocorrelation is
 * state-dependent and knowable in advance. That claim is a statement about the
 * DATA, not about a trading rule, and it is cheap to test directly. Its own
 * failure condition says the card dies if "the estimated correlation sign
 * changes more often than it holds". So measure that first. If the sign is
 * noise, P-001 is dead for a minute of compute instead of a full gate run, and
 * no strategy file is written at all.
 *
 * WHAT IS MEASURED
 *   1. Distribution of rolling lag-1 autocorrelation and of the variance ratio
 *      VR(q) = sigma2_q / (q * sigma2_1) over a trailing window.
 *   2. SIGN PERSISTENCE — the decisive number. If |VR-1| flips sign more often
 *      than it holds, the regime is not knowable and the card cannot be traded.
 *   3. Conditional forward returns given each state. A state that classifies
 *      but does not separate returns is a label, not a regime.
 *   4. Separability: does the sign at bar i predict the sign at i+k? Reported
 *      as hit-rate against the base rate of simply guessing the drift sign.
 *
 * The VR estimate uses only bars[0..i] — it is recomputed on a trailing window
 * and never looks forward. Forward returns are read deliberately, because we are
 * measuring what happened rather than deciding what to trade.
 *
 * Lo & MacKinlay (1988): the naive sample autocorrelation is biased toward zero
 * when returns are noisy, which is exactly the regime crypto is in. That bias is
 * the reason this prints |t| against a zero-mean null rather than trusting the
 * sign at face value.
 */
import { loadMany } from "./data.mjs";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "DOGEUSDT", "SOLUSDT", "ZECUSDT"];
const LOOKBACK = 200;   // bars; P-001's default
const Q = 5;            // aggregation period
const EDGE = 0.10;      // |VR-1| must exceed this to act
const HORIZON = 20;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const stdev = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};
const pct = (a, p) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))];
};

const to = Math.floor(Date.parse("2026-09-27T00:00:00Z") / 1000);
const from = to - 400 * 86400;
const loaded = await loadMany({ symbols: SYMBOLS, tf: "15m", from, to, limit: 400 * 96 });
const ok = loaded.filter((x) => x.ok);
for (const f of loaded.filter((x) => !x.ok)) console.error(`  ${f.symbol}: ${f.error}`);

/** Trailing variance ratio over bars[end-L+1..end]. Uses no bar after `end`. */
function varianceRatio(bars, end, L, q) {
  if (end < L + q + 1) return null;
  const rets = [];
  for (let k = end - L + 1; k <= end; k++) rets.push(bars[k].close / bars[k - 1].close - 1);
  const m1 = mean(rets);
  let v1 = 0;
  for (const r of rets) v1 += (r - m1) ** 2;
  v1 /= rets.length - 1;
  if (!(v1 > 0)) return null;
  // aggregate into q-period returns over the same span
  const agg = [];
  for (let k = 0; k + q <= rets.length; k += q) {
    let p = 1;
    for (let j = k; j < k + q; j++) p *= 1 + rets[j];
    agg.push(p - 1);
  }
  if (agg.length < 3) return null;
  const ma = mean(agg);
  let vq = 0;
  for (const a of agg) vq += (a - ma) ** 2;
  vq /= agg.length - 1;
  return vq / (q * v1);
}

/** Lag-1 autocorrelation over the same window. */
function autocorr1(bars, end, L) {
  if (end < L + 2) return null;
  const r = [];
  for (let k = end - L + 1; k <= end; k++) r.push(bars[k].close / bars[k - 1].close - 1);
  const m = mean(r);
  let num = 0, d1 = 0, d2 = 0;
  for (let k = 1; k < r.length; k++) {
    num += (r[k] - m) * (r[k - 1] - m);
    d1 += (r[k] - m) ** 2; d2 += (r[k - 1] - m) ** 2;
  }
  return d1 > 0 && d2 > 0 ? num / Math.sqrt(d1 * d2) : null;
}

// ------------------------------------------------------------- accumulate
// SAMPLES ARE DE-CLUSTERED AT `LOOKBACK` BARS, and this matters more than
// anything else in the file.
//
// The VR estimate at bar i uses bars[i-199..i] and the forward return uses
// bars[i+1..i+20]. Two samples 20 bars apart therefore share 180 of 200 window
// bars and all of their forward path. On raw samples that n was 51,576 drawn
// from 192,000 bars, and the trend state showed t = 8.99 — a number produced
// mostly by the overlap, not by information. Taking one sample per 200-bar
// window makes the windows AND the forward paths disjoint, so the t-statistic
// means what it appears to mean. Expect it to fall.
const STRIDE = LOOKBACK;
const vrAll = [], acAll = [];
let prevState = null, holds = 0, flips = 0;
const stateFwd = { trend: [], revert: [] };
const dirFwd = { trend: [], revert: [] };
let driftPositive = 0, driftTotal = 0;

// lag-LOOKBACK sign agreement: non-overlapping windows, the honest persistence
// test. Consecutive bars overlap by 199/200 and their agreement is mechanical.
let lagPairs = 0, lagAgree = 0;
const signLadder = new Map(); // bar i -> sign, for the lag test

for (const d of ok) {
  const bars = d.data.bars;
  let prev = null;
  let lastSample = -Infinity;
  for (let i = LOOKBACK + Q + 1; i < bars.length; i++) {
    // --- the full VR computation is only needed on sampled bars, but the
    // --- persistence ladder needs every classified bar's SIGN, which is cheap.
    if (i - lastSample >= STRIDE) {
      lastSample = i;
      const vr = varianceRatio(bars, i, LOOKBACK, Q);
      if (vr == null) continue;
      const ac = autocorr1(bars, i, LOOKBACK);
      vrAll.push(vr);
      if (ac != null) acAll.push(ac);

      const state = Math.abs(vr - 1) <= EDGE ? 0 : (vr > 1 ? 1 : -1);
      if (state === 0) { prev = null; continue; }

      if (prev !== null && prev === state) holds++; else flips++;
      prev = state;

      const key = state === 1 ? "trend" : "revert";
      if (bars[i + HORIZON]) {
        const fwd = bars[i + HORIZON].close / bars[i].close - 1;
        stateFwd[key].push(fwd);
        dirFwd[key].push(Math.sign(fwd));
        if (fwd > 0) driftPositive++;
        driftTotal++;
      }
    }

    // --- sign ladder for the non-overlapping persistence test ---
    const v = varianceRatio(bars, i, LOOKBACK, Q);
    if (v == null || Math.abs(v - 1) <= EDGE) { signLadder.delete(i); continue; }
    signLadder.set(i, v > 1 ? 1 : -1);
    const back = signLadder.get(i - LOOKBACK);
    if (back !== undefined) { lagPairs++; if (back === signLadder.get(i)) lagAgree++; }
  }
}

// ----------------------------------------------------------------- report
const pc = (x) => (x >= 0 ? "+" : "") + (x * 100).toFixed(4) + "%";

console.log(`\n=== REGIME AUDIT (P-001 measurement half) ===`);
console.log(`15m, 400d, ${ok.length} symbols, lookback=${LOOKBACK}, q=${Q}, edge=${EDGE}\n`);

console.log("1. VARIANCE RATIO DISTRIBUTION");
console.log(`   n=${vrAll.length}  mean ${mean(vrAll).toFixed(4)}  sd ${stdev(vrAll).toFixed(4)}`);
console.log(`   p05 ${pct(vrAll, 0.05).toFixed(3)}  p25 ${pct(vrAll, 0.25).toFixed(3)}  ` +
            `median ${pct(vrAll, 0.5).toFixed(3)}  p75 ${pct(vrAll, 0.75).toFixed(3)}  ` +
            `p95 ${pct(vrAll, 0.95).toFixed(3)}`);
const fracTrending = vrAll.filter((v) => Math.abs(v - 1) > EDGE && v > 1).length / vrAll.length;
const fracReverting = vrAll.filter((v) => Math.abs(v - 1) > EDGE && v < 1).length / vrAll.length;
console.log(`   classified trending ${(fracTrending * 100).toFixed(1)}%  ` +
            `classified reverting ${(fracReverting * 100).toFixed(1)}%  ` +
            `unclassified ${(100 - (fracTrending + fracReverting) * 100).toFixed(1)}%`);

console.log(`\n2. LAG-1 AUTOCORRELATION (the biased estimator, for contrast)`);
console.log(`   n=${acAll.length}  mean ${mean(acAll).toFixed(4)}  sd ${stdev(acAll).toFixed(4)}`);
console.log(`   p05 ${pct(acAll, 0.05).toFixed(4)}  median ${pct(acAll, 0.5).toFixed(4)}  p95 ${pct(acAll, 0.95).toFixed(4)}`);

console.log(`\n3. SIGN PERSISTENCE  <-- P-001's primary failure condition`);
console.log(`   (a) consecutive classified bars, stride ${STRIDE} (disjoint windows):`);
const hp = holds / (holds + flips);
console.log(`       hold ${holds}  flip ${flips}  P(same) = ${(hp * 100).toFixed(1)}%`);
console.log(`   (b) sign agreement at lag ${LOOKBACK} (one full window apart):`);
const lagp = lagPairs ? lagAgree / lagPairs : NaN;
console.log(`       ${lagAgree}/${lagPairs} agree = ${(lagp * 100).toFixed(1)}%  ` +
            `[coin = 50.0%]`);
console.log(`   verdict: ${lagp > 0.6 ? "PERSISTS across a full window — regime may be knowable"
                                  : "DOES NOT PERSIST across a full window — P-001 DIES HERE"}`);
console.log(`   (consecutive-bar agreement is inflated by 199/200 window overlap and`);
console.log(`    is reported only for contrast; (b) is the number that counts)`);

console.log(`\n4. CONDITIONAL FORWARD RETURN (+${HORIZON} bars, de-clustered)`);
for (const k of ["trend", "revert"]) {
  const a = stateFwd[k];
  if (a.length < 30) { console.log(`   ${k.padEnd(7)} n=${a.length} (too few)`); continue; }
  const m = mean(a), s = stdev(a);
  const t = s > 0 ? m / (s / Math.sqrt(a.length)) : 0;
  const hit = dirFwd[k].filter((x) => x > 0).length / dirFwd[k].length;
  console.log(`   ${k.padEnd(7)} n=${String(a.length).padStart(5)}  mean ${pc(m).padStart(9)}  ` +
              `sd ${(s * 100).toFixed(3)}%  t=${t.toFixed(2).padStart(6)}  ` +
              `P(up) ${(hit * 100).toFixed(1)}%`);
}
// The comparison P-001 actually rests on: trend state minus revert state.
const aT = stateFwd.trend, aR = stateFwd.revert;
if (aT.length > 30 && aR.length > 30) {
  const diff = mean(aT) - mean(aR);
  const se = Math.sqrt(stdev(aT) ** 2 / aT.length + stdev(aR) ** 2 / aR.length);
  console.log(`   DIFFERENCE (trend - revert) = ${pc(diff).padStart(9)}  ` +
              `t=${(diff / se).toFixed(2)}`);
  console.log(`   base rate P(up): ${((driftPositive / driftTotal) * 100).toFixed(1)}%`);
}
console.log(`\nA state that classifies but whose conditional return t-stat is inside +/-2`);
console.log(`is a LABEL, not a regime. P-001's secondary failure condition is`);
console.log(`"profit factor not materially above the better fixed sign" — which is`);
console.log(`exactly what a t inside +/-2 predicts.\n`);
