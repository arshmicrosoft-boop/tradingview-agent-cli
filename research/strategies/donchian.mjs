/** Donchian breakout on whatever timeframe it is handed. */
export default function donchian({ bars, i, cfg = {} }) {
  const n = cfg.lookback ?? 20;
  if (i < n + 1) return null;
  let hi = -Infinity;
  for (let k = i - n; k < i; k++) if (bars[k].high > hi) hi = bars[k].high;
  return bars[i].close > hi ? { side: "buy" } : null;
}