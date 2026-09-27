/**
 * Hypothesis B - trend continuation after a pullback into a prior impulse.
 *
 *   IF   close > SMA(long)                 (higher-timeframe direction is up)
 *   AND  close < highest(close, pullback)  (pulled back)
 *   AND  bar.close > bar.open              (rejection candle, buyers returned)
 *   AND  bar.volume > volMult * mean(volume of last M)
 *   THEN long on the next bar
 */
export default function trendPullback({ bars, i, cfg = {} }) {
  const trendLen = cfg.trendLen ?? 200;
  const pbLen    = cfg.pullback ?? 20;
  const volLen   = cfg.volLen ?? 50;
  const volMult  = cfg.volMult ?? 1.2;
  if (i < Math.max(trendLen, pbLen, volLen) + 2) return null;

  let s = 0;
  for (let k = i - trendLen + 1; k <= i; k++) s += bars[k].close;
  const sma = s / trendLen;
  if (bars[i].close <= sma) return null;                   // not an uptrend

  let hi = -Infinity;
  for (let k = i - pbLen; k < i; k++) if (bars[k].close > hi) hi = bars[k].close;
  if (bars[i].close >= hi) return null;                    // not pulled back

  let vsum = 0;
  for (let k = i - volLen; k < i; k++) vsum += bars[k].volume;
  const vavg = vsum / volLen;
  if (vavg <= 0) return null;

  const b = bars[i];
  if (b.close > b.open && b.volume > volMult * vavg) return { side: "buy" };
  return null;
}