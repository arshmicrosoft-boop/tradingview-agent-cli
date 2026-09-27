/** Classic SMA crossover on whatever timeframe it is handed. */
export default function smaCross({ bars, i, cfg = {} }) {
  const fast = cfg.fast ?? 20, slow = cfg.slow ?? 50;
  if (i < slow + 1) return null;
  const avg = (n) => { let s = 0; for (let k = i - n + 1; k <= i; k++) s += bars[k].close; return s / n; };
  return avg(fast) > avg(slow) ? { side: "buy" } : null;
}
export const grid = { fast: [15, 20, 25], slow: [40, 50, 60] };
