/**
 * Hypothesis A - liquidity sweep reversal, expressed as numbers.
 *
 *   IF   bar.high  > max(high of previous N bars)      (took liquidity)
 *   AND  bar.close < that prior high                   (rejected it)
 *   AND  bar.volume > volMult * mean(volume of last M) (participation)
 *   THEN short on the next bar
 *
 * No "smart money", no "sweep" judgement call: every term is a number you can
 * print. Parameters are exposed so the gate can be run against variants rather
 * than one arbitrary setting.
 */
export default function sweepReversal({ bars, i, cfg = {} }) {
  const lookback = cfg.lookback ?? 20;
  const volLen   = cfg.volLen ?? 50;
  const volMult  = cfg.volMult ?? 2.0;
  if (i < lookback + volLen + 2) return null;

  let priorHigh = -Infinity;
  for (let k = i - lookback; k < i; k++) if (bars[k].high > priorHigh) priorHigh = bars[k].high;

  let vsum = 0;
  for (let k = i - volLen; k < i; k++) vsum += bars[k].volume;
  const vavg = vsum / volLen;
  if (vavg <= 0) return null;

  const b = bars[i];
  if (b.high > priorHigh && b.close < priorHigh && b.volume > volMult * vavg) {
    return { side: "sell" };
  }
  return null;
}
export const grid = { lookback: [15, 20, 25], volMult: [1.5, 2.0, 2.5] };
