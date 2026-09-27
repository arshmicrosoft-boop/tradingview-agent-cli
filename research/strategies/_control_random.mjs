/**
 * NEGATIVE CONTROL — deliberately meaningless.
 *
 * Exists to prove the evaluator can reject nonsense. If this ever passes the
 * gate, the gate is broken, not the strategy.
 *
 * Deterministic pseudo-random: seeded from the bar index, so runs reproduce
 * exactly. Not `Math.random`, which would make the control irreproducible.
 */
export default function randomControl({ bars, i, cfg = {} }) {
  const p = cfg.buyProbability ?? 0.5;
  const seed = (bars[i].time * 2654435761) >>> 0;
  const r = (seed % 1000) / 1000;
  return r < p ? { side: "buy" } : { side: "sell" };
}
export const grid = { buyProbability: [0.3, 0.5, 0.7] };