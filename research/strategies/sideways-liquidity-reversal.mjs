/**
 * Hypothesis G - sideways liquidity sweep reversal, regime-gated and bidirectional.
 *
 * Built ON TOP of a falsified trigger. `sweep-reversal` (short-only, no regime
 * filter) measured PF 0.641 over 1,565 trades. This does not replace that
 * result; it asks whether the same trigger is worth anything once it is only
 * taken in the regime where the mechanism can exist. That is the P-003 question
 * (selectivity on a falsified trigger) applied concretely.
 *
 *   REGIME (all must hold on bar i)
 *     ADX(i)                <  adxMax                 (no directional trend)
 *     ATR percentile(i)     <= atrPctMax             (volatility low vs its own history)
 *     (hi-lo)/close over M  <  squeeze               (range is compressed)
 *
 *   ENTRY LONG
 *     bar.low  <  min(low of previous N bars)     (the range low was swept)
 *     bar.close >  that prior low                 (price closed back inside)
 *     bar.volume > volMult * mean(volume of last M)
 *     (open - close) <= dispAtr * ATR             (not a strong bearish displacement)
 *
 *   ENTRY SHORT  (exact mirror)
 *
 *   EXIT: none here. The simulator owns it - 2xATR stop, time out. A strategy
 *   that also manages its own exit cannot be compared against the others.
 *
 * Mechanism (why a sweep should revert): a range extreme in a low-ADX,
 * compressed, low-volatility market is where resting liquidity accumulates -
 * stop orders cluster just beyond the visible high/low because that is the
 * obvious place to put them. A trade through that level triggers them, and the
 * forced flow that follows is larger than the participant who caused it, so
 * price cannot sustain outside the range. The reclaim is the evidence that the
 * break failed: had the break absorbed the stops, the close would have stayed
 * outside.
 *
 * The two filters that make it different from `sweep-reversal`:
 *   1. The regime gate. A sweep only means something when there is a range to
 *      be swept. In a trending market the same print is a breakout, and the
 *      trade is backwards.
 *   2. The displacement guard. A sweep bar that also closes hard against the
 *      claimed direction is not a failed break, it is a real one - the reclaim
 *      condition is satisfied by the close while the sellers are still winning.
 *
 * Every term is a number you can print. No "smart money", no discretionary
 * judgement. No lookahead: the signal reads bars up to and including i, and the
 * simulator fills on bar i+1.
 */
export default function sidewaysLiquidityReversal({ bars, i, cfg = {} }) {
  const adxPeriod = cfg.adxPeriod ?? 14;
  const adxMax    = cfg.adxMax ?? 25;
  const lookback  = cfg.lookback ?? 20;
  const rangeLen  = cfg.rangeLen ?? 50;
  const squeeze   = cfg.squeeze ?? 0.02;
  const volLen    = cfg.volLen ?? 50;
  const volMult   = cfg.volMult ?? 2.0;
  const atrPctLen = cfg.atrPctLen ?? 200;
  const atrPctMax = cfg.atrPctMax ?? 30;
  const dispAtr   = cfg.dispAtr ?? 0.5;

  // Warmup: ADX is undefined until 2 * adxPeriod bars are in, and the ATR
  // percentile needs its own trailing window behind that.
  const warm = 2 * adxPeriod + Math.max(atrPctLen, rangeLen, lookback, volLen);
  if (i < warm) return null;

  const w = wilder(bars, adxPeriod, i);
  if (!w) return null;
  const adx = w.adx[i], atr = w.atr[i];
  if (adx == null || atr == null || atr <= 0) return null;

  // --- REGIME 1: no directional trend ---
  if (adx >= adxMax) return null;

  // --- REGIME 2: volatility low against its own trailing distribution ---
  let atOrBelow = 0, counted = 0;
  for (let k = i - atrPctLen; k <= i; k++) {
    const v = w.atr[k];
    if (v == null) continue;
    counted++;
    if (v <= atr) atOrBelow++;
  }
  if (!counted) return null;
  if ((atOrBelow / counted) * 100 > atrPctMax) return null;

  // --- REGIME 3: range compression ---
  let hi = -Infinity, lo = Infinity;
  for (let k = i - rangeLen + 1; k <= i; k++) {
    if (bars[k].high > hi) hi = bars[k].high;
    if (bars[k].low < lo) lo = bars[k].low;
  }
  if ((hi - lo) / bars[i].close >= squeeze) return null;

  // --- the range being swept (previous N bars, EXCLUDING the signal bar) ---
  let priorHigh = -Infinity, priorLow = Infinity;
  for (let k = i - lookback; k < i; k++) {
    if (bars[k].high > priorHigh) priorHigh = bars[k].high;
    if (bars[k].low < priorLow) priorLow = bars[k].low;
  }

  // --- participation ---
  let vsum = 0;
  for (let k = i - volLen; k < i; k++) vsum += bars[k].volume;
  const vavg = vsum / volLen;
  if (vavg <= 0) return null;
  const b = bars[i];
  if (b.volume <= volMult * vavg) return null;

  // --- LONG: swept the low, closed back inside, not a hard down bar ---
  if (b.low < priorLow && b.close > priorLow && (b.open - b.close) <= dispAtr * atr) {
    return { side: "buy" };
  }
  // --- SHORT: swept the high, closed back inside, not a hard up bar ---
  if (b.high > priorHigh && b.close < priorHigh && (b.close - b.open) <= dispAtr * atr) {
    return { side: "sell" };
  }
  return null;
}

export const grid = {
  adxMax: [20, 25, 30],
  lookback: [15, 20, 30],
  volMult: [1.5, 2.0],
};

/**
 * Wilder's ATR and ADX, built INCREMENTALLY and bounded by the current bar.
 *
 * Two constraints shape this, and the second one is easy to get wrong:
 *
 *   1. Wilder smoothing is recursive back to the start of the series, so
 *      recomputing it per bar would make a run O(n^2) - unusable at 38k+ bars.
 *      So the series is memoised and extended as `i` advances.
 *
 *   2. `leakage.mjs` wraps `bars` in a Proxy that THROWS if any index > i is
 *      read. An indicator that walks to `bars.length` to build its series reads
 *      the entire future and is rejected outright. So the build is bounded by
 *      `i` and never looks past it. (An earlier version of this file built the
 *      whole series per call and was correctly caught as LEAK DETECTED.)
 *
 * Cache key is `bars[0]` — the bar OBJECT, not the array. The guard hands each
 * call a brand-new Proxy, so keying on the array would miss every time, but the
 * underlying bar at index 0 is the same object either way. Keyed additionally on
 * array length, so a sliced series gets its own entry and can never serve a
 * longer or different series than the one being read.
 *
 * Every value at index k is built only from bars 0..k. No lookahead.
 *
 * Returns null until `i >= 2 * period`, where ADX is undefined.
 */
const _cache = new WeakMap(); // bar0 object -> Map(arrayLength -> entry)

function wilder(bars, period, i) {
  if (i < 2 * period) return null;
  const n = bars.length;
  if (i > n - 1) return null;

  const key = bars[0];
  if (!key) return null;
  let byLen = _cache.get(key);
  if (!byLen) { byLen = new Map(); _cache.set(key, byLen); }

  let e = byLen.get(n);
  if (!e) {
    e = {
      n, period, built: 0,
      tr: new Array(n).fill(null), dmP: new Array(n).fill(null), dmM: new Array(n).fill(null),
      atr: new Array(n).fill(null), sumP: new Array(n).fill(null), sumM: new Array(n).fill(null),
      dx: new Array(n).fill(null), adx: new Array(n).fill(null),
    };
    byLen.set(n, e);
  }
  buildTo(e, bars, i);
  return e;
}

/** Extend the cached series up to and including `upto`. Reads only bars 0..upto. */
function buildTo(e, bars, upto) {
  if (upto <= e.built) return;
  const { period, tr, dmP, dmM, atr, sumP, sumM, dx, adx } = e;

  for (let k = e.built + 1; k <= upto; k++) {
    // --- true range and directional movement ---
    const pc = bars[k - 1].close;
    tr[k] = Math.max(
      bars[k].high - bars[k].low,
      Math.abs(bars[k].high - pc),
      Math.abs(bars[k].low - pc)
    );
    const up = bars[k].high - bars[k - 1].high;
    const dn = bars[k - 1].low - bars[k].low;
    dmP[k] = up > dn && up > 0 ? up : 0;
    dmM[k] = dn > up && dn > 0 ? dn : 0;

    // --- Wilder smoothing, seeded with the mean of the first `period` values ---
    if (k === period) {
      let a = 0, p = 0, m = 0;
      for (let j = 1; j <= period; j++) { a += tr[j]; p += dmP[j]; m += dmM[j]; }
      atr[k] = a / period;
      sumP[k] = p;   // kept as a SUM: Wilder's +DI divides one by the other
      sumM[k] = m;
    } else if (k > period) {
      atr[k] = (atr[k - 1] * (period - 1) + tr[k]) / period;
      sumP[k] = sumP[k - 1] - sumP[k - 1] / period + dmP[k];
      sumM[k] = sumM[k - 1] - sumM[k - 1] / period + dmM[k];
    }

    // --- +DI / -DI -> DX ---
    if (k >= period && atr[k] > 0) {
      const pdi = (100 * sumP[k]) / (atr[k] * period);
      const mdi = (100 * sumM[k]) / (atr[k] * period);
      const tot = pdi + mdi;
      if (tot > 0) dx[k] = (100 * Math.abs(pdi - mdi)) / tot;
    }

    // --- ADX: mean of the first `period` DX values, then Wilder-smoothed ---
    if (k === 2 * period - 1) {
      let s = 0;
      for (let j = period; j <= k; j++) s += dx[j] || 0;
      adx[k] = s / period;
    } else if (k > 2 * period - 1) {
      adx[k] = (adx[k - 1] * (period - 1) + (dx[k] || 0)) / period;
    }
  }
  e.built = upto;
}
