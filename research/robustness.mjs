#!/usr/bin/env node
/**
 * robustness.mjs — the v2 robustness suite.
 *
 * This file cannot place an order. It imports harness.mjs, which imports the
 * pure risk-engine. There is no code path from here to TradingView.
 *
 * WHY THIS EXISTS ALONGSIDE v1
 *
 * v1 is frozen and hash-pinned, and two of its robustness criteria are weaker
 * than their names claim:
 *
 *   - v1's monteCarlo() only reshuffles trade ORDER. The sum of a fixed P&L
 *     set is order-invariant, so expectancy, profit factor and Sharpe are
 *     structurally unreachable by that method. It measures the path, never the
 *     edge. bootstrapMonteCarlo() below resamples outcomes instead, which is
 *     the only way to put an uncertainty interval on the edge itself.
 *
 *   - v1's walk-forward never re-optimises. It partitions time and asks how
 *     many windows were profitable. anchoredWalkForward() below re-picks
 *     parameters on train inside every fold, which is the only way to see a
 *     strategy whose parameters are merely right for the average of the sample.
 *
 * Everything here is seeded and deterministic: same trades + same seed => same
 * numbers, every run.
 */

import { simulate, metrics } from "./harness.mjs";

// ------------------------------------------------------------------ helpers

/** Abramowitz & Stegun 7.1.26 error function. |err| < 1.5e-7. */
function erf(x) {
  const sign = Math.sign(x);
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-ax * ax));
}

const SQRT2 = Math.SQRT2;

/** Standard normal CDF. */
export function normCdf(x) {
  return 0.5 * (1 + erf(x / SQRT2));
}

/** Standard normal inverse CDF (Acklam). |err| < 1.15e-9. */
export function normInv(p) {
  if (!(p > 0 && p < 1)) throw new RangeError(`normInv needs 0 < p < 1, got ${p}`);
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const pl = 0.02425, ph = 1 - pl;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > ph) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
         (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Deterministic PRNG. Same seed => same stream, on every platform. */
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** Box-Muller, consuming two uniforms. */
function gauss(rnd) {
  let u = rnd(), v = rnd();
  if (u < 1e-12) u = 1e-12;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const quantiles = (arr, ps) => {
  const a = [...arr].sort((x, y) => x - y);
  const q = (p) => (a.length ? a[Math.min(a.length - 1, Math.max(0, Math.floor(a.length * p)))] : null);
  return Object.fromEntries(ps.map((p) => [`p${Math.round(p * 100)}`, q(p)]));
};

// ------------------------------------------------- fractional return series

/**
 * The bootstrap needs each trade's return as a FRACTION OF ACCOUNT EQUITY.
 *
 * `returnPct` is not that: it is a return on notional, and notional is up to
 * 10x equity at 10x leverage. Compounding `returnPct` onto equity is therefore
 * a 10x error, which would quietly inflate or deflate every drawdown the
 * bootstrap reports. `simulate()` records `equityBefore` on every trade for
 * exactly this reason.
 *
 * When `equityBefore` is missing (an older record, or a caller that hand-rolled
 * its trades) the series falls back to pnl/initialEquity and the report says
 * so via `fractionalBasis`, rather than quietly guessing.
 */
export function fractionalReturns(trades, initialEquity) {
  if (!trades?.length) return { fracs: [], basis: "empty" };
  let withBefore = 0;
  for (const t of trades) if (t.equityBefore > 0) withBefore++;
  // A MIXTURE of the two bases is worse than either one: the right number for
  // the first trade and an order of magnitude wrong for the rest, which
  // silently understates the decay. So it gets its own name rather than being
  // reported as a clean fallback.
  const basis = withBefore === 0 ? "initialEquity"
    : withBefore === trades.length ? "equityBefore"
    : `mixed(${withBefore}/${trades.length} equityBefore)`;
  const fracs = trades.map((t) => (
    t.equityBefore > 0 ? t.pnl / t.equityBefore
      : initialEquity > 0 ? t.pnl / initialEquity : 0
  ));
  return { fracs, basis };
}

function sharpeOf(fracs) {
  const n = fracs.length;
  if (n < 2) return null;
  const mean = fracs.reduce((a, b) => a + b, 0) / n;
  const varr = fracs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(varr);
  return sd > 0 ? mean / sd : null;
}

function profitFactorOf(fracs) {
  let win = 0, loss = 0;
  for (const f of fracs) { if (f > 0) win += f; else loss -= f; }
  return loss > 0 ? win / loss : (win > 0 ? Infinity : 0);
}

// ------------------------------------------------------- bootstrap resample

/**
 * Draw `n` source INDICES with replacement, in blocks.
 *
 *   iid   — independent draws. Correct only if trades carry no serial
 *           dependence. They do: consecutive bars of one trend are one trade
 *           cluster, so iid sampling understates the tail.
 *   block — contiguous blocks of `blockSize`, preserving within-block
 *           dependence. Default block length is ceil(n^(1/3)), the Politis &
 *           White order for stationary series.
 */
function resampleIdx(n, rnd, { method, blockSize }) {
  const out = new Array(n);
  if (method === "block") {
    const L = Math.max(1, Math.min(blockSize, n));
    const blocks = Math.ceil(n / L);
    for (let b = 0; b < blocks; b++) {
      const start = Math.floor(rnd() * (n - L + 1));
      for (let k = 0; k < L; k++) {
        const i = b * L + k;
        if (i < n) out[i] = start + k;
      }
    }
    return out;
  }
  for (let i = 0; i < n; i++) out[i] = Math.floor(rnd() * n);
  return out;
}

/**
 * Split a trade list into independent per-symbol groups.
 *
 * This is the difference between measuring a portfolio and measuring a levered
 * account. `evidence.mjs` already states the rule for the equity curve —
 * "drawdown and return are PATH properties and must NOT be pooled across
 * symbols" — and the first version of this file broke it: it concatenated five
 * independent 1000-equity accounts and compounded all of their fractional
 * returns into ONE curve with no 1/N weighting, which is a portfolio with five
 * times the capital in it. The result was arithmetically impossible as a
 * portfolio statistic: on the real data the pooled median drawdown came out at
 * 99.5% while the worst single symbol was 80.6% and the best was 34.4%. A
 * genuine equal-weight book cannot be deeper than its worst component.
 *
 * So: resample WITHIN each symbol (blocks never straddle a symbol boundary),
 * then weight every trade by 1/N and replay the merged events in time order.
 */
function groupBySymbol(trades) {
  const by = new Map();
  for (const t of trades) {
    const k = t.symbol ?? "_single";
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(t);
  }
  return [...by.entries()].map(([symbol, rows]) => ({ symbol, rows }));
}

/** One resampled portfolio event stream, in time order, equal-weighted. */
function resamplePortfolio(groups, fracsOf, rnd, { method }, blockSizeFor) {
  const nGroups = groups.length;
  const events = [];
  for (const g of groups) {
    const n = g.rows.length;
    const idx = resampleIdx(n, rnd, { method, blockSize: blockSizeFor(n) });
    for (const i of idx) {
      // 1/N: equal capital per symbol, so the book is NOT geared by N.
      events.push({ time: g.rows[i].time ?? 0, frac: fracsOf(g.rows, i) / nGroups });
    }
  }
  events.sort((a, b) => a.time - b.time);
  return events.map((e) => e.frac);
}

/** Path statistics of one resampled return stream. */
function pathStats(fracs) {
  let eq = 1, peak = 1, dd = 0, streak = 0, worst = 0;
  for (const f of fracs) {
    eq *= 1 + f;
    if (eq > peak) peak = eq;
    if (peak > 0) dd = Math.max(dd, (peak - eq) / peak);
    streak = f <= 0 ? streak + 1 : 0;
    if (streak > worst) worst = streak;
  }
  return {
    totalReturn: eq - 1,
    maxDrawdown: dd,
    sharpe: sharpeOf(fracs),
    profitFactor: profitFactorOf(fracs),
    longestLosingStreak: worst,
  };
}

// ---------------------------------------------------------- bootstrap monte carlo

/**
 * Resample trade OUTCOMES and report the distribution of the quantities that
 * actually describe an edge.
 *
 *   pProfitable             P(final equity > starting equity)
 *   pSharpePositive         P(Sharpe > 0)
 *   pProfitFactorAboveOne   P(PF > 1)
 *   sharpeP05/P50/P95       the Sharpe distribution
 *   maxDrawdownP50/P95      the drawdown distribution
 *
 * v1's monteCarlo() cannot produce any of these: it reorders a fixed P&L set,
 * and the sum of a fixed P&L set is a constant.
 */
export function bootstrapMonteCarlo({
  trades, initialEquity = 1000, runs = 1000, seed = 12345,
  method = "block", blockSize = null, ddThresholdPct = 20,
}) {
  const { fracs, basis } = fractionalReturns(trades, initialEquity);
  if (fracs.length < 20) return { runs: 0, trades: fracs.length, note: "too few trades to bootstrap" };

  const groups = groupBySymbol(trades);
  const isPortfolio = groups.length > 1;
  const L = (n) => blockSize ?? Math.ceil(Math.cbrt(n));
  const rnd = rng(seed);
  const totals = [], sharpes = [], dds = [], pfs = [], streaks = [];
  const perSymbolProfitable = new Map(groups.map((g) => [g.symbol, 0]));
  let breached = 0;

  // Per-group fractional series, so resampling stays inside one symbol.
  const groupFracs = groups.map((g) => {
    const start = trades.indexOf(g.rows[0]);
    return { g, f: fracs.slice(start, start + g.rows.length) };
  });

  for (let r = 0; r < runs; r++) {
    let bag, perSymbolOk = true;
    if (isPortfolio) {
      const events = [];
      for (const { g, f } of groupFracs) {
        const n = f.length;
        const idx = resampleIdx(n, rnd, { method, blockSize: L(n) });
        let symProfitable = false;
        let symEq = 1;
        for (const i of idx) {
          const fr = f[i] / groups.length;          // equal capital per symbol
          events.push({ time: g.rows[i].time ?? 0, frac: fr });
          symEq *= 1 + fr;
        }
        symProfitable = symEq > 1;
        if (!symProfitable) perSymbolOk = false;
        perSymbolProfitable.set(g.symbol, perSymbolProfitable.get(g.symbol) + (symProfitable ? 1 : 0));
      }
      events.sort((a, b) => a.time - b.time);
      bag = events.map((e) => e.frac);
    } else {
      bag = resampleIdx(fracs.length, rnd, { method, blockSize: L(fracs.length) })
        .map((i) => fracs[i]);
    }

    const s = pathStats(bag);
    totals.push(s.totalReturn);
    dds.push(s.maxDrawdown);
    streaks.push(s.longestLosingStreak);
    if (s.sharpe != null) sharpes.push(s.sharpe);
    if (Number.isFinite(s.profitFactor)) pfs.push(s.profitFactor);
    if (s.maxDrawdown * 100 >= ddThresholdPct) breached++;
  }

  const qs = quantiles(totals, [0.05, 0.5, 0.95]);
  const dq = quantiles(dds, [0.5, 0.95]);
  const sq = quantiles(sharpes, [0.05, 0.5, 0.95]);
  const worstSymbol = [...perSymbolProfitable.values()].reduce((a, b) => Math.min(a, b), Infinity);
  const worstSymbolPct = Number(((worstSymbol / runs) * 100).toFixed(2));

  return {
    method, runs, trades: fracs.length, blockSize: method === "block" ? L(fracs.length) : null,
    fractionalBasis: basis,
    seed,
    scope: isPortfolio ? `equal-weight portfolio of ${groups.length} symbols (1/${groups.length} per symbol)` : "single account",
    symbols: groups.map((g) => g.symbol),
    pProfitable: Number(((totals.filter((x) => x > 0).length / runs) * 100).toFixed(2)),
    pProfitableWorstSymbol: isPortfolio ? worstSymbolPct : null,
    pSharpePositive: sharpes.length ? Number(((sharpes.filter((x) => x > 0).length / sharpes.length) * 100).toFixed(2)) : null,
    pProfitFactorAboveOne: pfs.length ? Number(((pfs.filter((x) => x > 1).length / pfs.length) * 100).toFixed(2)) : null,
    sharpeP05: sq.p5, sharpeP50: sq.p50, sharpeP95: sq.p95,
    totalReturnP05: qs.p5, totalReturnP50: qs.p50, totalReturnP95: qs.p95,
    maxDrawdownP50Pct: Number((dq.p50 * 100).toFixed(2)),
    maxDrawdownP95Pct: Number((dq.p95 * 100).toFixed(2)),
    pBreach: Number(((breached / runs) * 100).toFixed(2)),
    ddThresholdPct,
    longestLosingStreakP95: quantiles(streaks, [0.95]).p95,
    note: "OUTCOME resampling with replacement, equal-weighted across symbols; v1's order-shuffle cannot move expectancy, PF or Sharpe",
  };
}

// ------------------------------------------------------- deflated sharpe

/**
 * Expected maximum of `nTrials` INDEPENDENT standard-normal Sharpes.
 *
 * Lo (2002): E[max of N] ~ (1-g) * Phi^-1(1 - 1/N) + g * Phi^-1(1 - 1/(N*e)),
 * with g the Euler-Mascheroni constant.
 *
 * There is deliberately NO square root around that expression. The sqrt(2 ln N)
 * shortcut that is often quoted alongside it is a different (and much cruder)
 * asymptotic, and wrapping the order-statistic formula in a sqrt is wrong by
 * 36% at N=100. Validated in the selftest against a 20,000-trial simulation of
 * the max of 100 normals: simulated 2.507, this formula 2.531, the sqrt-wrapped
 * form 1.591.
 */
const EULER_GAMMA = 0.5772156649015329;

export function expectedMaxSharpe(nTrials) {
  if (!(nTrials >= 1)) throw new RangeError(`expectedMaxSharpe needs >= 1 trial, got ${nTrials}`);
  if (nTrials === 1) return 0;
  const e = Math.E;
  const a = normInv(1 - 1 / nTrials);
  const b = normInv(1 - 1 / (nTrials * e));
  return Number(((1 - EULER_GAMMA) * a + EULER_GAMMA * b).toFixed(4));
}

/**
 * Probabilistic Sharpe Ratio: the probability the true Sharpe exceeds the
 * break-even level of 0, given the series' REAL skewness and kurtosis.
 *
 * Assumed normality would be dishonest here — trade P&L is bounded, fat-tailed
 * and skewed, and PSR exists precisely to correct for that.
 */
export function probabilisticSharpeRatio({ sharpe, trades, skewness = 0, kurtosis = 3 }) {
  if (sharpe == null || !(trades > 1)) return null;
  const g = skewness;
  const k = kurtosis;
  const denom = 1 - g * sharpe + (k - 1) / 4 * sharpe * sharpe;
  if (!(denom > 0)) return null;
  const z = (sharpe - 0) * Math.sqrt(trades - 1) / Math.sqrt(denom);
  return Number(normCdf(z).toFixed(6));
}

/** Sample skewness and (excess) kurtosis of a return series. */
export function moments(fracs) {
  const n = fracs.length;
  if (n < 4) return { skewness: 0, kurtosis: 3 };
  const mean = fracs.reduce((a, b) => a + b, 0) / n;
  const m2 = fracs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const m3 = fracs.reduce((a, b) => a + (b - mean) ** 3, 0) / n;
  const m4 = fracs.reduce((a, b) => a + (b - mean) ** 4, 0) / n;
  if (!(m2 > 0)) return { skewness: 0, kurtosis: 3 };
  return {
    skewness: Number((m3 / Math.pow(m2, 1.5)).toFixed(4)),
    kurtosis: Number((m4 / (m2 * m2)).toFixed(4)),   // raw, normal = 3
  };
}

/**
 * Deflated Sharpe Ratio (Bailey & Lopez de Prado).
 *
 *   DSR = Phi( (S - SR) * sqrt(n - 1) / sqrt(1 - g*S + (k - 1)/4 * S^2) )
 *
 * where SR = E[max Sharpe over nTrials] is the null Sharpe you should expect
 * from having tried nTrials things, and g/k are the series' real skewness and
 * kurtosis.
 *
 * Note the structure: SR goes INSIDE the same z-statistic PSR uses, as the
 * benchmark. The tempting alternative — compute PSR against 0 and then subtract
 * SR*sqrt(n-1) from the resulting probability — is wrong, and wrong in a way
 * that is invisible at small n: PSR is bounded in [0,1] while the penalty grows
 * with sqrt(n), so beyond a few hundred trades the subtraction always lands
 * below -inf and the DSR is a flat 0 for every strategy, real edge or not. A
 * discriminator that cannot discriminate is worse than no discriminator.
 *
 * DSR >= 0.95 means the edge is not explained by having tried this many things.
 * The bar is 0.95 and NOT 0.5 for a reason worth stating: at S exactly equal to
 * the trials-adjusted null, DSR is Phi(0) = 0.5 by construction, so a 0.5 bar
 * would put the break-even point of the test statistic on the pass line, and a
 * strategy one hair above pure luck would clear it.
 *
 * This repo has tried 15 cards and its best profit factor is 1.013; without
 * this correction, "the best of 15 was 1.013" reads exactly like an edge.
 */
export function deflatedSharpe({ sharpe, trades, nTrials, fracs = null }) {
  const mom = fracs?.length >= 4 ? moments(fracs) : { skewness: 0, kurtosis: 3 };
  const psr = probabilisticSharpeRatio({ sharpe, trades, skewness: mom.skewness, kurtosis: mom.kurtosis });
  if (psr == null) return { ok: false, reason: "insufficient trades or zero variance" };
  const esMax = expectedMaxSharpe(nTrials);
  const denom = Math.sqrt(Math.max(1e-12, 1 - mom.skewness * sharpe + (mom.kurtosis - 1) / 4 * sharpe * sharpe));
  const z = (sharpe - esMax) * Math.sqrt(Math.max(0, trades - 1)) / denom;
  const dsr = normCdf(z);
  return {
    ok: true,
    sharpe, trades, nTrials,
    skewness: mom.skewness, kurtosis: mom.kurtosis,
    psr, expectedMaxSharpe: esMax, z: Number(z.toFixed(4)),
    dsr: Number(dsr.toFixed(6)),
    survivesMultipleTesting: dsr >= 0.95,
  };
}

// ------------------------------------------------------- fill / size stress

/**
 * The bootstrap again, but every trade's execution is also wrong in a random
 * direction: size jitter and extra adverse slippage on top of modelled costs.
 *
 * costStress asks "what if fees were 2x?" — deterministic, and it can step
 * straight over the cliff. This asks "what if my fills are worse than modelled,
 * randomly, on some trades?", which is closer to a live account.
 *
 * The invariant the selftest pins: with zero perturbation and a single run, the
 * result is exactly bootstrapMonteCarlo's. It is NOT true for runs > 1 — the
 * jitter and slippage draws are taken AFTER the resample, so from the second run
 * onward the two RNG streams sit at different positions and draw different
 * resamples. Asserting the multi-run case would be asserting something false.
 *
 * Like the bootstrap, this is an equal-weight portfolio across symbols: 1/N per
 * symbol, resampled within each symbol, events replayed in time order.
 */
export function fillPerturbation({
  trades, initialEquity = 1000, runs = 500, seed = 12345,
  sizeJitterPct = 0.1, extraSlippageBps = 5, ddThresholdPct = 20, method = "block",
}) {
  const { fracs, basis } = fractionalReturns(trades, initialEquity);
  if (fracs.length < 20) return { runs: 0, note: "too few trades to perturb" };

  const groups = groupBySymbol(trades);
  const isPortfolio = groups.length > 1;
  const L = (n) => Math.ceil(Math.cbrt(n));
  const rnd = rng(seed);

  // notional per trade, aligned to the same grouping
  const notionalOf = new Map(trades.map((t, i) => [i, Math.abs((t.entry ?? 0) * (t.qty ?? 0))]));
  const startOf = new Map();
  { let acc = 0; for (const g of groups) { startOf.set(g.symbol, acc); acc += g.rows.length; } }

  const totals = [], dds = [];
  let breached = 0;

  for (let r = 0; r < runs; r++) {
    const events = [];
    for (const g of groups) {
      const n = g.rows.length;
      const base = startOf.get(g.symbol);
      const idx = resampleIdx(n, rnd, { method, blockSize: L(n) });
      for (const i of idx) {
        const gi = base + i;
        const jitter = 1 + gauss(rnd) * sizeJitterPct;
        const notional = notionalOf.get(gi) ?? 0;
        const extraCost = notional > 0 && initialEquity > 0
          ? (notional * (rnd() * extraSlippageBps) / 10000) / initialEquity : 0;
        events.push({ time: g.rows[i].time ?? 0, frac: (fracs[gi] * Math.max(0, jitter) - extraCost) / groups.length });
      }
    }
    events.sort((a, b) => a.time - b.time);
    const s = pathStats(events.map((e) => e.frac));
    totals.push(s.totalReturn);
    dds.push(s.maxDrawdown);
    if (s.maxDrawdown * 100 >= ddThresholdPct) breached++;
  }

  const dq = quantiles(dds, [0.5, 0.95]);
  return {
    runs, trades: fracs.length, seed, fractionalBasis: basis,
    scope: isPortfolio ? `equal-weight portfolio of ${groups.length} symbols` : "single account",
    sizeJitterPct, extraSlippageBps, ddThresholdPct,
    pBreach: Number(((breached / runs) * 100).toFixed(2)),
    maxDrawdownP50Pct: Number((dq.p50 * 100).toFixed(2)),
    maxDrawdownP95Pct: Number((dq.p95 * 100).toFixed(2)),
    pProfitable: Number(((totals.filter((x) => x > 0).length / runs) * 100).toFixed(2)),
    note: "bootstrap with random size error and extra adverse slippage per fill, equal-weighted across symbols",
  };
}

// ---------------------------------------------------------- slippage sweep

/**
 * Fine-grained fee x slippage grid, reporting the break-even cost per round trip.
 *
 * v1 jumps 1x/2x/5x, which can step over the cliff and report "survives
 * nothing" when the true break-even sits between two multipliers.
 *
 *   mode "cross"   the full fee x slip square. Exact, and 3x the simulations.
 *   mode "paired"  three legs per level — fee-only, slippage-only, and a
 *                  diagonal split of the same total — plus the far corner.
 *                  Survival tracks the SUM of fee and slippage closely, so the
 *                  diagonal locates the cliff and the axis legs bound it.
 *
 * Paired is the default because cost SURVIVAL is already a v1 criterion
 * (`stress`, the 3x3 grid); this sweep exists to refine WHERE the cliff is, not
 * to re-decide whether it exists. That matters here: the cost is the strategy's
 * own signal function evaluated over 38,401 bars, multiplied by the number of
 * grid points. On `sideways-liquidity-reversal`, the slowest strategy in the
 * repo, cross mode costs 1184s against 300s for paired.
 *
 * WHAT PAIRED GIVES UP, precisely: it samples a SUBSET of the (fee, slippage)
 * pairs, so its break-even is a LOWER BOUND on cross mode's — never higher,
 * because the winner over a subset cannot exceed the winner over the whole set.
 * The cost split is not quite irrelevant (fee and slippage hit opposite sides
 * of a trade), so the bound can be a few bps loose. The selftest pins all three
 * of these properties rather than asserting the two modes agree exactly, which
 * they do not.
 */
export function slippageSweep({
  bars, signal, cfg = {}, baseFeeBps = 10, baseSlipBps = 5,
  feeSteps = [0, 2, 5, 8, 10, 15, 20, 30, 50, 80],
  slipSteps = [0, 2, 5, 8, 10, 15, 20, 30, 50, 80],
  mode = "paired",
}) {
  const points = [];
  if (mode === "cross") {
    for (const f of feeSteps) for (const s of slipSteps) points.push([f, s]);
  } else {
    const levels = [...new Set([...feeSteps, ...slipSteps])].sort((a, b) => a - b);
    for (const c of levels) {
      points.push([c, 0], [0, c]);                          // axis legs
      const half = Math.floor(c / 2);
      points.push([half, c - half]);                        // diagonal: exact total c, odd or even
    }
    const maxF = Math.max(...feeSteps), maxS = Math.max(...slipSteps);
    points.push([maxF, maxS]);                              // the far corner, for full range coverage
  }

  const grid = points.map(([f, s]) => {
    const c = { ...cfg, feeBps: f, slippageBps: s };
    const r = simulate({ bars, signal, cfg: c });
    const m = metrics({ trades: r.trades, equityCurve: r.equityCurve, initialEquity: r.cfg.equity, ruined: r.ruined });
    return {
      feeBps: f, slipBps: s, roundTripBps: f + s,
      profitFactor: m.profitFactor, sharpe: m.sharpe, trades: m.trades, ruined: r.ruined,
    };
  });

  const winners = grid.filter((g) => !g.ruined && Number(g.profitFactor) > 1);
  const best = winners.length ? winners.reduce((a, b) => (a.roundTripBps > b.roundTripBps ? a : b)) : null;
  return {
    mode,
    baseRoundTripBps: baseFeeBps + baseSlipBps,
    points: grid.length,
    grid,
    profitable: winners.length,
    survivalRate: Number((winners.length / grid.length).toFixed(3)),
    breakEvenRoundTripBps: best ? best.roundTripBps : 0,
    breakEvenPoint: best ?? null,
    note: mode === "cross"
      ? "full fee x slip cross product; finer than v1's 1x/2x/5x, so the cliff cannot be stepped over"
      : "paired fee-only / slip-only / diagonal legs; survival depends on the sum, so the diagonal is the answer",
  };
}

// ------------------------------------------------------- anchored walk-forward

/** Cartesian product of a parameter grid. */
function gridVariants(grid) {
  const keys = Object.keys(grid);
  if (!keys.length) return [{}];
  const out = [];
  const idx = new Array(keys.length).fill(0);
  for (;;) {
    out.push(Object.fromEntries(keys.map((k, j) => [k, grid[k][idx[j]]])));
    let j = keys.length - 1;
    while (j >= 0) { idx[j]++; if (idx[j] < grid[keys[j]].length) break; idx[j] = 0; j--; }
    if (j < 0) break;
  }
  return out;
}

/**
 * Anchored (expanding-train) walk-forward with PER-FOLD re-optimisation.
 *
 * For each fold: choose parameters on TRAIN ONLY by running the declared grid,
 * then trade the forward window with those exact parameters. The test window is
 * never seen during selection — that is the whole difference from v1's fold
 * count, which never re-optimises and so cannot see a strategy that is only
 * right for the average of the sample.
 *
 *   efficiencyRatio  mean OOS fold Sharpe / mean IS fold Sharpe
 *   foldCoverage     % of folds that produced ANY out-of-sample trades. Gated,
 *                     because a strategy that goes silent out of sample must not
 *                     score 100% consistency across the folds that did fire.
 *   stationarityT    paired Student t on the per-fold (OOS - IS) Sharpe gap.
 *                   Sign convention: MORE NEGATIVE IS WORSE. Stationary means
 *                   the differences are noise around zero; a strategy whose
 *                   parameters only fit the whole sample gives a systematically
 *                   negative difference, so t goes large and negative.
 */
export function anchoredWalkForward({
  bars, signal, cfg = {}, grid = {}, folds = 4, warmup = 250, objective = "sharpe",
}) {
  const usable = bars.slice(warmup);
  const need = 400;
  if (usable.length < need) return { folds: 0, note: `not enough bars: ${usable.length} < ${need} after warmup` };

  const variants = gridVariants(grid);
  const seg = Math.floor(usable.length / (folds + 1));
  if (seg < 100) return { folds: 0, note: `fold window too small: ${seg} bars` };

  const score = (m) => (objective === "sharpe" ? (m.sharpe ?? -99)
    : objective === "pf" ? (m.profitFactor === "inf" ? 99 : Number(m.profitFactor))
    : m.totalReturnPct);

  const perFold = [];
  for (let f = 0; f < folds; f++) {
    const testStart = (f + 1) * seg;
    const train = usable.slice(0, testStart);
    const hist = train.slice(-warmup);                 // indicator priming, no future
    const trainRun = [...hist, ...train.slice(0, train.length - warmup)];
    const testBars = usable.slice(testStart, testStart + seg);
    const testHist = usable.slice(Math.max(0, testStart - warmup), testStart);
    if (train.length < 200 || testBars.length < 50) continue;

    // --- select on train only
    let best = null;
    for (const params of variants) {
      const r = simulate({ bars: trainRun, signal, cfg: { ...cfg, ...params, warmup: hist.length } });
      const m = metrics({ trades: r.trades, equityCurve: r.equityCurve, initialEquity: r.cfg.equity, ruined: r.ruined });
      const sc = r.ruined ? -Infinity : score(m);
      if (!best || sc > best.score) best = { params, score: sc, metrics: m, trades: r.trades.length };
    }

    // --- trade the unseen window with exactly those parameters
    const testRun = [...testHist, ...testBars];
    const rt = simulate({ bars: testRun, signal, cfg: { ...cfg, ...best.params, warmup: testHist.length } });
    const mt = metrics({ trades: rt.trades, equityCurve: rt.equityCurve, initialEquity: rt.cfg.equity, ruined: rt.ruined });

    perFold.push({
      fold: f + 1,
      trainBars: train.length,
      trainEndTime: train[train.length - 1].time,
      testStartTime: testBars[0].time,
      testBars: testBars.length,
      variantsTested: variants.length,
      chosen: best.params,
      is: { sharpe: best.metrics.sharpe, profitFactor: best.metrics.profitFactor, trades: best.trades, totalReturnPct: best.metrics.totalReturnPct },
      oos: { sharpe: mt.sharpe, profitFactor: mt.profitFactor, trades: mt.trades, totalReturnPct: mt.totalReturnPct, ruined: rt.ruined },
    });
  }

  if (!perFold.length) return { folds: 0, perFold: [], note: "no fold had enough train and test bars" };

  const isS = perFold.map((x) => x.is.sharpe).filter((x) => x != null);
  const oosS = perFold.map((x) => x.oos.sharpe).filter((x) => x != null);
  const diffs = perFold.filter((x) => x.is.sharpe != null && x.oos.sharpe != null).map((x) => x.oos.sharpe - x.is.sharpe);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const sd = (a) => {
    if (a.length < 2) return null;
    const m = mean(a);
    return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
  };
  const dMean = mean(diffs), dSd = sd(diffs);
  const t = dMean != null && dSd != null && dSd > 0 ? dMean / (dSd / Math.sqrt(diffs.length)) : null;

  const traded = perFold.filter((x) => x.oos.trades > 0);
  const profitable = traded.filter((x) => x.oos.totalReturnPct > 0);
  const isMean = mean(isS);
  const oosMean = mean(oosS);
  const effOk = isS.length && oosS.length && isMean > 0;

  // SILENT FOLDS ARE A FAILURE, NOT A FILTER-OUT.
  //
  // `traded` and `oosS` both exclude folds that produced no trades, so every
  // statistic below is computed over the folds that happened to fire. A signal
  // that trades for the first 1900 bars and is then silent for the last 1100
  // (~37% of the sample) scored consistency 100%, meanOosSharpe 2.72 and an
  // efficiency ratio of 1.31, and cleared all three walk-forward criteria with
  // perfect marks — while being unable to trade for more than a third of the
  // out-of-sample period. That is precisely the "only right for the average of
  // the sample" failure the anchored walk-forward exists to detect, and it is
  // what a walk-forward is supposed to expose.
  //
  // So the coverage ratio is reported, and `anchoredWalkForward` reports it as
  // its own field for the gate to read. It is a separate field precisely so that
  // no downstream consumer can accidentally read the filtered statistics
  // without also seeing how much was filtered out.
  const coverage = perFold.length ? Number(((traded.length / perFold.length) * 100).toFixed(1)) : null;

  return {
    folds: perFold.length,
    perFold,
    warmup, seg,
    variantsTotal: variants.length,
    // A strategy with no declared grid yields one variant, so nothing is
    // actually re-optimised. v2 advertises per-fold re-optimisation; for these
    // strategies the test could not run, and the report has to say so rather
    // than let "walk-forward" imply a search that never happened.
    reoptimised: variants.length > 1,
    reoptimisedNote: variants.length > 1
      ? `${variants.length} variants re-selected on train in each of ${perFold.length} folds`
      : "strategy declares no parameter grid, so folds did not re-optimise — this is v1's fold count, not an anchored search",
    foldsWithTrades: traded.length,
    foldsSilent: perFold.length - traded.length,
    foldCoverage: coverage,
    foldsProfitable: profitable.length,
    consistency: traded.length ? Number(((profitable.length / traded.length) * 100).toFixed(1)) : null,
    meanIsSharpe: isS.length ? Number(isMean.toFixed(3)) : null,
    meanOosSharpe: oosS.length ? Number(oosMean.toFixed(3)) : null,
    worstOosSharpe: oosS.length ? Number(Math.min(...oosS).toFixed(3)) : null,
    efficiencyRatio: effOk ? Number((oosMean / isMean).toFixed(3)) : null,
    // An unexplained null reads as a bug rather than as a verdict. Retention
    // is undefined when mean in-sample Sharpe is not positive, because the
    // ratio of a negative IS by a negative OOS says nothing about retention.
    efficiencyNote: effOk ? null
      : !isS.length ? "no fold produced an in-sample Sharpe"
      : `undefined: mean in-sample Sharpe is ${isMean.toFixed(3)}, so OOS/IS retention has no meaning`,
    // A paired Student t on the per-fold (OOS - IS) Sharpe differences, not
    // Welch's: the differences are pairs from the same fold, which is a paired
    // design. Sign convention: MORE NEGATIVE IS WORSE.
    stationarityT: t == null ? null : Number(t.toFixed(3)),
    stationarityNote: "more negative = worse: OOS reliably below IS across folds (paired t)",
    totalOosTrades: perFold.reduce((a, x) => a + x.oos.trades, 0),
  };
}

// --------------------------------------------------------------- selftest
if (process.argv[1] && process.argv[1].endsWith("robustness.mjs")) {
  let pass = 0, fail = 0;
  const check = (n, c, x = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); };
  console.log("robustness.mjs selftest\n");

  // ---- normal distribution primitives
  check("normCdf(0) = 0.5", Math.abs(normCdf(0) - 0.5) < 1e-6, `${normCdf(0)}`);
  check("normCdf(1.96) ~ 0.975", Math.abs(normCdf(1.96) - 0.975) < 1e-3, `${normCdf(1.96).toFixed(5)}`);
  check("normInv round-trips normCdf", Math.abs(normCdf(normInv(0.975)) - 0.975) < 1e-6,
    `normInv(0.975)=${normInv(0.975).toFixed(5)}`);
  check("normInv rejects p outside (0,1)", (() => { try { normInv(0); return false; } catch { return true; } })());

  // ---- expected max Sharpe
  check("expectedMaxSharpe(1) = 0", expectedMaxSharpe(1) === 0);
  check("expectedMaxSharpe grows with trial count",
    expectedMaxSharpe(1000) > expectedMaxSharpe(100) && expectedMaxSharpe(100) > expectedMaxSharpe(15),
    `15->${expectedMaxSharpe(15)} 100->${expectedMaxSharpe(100)} 1000->${expectedMaxSharpe(1000)}`);

  // Validate against GROUND TRUTH: simulate the max of N standard normals and
  // compare. The crude sqrt(2 ln N) shortcut is a poor check here — it gives
  // 3.03 at N=100 where the expected max of 100 normals is 2.51, because it
  // assumes the tail is dominated by the single largest of N rather than by the
  // shape of the order statistics. A cross-check against a wrong approximation
  // is worse than no cross-check, so this one simulates instead.
  {
    const N = 100, TRIALS = 20000;
    const r = rng(4242);
    const maxima = [];
    for (let t = 0; t < TRIALS; t++) {
      let m = -Infinity;
      for (let i = 0; i < N; i++) m = Math.max(m, gauss(r));
      maxima.push(m);
    }
    const empirical = maxima.reduce((a, b) => a + b, 0) / TRIALS;
    const analytic = expectedMaxSharpe(N);
    check("expectedMaxSharpe matches the simulated max of 100 normals within 3%",
      Math.abs(analytic - empirical) / empirical < 0.03,
      `analytic ${analytic} vs simulated ${empirical.toFixed(4)} (n=${N}, ${TRIALS} trials)`);
    check("the sqrt(2 ln N) shortcut really is the wrong cross-check",
      Math.abs(Math.sqrt(2 * Math.log(N)) - empirical) / empirical > 0.15,
      `sqrt(2 ln 100) = ${Math.sqrt(2 * Math.log(N)).toFixed(3)} vs simulated ${empirical.toFixed(3)}`);
  }
  // ---- fractional returns: the 10x-notional trap
  {
    const t = [{ pnl: 10, equityBefore: 1000, returnPct: 1, entry: 100, qty: 100 }];
    check("fractional return uses equityBefore, not notional",
      Math.abs(fractionalReturns(t, 1000).fracs[0] - 0.01) < 1e-12,
      `${fractionalReturns(t, 1000).fracs[0]}`);
    check("missing equityBefore falls back and says so",
      fractionalReturns([{ pnl: 10 }], 1000).basis === "initialEquity");
  }

  // ---- bootstrap Monte Carlo
  // Build a REAL trade set by simulation so the tests use the same shape the
  // runner produces. A hand-rolled set would not exercise the same path.
  const mkBars = (n, drift) => {
    const b = []; let px = 100;
    for (let i = 0; i < n; i++) {
      const o = px, c = px + drift + Math.sin(i / 3) * 1.2;
      b.push({ time: 1767225600 + i * 900, open: o, high: Math.max(o, c) + 1, low: Math.min(o, c) - 1, close: c, volume: 1 });
      px = c;
    }
    return b;
  };
  const alwaysLong = () => ({ side: "buy" });
  const good = mkBars(1500, 0.35);
  // A flat, choppy market is the honest "unprofitable" fixture, and it is the
  // one this repo actually produces: gross edge ~0 and 15 bps per round trip
  // charged on a churn-heavy stream. A steadily FALLING market was the obvious
  // choice and is the wrong one — every long stops out within two bars, so it
  // yields 36 trades and a bootstrap that is measuring almost nothing.
  const bad = mkBars(4000, 0);
  const simOf = (bars, cfg = {}) => {
    const r = simulate({ bars, signal: alwaysLong, cfg: { maxHoldBars: 8, ...cfg } });
    return r.trades;
  };
  const goodTrades = simOf(good), badTrades = simOf(bad);
  check("bootstrap fixtures produced enough trades", goodTrades.length > 50 && badTrades.length > 100,
    `${goodTrades.length} good / ${badTrades.length} bad`);
  check("the losing fixture really is unprofitable",
    Number(goodTrades.reduce((a, t) => a + t.pnl, 0)) > 0 &&
    Number(badTrades.reduce((a, t) => a + t.pnl, 0)) < 0,
    `good ${goodTrades.reduce((a, t) => a + t.pnl, 0).toFixed(1)} / bad ${badTrades.reduce((a, t) => a + t.pnl, 0).toFixed(1)}`);

  const bc1 = bootstrapMonteCarlo({ trades: goodTrades, runs: 400, seed: 7 });
  const bc2 = bootstrapMonteCarlo({ trades: goodTrades, runs: 400, seed: 7 });
  const bc3 = bootstrapMonteCarlo({ trades: goodTrades, runs: 400, seed: 8 });
  check("bootstrap is deterministic on a real statistic",
    bc1.sharpeP50 === bc2.sharpeP50 && bc1.pProfitable === bc2.pProfitable,
    `p50 ${bc1.sharpeP50} vs ${bc2.sharpeP50}`);
  check("a DIFFERENT seed changes the answer (negative control)",
    bc1.maxDrawdownP50Pct !== bc3.maxDrawdownP50Pct || bc1.sharpeP50 !== bc3.sharpeP50,
    `seed7 ${bc1.maxDrawdownP50Pct}% / seed8 ${bc3.maxDrawdownP50Pct}%`);
  check("bootstrap refuses on too few trades",
    bootstrapMonteCarlo({ trades: goodTrades.slice(0, 10) }).runs === 0);
  check("probabilities are in [0,100]",
    bc1.pProfitable >= 0 && bc1.pProfitable <= 100 && bc1.pSharpePositive >= 0 && bc1.pSharpePositive <= 100,
    `pProfitable=${bc1.pProfitable}% pSharpePos=${bc1.pSharpePositive}%`);

  const bcGood = bootstrapMonteCarlo({ trades: goodTrades, runs: 400, seed: 7 });
  const bcBad = bootstrapMonteCarlo({ trades: badTrades, runs: 400, seed: 7 });
  check("a profitable strategy has P(profitable) well above 50%",
    bcGood.pProfitable > 50, `${bcGood.pProfitable}%`);
  check("a losing strategy has P(profitable) well below 50%",
    bcBad.pProfitable < 50, `${bcBad.pProfitable}%`);
  check("bootstrap separates good from bad on P(Sharpe>0)",
    bcGood.pSharpePositive > bcBad.pSharpePositive,
    `${bcGood.pSharpePositive}% vs ${bcBad.pSharpePositive}%`);
  check("the drawdown tail is worse for the losing strategy",
    bcBad.maxDrawdownP95Pct > bcGood.maxDrawdownP95Pct,
    `${bcBad.maxDrawdownP95Pct}% vs ${bcGood.maxDrawdownP95Pct}%`);

  // v1's order-shuffle CANNOT do this. Prove the distinction is real.
  {
    const { monteCarlo } = await import("./harness.mjs");
    const v1mc = monteCarlo({ trades: goodTrades, initialEquity: 1000, runs: 200 });
    check("v1's order-shuffle CANNOT report P(profitable) — the distinction is real",
      v1mc.pProfitable === undefined && v1mc.probabilityOfBreachingThreshold !== undefined,
      "v1 reports a path breach probability only; v2 reports edge probability");
  }

  // Quantile ordering must hold, or every percentile in the report is noise.
  check("bootstrap quantiles are ordered (return)",
    bcGood.totalReturnP05 <= bcGood.totalReturnP50 && bcGood.totalReturnP50 <= bcGood.totalReturnP95,
    `${bcGood.totalReturnP05} / ${bcGood.totalReturnP50} / ${bcGood.totalReturnP95}`);
  check("bootstrap quantiles are ordered (sharpe)",
    bcGood.sharpeP05 <= bcGood.sharpeP50 && bcGood.sharpeP50 <= bcGood.sharpeP95,
    `${bcGood.sharpeP05} / ${bcGood.sharpeP50} / ${bcGood.sharpeP95}`);

  // Block bootstrap must produce a FATTER tail than iid on an autocorrelated
  // series. Trades here arrive in clusters (consecutive bars of one trend), so
  // iid sampling understates the tail. If this fails, blockSize is not working.
  {
    const clustered = [];
    for (let k = 0; k < 60; k++) {
      const sign = k % 2 === 0 ? 1 : -1;
      for (let j = 0; j < 12; j++) clustered.push({ pnl: sign * (5 + j * 0.3), equityBefore: 1000, entry: 100, qty: 10 });
    }
    const iidB = bootstrapMonteCarlo({ trades: clustered, runs: 600, seed: 3, method: "iid" });
    const blkB = bootstrapMonteCarlo({ trades: clustered, runs: 600, seed: 3, method: "block" });
    check("block bootstrap has a fatter drawdown tail than iid on clustered trades",
      blkB.maxDrawdownP95Pct > iidB.maxDrawdownP95Pct,
      `block ${blkB.maxDrawdownP95Pct}% > iid ${iidB.maxDrawdownP95Pct}%`);
  }

  // ---- deflated Sharpe
  //
  // These tests need SMALL n on purpose. PSR is a probability in [0,1], so at
  // n in the thousands any Sharpe above ~0.1 saturates it at 1.0 and the DSR
  // becomes a flat 0 for every strategy. Monotonicity is only observable in the
  // interior, so the fixtures sit near the null maximum for their trial count.
  {
    const ds15 = deflatedSharpe({ sharpe: 1.2, trades: 30, nTrials: 15 });
    const ds1 = deflatedSharpe({ sharpe: 1.2, trades: 30, nTrials: 1 });
    check("deflating against 15 trials is harsher than against 1",
      ds15.dsr < ds1.dsr, `15 trials ${ds15.dsr} < 1 trial ${ds1.dsr}`);
    check("deflated DSR stays in the interior (not saturated at 0 or 1)",
      ds15.dsr > 0 && ds15.dsr < 1, `dsr=${ds15.dsr}`);

    const more = deflatedSharpe({ sharpe: 1.2, trades: 30, nTrials: 15 });
    const fewer = deflatedSharpe({ sharpe: 1.2, trades: 30, nTrials: 5 });
    check("more trials => lower DSR at the same Sharpe and sample",
      more.dsr < fewer.dsr, `15 -> ${more.dsr}, 5 -> ${fewer.dsr}`);

    // DSR moves with n in OPPOSITE directions depending on which side of the
    // trials-adjusted null the observed Sharpe sits. Asserting only one
    // direction is how a one-sided test sneaks past a broken formula.
    const aboveSmall = deflatedSharpe({ sharpe: 2.2, trades: 30, nTrials: 15 });
    const aboveBig = deflatedSharpe({ sharpe: 2.2, trades: 3000, nTrials: 15 });
    check("more samples RAISE the DSR when Sharpe beats the trials null",
      aboveBig.dsr > aboveSmall.dsr, `n=3000 -> ${aboveBig.dsr}, n=30 -> ${aboveSmall.dsr}`);
    const belowSmall = deflatedSharpe({ sharpe: 1.2, trades: 30, nTrials: 15 });
    const belowBig = deflatedSharpe({ sharpe: 1.2, trades: 3000, nTrials: 15 });
    check("more samples LOWER the DSR when Sharpe is below the trials null",
      belowBig.dsr < belowSmall.dsr, `n=3000 -> ${belowBig.dsr}, n=30 -> ${belowSmall.dsr}`);

    // The headline case: a big sample and a real edge clears it comfortably...
    const solid = deflatedSharpe({ sharpe: 0.35, trades: 2000, nTrials: 1 });
    check("a large-sample real edge survives deflation against 1 trial",
      solid.survivesMultipleTesting === true, `dsr=${solid.dsr}`);
    // ...and the best of 15 lucky runs does not, at ANY sample size.
    const luckySharpe = expectedMaxSharpe(15) + 0.01;
    for (const n of [30, 500, 5000]) {
      const lucky = deflatedSharpe({ sharpe: luckySharpe, trades: n, nTrials: 15 });
      check(`the BEST of 15 lucky runs does NOT survive deflation (n=${n})`,
        lucky.survivesMultipleTesting === false, `sharpe=${lucky.sharpe} (null max ${expectedMaxSharpe(15)}) dsr=${lucky.dsr}`);
    }
  }

  // Skew and kurtosis must actually be USED, or PSR is just normality in disguise.
  {
    const fat = Array.from({ length: 12 }, (_, i) => (i % 3 === 0 ? 0.4 : -0.02));
    const thin = Array.from({ length: 12 }, () => 0.01);
    const a = deflatedSharpe({ sharpe: 0.3, trades: 12, nTrials: 1, fracs: fat });
    const b = deflatedSharpe({ sharpe: 0.3, trades: 12, nTrials: 1, fracs: thin });
    check("PSR uses real skew/kurtosis, not an assumed normal",
      a.psr !== b.psr, `fat-tailed psr=${a.psr} (skew ${a.skewness}, kurt ${a.kurtosis}) vs normal psr=${b.psr}`);
    const mom = moments(fat);
    check("moments report non-zero skew for a skewed series",
      Math.abs(mom.skewness) > 0.1, `skew=${mom.skewness} kurt=${mom.kurtosis}`);
    check("a fat tail makes PSR LESS confident at the same Sharpe",
      a.psr < b.psr, `${a.psr} < ${b.psr}`);
  }

  // ---- fill perturbation
  {
    const zero = fillPerturbation({ trades: goodTrades, runs: 400, seed: 7, sizeJitterPct: 0, extraSlippageBps: 0 });
    const noisy = fillPerturbation({ trades: goodTrades, runs: 400, seed: 7, sizeJitterPct: 0.25, extraSlippageBps: 15 });
    // Zero perturbation means every bag is the plain bootstrap's bag. That is
    // exactly true for the FIRST run only: the jitter and slippage draws happen
    // after the resample, so from run 2 onward the two RNG streams sit at
    // different positions and draw different resamples. Asserting multi-run
    // equality here would be asserting something false; the honest invariant is
    // the one-run case, and the noise comparison below is a controlled one
    // because both settings share a seed and therefore the run-1 resample.
    const oneRunBoot = bootstrapMonteCarlo({ trades: goodTrades, runs: 1, seed: 7 });
    const oneRunZero = fillPerturbation({ trades: goodTrades, runs: 1, seed: 7, sizeJitterPct: 0, extraSlippageBps: 0 });
    check("with zero perturbation, fill stress reproduces the plain bootstrap exactly",
      oneRunZero.maxDrawdownP50Pct === oneRunBoot.maxDrawdownP50Pct
      && oneRunZero.pProfitable === oneRunBoot.pProfitable
      && zero.fractionalBasis === bcGood.fractionalBasis,
      `one run: ${oneRunZero.maxDrawdownP50Pct}% vs ${oneRunBoot.maxDrawdownP50Pct}%`);
    check("execution noise can only make the drawdown tail WORSE",
      noisy.maxDrawdownP95Pct >= zero.maxDrawdownP95Pct && noisy.pBreach >= zero.pBreach,
      `noisy p95 ${noisy.maxDrawdownP95Pct}% / breach ${noisy.pBreach}%  vs  clean p95 ${zero.maxDrawdownP95Pct}% / breach ${zero.pBreach}%`);
    check("execution noise lowers P(profitable)",
      noisy.pProfitable <= zero.pProfitable, `${noisy.pProfitable}% <= ${zero.pProfitable}%`);
    check("fill perturbation is deterministic",
      fillPerturbation({ trades: goodTrades, runs: 200, seed: 11, sizeJitterPct: 0.2, extraSlippageBps: 8 }).pBreach ===
      fillPerturbation({ trades: goodTrades, runs: 200, seed: 11, sizeJitterPct: 0.2, extraSlippageBps: 8 }).pBreach);
  }

  // ---- slippage sweep
  //
  // A gentle drift on purpose. The steep market used elsewhere elsewhere in this
  // file earns so much per trade that even 160 bps of friction leaves it
  // profitable, so "dies at high cost" is a statement about the fixture, not
  // about cost sensitivity.
  {
    const thinEdge = mkBars(4000, 0.16);
    const sw = slippageSweep({ bars: thinEdge, signal: alwaysLong, cfg: { maxHoldBars: 8 } });
    check("slippage sweep is finer than v1's 3x3 cost grid", sw.points > 9, `${sw.points} points`);
    const at = (bps) => sw.grid.filter((g) => g.roundTripBps === bps);
    check("the base cost level is profitable on a thin real edge",
      at(sw.baseRoundTripBps).some((g) => Number(g.profitFactor) > 1),
      `base ${sw.baseRoundTripBps} bps`);
    check("160 bps of friction kills the thin edge",
      at(160).length > 0 && at(160).every((g) => !(Number(g.profitFactor) > 1)),
      `${at(160).length} points at 160 bps: ${at(160).map((g) => g.profitFactor).join(",")}`);
    check("the profitable fraction of the grid shrinks as cost rises",
      (() => {
        const cheap = sw.grid.filter((g) => g.roundTripBps <= 20 && Number(g.profitFactor) > 1).length;
        const dear = sw.grid.filter((g) => g.roundTripBps >= 60 && Number(g.profitFactor) > 1).length;
        return dear < cheap;
      })(), `break-even ${sw.breakEvenRoundTripBps} bps`);
    check("slippage sweep reports a break-even at or above the base cost",
      sw.breakEvenRoundTripBps >= sw.baseRoundTripBps,
      `base ${sw.baseRoundTripBps} bps, break-even ${sw.breakEvenRoundTripBps} bps`);

    // The paired mode exists to save simulations, so the properties it must
    // preserve have to be pinned. It does NOT reproduce cross mode exactly:
    // fee and slippage hit opposite sides of a trade, so the split matters and
    // paired samples only a subset of cost pairs. The provable relationship is
    // that a winner over a subset cannot beat the winner over the whole set, so
    // paired's break-even is a LOWER BOUND.
    const cross = slippageSweep({ bars: thinEdge, signal: alwaysLong, cfg: { maxHoldBars: 8 }, mode: "cross" });
    check("paired mode costs fewer simulations than cross mode",
      sw.points < cross.points, `paired ${sw.points} vs cross ${cross.points}`);
    check("paired break-even is a LOWER BOUND on cross, never higher",
      sw.breakEvenRoundTripBps <= cross.breakEvenRoundTripBps,
      `paired ${sw.breakEvenRoundTripBps} bps <= cross ${cross.breakEvenRoundTripBps} bps`);
    check("paired and cross agree on the break-even to within the grid resolution",
      cross.breakEvenRoundTripBps - sw.breakEvenRoundTripBps <= 5,
      `gap ${cross.breakEvenRoundTripBps - sw.breakEvenRoundTripBps} bps`);
    check("paired mode reaches the same maximum cost as cross mode",
      Math.max(...sw.grid.map((g) => g.roundTripBps)) === Math.max(...cross.grid.map((g) => g.roundTripBps)),
      `${Math.max(...sw.grid.map((g) => g.roundTripBps))} bps`);
    check("paired mode hits odd totals as well as even ones",
      at(15).length > 0, `${at(15).length} points at 15 bps total`);
  }

  // ---- anchored walk-forward
  {
    const wfBars = mkBars(2000, 0.25);
    const wf = anchoredWalkForward({ bars: wfBars, signal: alwaysLong, folds: 4, warmup: 100, grid: { _none: [1] } });
    check("anchored walk-forward produces folds", wf.folds === 4, `${wf.folds}`);
    check("train windows EXPAND (anchored)",
      wf.perFold.every((f, i) => i === 0 || f.trainBars > wf.perFold[i - 1].trainBars),
      wf.perFold.map((f) => f.trainBars).join(" < "));
    check("no test window starts before its train window ends (no leakage)",
      wf.perFold.every((f) => f.testStartTime > f.trainEndTime));
    check("test windows do not overlap",
      wf.perFold.every((f, i) => i === 0 || f.testStartTime > wf.perFold[i - 1].testStartTime));
    check("efficiency ratio is reported", typeof wf.efficiencyRatio === "number" || wf.efficiencyRatio === null,
      `IS ${wf.meanIsSharpe} -> OOS ${wf.meanOosSharpe} = ${wf.efficiencyRatio}`);
    check("a rising market is consistent across folds", (wf.consistency ?? 0) >= 75, `${wf.consistency}%`);
  }

  // THE test that distinguishes anchored WF from v1's fold count: parameters are
  // re-chosen per fold, and the search is real rather than hardcoded.
  {
    const probeBars = mkBars(3000, 0.2);
    const only11 = ({ i, cfg }) => (i % cfg.n === 0
      ? (cfg.n === 11 ? { side: "buy" } : { side: "sell" }) : null);
    const w11 = anchoredWalkForward({ bars: probeBars, signal: only11, folds: 4, warmup: 100, grid: { n: [3, 11, 40] } });
    check("the grid search actually selects the profitable variant",
      w11.perFold.every((f) => f.chosen.n === 11),
      w11.perFold.map((f) => f.chosen.n).join(","));
    const only40 = ({ i, cfg }) => (i % cfg.n === 0
      ? (cfg.n === 40 ? { side: "buy" } : { side: "sell" }) : null);
    const w40 = anchoredWalkForward({ bars: probeBars, signal: only40, folds: 4, warmup: 100, grid: { n: [3, 11, 40] } });
    check("the selection is not hardcoded — a different optimum is found",
      w40.perFold.every((f) => f.chosen.n === 40),
      w40.perFold.map((f) => f.chosen.n).join(","));
    check("every fold reports the number of variants it searched",
      w11.perFold.every((f) => f.variantsTested === 3), `${w11.perFold[0].variantsTested}`);
  }

  // stationarityT sign convention: more negative = worse.
  {
    const rising = mkBars(3000, 0.3);
    const frontLoaded = mkBars(1500, 0.5).concat(mkBars(1500, -0.5).map((b, i) => ({ ...b, time: b.time + 1500 * 900 })));
    const sRising = anchoredWalkForward({ bars: rising, signal: alwaysLong, folds: 4, warmup: 100 });
    const cutTime = frontLoaded[1500].time;
    const earlyOnly = ({ bar }) => (bar.time < cutTime ? { side: "buy" } : null);
    const sFront = anchoredWalkForward({ bars: frontLoaded, signal: earlyOnly, folds: 4, warmup: 100 });
    check("a stationary strategy has a less negative stationarity t than a decaying one",
      sRising.stationarityT > sFront.stationarityT,
      `stationary ${sRising.stationarityT} vs front-loaded ${sFront.stationarityT}`);
    check("the front-loaded strategy loses money out of sample",
      sFront.consistency < sRising.consistency,
      `${sFront.consistency}% vs ${sRising.consistency}%`);
  }

  check("anchored walk-forward refuses on too few bars",
    anchoredWalkForward({ bars: mkBars(300, 0.2), signal: alwaysLong, folds: 4, warmup: 250 }).folds === 0);

  // ---- REGRESSION: pooling symbols without 1/N weighting is a 5x-geared account
  //
  // The first version of this file concatenated five independent 1000-equity
  // accounts and compounded all of their fractional returns into one curve with
  // no 1/N weighting. On the real data that produced a median drawdown of 99.5%
  // while the WORST single symbol was 80.6% — arithmetically impossible for a
  // genuine equal-weight book, and enough to make two gate criteria meaningless.
  {
    const acct = (id, perTrade, n = 200) => {
      const trades = []; let eq = 1000;
      for (let i = 0; i < n; i++) {
        const pnl = eq * perTrade;
        trades.push({ symbol: id, time: 1767225600 + i * 900, pnl, equityBefore: eq, entry: 100, qty: 1 });
        eq += pnl;
      }
      return trades;
    };
    // Five identical accounts. An equal-weight book of five IDENTICAL accounts
    // must have the same drawdown as one of them. The unweighted version
    // compounds five times the return into one curve, so it is ~5x deeper.
    const five = [0, 1, 2, 3, 4].map((i) => acct(`S${i}`, -0.02));
    const one = acct("S0", -0.02);
    const port = bootstrapMonteCarlo({ trades: five.flat(), runs: 400, seed: 11 });
    const solo = bootstrapMonteCarlo({ trades: one, runs: 400, seed: 11 });
    check("five identical accounts are an equal-weight book, not a 5x-geared one",
      Math.abs(port.maxDrawdownP50Pct - solo.maxDrawdownP50Pct) < 1,
      `portfolio ${port.maxDrawdownP50Pct}% vs single ${solo.maxDrawdownP50Pct}%`);
    check("portfolio drawdown is never deeper than the worst identical component",
      port.maxDrawdownP50Pct <= solo.maxDrawdownP50Pct + 0.5,
      `${port.maxDrawdownP50Pct}% vs ${solo.maxDrawdownP50Pct}%`);
    check("the portfolio reports its equal-weight scope", /equal-weight portfolio of 5/.test(port.scope), port.scope);
    check("a single account is reported as a single account, not a portfolio",
      bootstrapMonteCarlo({ trades: one, runs: 50, seed: 11 }).scope === "single account");

    // Blocks must not straddle a symbol boundary: a draw that mixes one symbol's
    // returns into another's window is a resample of something that never happened.
    const good = acct("GOOD", 0.02), bad = acct("BAD", -0.02);
    const mixed = bootstrapMonteCarlo({ trades: [...good, ...bad], runs: 400, seed: 3 });
    const gOnly = bootstrapMonteCarlo({ trades: good, runs: 400, seed: 3 });
    const bOnly = bootstrapMonteCarlo({ trades: bad, runs: 400, seed: 3 });
    check("a 50/50 book of one winner and one loser sits between its components",
      mixed.pProfitable <= gOnly.pProfitable && mixed.pProfitable >= bOnly.pProfitable,
      `mixed ${mixed.pProfitable}% between good ${gOnly.pProfitable}% and bad ${bOnly.pProfitable}%`);
    check("the worst-symbol probability is reported for a portfolio", typeof mixed.pProfitableWorstSymbol === "number",
      `worst symbol profitable in ${mixed.pProfitableWorstSymbol}% of draws`);
    check("the worst-symbol probability is absent for a single account",
      bootstrapMonteCarlo({ trades: one, runs: 50, seed: 11 }).pProfitableWorstSymbol === null);
  }

  // ---- REGRESSION: a silent out-of-sample fold must not be filtered out
  //
  // consistency/meanOosSharpe/efficiencyRatio are all computed over folds that
  // produced trades. A signal that trades for the first 1900 bars and is then
  // silent for the last 1100 used to report consistency 100%, meanOosSharpe
  // 2.72 and efficiency 1.31 — clearing every walk-forward criterion with perfect
  // marks while being unable to trade for more than a third of the period.
  {
    const bars = mkBars(4000, 0.3);
    const cutoff = bars[1900].time;
    const goesSilent = ({ bar }) => (bar.time < cutoff ? { side: "buy" } : null);
    const silentWf = anchoredWalkForward({ bars, signal: goesSilent, folds: 4, warmup: 100 });
    check("a strategy that goes silent out of sample has folds with no trades",
      silentWf.foldsSilent > 0, `${silentWf.foldsSilent} of ${silentWf.folds} folds silent`);
    check("fold coverage exposes the silence", silentWf.foldCoverage < 100,
      `coverage ${silentWf.foldCoverage}% (${silentWf.foldsWithTrades}/${silentWf.folds} folds traded)`);
    check("silent folds are REPORTED, not silently dropped",
      silentWf.foldsSilent === silentWf.perFold.filter((x) => x.oos.trades === 0).length,
      `${silentWf.foldsSilent} silent`);
    // The contrast that makes the coverage number meaningful: a strategy that
    // trades throughout has 100% coverage.
    const tradesThroughout = anchoredWalkForward({ bars, signal: alwaysLong, folds: 4, warmup: 100 });
    check("a strategy that trades throughout has 100% fold coverage",
      tradesThroughout.foldCoverage === 100, `${tradesThroughout.foldCoverage}%`);
  }

  // ---- REGRESSION: a strategy with no grid cannot re-optimise, and says so
  {
    const noGrid = anchoredWalkForward({ bars: mkBars(2000, 0.25), signal: alwaysLong, folds: 4, warmup: 100 });
    check("no declared grid => not re-optimised, and flagged", noGrid.reoptimised === false && noGrid.variantsTotal === 1);
    check("the re-optimisation flag carries an explanation", /no parameter grid/.test(noGrid.reoptimisedNote), noGrid.reoptimisedNote);
    const withGrid = anchoredWalkForward({
      bars: mkBars(2000, 0.25), signal: alwaysLong, folds: 4, warmup: 100, grid: { _x: [1, 2] },
    });
    check("a declared grid IS re-optimised, and flagged", withGrid.reoptimised === true && withGrid.variantsTotal === 2);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
