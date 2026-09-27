/**
 * Hypothesis C - volatility expansion breakout.
 *
 *   IF  (max(high,M) - min(low,M)) / close  <  squeeze   (compression)
 *   AND bar.close > max(high of last N)                  (breakout)
 *   AND bar.volume > volMult * mean(volume of last M)     (participation)
 *   THEN long on the next bar
 */
export default function volExpansion({ bars, i, cfg = {} }) {
  const N = cfg.lookback ?? 20;
  const M = cfg.squeezeLen ?? 50;
  const volLen = cfg.volLen ?? 50;
  const volMult = cfg.volMult ?? 1.5;
  const squeeze = cfg.squeeze ?? 0.02;
  if (i < Math.max(N, M, volLen) + 2) return null;

  let hi = -Infinity, lo = Infinity;
  for (let k = i - M; k < i; k++) { if (bars[k].high > hi) hi = bars[k].high; if (bars[k].low < lo) lo = bars[k].low; }
  const rangePct = (hi - lo) / bars[i].close;
  if (rangePct >= squeeze) return null;                    // not compressed

  let priorHigh = -Infinity;
  for (let k = i - N; k < i; k++) if (bars[k].high > priorHigh) priorHigh = bars[k].high;

  let vsum = 0;
  for (let k = i - volLen; k < i; k++) vsum += bars[k].volume;
  const vavg = vsum / volLen;
  if (vavg <= 0) return null;

  const b = bars[i];
  if (b.close > priorHigh && b.volume > volMult * vavg) return { side: "buy" };
  return null;
}