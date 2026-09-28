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

// ------------------------------------------------------------ symbol groups

/**
 * Split a trade list into independent per-symbol groups, each carrying ITS OWN
 * returns and notionals.
 *
 * WHY THE GROUPS CARRY THEIR OWN NUMBERS
 *
 * The first version of this file located a symbol's slice of the pooled
 * fractional-return array by index arithmetic:
 *
 *     const start = trades.indexOf(g.rows[0]);
 *     const pooled.slice(start, start + g.rows.length)
 *
 * That is correct only while every symbol's trades are CONTIGUOUS in the pooled
 * list. They are today, but by accident: `evidence.mjs` adds a `barOffset` per
 * symbol that pushes the five windows apart, so the contiguity is a side effect
 * of a data-loading detail, not an invariant anything checked. On interleaved
 * data the same code misattributed 2578 of 2583 pooled trades and moved the
 * median portfolio drawdown from 70.47% to 80.71% on the real cached dataset,
 * with no error raised and no number that looked wrong. Reproduce it with the
 * selftest's "old index-arithmetic slice" check below.
 *
 * So a group's returns are now attached to that group's OWN TRADES, by
 * identity, and `assertGroups` proves the pairing trade-by-trade before any
 * resampling happens. See `symbolOrdering` for the contiguity report, which is
 * now a DIAGNOSTIC rather than a load-bearing assumption.
 */
function groupBySymbol(trades, fracs) {
  const by = new Map();
  trades.forEach((t, i) => {
    const k = t.symbol ?? "_single";
    let g = by.get(k);
    if (!g) { g = { symbol: k, rows: [], fracs: [], notionals: [], times: [] }; by.set(k, g); }
    g.rows.push(t);
    g.fracs.push(fracs[i]);
    g.notionals.push(Math.abs((t.entry ?? 0) * (t.qty ?? 0)));
    g.times.push(tradeTime(t, g.rows.length - 1));
  });
  return [...by.values()];
}

/**
 * When a trade happened.
 *
 * `evidence.mjs` stamps `time` (exit time plus a per-symbol barOffset) on every
 * pooled trade, which is the normal case. Raw `harness.simulate` trades carry
 * only `entryTime`/`exitTime`, so those are the fallbacks. With no timestamp at
 * whatsoever, the only ordering that exists is the order the trades were
 * supplied in, and pretending otherwise (collapsing every trade onto t=0, say)
 * would destroy the path and silently zero its drawdown.
 */
function tradeTime(t, position) {
  if (Number.isFinite(t.time)) return t.time;
  if (Number.isFinite(t.exitTime)) return t.exitTime;
  if (Number.isFinite(t.entryTime)) return t.entryTime;
  return position;
}

/**
 * Group, verify, and report. Every consumer goes through this, so no caller can
 * resample a group whose returns are not its own.
 *
 * `assertGroups` is exported only so the selftest can prove it actually throws
 * on a mis-attributed return; nothing in the runner calls it directly.
 */
export function groupTradesBySymbol(trades, initialEquity) {
  const { fracs, basis } = fractionalReturns(trades, initialEquity);
  const groups = groupBySymbol(trades, fracs);
  assertGroups(groups, trades, initialEquity);
  return { groups, fracs, basis, ordering: symbolOrdering(trades) };
}

/**
 * Loud invariant checks, run before a single trade is resampled.
 *
 * Every failure mode here used to be a silently wrong number rather than an
 * error, which is why each check names the quantity that no longer lines up:
 *
 *   1. no trade dropped or duplicated while grouping;
 *   2. the return used for a trade is THAT trade's own return — recomputed from
 *      the trade itself, not sliced out of a pooled array by index. This is the
 *      check the old code could not have passed on interleaved data;
 *   3. each group's trades are in non-decreasing time order, because the block
 *      bootstrap resamples a time-ordered path and reordering one makes the
 *      block meaningless.
 *
 * Contiguity ACROSS symbols is deliberately NOT required: grouping by identity
 * handles interleaving correctly, so throwing on it would reject valid input.
 * It is reported by `symbolOrdering` instead.
 */
export function assertGroups(groups, trades, initialEquity) {
  const grouped = groups.reduce((a, g) => a + g.rows.length, 0);
  if (grouped !== trades.length) {
    throw new Error(
      `symbol grouping lost or duplicated trades: ${grouped} grouped vs ${trades.length} supplied`);
  }
  for (const g of groups) {
    if (g.rows.length !== g.fracs.length || g.rows.length !== g.notionals.length) {
      throw new Error(
        `symbol "${g.symbol}": ${g.rows.length} trades but ${g.fracs.length} returns `
        + `and ${g.notionals.length} notionals — per-symbol attribution is broken`);
    }
    for (let i = 0; i < g.rows.length; i++) {
      const t = g.rows[i];
      const own = t.equityBefore > 0 ? t.pnl / t.equityBefore
        : initialEquity > 0 ? t.pnl / initialEquity : 0;
      if (g.fracs[i] !== own) {
        throw new Error(
          `symbol "${g.symbol}" trade ${i} (time ${g.times[i]}) is carrying return `
          + `${g.fracs[i]} but its own return is ${own} — a return has been attributed to the `
          + `wrong trade, so every path statistic computed from it is meaningless`);
      }
      if (i > 0 && g.times[i] < g.times[i - 1]) {
        throw new Error(
          `symbol "${g.symbol}" trade ${i} (time ${g.times[i]}) precedes its predecessor `
          + `(time ${g.times[i - 1]}) — the block bootstrap resamples a time-ordered path`);
      }
    }
  }
  return true;
}

/**
 * Whether each symbol's trades are contiguous in the POOLED list.
 *
 * Reported, not required. See `groupBySymbol` for why this stopped being
 * load-bearing.
 */
export function symbolOrdering(trades) {
  const spans = new Map();
  trades.forEach((t, i) => {
    const k = t.symbol ?? "_single";
    const s = spans.get(k) ?? { symbol: k, first: i, last: i, count: 0 };
    s.last = i; s.count++;
    spans.set(k, s);
  });
  // A symbol's trades are contiguous when they occupy exactly the window
  // [first, last]; anything else means another symbol's trades sit inside it.
  const interleaved = [...spans.values()].filter((s) => s.last - s.first + 1 !== s.count);
  return {
    contiguous: interleaved.length === 0,
    interleavedSymbols: interleaved.map((s) => s.symbol),
    note: interleaved.length === 0
      ? "each symbol's trades are contiguous in the pooled list"
      : `interleaved in the pooled list; attribution is unaffected because each group carries its own returns (${interleaved.map((s) => s.symbol).join(", ")})`,
  };
}

// ------------------------------------------------------- equal-weight book

/**
 * The portfolio model, stated exactly.
 *
 * N symbols become N INDEPENDENT SUB-ACCOUNTS, each starting at 1 unit and
 * compounding only its own resampled trades. The portfolio is the ARITHMETIC
 * MEAN of the N equity curves at every point in time:
 *
 *     A(t) = (1/N) * sum_s equity_s(t)
 *
 * Three things follow, and all three are the point:
 *
 *   - Drawdown is measured on A. It is a property of the real equal-weight book,
 *     not of an arithmetic trick on independent paths.
 *   - A genuine equal-weight book cannot be deeper than its worst component —
 *     PROVIDED every sleeve's equity stays non-negative. Under that condition it
 *     is a theorem of the model, not a hope: for every symbol s and every t,
 *     equity_s(t) >= peak_s * (1 - DD_s) >= equity_s(t') * (1 - DD_s) at the time
 *     t' the portfolio peaked, so A(t) >= (1 - max_s DD_s) * A(t') and the
 *     averaged curve's drawdown is bounded by the worst component's. The
 *     selftest pins the bound.
 *     The non-negativity condition is not decorative, and nothing on this path
 *     enforces it: the equity update multiplies 1 + frac with no floor, so a
 *     leg that loses more than 100% takes that sleeve's equity NEGATIVE, the
 *     mean is dragged below the peak by more than 100%, and the bound is
 *     exceeded. The minimal witness is two legs of [1000, -500, -500] — each
 *     step is a frac of -1.5, each sleeve ends at -0.5 of its start, the mean
 *     ends at -0.5, and the reported drawdown is 150%.
 *     On the real pipeline this cannot arise: simulate() floors equity at
 *     ruinEquityPct, so a sleeve is already pinned non-negative before it ever
 *     reaches here, and the bound holds on that path. But equalWeightPath is
 *     reachable from the EXPORTED entry points — bootstrapMonteCarlo,
 *     fillPerturbation, slippageSweep, anchoredWalkForward — which all take a
 *     caller's `trades` and apply no floor of their own. bootstrapMonteCarlo on
 *     a synthetic pair of sleeves losing 300% of equity reports
 *     maxDrawdownP50Pct of 2700% against a component mean of 300%. So the bound
 *     is stated here as the conditional it is: it holds for the simulated book,
 *     not for arbitrary input to these helpers.
 *     Clamping is deliberately NOT added here: it would silently rewrite a
 *     pathological input into a plausible-looking one, and deciding whether to
 *     fail, clamp, or report is the owner's call, not a comment's.
 *   - A RESAMPLED book path can still be deeper than the worst sleeve that was
 *     actually observed, and that is not a contradiction of the bound above.
 *     The bound relates one book to its own components — max_s DD_s is drawn
 *     from the same paths that produced A. The observed worst sleeve drawdown
 *     and the resampled book drawdown are DIFFERENT quantities: the former is
 *     one observed sample, the latter a drawdown from a block-bootstrap path
 *     whose sleeves were not individually observed and were free to coincide
 *     badly. So "deeper than maxDrawdownP50PctComponentsWorst" is a legitimate
 *     reading of two independent estimates, not evidence the model is wrong.
 *   - Total return is the MEAN of the per-symbol returns, not their product.
 *     That is the return of holding equal capital in each symbol without
 *     rebalancing, which is what an equal-weight book is.
 *
 * Why the curves are averaged rather than the per-symbol drawdowns being
 * averaged: the mean of N drawdowns is not the drawdown of any account, and it
 * throws away the only thing a drawdown measures — the ORDER of the paths. Two
 * books with identical per-symbol drawdowns and opposite interleavings produce
 * the same mean of drawdowns and different real books. Averaging the curves
 * keeps the ordering, and it is the quantity an investor would actually have
 * experienced. The two are NOT equal — on the real data quoted below they are
 * 67.11% and 78.13% — and the report carries both, as
 * maxDrawdownP50Pct and the diagnostic maxDrawdownP50PctComponentsMean, so the
 * difference is visible rather than asserted.
 *
 * WHAT THIS REPLACED, and in which direction it was wrong. The previous model
 * divided every trade by N and compounded the merged stream into ONE curve: a
 * single account of 1000 running N symbols at 1/N of its equity each. That is a
 * levered account, not a portfolio, and it is wrong in BOTH directions rather
 * than conservatively wrong, which is the worst property a risk statistic can
 * have:
 *
 *   - where symbols draw down together, the 1/N account pays (1 - x/N)^N for N
 *     shocks of size x where the real book pays x, which flatters the book;
 *   - where one symbol's drawdown is offset by another's gain in the same
 *     window, the 1/N account keeps a single shared equity base, so a gain on
 *     one symbol cushions a loss on another and it reports a deeper drawdown
 *     than the book had.
 *
 * Measured on the real cached dataset (vol-normalized-breakout, 2583 pooled
 * trades, 500 block resamples, seed 12345): the old 1/N account reports a median
 * portfolio drawdown of 70.47% where the equal-weight book reports 67.11%, and
 * the mean of the per-symbol drawdowns reports 78.13%. The two errors are of
 * similar size and point in opposite directions, which is why no threshold was
 * nudged to compensate: the fix is to report a number that means something.
 *
 * The old model also violated the rule `evidence.mjs` states outright — "drawdown
 * and return are PATH properties and must NOT be pooled across symbols" — in
 * the opposite direction from the unweighted-pooling bug that preceded it.
 * Drawdowns are never summed, and five full accounts are never compounded into
 * one.
 *
 * Events sharing a timestamp are applied as ONE step. A +50% and a -50% landing
 * on the same millisecond must not be allowed to register a mid-step portfolio
 * peak, which would invent a drawdown that no account ever had.
 */
function equalWeightPath(legs) {
  const n = legs.length;
  const zero = {
    totalReturn: 0, maxDrawdown: 0, sharpe: null, profitFactor: 0,
    longestLosingStreak: 0, perSymbol: [],
  };
  if (!n) return zero;

  const eq = new Array(n).fill(1);
  const peak = new Array(n).fill(1);
  const dd = new Array(n).fill(0);
  const cur = new Array(n).fill(0);
  const steps = [];
  let sumEq = n;                 // sum of the sub-account equities; all start at 1
  let portEq = 1, portPeak = 1, portDd = 0;
  let remaining = 0;
  for (const leg of legs) remaining += leg.events.length;

  while (remaining > 0) {
    // Earliest next event across all sub-accounts.
    let s = -1, t = Infinity;
    for (let k = 0; k < n; k++) {
      const j = cur[k];
      if (j < legs[k].events.length) {
        const tk = legs[k].events[j].time ?? 0;
        if (tk < t) { t = tk; s = k; }
      }
    }
    if (s < 0) break;
    const prevEq = portEq;
    // Every trade settling at this instant, applied before the book is observed.
    while (s >= 0) {
      const leg = legs[s];
      const j = cur[s];
      if (j >= leg.events.length || (leg.events[j].time ?? 0) !== t) {
        s = -1; break;
      }
      const before = eq[s];
      eq[s] *= 1 + leg.events[j].frac;
      sumEq += eq[s] - before;
      if (eq[s] > peak[s]) peak[s] = eq[s];
      if (peak[s] > 0) dd[s] = Math.max(dd[s], (peak[s] - eq[s]) / peak[s]);
      cur[s]++; remaining--;
      // Advance to the next leg that also has an event at this instant.
      s = -1;
      for (let k = 0; k < n; k++) {
        const q = cur[k];
        if (q < legs[k].events.length && (legs[k].events[q].time ?? 0) === t) { s = k; break; }
      }
    }
    portEq = sumEq / n;
    if (portEq > portPeak) portPeak = portEq;
    if (portPeak > 0) portDd = Math.max(portDd, (portPeak - portEq) / portPeak);
    // A sub-account at zero makes the book's period return a ratio of zero, and
    // recording that as 0 would understate the variance. Such steps are dropped
    // from the Sharpe/profit-factor sample instead of being invented.
    if (prevEq > 0) steps.push(portEq / prevEq - 1);
  }

  let streak = 0, worst = 0;
  for (const f of steps) { streak = f <= 0 ? streak + 1 : 0; if (streak > worst) worst = streak; }

  return {
    totalReturn: portEq - 1,
    maxDrawdown: portDd,
    sharpe: sharpeOf(steps),
    profitFactor: profitFactorOf(steps),
    longestLosingStreak: worst,
    perSymbol: legs.map((leg, k) => ({
      symbol: leg.symbol, totalReturn: eq[k] - 1, maxDrawdown: dd[k],
    })),
  };
}

// ---------------------------------------------------------- bootstrap monte carlo

/**
 * Resample trade OUTCOMES and report the distribution of the quantities that
 * actually describe an edge.
 *
 *   pProfitable             P(portfolio return > 0), where the portfolio return
 *                           is the MEAN of the per-symbol returns
 *   pSharpePositive         P(Sharpe > 0) of the averaged portfolio curve
 *   pProfitFactorAboveOne   P(PF > 1) of the averaged portfolio curve
 *   sharpeP05/P50/P95       the Sharpe distribution
 *   maxDrawdownP50/P95      the drawdown distribution, measured on the averaged
 *                           equity curve — see `equalWeightPath` for the model
 *
 *   pProfitableWorstSymbol            DIAGNOSTIC, read by no criterion
 *   maxDrawdownP50/95PctComponentsMean DIAGNOSTIC, read by no criterion
 *
 * v1's monteCarlo() cannot produce any of these: it reorders a fixed P&L set,
 * and the sum of a fixed P&L set is a constant.
 */
export function bootstrapMonteCarlo({
  trades, initialEquity = 1000, runs = 1000, seed = 12345,
  method = "block", blockSize = null, ddThresholdPct = 20,
}) {
  const { groups, fracs, basis, ordering } = groupTradesBySymbol(trades, initialEquity);
  if (fracs.length < 20) return { runs: 0, trades: fracs.length, note: "too few trades to bootstrap" };

  const isPortfolio = groups.length > 1;
  const L = (n) => blockSize ?? Math.ceil(Math.cbrt(n));
  const rnd = rng(seed);
  const totals = [], sharpes = [], dds = [], pfs = [], streaks = [], compDd = [];
  const perSymbolProfitable = new Map(groups.map((g) => [g.symbol, 0]));
  let breached = 0;

  for (let r = 0; r < runs; r++) {
    // Resample WITHIN each symbol, so a block never straddles a symbol
    // boundary, then hand equalWeightPath one leg per sub-account.
    const legs = groups.map((g) => {
      const n = g.fracs.length;
      const idx = resampleIdx(n, rnd, { method, blockSize: L(n) });
      const events = idx.map((i) => ({ time: g.times[i], frac: g.fracs[i] }));
      events.sort((a, b) => a.time - b.time);
      return { symbol: g.symbol, events };
    });

    const s = equalWeightPath(legs);
    totals.push(s.totalReturn);
    dds.push(s.maxDrawdown);
    streaks.push(s.longestLosingStreak);
    if (s.sharpe != null) sharpes.push(s.sharpe);
    if (Number.isFinite(s.profitFactor)) pfs.push(s.profitFactor);
    if (s.maxDrawdown * 100 >= ddThresholdPct) breached++;
    // Diagnostic only: the mean of the per-symbol drawdowns, which is NOT the
    // drawdown of the averaged curve. Reported so the difference is visible.
    compDd.push(s.perSymbol.reduce((a, x) => a + x.maxDrawdown, 0) / s.perSymbol.length);
    for (const ps of s.perSymbol) {
      perSymbolProfitable.set(ps.symbol, perSymbolProfitable.get(ps.symbol) + (ps.totalReturn > 0 ? 1 : 0));
    }
  }

  const qs = quantiles(totals, [0.05, 0.5, 0.95]);
  const dq = quantiles(dds, [0.5, 0.95]);
  const cq = quantiles(compDd, [0.5, 0.95]);
  const sq = quantiles(sharpes, [0.05, 0.5, 0.95]);
  const worstSymbol = [...perSymbolProfitable.values()].reduce((a, b) => Math.min(a, b), Infinity);
  const worstSymbolPct = Number(((worstSymbol / runs) * 100).toFixed(2));

  return {
    method, runs, trades: fracs.length, blockSize: method === "block" ? L(fracs.length) : null,
    fractionalBasis: basis,
    seed,
    scope: isPortfolio
      ? `equal-weight portfolio of ${groups.length} symbols: ${groups.length} independent sub-accounts `
        + `of 1 unit, portfolio equity = arithmetic mean of the ${groups.length} curves at every `
        + `timestamp; returns averaged, drawdown taken on the averaged curve, never compounded or summed`
      : "single account",
    portfolioModel: "equal-weight additive (arithmetic mean of per-symbol equity curves)",
    symbols: groups.map((g) => g.symbol),
    symbolOrdering: ordering,
    pProfitable: Number(((totals.filter((x) => x > 0).length / runs) * 100).toFixed(2)),
    // DIAGNOSTIC ONLY. No criterion in gate-v2.mjs reads this field; it exists
    // to show how often the book's WORST component made money, which is a
    // different question from whether the book did. Nothing may start reading
    // it as a gate input without a protocol change.
    pProfitableWorstSymbol: isPortfolio ? worstSymbolPct : null,
    diagnosticOnly: ["pProfitableWorstSymbol", "maxDrawdownP50PctComponentsMean", "maxDrawdownP95PctComponentsMean"],
    pSharpePositive: sharpes.length ? Number(((sharpes.filter((x) => x > 0).length / sharpes.length) * 100).toFixed(2)) : null,
    pProfitFactorAboveOne: pfs.length ? Number(((pfs.filter((x) => x > 1).length / pfs.length) * 100).toFixed(2)) : null,
    sharpeP05: sq.p5, sharpeP50: sq.p50, sharpeP95: sq.p95,
    totalReturnP05: qs.p5, totalReturnP50: qs.p50, totalReturnP95: qs.p95,
    maxDrawdownP50Pct: Number((dq.p50 * 100).toFixed(2)),
    maxDrawdownP95Pct: Number((dq.p95 * 100).toFixed(2)),
    // Diagnostic: the same resamples scored as the MEAN of the per-symbol
    // drawdowns instead of the drawdown of the averaged curve. Not the same
    // quantity, and the one the criteria read is the one above.
    maxDrawdownP50PctComponentsMean: Number((cq.p50 * 100).toFixed(2)),
    maxDrawdownP95PctComponentsMean: Number((cq.p95 * 100).toFixed(2)),
    pBreach: Number(((breached / runs) * 100).toFixed(2)),
    ddThresholdPct,
    longestLosingStreakP95: quantiles(streaks, [0.95]).p95,
    note: "OUTCOME resampling with replacement inside each symbol; the portfolio is the equal-weight "
      + "mean of per-symbol equity curves, so its drawdown is never deeper than its worst component "
      + "and never compounds across symbols; v1's order-shuffle cannot move expectancy, PF or Sharpe",
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
 * Like the bootstrap, this is the same equal-weight portfolio: N independent
 * sub-accounts of one unit, resampled within each symbol, and the book is the
 * ARITHMETIC MEAN of the N equity curves. The extra fill cost needs no scaling:
 * `notional * bps / initialEquity` is already the cost as a fraction of the
 * leg's own capital, and averaging the legs scales it to the book exactly once.
 * Dividing it by N here as well would have understated execution cost fivefold.
 */
export function fillPerturbation({
  trades, initialEquity = 1000, runs = 500, seed = 12345,
  sizeJitterPct = 0.1, extraSlippageBps = 5, ddThresholdPct = 20, method = "block",
}) {
  const { groups, fracs, basis, ordering } = groupTradesBySymbol(trades, initialEquity);
  if (fracs.length < 20) return { runs: 0, note: "too few trades to perturb" };

  const isPortfolio = groups.length > 1;
  const L = (n) => Math.ceil(Math.cbrt(n));
  const rnd = rng(seed);

  const totals = [], dds = [];
  let breached = 0;

  for (let r = 0; r < runs; r++) {
    const legs = groups.map((g) => {
      const n = g.fracs.length;
      const idx = resampleIdx(n, rnd, { method, blockSize: L(n) });
      const events = idx.map((i) => {
        const jitter = 1 + gauss(rnd) * sizeJitterPct;
        const notional = g.notionals[i];
        const extraCost = notional > 0 && initialEquity > 0
          ? (notional * (rnd() * extraSlippageBps) / 10000) / initialEquity : 0;
        return { time: g.times[i], frac: g.fracs[i] * Math.max(0, jitter) - extraCost };
      });
      events.sort((a, b) => a.time - b.time);
      return { symbol: g.symbol, events };
    });

    const s = equalWeightPath(legs);
    totals.push(s.totalReturn);
    dds.push(s.maxDrawdown);
    if (s.maxDrawdown * 100 >= ddThresholdPct) breached++;
  }

  const dq = quantiles(dds, [0.5, 0.95]);
  return {
    runs, trades: fracs.length, seed, fractionalBasis: basis,
    scope: isPortfolio
      ? `equal-weight portfolio of ${groups.length} symbols: ${groups.length} independent sub-accounts `
        + `of 1 unit, portfolio equity = arithmetic mean of the ${groups.length} curves at every timestamp`
      : "single account",
    portfolioModel: "equal-weight additive (arithmetic mean of per-symbol equity curves)",
    symbolOrdering: ordering,
    sizeJitterPct, extraSlippageBps, ddThresholdPct,
    pBreach: Number(((breached / runs) * 100).toFixed(2)),
    maxDrawdownP50Pct: Number((dq.p50 * 100).toFixed(2)),
    maxDrawdownP95Pct: Number((dq.p95 * 100).toFixed(2)),
    pProfitable: Number(((totals.filter((x) => x > 0).length / runs) * 100).toFixed(2)),
    note: "bootstrap with random size error and extra adverse slippage per fill; the portfolio is the "
      + "equal-weight mean of per-symbol equity curves, so its drawdown is the book's own and never "
      + "compounds across symbols",
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
 *   foldCoverage     % of folds that produced ANY out-of-sample trades. Gated at
 *                     100, because a strategy that goes silent out of sample must
 *                     not score 100% consistency across the folds that did fire.
 *   stationarityT    paired Student t on the per-fold (OOS - IS) Sharpe gap.
 *                   Sign convention: MORE NEGATIVE IS WORSE. Stationary means
 *                   the differences are noise around zero; a strategy whose
 *                   parameters only fit the whole sample gives a systematically
 *                   negative difference, so t goes large and negative.
 *
 * A SILENT FOLD IS A FAILED FOLD, NOT A MISSING ONE. Every average below is
 * taken over ALL folds; a fold with no out-of-sample trades contributes a
 * Sharpe of 0 and a non-profitable result. Excluding it would let a strategy
 * that stopped trading keep a perfect consistency score, which is the exact
 * failure an anchored walk-forward exists to catch.
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
      is: { sharpe: best.metrics.sharpe, profitFactor: best.metrics.profitFactor, trades: best.trades, totalReturnPct: best.metrics.totalReturnPct ?? 0 },
      // `metrics()` omits totalReturnPct entirely when a window produced no
      // trades. A fold that could not trade returned exactly 0%, so it is
      // recorded as 0 rather than left undefined and dropped from a JSON record.
      oos: { sharpe: mt.sharpe, profitFactor: mt.profitFactor, trades: mt.trades, totalReturnPct: mt.totalReturnPct ?? 0, ruined: rt.ruined, silent: mt.trades === 0 },
    });
  }

  if (!perFold.length) return { folds: 0, perFold: [], note: "no fold had enough train and test bars" };

  // EVERY fold counts. A fold in which the strategy produced no out-of-sample
  // trades earned exactly 0% out of sample, so it contributes a Sharpe of 0 and
  // a non-profitable result — not a gap in the sample. Dropping such folds is
  // what let a strategy that stopped trading entirely still look perfect; see
  // the block below.
  const isS = perFold.map((x) => x.is.sharpe ?? 0);
  const oosS = perFold.map((x) => x.oos.sharpe ?? 0);
  const diffs = perFold.map((x, i) => oosS[i] - isS[i]);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const sd = (a) => {
    if (a.length < 2) return null;
    const m = mean(a);
    return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
  };
  const dMean = mean(diffs), dSd = sd(diffs);
  const t = dMean != null && dSd != null && dSd > 0 ? dMean / (dSd / Math.sqrt(diffs.length)) : null;

  const traded = perFold.filter((x) => x.oos.trades > 0);
  // A silent fold is a FAILED fold, so the denominator is every fold, not just
  // the ones that fired.
  const profitable = perFold.filter((x) => x.oos.trades > 0 && x.oos.totalReturnPct > 0);
  const isMean = mean(isS);
  const oosMean = mean(oosS);
  const effOk = isMean != null && oosMean != null && isMean > 0;

  // SILENT FOLDS ARE A FAILURE, NOT A FILTER-OUT.
  //
  // This used to read `perFold.filter((x) => x.oos.trades > 0)` and then divide
  // by `traded.length`, with `oosS` filtered by `!= null` in the same way, so
  // every statistic below was computed over the folds that happened to fire. A
  // signal that trades for the first 1900 bars and is then silent for the last
  // 1100 (~37% of the sample) scored consistency 100%, meanOosSharpe 2.72 and
  // an efficiency ratio of 1.31, and cleared all three walk-forward criteria
  // with perfect marks — while being unable to trade for more than a third of
  // the out-of-sample period. That is precisely the "only right for the average
  // of the sample" failure the anchored walk-forward exists to detect, and it
  // is what a walk-forward is supposed to expose.
  //
  // A partially silent strategy is just as bad and still exploitable: with four
  // folds and a 75% coverage bar, ONE dead fold passes. A fold window the
  // strategy has no opinion about is not evidence it worked, so the coverage
  // bar is 100 (protocol.v2.json `MIN_WF_COVERAGE`) and, independently,
  //   - consistency divides by EVERY fold, so a silent fold is counted as a
  //     failed fold rather than removed from the sample;
  //   - meanOosSharpe, worstOosSharpe and the efficiency ratio average over
  //     EVERY fold with silent folds contributing 0, which can only lower them;
  //   - the stationarity t-test pairs every fold, so a silent fold enters as a
  //     genuine OOS-minus-IS shortfall instead of vanishing.
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
    // Stated in the artefact, because the bar being 100 is a protocol decision
    // and a reader of one run should not have to know it.
    foldCoverageBarPct: 100,
    foldsProfitable: profitable.length,
    // Denominator is EVERY fold. A silent fold is a failed fold.
    consistencyDenominator: perFold.length,
    consistency: perFold.length ? Number(((profitable.length / perFold.length) * 100).toFixed(1)) : null,
    consistencyNote: perFold.length === traded.length
      ? `profitable folds / all ${perFold.length} folds; no fold was silent`
      : `${profitable.length}/${perFold.length} folds profitable out of sample; `
        + `${perFold.length - traded.length} silent fold(s) counted as failures, not excluded`,
    // Silent folds contribute a 0 here, not a missing value.
    silentFoldPolicy: "a fold with no out-of-sample trades earns 0% and Sharpe 0; it is never dropped "
      + "from the consistency, mean OOS Sharpe, efficiency or stationarity statistics",
    meanIsSharpe: isMean != null ? Number(isMean.toFixed(3)) : null,
    meanOosSharpe: oosMean != null ? Number(oosMean.toFixed(3)) : null,
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
    stationarityNote: "more negative = worse: OOS reliably below IS across folds (paired t, one pair per fold)",
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
    check("the worst-symbol probability is labelled diagnostic, not a gate input",
      Array.isArray(port.diagnosticOnly) && port.diagnosticOnly.includes("pProfitableWorstSymbol"),
      `diagnosticOnly: ${port.diagnosticOnly.join(", ")}`);
  }

  // ---- REGRESSION: the book is the MEAN OF THE CURVES, not a 1/N-capped account
  //
  // The model this file used to compute divided every trade by N and compounded
  // the merged stream into one curve. That is one account running N symbols at
  // 1/N of its equity each, and it is not a portfolio. It is a different
  // quantity in BOTH directions, which is why nothing here is a threshold
  // tweak: it lets a gain on one symbol cushion a loss on another inside a
  // single shared equity base the real book does not have, and it applies N
  // simultaneous shocks of size x as (1 - x/N)^N where the real book takes x.
  {
    // Five symbols, four trades each, every trade of a symbol the same shock.
    // iid resampling is used because it permutes the same 20 trades, so every
    // draw is the same path and the expected values below are exact:
    //   leg_s    = (1 + x_s)^4
    //   book     = mean of the legs
    //   1/N acct = product over all 20 events of (1 + x_s/N)
    const t0 = 1767225600;
    const legs = (m) => {
      const out = [];
      for (const [sym, x] of Object.entries(m)) {
        for (let i = 0; i < 4; i++) {
          out.push({ symbol: sym, time: t0 + i * 5 * 900, pnl: 1000 * x, equityBefore: 1000, entry: 100, qty: 1 });
        }
      }
      return out.sort((a, b) => a.time - b.time);
    };
    const allDown = { S0: -0.5, S1: -0.5, S2: -0.5, S3: -0.5, S4: -0.5 };
    const book = bootstrapMonteCarlo({ trades: legs(allDown), runs: 200, seed: 5, method: "iid" });
    const equalWeightFinal = 0.5 ** 4;                            // mean of five identical legs
    const oneNthFinal = Object.values(allDown).reduce((eq, x) => eq * (1 + x / 5), 1) ** 4;
    check("the book's curve is the MEAN of the per-symbol curves, exactly",
      Math.abs(book.maxDrawdownP50Pct - (1 - equalWeightFinal) * 100) < 0.5,
      `reported ${book.maxDrawdownP50Pct}% vs mean-of-legs ${((1 - equalWeightFinal) * 100).toFixed(2)}%`);
    check("a 1/N-capped account is a DIFFERENT book, not a flatter version of this one",
      Math.abs(oneNthFinal - equalWeightFinal) > 0.01,
      `1/N account ends at ${oneNthFinal.toFixed(4)}x, the equal-weight book at ${equalWeightFinal.toFixed(4)}x`);

    // The other direction, and the property the old docstring claimed while the
    // old code did not have it: one symbol in freefall against four winners.
    const mixedShock = { S0: -0.5, S1: 0.1, S2: 0.1, S3: 0.1, S4: 0.1 };
    const mixedBook = bootstrapMonteCarlo({ trades: legs(mixedShock), runs: 200, seed: 5, method: "iid" });
    const worstLegDd = (1 - 0.5 ** 4) * 100;
    check("the book is never deeper than its worst component",
      mixedBook.maxDrawdownP50Pct <= worstLegDd + 0.5,
      `book ${mixedBook.maxDrawdownP50Pct}% vs worst component ${worstLegDd.toFixed(2)}%`);
    check("the drawdown of the averaged curve is NOT the mean of the components' drawdowns",
      mixedBook.maxDrawdownP50Pct !== mixedBook.maxDrawdownP50PctComponentsMean,
      `averaged curve ${mixedBook.maxDrawdownP50Pct}% vs mean of components ${mixedBook.maxDrawdownP50PctComponentsMean}%`);
    check("the report names the model it actually used",
      book.portfolioModel === "equal-weight additive (arithmetic mean of per-symbol equity curves)"
      && /arithmetic mean/.test(book.scope), book.scope);
  }

  // ---- REGRESSION: interleaved per-symbol trades must be attributed correctly
  //
  // The old code found a symbol's slice of the pooled return array with
  // `trades.indexOf(g.rows[0])` and added `g.rows.length`. That is only right
  // while each symbol's trades are contiguous in the pooled list, which held
  // only because `evidence.mjs` offsets every symbol's bar range. On the real
  // cached data, interleaving the same trades moved 2578 of 2583 returns to the
  // wrong symbol and the median portfolio drawdown from 70.47% to 80.71%, with
  // no error raised.
  {
    const perSymbol = (sym, n, dr) => {
      const out = []; let eq = 1000;
      for (let i = 0; i < n; i++) {
        out.push({ symbol: sym, time: 1767225600 + (i * 5) * 900, pnl: eq * dr, equityBefore: eq, entry: 100, qty: 1 });
        eq += out[i].pnl;
      }
      return out;
    };
    const contig = [
      ...perSymbol("A", 200, 0.01), ...perSymbol("B", 200, 0.02),
      ...perSymbol("C", 200, -0.01), ...perSymbol("D", 200, 0.005),
      ...perSymbol("E", 200, -0.02),
    ];
    // The same trades, round-robin in time: no symbol is contiguous.
    const inter = [];
    for (let i = 0; i < 200; i++) {
      for (const sym of ["A", "B", "C", "D", "E"]) {
        inter.push(contig.find((t) => t.symbol === sym && t.time === 1767225600 + (i * 5) * 900));
      }
    }

    const c = bootstrapMonteCarlo({ trades: contig, runs: 300, seed: 21 });
    const x = bootstrapMonteCarlo({ trades: inter, runs: 300, seed: 21 });
    check("interleaved trades are NOT contiguous in the pooled list",
      symbolOrdering(contig).contiguous === true && symbolOrdering(inter).contiguous === false,
      `contiguous report: ${symbolOrdering(inter).note}`);
    check("interleaved trades do not raise, and are attributed correctly",
      x.pProfitable === c.pProfitable && x.maxDrawdownP50Pct === c.maxDrawdownP50Pct
      && x.sharpeP50 === c.sharpeP50,
      `interleaved ${x.pProfitable}%/${x.maxDrawdownP50Pct}%/${x.sharpeP50} vs `
      + `contiguous ${c.pProfitable}%/${c.maxDrawdownP50Pct}%/${c.sharpeP50}`);
    check("the interleaved run still names all five symbols and the same scope",
      x.symbols.length === 5 && x.scope === c.scope, x.scope);

    // The old slicing, reproduced, to show what the new code no longer does:
    // for each symbol, take pooled.slice(indexOf(first), +rows.length) and count
    // the positions where that slice is not this symbol's own return.
    const { fracs: pooled } = fractionalReturns(inter, 1000);
    const g = groupTradesBySymbol(inter, 1000);
    let misattributed = 0, total = 0;
    for (const grp of g.groups) {
      const start = inter.indexOf(grp.rows[0]);
      const slice = pooled.slice(start, start + grp.rows.length);
      total += slice.length;
      for (let k = 0; k < slice.length; k++) if (slice[k] !== grp.fracs[k]) misattributed++;
    }
    check("the old index-arithmetic slice really did misattribute (this test would have caught it)",
      misattributed > total * 0.5,
      `${misattributed} of ${total} returns would have been attributed to the wrong symbol`);

    // And the invariant itself is loud rather than silent.
    g.groups[0].fracs[0] = g.groups[1].fracs[0];
    let msg = "";
    try { assertGroups(g.groups, inter, 1000); } catch (e) { msg = e.message; }
    check("a mis-attributed return raises instead of producing a plausible number",
      /attributed to the\s+wrong trade/.test(msg.replace(/\s+/g, " ")), msg.slice(0, 110));
  }

  // ---- REGRESSION: a silent out-of-sample fold must not be filtered out
  //
  // A fold in which the strategy produced no out-of-sample trades used to be
  // removed from the sample, so consistency divided by the folds that fired.
  // A signal that trades for the first 1900 bars and is then silent for the last
  // 1100 reported consistency 100%, meanOosSharpe 2.72 and efficiency 1.31 —
  // clearing every walk-forward criterion with perfect marks while being unable
  // to trade for more than a third of the period.
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

  // ---- REGRESSION: ONE dead fold must not be survivable (the coverage hole)
  //
  // A 75% coverage bar with four folds lets a single completely dead fold
  // through, so a signal that trades for the first 80% of the sample and is
  // silent for the last 20% — a full fold window — used to pass with nothing
  // failed. Both defences are pinned here: the coverage bar is 100, and the
  // consistency denominator is every fold rather than the folds that fired.
  {
    const bars = mkBars(4000, 0.3);
    const lastFoldStart = bars[Math.floor((4000 - 100) / 5) * 4].time;
    const diesInLastFold = ({ bar }) => (bar.time < lastFoldStart ? { side: "buy" } : null);
    const dead = anchoredWalkForward({ bars, signal: diesInLastFold, folds: 4, warmup: 100 });
    const silentFolds = dead.perFold.filter((x) => x.oos.trades === 0).length;

    check("the one-dead-fold case really is one dead fold", silentFolds === 1,
      `${silentFolds} silent, coverage ${dead.foldCoverage}%`);
    check("a single dead fold is below the 100% coverage bar",
      dead.foldCoverage === 75 && dead.foldCoverage < 100, `coverage ${dead.foldCoverage}%`);
    check("the consistency denominator is EVERY fold, not the folds that fired",
      dead.consistencyDenominator === 4 && dead.consistency < 100,
      `${dead.foldsProfitable}/${dead.consistencyDenominator} = ${dead.consistency}%`);
    // A dead fold contributes a Sharpe of 0, not a missing value, so the mean
    // over the folds that fired is diluted.
    const liveSharpes = dead.perFold.filter((x) => x.oos.trades > 0).map((x) => x.oos.sharpe);
    const liveMean = liveSharpes.reduce((a, b) => a + b, 0) / liveSharpes.length;
    check("meanOosSharpe counts the dead fold as 0 rather than dropping it",
      Math.abs(dead.meanOosSharpe - liveMean * (liveSharpes.length / 4)) < 0.001,
      `reported ${dead.meanOosSharpe} vs mean-over-folds-that-fired ${liveMean.toFixed(3)}`);
    check("the efficiency ratio is computed over every fold too",
      Math.abs(dead.efficiencyRatio - (liveMean * liveSharpes.length / 4) / dead.meanIsSharpe) < 0.001,
      `efficiency ${dead.efficiencyRatio} with meanIsSharpe ${dead.meanIsSharpe}`);
    check("the run says out loud that silent folds count as failures",
      /counted as failures/.test(dead.consistencyNote), dead.consistencyNote);
    check("every fold is flagged silent or not, in the per-fold record",
      dead.perFold.every((x) => x.oos.silent === (x.oos.trades === 0)),
      dead.perFold.map((x) => `${x.fold}:${x.oos.trades}`).join(" "));

    // And the whole point: the v2 gate reads these numbers, so it fails.
    const { evaluateRobustness, CRITERIA_V2 } = await import("./gate-v2.mjs");
    const verdict = evaluateRobustness({
      wf: dead,
      mc: { pProfitable: 100, pSharpePositive: 100 },
      dsr: { ok: true, dsr: 0.999 },
      fill: { pBreach: 0 },
    });
    const failed = verdict.checks.filter((c) => !c.ok).map((c) => c.name);
    check("the v2 gate FAILS a strategy that died for one whole fold",
      verdict.passed === false && failed.some((f) => /coverage/.test(f)),
      `failed: ${failed.join("; ") || "nothing"}`);
    check("the coverage bar in the protocol is 100, not 75", CRITERIA_V2.MIN_WF_COVERAGE === 100,
      `MIN_WF_COVERAGE=${CRITERIA_V2.MIN_WF_COVERAGE}`);
    // The same strategy that was silent for the last 20% must not be able to
    // buy a pass by being silent over a whole quarter of the sample.
    const aLiveFold = anchoredWalkForward({ bars, signal: alwaysLong, folds: 4, warmup: 100 });
    const stillGood = evaluateRobustness({
      wf: aLiveFold,
      mc: { pProfitable: 100, pSharpePositive: 100 },
      dsr: { ok: true, dsr: 0.999 }, fill: { pBreach: 0 },
    });
    check("a strategy with an opinion in every fold is unaffected by the stricter bar",
      aLiveFold.foldCoverage === 100 && aLiveFold.consistencyDenominator === 4,
      `coverage ${aLiveFold.foldCoverage}%, consistency ${aLiveFold.consistency}%, gate v2 ${stillGood.passed ? "pass" : `fail (${stillGood.failedNames.join("; ")})`}`);
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
