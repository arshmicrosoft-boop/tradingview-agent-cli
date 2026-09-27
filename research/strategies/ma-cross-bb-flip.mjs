/**
 * MA cross (20/50) + Bollinger Bands, position-flipping — the 1m scalping rule.
 *
 * The rule being tested, stated as numbers:
 *
 *   1. A SIGNAL is a cross EVENT, not a state. MA20 crossing MA50 upward is a
 *      buy signal; crossing downward is a sell signal. Nothing fires on bars
 *      where the MAs are already separated. (This is the difference from
 *      `sma-cross`, which returns "buy" on every bar MA20 > MA50 and is
 *      therefore permanently long.)
 *
 *   2. Each signal REVERSES the existing position. The harness holds one
 *      position at a time, so returning the opposite side closes and re-opens
 *      the other way. Position state is the harness's, not the strategy's.
 *
 *   3. BB GATE — a cross only reverses if band position agrees with it:
 *        buy  requires pctB <  pctBMax   (not already overextended upward)
 *        sell requires pctB > 100-pctBMax (not already overextended downward)
 *      A cross that fires while price is stretched the other way is treated as
 *      NOISE: return null and let the existing position carry.
 *
 *   Mechanism (why rule 3 should exist at all): %B measures where price sits
 *   inside its own 20-bar distribution. A bullish cross printed while price is
 *   in the top of the band is a cross into supply, not a fresh entry — the
 *   moving averages lag price by construction, so a cross fired late reads as
 *   confirmation long after the move. The gate refuses to pay that price. The
 *   same argument inverts for sells. On 1m this matters more than on 15m
 *   because the band is narrower and the lag is the same size.
 *
 * Every term is a number you can print. Parameters are exposed so the gate can
 * test sensitivity instead of trusting one arbitrary setting.
 */
export default function maCrossBbFlip({ bars, i, cfg = {} }) {
  const fast = cfg.fast ?? 20;
  const slow = cfg.slow ?? 50;
  const bbLen = cfg.bbLen ?? 20;
  const bbMult = cfg.bbMult ?? 2.0;
  const pctBMax = cfg.pctBMax ?? 50;

  // Need: slow bars for MA50, plus one prior bar to detect a cross.
  if (i < slow + 1) return null;
  // BB needs its own window to be fully formed, independent of the MA window.
  if (i < Math.max(slow, bbLen) + 1) return null;

  const avg = (n, j) => {
    let s = 0;
    for (let k = j - n + 1; k <= j; k++) s += bars[k].close;
    return s / n;
  };

  // --- cross EVENT (state alone is not a signal) ---
  const dNow = avg(fast, i) - avg(slow, i);
  const dPrev = avg(fast, i - 1) - avg(slow, i - 1);
  const crossedUp = dPrev <= 0 && dNow > 0;
  const crossedDown = dPrev >= 0 && dNow < 0;
  if (!crossedUp && !crossedDown) return null;

  // --- BB position (%B) ---
  const mid = avg(bbLen, i);
  let sq = 0;
  for (let k = i - bbLen + 1; k <= i; k++) sq += (bars[k].close - mid) ** 2;
  const sd = Math.sqrt(sq / bbLen);
  const range = bbMult * sd * 2;
  // A dead-flat window has no band structure and no opinion to offer.
  if (range <= 0) return null;
  const pctB = ((bars[i].close - (mid - bbMult * sd)) / range) * 100;

  // --- gate: refuse a cross that is already stretched the other way ---
  if (crossedUp) return pctB < pctBMax ? { side: "buy" } : null;
  return pctB > 100 - pctBMax ? { side: "sell" } : null;
}

export const grid = {
  fast: [15, 20, 25],
  slow: [40, 50, 60],
  pctBMax: [50, 65],
};
