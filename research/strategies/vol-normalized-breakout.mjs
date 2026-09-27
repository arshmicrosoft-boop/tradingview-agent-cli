/**
 * P-002 - volatility-normalized channel breakout.
 *
 * A claim about UNITS, not a new indicator. The trigger is donchian's and the
 * exit is the protocol's; the only change is the denominator a price distance is
 * divided by. Only the DISTANCE is normalized - the channel level stays in raw
 * price units, because a level is a price and normalizing it would destroy the
 * thing being broken through.
 *
 *   hi       = max(high[i-lookback .. i-1])        # a LEVEL, raw price
 *   dist_up  = (high[i] - hi) / atr[i]            # a DISTANCE, normalized
 *   IF   high[i] > hi AND dist_up >= k  THEN buy
 *   lo       = min(low[i-lookback .. i-1])
 *   dist_dn  = (lo - low[i]) / atr[i]
 *   IF   low[i] < lo AND dist_dn >= k  THEN sell
 *
 * WHY THIS FILE IS PARAMETERISED BEYOND THE CARD
 * The card makes a `k = 0.00` arm a mandatory control that "must reproduce
 * donchian exactly: PF 0.92, 1,645 trades". As written that is UNSATISFIABLE,
 * in three separate ways, so the control could not be run at all:
 *
 *   1. `donchian.mjs` triggers on `close[i] > hi`. This card specifies
 *      `high[i] > hi`, which is strictly looser.
 *   2. `donchian.mjs` is LONG-ONLY. This card specifies a short arm.
 *   3. At k = 0 the `dist >= k` term vanishes, which is intended - but combined
 *      with (1) and (2) the arm fires strictly more often than donchian, so it
 *      cannot return donchian's trade count under any implementation that also
 *      honours the card's own rules.
 *
 * Rather than bend the rules until the control passes - which is precisely the
 * relabelling `SCHEMA.md` exists to prevent - the trigger basis and the side are
 * exposed as config. That lets the donchian-shaped arm (`trigger:"close"`,
 * `side:"long"`, `k:0`) be run as a true reproduction check on this file's own
 * ATR and plumbing, while the card's literal form remains the default and the
 * default is what the grid tests.
 *
 * `atr_len` is pinned at 14 so the entry threshold and the protocol's 2xATR(14)
 * stop come from the same volatility estimate. Two different estimates would
 * mean entry difficulty and risk per trade are measured on two different scales,
 * and the comparison this card exists to make would be confounded.
 *
 * ATR is Wilder-smoothed, which is recursive back to the start of the series, so
 * it is built INCREMENTALLY and bounded by `i` - `leakage.mjs` wraps bars in a
 * Proxy that throws on any index > `i`, and a whole-series build reads the entire
 * future on every bar. See AGENT.md 6.11. The cache is keyed on `bars[0]`, the
 * bar OBJECT rather than the array, because the guard hands each call a fresh
 * Proxy and an array-keyed cache would miss every time; length is part of the
 * key so a sliced series cannot serve a longer one.
 */
export default function volNormalizedBreakout({ bars, i, cfg = {} }) {
  const lookback = cfg.lookback ?? 20;
  const atrLen = cfg.atrLen ?? 14;
  const k = cfg.k ?? 0.25;
  const trigger = cfg.trigger ?? "high";   // "high" = card spec, "close" = donchian
  const side = cfg.side ?? "both";          // "both" = card spec, "long" = donchian

  if (i < Math.max(lookback, atrLen) + 1) return null;

  const atr = atrAt(bars, atrLen, i);
  if (atr == null || atr <= 0) return null;

  let hi = -Infinity, lo = Infinity;
  for (let j = i - lookback; j < i; j++) {
    if (bars[j].high > hi) hi = bars[j].high;
    if (bars[j].low < lo) lo = bars[j].low;
  }

  // --- long arm ---
  if (trigger === "close" ? bars[i].close > hi : bars[i].high > hi) {
    if ((bars[i].high - hi) / atr >= k) return { side: "buy" };
  }
  // --- short arm ---
  if (side === "both" && bars[i].low < lo) {
    if ((lo - bars[i].low) / atr >= k) return { side: "sell" };
  }
  return null;
}

export const grid = {
  k: [0.10, 0.25, 0.50, 1.00],
  lookback: [10, 20, 40],
};

// ------------------------------------------------------------- leak-free ATR
const _cache = new WeakMap(); // bar0 -> Map(length -> { n, len, built, atr })

function atrAt(bars, len, i) {
  if (i < len) return null;
  const n = bars.length;
  const key = bars[0];
  if (!key) return null;
  let byLen = _cache.get(key);
  if (!byLen) { byLen = new Map(); _cache.set(key, byLen); }
  let e = byLen.get(n);
  if (!e) {
    e = { n, len, built: 0, tr: new Array(n).fill(null), atr: new Array(n).fill(null) };
    byLen.set(n, e);
  }
  const upto = Math.min(i, n - 1);
  if (upto > e.built) {
    for (let j = e.built + 1; j <= upto; j++) {
      const pc = bars[j - 1].close;
      e.tr[j] = Math.max(
        bars[j].high - bars[j].low,
        Math.abs(bars[j].high - pc),
        Math.abs(bars[j].low - pc)
      );
      if (j === len) {
        let s = 0;
        for (let q = 1; q <= len; q++) s += e.tr[q];
        e.atr[j] = s / len;
      } else if (j > len) {
        e.atr[j] = (e.atr[j - 1] * (len - 1) + e.tr[j]) / len;
      }
    }
    e.built = upto;
  }
  return e.atr[i];
}
