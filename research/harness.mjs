#!/usr/bin/env node
/**
 * harness.mjs — strategy-agnostic evaluation harness.
 *
 * ARCHITECTURAL GUARANTEE
 * This file does not import paper-trade.mjs and cannot place an order. It
 * imports risk-engine.mjs, which is pure arithmetic, so a backtest sizes every
 * position exactly the way live execution would. There is no code path from a
 * signal to TradingView from in here.
 *
 *   signal(bar, ctx) -> { side: "buy"|"sell" } | null
 *          ↓
 *      Risk Engine        (same sizing as live)
 *          ↓
 *      Simulator          (costs, gaps, one position at a time)
 *          ↓
 *      Metrics + Monte Carlo + walk-forward
 *
 * Everything is seeded and deterministic: same data + same strategy => same
 * numbers, every run.
 */

import { load } from "./data.mjs";
import { atr, sizePosition } from "./risk-engine.mjs";
import { experimentFromProtocol } from "./experiment.mjs";

// Simulator defaults come from the protocol, not from a literal here. This
// object used to hardcode equity/risk/fee/slippage/leverage AND disagree with
// protocol.v1.json on two values: `maxHoldBars` 40 here vs 96 in the protocol,
// and `warmup` 60 here vs 250. The runners always passed an explicit cfg built
// from simCfgFor, so the disagreement was invisible — but it meant the
// simulator's own fallback was a second, un-hashed definition of the
// experiment. Any caller that relied on the fallback (a selftest, a future
// entry point) silently ran a different experiment than the protocol describes.
const P = experimentFromProtocol();
const DEFAULTS = {
  equity: P.equity,              // paper-equivalent starting equity for the sim
  riskPct: P.riskPct,            // risk per trade
  stopAtrMult: P.stopAtrMult,
  atrPeriod: P.atrPeriod,
  leverage: P.leverage,
  allowFractional: P.allowFractional,
  feeBps: P.feeBps,              // per side
  slippageBps: P.slippageBps,    // adverse, per side
  maxHoldBars: P.maxHoldBars,
  warmup: P.warmup,              // bars reserved for indicator warm-up
  // NOTE: `ruinEquityPct` is deliberately NOT defaulted from the protocol.
  // DEFAULTS never had it, and the selftest fixtures that exercise the ruin
  // close-out depend on its absence (they pass it explicitly when they want it).
  // Adding it silently gave every fixture a 20% ruin floor and broke three
  // exit-path tests. The runners pass it from simCfgFor, which does read the
  // protocol, so the experiment is still fully bound.
};

// --------------------------------------------------------------- simulator

/**
 * Walk bars forward. One position at a time. Signal sees only data up to and
 * including the current bar, and decides AFTER the bar closes — so execution
 * happens on the NEXT bar's open. That one-bar delay is the difference between
 * an honest backtest and a fictional one.
 */
export function simulate({ bars, signal, cfg = {}, atrPeriod = 14 }) {
  const c = { ...DEFAULTS, ...cfg };
  const tfStep = bars.length > 1 ? bars[1].time - bars[0].time : 86400;
  // A run is ruined once equity cannot support one more unit of risk. Without
  // this the simulator keeps "trading" a dead account and the trade count stays
  // high, which would let a bankrupt strategy clear a minimum-trade gate.
  const ruinAt = c.ruinEquityPct != null ? c.equity * c.ruinEquityPct : null;

  let equity = c.equity;
  let pos = null;                 // { side, qty, entry, entryPrice, stop, entryFee }
  const trades = [];
  const equityCurve = [];
  let rejected = 0;
  let ruined = false;
  let ruinAtBar = null;
  let signalErrors = 0;
  let firstSignalError = null;

  for (let i = c.warmup; i < bars.length; i++) {
    const bar = bars[i];
    const next = bars[i + 1];

    // --- manage an open position first
    if (pos) {
      const held = bar.time - pos.entryTime;
      let exit = null, why = null;

      if (pos.side === "buy") {
        if (bar.low <= pos.stop)        { exit = pos.stop;        why = "stop"; }
        else if (held >= c.maxHoldBars * tfStep) { exit = bar.close; why = "time"; }
      } else {
        if (bar.high >= pos.stop)       { exit = pos.stop;        why = "stop"; }
        else if (held >= c.maxHoldBars * tfStep) { exit = bar.close; why = "time"; }
      }

      if (exit != null && next) {
        // fill at the exit with costs, on the next bar's open when stopped out
        const fillBase = why === "stop" ? next.open : next.open;
        const fill = applyCosts(fillBase, pos.side === "buy" ? "sell" : "buy", c);
        const gross = (fill - pos.entryPrice) * pos.qty * (pos.side === "buy" ? 1 : -1);
        const fees = pos.entryFee + Math.abs(fill * pos.qty) * (c.feeBps / 10000);
        const pnl = gross - fees;
        const equityBefore = equity;      // captured before the P&L is booked
        equity += pnl;
        trades.push({
          side: pos.side, entryTime: pos.entryTime, exitTime: next.time,
          entry: pos.entryPrice, exit: Number(fill.toFixed(8)), qty: pos.qty,
          stop: pos.stop, reason: why,
          barsHeld: Math.round((next.time - pos.entryTime) / tfStep),
          pnl: Number(pnl.toFixed(6)), returnPct: Number(((pnl / (pos.entryPrice * pos.qty)) * 100).toFixed(4)),
          // Equity BEFORE this trade was booked. `returnPct` above is a return
          // on NOTIONAL, and notional is up to 10x equity at 10x leverage — so
          // it cannot be compounded onto an equity curve without a 10x error.
          // Any resampling method (see robustness.mjs) needs the trade's
          // fractional return on ACCOUNT equity, and this is the only place in
          // the simulator where that number exists. Additive: no existing
          // metric reads it, so no recorded v1 number moves.
          equityBefore: Number(equityBefore.toFixed(8)),
        });
        pos = null;
      }
    }

    // --- flat: consider a new signal
    if (!pos && next) {
      const ctx = {
        i, bar, bars, atrPeriod,
        atr: atr(bars.slice(0, i + 1), atrPeriod),
        equity, openPosition: null,
        // Strategies read their parameters from `cfg`. This line was MISSING,
        // and it is load-bearing for the entire robustness apparatus.
        //
        // `c` is DEFAULTS merged with the caller's cfg, which is how a grid
        // variant reaches the strategy: `holdoutEvaluate` calls
        // `simulate({ cfg: { ...cfg, ...params } })` for every point of the
        // cartesian product. Without `cfg: c` in this object, `params` went
        // nowhere, every "variant" was the same default-config run, and the
        // gate's `parameter sensitivity` criterion silently measured nothing —
        // reporting 0% for every strategy in the repo, which reads exactly
        // like "no variant was profitable" rather than "nothing was varied".
        // Proven with a probe signal keyed on `cfg.n`: n=3, 7 and 40 all
        // returned an identical 213 trades.
        //
        // DEFAULTS keys are also visible here now, which is harmless: no
        // strategy reads a parameter by a name that collides with one
        // (equity, riskPct, maxHoldBars, warmup, feeBps, slippageBps,
        // stopAtrMult, leverage, ruinEquityPct, atrPeriod).
        cfg: c,
      };
      let sig = null;
      // A throwing signal used to be indistinguishable from a silent one. It is
      // counted and reported rather than swallowed, so a strategy that crashes
      // on some bars shows up as `signalErrors > 0` instead of quietly
      // producing fewer trades.
      try { sig = signal(ctx); }
      catch (err) { sig = null; signalErrors++; if (signalErrors === 1) firstSignalError = String(err && err.message || err); }
      if (sig && (sig.side === "buy" || sig.side === "sell")) {
        // Size with the SAME engine used in live execution.
        const a = atr(bars.slice(0, i + 1), atrPeriod);
        const size = sizePosition({
          equity, price: next.open, atrValue: a, side: sig.side,
          riskPct: c.riskPct, stopAtrMult: c.stopAtrMult,
          maxNotional: equity * 100, maxMargin: equity, leverage: c.leverage,
          allowFractional: c.allowFractional, existingExposure: 0,
        });
        if (!size.ok) {
          rejected++;
        } else {
          const entry = applyCosts(next.open, sig.side, c);
          pos = {
            side: sig.side, qty: size.qty, entryPrice: entry,
            entryTime: next.time,
            stop: sig.side === "buy" ? entry - size.stopDistance : entry + size.stopDistance,
            entryFee: Math.abs(entry * size.qty) * (c.feeBps / 10000),
            riskPlanned: size.riskAmount,
          };
        }
      }
    }

    equityCurve.push({ time: bar.time, equity });

    // Ruin check: stop the run. A dead account cannot take new risk, so every
    // trade after this point would be fictional.
    if (ruinAt != null && equity <= ruinAt && !ruined) {
      ruined = true;
      ruinAtBar = i;
      if (pos && next) {                      // close out at fair value
        const fill = pos.side === "buy" ? next.close : next.close;
        const gross = (fill - pos.entryPrice) * pos.qty * (pos.side === "buy" ? 1 : -1);
        const equityBefore = equity;
        equity += gross;
        trades.push({ side: pos.side, entryTime: pos.entryTime, exitTime: next.time,
          entry: pos.entryPrice, exit: Number(fill.toFixed(8)), qty: pos.qty, stop: pos.stop,
          reason: "ruin", barsHeld: Math.round((next.time - pos.entryTime) / tfStep),
          pnl: Number(gross.toFixed(6)), returnPct: Number(((gross / (pos.entryPrice * pos.qty)) * 100).toFixed(4)),
          equityBefore: Number(equityBefore.toFixed(8)) });
        pos = null;
      }
      break;
    }
  }

  // Mark any still-open position so the curve is honest.
  if (pos && bars.length) {
    const last = bars[bars.length - 1].close;
    const equityBefore = equity;
    const gross = (last - pos.entryPrice) * pos.qty * (pos.side === "buy" ? 1 : -1);
    trades.push({
      side: pos.side, entryTime: pos.entryTime, exitTime: pos.entryTime,
      entry: pos.entryPrice, exit: last, qty: pos.qty, stop: pos.stop,
      reason: "open_at_end", barsHeld: 0,
      pnl: Number(gross.toFixed(6)), returnPct: 0,
      equityBefore: Number(equityBefore.toFixed(8)),
    });
  }

  return { trades, equityCurve, finalEquity: equity, rejected, ruined, ruinAtBar, cfg: c,
           signalErrors, firstSignalError };
}

function applyCosts(price, side, c) {
  const adverse = price * (c.slippageBps / 10000);
  return side === "buy" ? price + adverse : price - adverse;
}

// ----------------------------------------------------------------- metrics

export function metrics({ trades, equityCurve, initialEquity, barSeconds = 86400, ruined = false }) {
  const n = trades.length;
  if (!n) {
    return { trades: 0, winRate: null, expectancy: null, profitFactor: null,
             sharpe: null, maxDrawdownPct: null, avgHoldBars: null, verdict: "NO_TRADES" };
  }
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const expectancy = trades.reduce((a, t) => a + t.pnl, 0) / n;

  // Sharpe from per-trade returns (not per-bar), annualised by trade count.
  const rets = trades.map((t) => t.returnPct / 100);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  const sharpe = sd > 0 ? mean / sd : null;

  let peak = equityCurve[0]?.equity ?? initialEquity, maxDd = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak > 0 ? (peak - p.equity) / peak : 0;
    if (dd > maxDd) maxDd = dd;
  }

  const totalReturn = (equityCurve[equityCurve.length - 1]?.equity ?? initialEquity) / initialEquity - 1;

  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: Number(((wins.length / n) * 100).toFixed(2)),
    expectancy: Number(expectancy.toFixed(6)),
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(3)) : (grossWin > 0 ? "inf" : 0),
    grossWin: Number(grossWin.toFixed(4)),
    grossLoss: Number(grossLoss.toFixed(4)),
    sharpe: sharpe == null ? null : Number(sharpe.toFixed(3)),
    maxDrawdownPct: Number((maxDd * 100).toFixed(2)),
    totalReturnPct: Number((totalReturn * 100).toFixed(2)),
    avgHoldBars: Number((trades.reduce((a, t) => a + (t.barsHeld || 0), 0) / n).toFixed(1)),
    ruined,
    ruinTradeIndex: ruined ? trades.findIndex((t) => t.reason === "ruin") : -1,
    expectancyR: trades.reduce((a, t) => a + t.returnPct, 0) / n,
  };
}

// ------------------------------------------------------------ monte carlo

/**
 * THE PORTFOLIO MODEL, stated exactly. One definition, three files.
 *
 * N symbols become N INDEPENDENT SUB-ACCOUNTS, each of `initialEquity`, each
 * trading only its own trades. The book is the ARITHMETIC MEAN of the N
 * sleeves' equity at every point in time:
 *
 *     A(t) = (1/N) * sum_s equity_s(t)
 *
 *   - Portfolio RETURN is the MEAN of the N per-symbol returns, additive. It is
 *     never the product of the returns, which is a 5x-geared book.
 *   - Portfolio max DRAWDOWN is the drawdown OF A(t). Never the worst single
 *     symbol, and never the sum of the per-symbol drawdowns — the mean of N
 *     drawdowns is not the drawdown of any account and throws away the only
 *     thing a drawdown measures, which is the ORDER of the paths.
 *   - A `null` in a sleeve is forward-filled from that sleeve's OWN last value.
 *     A ruined account stops trading and stops reporting, but its capital does
 *     not come back; dropping the sleeve instead would delete its losses and
 *     shrink the book.
 *
 * The same model is implemented in `robustness.mjs` (`equalWeightPath`, on
 * resampled outcomes) and in `gate.mjs` (`equalWeightPath`/`equalWeightBook`, on
 * aligned curves). Those are the two implementations this one is pinned
 * against by the "equal-weight book" selftests below, so the three cannot
 * silently drift apart.
 *
 * WHAT THIS REPLACED, and in which direction it was wrong. This function
 * replayed the POOLED five-symbol trade set against a SINGLE `initialEquity`,
 * so its equity path was the return of five FULL accounts compounded into one
 * 1000-unit account: a 5x-GEARED book, exactly the error `evidence.mjs` names
 * in its own header ("drawdown and return are PATH properties and must NOT be
 * pooled across symbols"). It was wrong in the flattering direction, which is
 * the worst direction for a risk statistic:
 *
 *   - the geared path is five times as volatile as the real book, so its
 *     drawdown was inflated roughly fivefold;
 *   - worse, it is not a drawdown at all. On the real cached dataset
 *     (vol-normalized-breakout, 2583 pooled trades, seed 12345) the geared
 *     replay ended at an equity of -500.64 — a NEGATIVE account balance, which
 *     no real book can report — and its `(peak - eq) / peak` therefore reported
 *     a median drawdown of 168.41% and a worst of 363.73%, percentages no
 *     account can lose. Under the non-negative-equity condition — every sleeve's
 *     path stays at or above zero, which `simulate`'s ruin rule enforces — this
 *     equal-weight book cannot exceed 100% by construction, and reports a
 *     median of 54.58% and a worst of 92.63% on the
 *     same trades. That 54.58% is what `evidence.agg.maxDrawdownPct` reports
 *     (54.55%), which is the point: the `P(dd breach)` criterion and the
 *     `max drawdown %` criterion now describe the same book.
 *
 * The 100% bound is CONDITIONAL and the condition is not decorative. A sleeve
 * that trades through zero has an equity curve that crosses the denominator of
 * `(peak - eq) / peak`, where the ratio stops being a fraction of a loss and
 * becomes larger than 1: `equalWeightPath([[1000, -500, -500], ...])` reports
 * 150%. The `peak > 0` guard in the scan below stops the scan running past a
 * non-positive peak, but it cannot un-report a book whose peak was already
 * above zero and whose trough went below it. So: the bound holds for any book
 * that never goes negative, and does not hold for one that does. The old text
 * claimed it unconditionally, which is false.
 *
 * So the honest number here is SMALLER than the old one, and the old one was
 * not a conservative error to be compensated for with a threshold. It was a
 * number with no referent. No threshold was moved.
 *
 * SINGLE-SYMBOL CALLERS ARE BIT-IDENTICAL. A raw `simulate()` trade carries no
 * `symbol`, so it forms one sleeve of N=1, and then A(t) is that one account:
 * one Fisher-Yates over one bag off the same RNG stream in the same order, one
 * equity path, no forward-filling (a sleeve is defined at every step of its own
 * axis), and the same peak/drawdown scan. The selftest pins it, and it is
 * asserted on the real cached data too.
 */
export function monteCarlo({ trades, initialEquity, runs = 1000, seed = 12345, ddThresholdPct = 20 }) {
  if (trades.length < 5) return { runs: 0, note: "too few trades" };
  const sleeves = groupSleeves(trades);
  const N = sleeves.length;
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const legsOf = sleeves.map((g) => ({ pnls: g.rows.map((t) => t.pnl), times: g.times }));
  // The sum of a fixed P&L set is order-invariant, so "final equity
  // percentiles" would be a constant and carry no information. What ordering
  // changes is the PATH: drawdown depth, drawdown breach probability, and the
  // longest losing run. Those are the risk quantities, so those are reported.
  //
  // The book's FINAL equity is the mean of the sleeves' final equities:
  //   A(T) = (1/N) * sum_s (initialEquity + sum_{t in s} pnl)
  //        = initialEquity + (1/N) * sum_{all t} pnl
  // which for N=1 is exactly `initialEquity + sum(pnl)`, the pre-portfolio
  // value. It is also algebraically the MEAN of the N per-symbol returns over
  // `initialEquity`, so it is the additive portfolio return by construction.
  const pooledPnl = legsOf.reduce((a, l) => a + l.pnls.reduce((x, y) => x + y, 0), 0);
  const finalEquity = initialEquity + pooledPnl / N;

  const maxDds = [], streaks = [], compDds = [];
  let breached = 0;
  for (let r = 0; r < runs; r++) {
    // 1. Shuffle WITHIN each sleeve, independently, so a trade never migrates
    //    between symbols and the book is always N real sub-accounts. Swapping an
    //    index array rather than the P&L array makes the single-sleeve case the
    //    same swap sequence, in the same order, as the pre-portfolio shuffle.
    const legs = legsOf.map((l) => shuffleLeg(l, rnd));

    // 2. Replay each sleeve against its OWN account of `initialEquity`. No
    //    sleeve sees another sleeve's P&L and no P&L is ever divided by N: the
    //    scaling happens exactly once, in the average below.
    const paths = legs.map((leg) => {
      const eq = new Array(leg.length);
      let e = initialEquity;
      for (let i = 0; i < leg.length; i++) { e += leg[i].pnl; eq[i] = e; }
      return eq;
    });

    // 3. Average the N sleeves into the book on a shared step axis. The axis is
    //    as long as the LONGEST sleeve, so a shorter sleeve is `null` past its
    //    own end and is forward-filled from its own last value. N = 1 => the
    //    axis is exactly that sleeve and no forward-fill ever fires.
    const steps = Math.max(...paths.map((p) => p.length));
    let a = initialEquity, peak = initialEquity, dd = 0;
    for (let k = 0; k < steps; k++) {
      let sum = 0;
      for (let j = 0; j < N; j++) {
        const p = paths[j];
        sum += k < p.length ? p[k] : p[p.length - 1];      // forward-fill, own value
      }
      a = sum / N;
      if (a > peak) peak = a;
      if (peak > 0) dd = Math.max(dd, (peak - a) / peak);
    }
    maxDds.push(dd);
    if (dd * 100 >= ddThresholdPct) breached++;

    // Longest losing run of CONSECUTIVE LOSING TRADES, on the time-merged
    // stream of the N shuffled sleeves. This stays a TRADE-level quantity — the
    // repo's rule pools trade statistics and forbids pooling only paths — so it
    // is unaffected by the portfolio model. The merge is a k-way merge on
    // trade time, and with one sleeve it is the identity, so the single-symbol
    // number is the pre-portfolio one. It is deliberately NOT computed from the
    // book's step returns: the geared replay drove the account negative, and a
    // ratio of two negatives flips the sign of a profitable step.
    let streak = 0, worstStreak = 0;
    for (const p of mergeByTime(legs)) {
      streak = p <= 0 ? streak + 1 : 0;
      if (streak > worstStreak) worstStreak = streak;
    }
    streaks.push(worstStreak);

    // DIAGNOSTIC ONLY, read by no criterion: the mean of the N per-sleeve
    // drawdowns. Reported so the difference between it and the book's own
    // drawdown above is visible rather than asserted.
    compDds.push(paths.reduce((acc, p) => acc + sleeveDrawdown(p, initialEquity), 0) / N);
  }
  const q = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; };

  return {
    runs,
    trades: trades.length,
    finalEquity: Number(finalEquity.toFixed(2)),        // identical for every ordering
    note: "finalEquity is order-invariant; the distributions below are the risk signal",
    symbols: sleeves.map((g) => g.symbol),
    symbolCount: N,
    scope: N > 1
      ? `equal-weight portfolio of ${N} symbols: ${N} independent sub-accounts of `
        + `${initialEquity}, book equity = arithmetic mean of the ${N} curves at every step; `
        + `trades shuffled WITHIN each symbol only`
      : "single account",
    portfolioModel: "equal-weight additive (arithmetic mean of per-symbol equity curves)",
    medianMaxDrawdownPct: Number((q(maxDds, 0.5) * 100).toFixed(2)),
    p95MaxDrawdownPct: Number((q(maxDds, 0.95) * 100).toFixed(2)),
    worstMaxDrawdownPct: Number((Math.max(...maxDds) * 100).toFixed(2)),
    // DIAGNOSTIC ONLY, read by no criterion. It sits below the book's own
    // drawdown under the non-negative-equity condition — no sleeve's path ever
    // crossing zero — which is the case the ruin rule produces. That ordering
    // is a consequence of the book's equity being the MEAN of its sleeves'
    // (an average cannot fall below the average of their peaks by more than the
    // average of their declines) and NOT an unconditional bound: once a sleeve
    // is driven negative the ratio `(peak - eq) / peak` is measured from a
    // denominator that is itself below the peak, and a book can then report
    // more than 100%. The selftest below pins the ordering on a fixture that
    // stays non-negative; it does not establish it for books that do not.
    maxDrawdownPctComponentsMeanMedian: Number((q(compDds, 0.5) * 100).toFixed(2)),
    diagnosticOnly: ["maxDrawdownPctComponentsMeanMedian"],
    ddThresholdPct,
    probabilityOfBreachingThreshold: Number(((breached / runs) * 100).toFixed(2)),
    medianLongestLosingStreak: q(streaks, 0.5),
    p95LongestLosingStreak: q(streaks, 0.95),
    observedLongestLosingStreak: Math.max(...streaks),
  };
}

/**
 * Split a trade list into per-symbol sleeves, each keeping its OWN trades.
 *
 * Keyed on `t.symbol`, which `evidence.mjs` stamps on every pooled trade. A raw
 * `simulate()` trade carries no symbol and therefore forms exactly one sleeve —
 * which is what makes every single-symbol caller bit-identical to the
 * pre-portfolio implementation.
 *
 * Robustness.mjs groups the same way and carries each group's own returns; the
 * two are pinned together by the cross-check selftest, and the time precedence
 * below is deliberately identical to `robustness.mjs`'s `tradeTime`, because
 * only one of the two files can be edited at a time and a silent divergence
 * here would move the block bootstrap's ordering.
 */
function groupSleeves(trades) {
  const by = new Map();
  trades.forEach((t, i) => {
    const k = t.symbol ?? "_single";
    let g = by.get(k);
    if (!g) { g = { symbol: k, rows: [], times: [] }; by.set(k, g); }
    g.rows.push(t);
    g.times.push(tradeTimeOf(t, i));
  });
  return [...by.values()];
}

/**
 * When a trade happened. `evidence.mjs` stamps `time` (exit time plus a
 * per-symbol bar offset) on every pooled trade, which is the normal case; raw
 * `simulate()` trades carry only `entryTime`/`exitTime`. With no timestamp at
 * all the only ordering that exists is the order supplied, and collapsing every
 * trade onto t=0 would destroy the path.
 */
function tradeTimeOf(t, position) {
  if (Number.isFinite(t.time)) return t.time;
  if (Number.isFinite(t.exitTime)) return t.exitTime;
  if (Number.isFinite(t.entryTime)) return t.entryTime;
  return position;
}

/** Seeded Fisher-Yates over one sleeve, carrying each trade's time with it. */
function shuffleLeg({ pnls, times }, rnd) {
  const idx = pnls.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.map((i) => ({ pnl: pnls[i], time: times[i] }));
}

/**
 * k-way merge of the shuffled sleeves on trade time, yielding one P&L stream.
 * Ties go to the lowest sleeve index, so the merge is deterministic. With a
 * single sleeve it is the identity on that sleeve's shuffled order.
 */
function mergeByTime(legs) {
  const n = legs.length;
  const cur = new Array(n).fill(0);
  const out = [];
  let left = legs.reduce((a, l) => a + l.length, 0);
  while (left > 0) {
    let best = -1, bt = Infinity;
    for (let k = 0; k < n; k++) {
      if (cur[k] >= legs[k].length) continue;
      const t = legs[k][cur[k]].time;
      if (t < bt) { bt = t; best = k; }
    }
    if (best < 0) break;
    out.push(legs[best][cur[best]].pnl);
    cur[best]++; left--;
  }
  return out;
}

/** Max drawdown of ONE sleeve's own equity path. Diagnostic input only. */
function sleeveDrawdown(eq, base) {
  let peak = base, dd = 0;
  for (const v of eq) {
    if (v > peak) peak = v;
    if (peak > 0) dd = Math.max(dd, (peak - v) / peak);
  }
  return dd;
}

// ----------------------------------------------------------- walk-forward

/**
 * Split-and-test: repeated out-of-sample evaluation over sequential windows.
 *
 * Each fold is given `warmup` bars of history BEFORE its test window, so
 * indicators are actually primed inside the fold. Without that, a moving
 * average sees 1 bar and never fires — which silently turns walk-forward into
 * "report almost no trades" rather than an honest evaluation.
 */
export function walkForward({ bars, signal, cfg = {}, folds = 4, warmup = DEFAULTS.warmup }) {
  const usable = bars.slice(warmup);
  if (usable.length < folds * 40) return { folds: 0, note: "not enough bars for walk-forward" };
  const size = Math.floor(usable.length / folds);
  const out = [];
  for (let f = 0; f < folds; f++) {
    const start = f * size;
    // history immediately preceding this fold, for indicator warm-up
    const hist = bars.slice(Math.max(0, warmup + start - warmup), warmup + start);
    const test = usable.slice(start, start + size);
    if (hist.length < 2 || test.length < 20) continue;

    const series = [...hist, ...test];
    const res = simulate({ bars: series, signal, cfg: { ...cfg, warmup: hist.length } });
    const m = metrics({ trades: res.trades, equityCurve: res.equityCurve, initialEquity: res.cfg.equity });
    out.push({ fold: f + 1, testBars: test.length, histBars: hist.length,
               trades: m.trades, winRate: m.winRate, profitFactor: m.profitFactor,
               expectancy: m.expectancy, totalReturnPct: m.totalReturnPct });
  }
  const traded = out.filter((o) => o.trades > 0);
  const totalTrades = traded.reduce((a, o) => a + o.trades, 0);
  const foldsProfitable = traded.filter((o) => o.totalReturnPct > 0).length;

  // A SILENT FOLD IS A FAILED FOLD, SO THE DENOMINATOR IS EVERY FOLD.
  //
  // This used to divide by `traded.length` — the folds that happened to fire.
  // That made a strategy that cannot trade for a whole out-of-sample window
  // INVISIBLE to the statistic instead of penalised by it: a signal long until
  // the last fold and silent through it reported folds=4, foldsWithTrades=3 and
  // a perfect consistency of 100, and cleared the v1 `walk-forward consistency %`
  // criterion (MIN_WF = 50) on that number. The fold the strategy had no opinion
  // about was read as evidence it worked, which is the exact
  // "only-right-for-the-average-of-the-sample" failure this statistic exists to
  // detect.
  //
  // It is not a missing datum that was dropped. A fold with no out-of-sample
  // trades had a complete-sample return of 0 — it did not trade, so it neither
  // gained nor lost — and 0 is not `> 0`, so it was already excluded from the
  // NUMERATOR. Only the denominator was flattering it. `robustness.mjs`'s
  // `anchoredWalkForward` (the v2 implementation of the same idea) was fixed
  // earlier in this changeset and counts silent folds the same way; the two
  // must not disagree, because gate.mjs reads THIS one.
  //
  // WHAT THIS DOES NOT DO. It narrows the hole; it does not close it. At
  // MIN_WF = 50 a strategy silent for one fold in four now reads 75% and STILL
  // PASSES. Closing that needs a v1 fold-coverage criterion, which is a
  // protocol change (it moves the v1 hash) and therefore the repo owner's
  // decision, not a computation fix. Until it exists, `foldCoveragePct` /
  // `foldsSilent` below are the only visible sign of the gap, which is why they
  // are in the record rather than left implicit in the denominator.
  const total = out.length;

  return {
    folds: total,
    perFold: out,
    foldsWithTrades: traded.length,
    // Diagnostics, not criteria: no v1 criterion reads these, because adding one
    // would move the protocol hash. They exist so the denominator is auditable
    // from the artefact alone. Named to match `robustness.mjs`'s v2 fields
    // (`foldsSilent` is identical; v2's coverage field is `foldCoverage`).
    foldsSilent: total - traded.length,
    foldCoveragePct: total ? Number(((traded.length / total) * 100).toFixed(1)) : null,
    totalTrades,
    foldsProfitable,
    consistencyDenominator: total,
    consistency: total
      ? Number(((foldsProfitable / total) * 100).toFixed(1))
      : null,
    consistencyNote: total === traded.length
      ? `profitable folds / all ${total} folds; no fold was silent`
      : `${foldsProfitable}/${total} folds profitable out of sample; `
        + `${total - traded.length} silent fold(s) counted as failures, not excluded`,
    caveat: traded.length && totalTrades / traded.length < 20
      ? "few trades per fold - consistency is weakly determined"
      : null,
  };
}

// ------------------------------------------------------------------ CLI

async function runCli(argv) {
  const get = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  const strategy = get("--strategy", "buy-and-hold");
  const provider = get("--provider", "binance");
  const symbol = get("--symbol", "DOGEUSDT");
  const tf = get("--tf", "1d");
  const equity = Number(get("--equity", 1000));
  const runs = Number(get("--mc", 1000));

  const mod = await import(`./strategies/${strategy}.mjs`);
  const signal = mod.default;

  const data = await load({ provider, symbol, tf });
  const sim = simulate({ bars: data.bars, signal, cfg: { equity } });
  const m = metrics({ trades: sim.trades, equityCurve: sim.equityCurve, initialEquity: equity });
  const mc = monteCarlo({ trades: sim.trades, initialEquity: equity, runs });
  const wf = walkForward({ bars: data.bars, signal, cfg: { equity } });

  const report = {
    run: { strategy, provider, symbol: data.symbol, tf, bars: data.bars.length,
           spanDays: data.audit.spanDays, from: data.audit.from, to: data.audit.to,
           equity, sizingRejected: sim.rejected, costs: { feeBps: sim.cfg.feeBps, slippageBps: sim.cfg.slippageBps } },
    metrics: m,
    monteCarlo: mc,
    walkForward: wf,
    dataGaps: data.audit.gaps,
  };
  console.log(JSON.stringify(report, null, 2));
  console.log("\n--- verdicts ---");
  const v = (ok, label) => console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  v(m.trades >= 30, `trade count >= 30 (have ${m.trades}) - below this, results are noise`);
  v(m.profitFactor > 1, `profit factor > 1 (have ${m.profitFactor})`);
  v(m.maxDrawdownPct < 40, `max drawdown < 40% (have ${m.maxDrawdownPct}%)`);
  v(wf.consistency == null || wf.consistency >= 50, `walk-forward consistency >= 50% (have ${wf.consistency}%)`);
  if (wf.caveat) console.log(`  WARN  ${wf.caveat}`);
  if (m.trades < 100) console.log("  NOTE  under 100 trades - treat any edge as unproven");
  v(mc.probabilityOfBreachingThreshold < 25, `P(drawdown >= ${mc.ddThresholdPct}%) < 25% (have ${mc.probabilityOfBreachingThreshold}%)`);
  if (m.trades < 30) console.log("\n  NOTE: fewer than 30 trades. This is not evidence of anything.");
}

const IS_HARNESS = process.argv[1] && process.argv[1].endsWith("harness.mjs");

if (IS_HARNESS && process.argv[2] === "run") {
  runCli(process.argv.slice(3)).catch((e) => { console.error("error: " + e.message); process.exit(1); });
}
// ------------------------------------------------- out-of-sample holdout

/** Chronological split. The test half is never used to choose anything. */
export function holdoutSplit(bars, trainFrac = 0.7, warmup = DEFAULTS.warmup) {
  const cut = Math.floor(bars.length * trainFrac);
  return {
    train: bars.slice(0, cut),
    // give the test window the warmup bars immediately before it, so
    // indicators are primed without leaking anything from the future
    test: bars.slice(Math.max(0, cut - warmup)),
    cutIndex: cut,
  };
}

/**
 * Choose a parameter variant on TRAIN, then evaluate that exact variant on
 * TEST. This is the only honest way to use a holdout: picking parameters by
 * looking at the test half converts it into a second training set.
 */
export function holdoutEvaluate({ bars, signal, cfg = {}, grid = {}, objective = "sharpe", trainFrac = 0.7 }) {
  const { train, test, cutIndex } = holdoutSplit(bars, trainFrac, cfg.warmup ?? DEFAULTS.warmup);
  if (train.length < 200 || test.length < 100) return { ok: false, reason: "not enough bars to split" };

  const keys = Object.keys(grid);
  const variants = [];
    // enumerate the cartesian product

  const idx = new Array(keys.length).fill(0);
  const combos = [];
  for (;;) {
    combos.push(Object.fromEntries(keys.map((k, j) => [k, grid[k][idx[j]]])));
    let j = keys.length - 1;
    while (j >= 0) { idx[j]++; if (idx[j] < grid[keys[j]].length) break; idx[j] = 0; j--; }
    if (j < 0) break;
  }

  for (const params of combos) {
    const r = simulate({ bars: train, signal, cfg: { ...cfg, ...params } });
    const m = metrics({ trades: r.trades, equityCurve: r.equityCurve, initialEquity: r.cfg.equity, ruined: r.ruined });
    variants.push({ params, train: m, ruined: r.ruined, test: null });
  }
  if (!variants.length) return { ok: false, reason: "empty parameter grid" };

  const score = (m) => (objective === "sharpe" ? (m.sharpe ?? -99) : objective === "pf" ? Number(m.profitFactor === "inf" ? 99 : m.profitFactor) : m.totalReturnPct);
  const viable = variants.filter((v) => !v.ruined && v.train.trades > 0);
  const best = (viable.length ? viable : variants).reduce((a, b) => (score(b.train) > score(a.train) ? b : a));

  // Evaluate the chosen variant on data it has never seen.
  const rt = simulate({ bars: test, signal, cfg: { ...cfg, ...best.params } });
  const mt = metrics({ trades: rt.trades, equityCurve: rt.equityCurve, initialEquity: rt.cfg.equity, ruined: rt.ruined });

  const trainScore = score(best.train);
  const testScore = score(mt);
  return {
    ok: true,
    objective,
    cutIndex,
    trainBars: train.length,
    testBars: test.length,
    variantsTested: variants.length,
    chosen: best.params,
    train: best.train,
    test: mt,
    testRuin: rt.ruined,
    // Degradation: how much of the in-sample result survived out of sample.
    degradation: trainScore > 0 ? Number((testScore / trainScore).toFixed(3)) : null,
    // A narrow winner among many variants is the signature of curve fitting.
    variantsPositive: variants.filter((v) => score(v.train) > 0).length,
    sensitivity: Number((variants.filter((v) => score(v.train) > 0).length / variants.length).toFixed(3)),
  };
}

// ------------------------------------------------------------ cost stress

/**
 * Re-run the same signal at progressively worse costs. A real edge survives
 * realistic frictions; a curve-fit one dissolves the moment fees rise.
 */
export function costStress({ bars, signal, cfg = {}, feeMults = [1, 2, 5], slipMults = [1, 2, 5] }) {
  const base = { feeBps: DEFAULTS.feeBps, slippageBps: DEFAULTS.slippageBps, ...cfg };
  const grid = [];
  for (const f of feeMults) {
    for (const s of slipMults) {
      const c = { ...base, feeBps: DEFAULTS.feeBps * f, slippageBps: DEFAULTS.slippageBps * s };
      const r = simulate({ bars, signal, cfg: c });
      const m = metrics({ trades: r.trades, equityCurve: r.equityCurve, initialEquity: r.cfg.equity, ruined: r.ruined });
      grid.push({
        feeMult: f, slipMult: s,
        feeBps: Number(c.feeBps.toFixed(2)), slippageBps: Number(c.slippageBps.toFixed(2)),
        profitFactor: m.profitFactor, sharpe: m.sharpe, totalReturnPct: m.totalReturnPct, ruined: r.ruined,
      });
    }
  }
  const baseline = grid.find((g) => g.feeMult === 1 && g.slipMult === 1);
  const survivors = grid.filter((g) => !g.ruined && Number(g.profitFactor) > 1);
  // The worst cost level at which the strategy still makes money.
  const cost = (g) => g.feeBps + g.slippageBps;
  const best = survivors.length ? survivors.reduce((a, b) => (cost(b) > cost(a) ? b : a)) : null;
  return {
    grid,
    baseline: baseline ?? null,
    survived: survivors.length,
    of: grid.length,
    survivalRate: Number((survivors.length / grid.length).toFixed(3)),
    maxSurvivableFeeBps: best ? best.feeBps : null,
    maxSurvivableSlippageBps: best ? best.slippageBps : null,
  };
}

// --------------------------------------------------------------- selftest
if (IS_HARNESS && process.argv[2] !== "run") {
  let pass = 0, fail = 0;
  const check = (n, c, x = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); };
  console.log("harness.mjs selftest\n");

  // Deterministic synthetic market with a known drift.
  const mk = (n, drift, vol = 1) => {
    const b = []; let px = 100;
    for (let i = 0; i < n; i++) {
      const d = drift + Math.sin(i / 5) * vol;
      const o = px, c = px + d;
      b.push({ time: 1767225600 + i * 86400, open: o, high: Math.max(o, c) + vol, low: Math.min(o, c) - vol, close: c, volume: 1 });
      px = c;
    }
    return b;
  };

  // A deliberately trivial signal: always long.
  const alwaysLong = () => ({ side: "buy" });
  // These fixtures are 400 bars. DEFAULTS.warmup is now the protocol's 250
// (it used to be a literal 60 here), so a 400-bar series leaves only 150 bars
// to trade and the exit-path fixtures below stopped producing trades at all.
// The fix is to size the fixtures to the warmup they actually need, not to
// soften the protocol: a simulator that silently trades nothing is exactly the
// failure this session has been removing.
const up = mk(400, 0.6), down = mk(400, -0.6), flat = mk(400, 0.0);
// Exit-path fixtures get a SHORT warmup so the behaviour under test (ruin
// close-out, open_at_end) is reached in a short series. Declared here rather
// than defaulted, so the test states its own assumption.
const EXIT_CFG = { warmup: 20 };

  const rUp = simulate({ bars: up, signal: alwaysLong });
  const mUp = metrics({ trades: rUp.trades, equityCurve: rUp.equityCurve, initialEquity: DEFAULTS.equity });
  check("produces trades", mUp.trades > 0, `${mUp.trades}`);
  check("a rising market with a long signal is profitable", mUp.totalReturnPct > 0, `${mUp.totalReturnPct}%`);
  check("reports drawdown >= 0", mUp.maxDrawdownPct >= 0, `${mUp.maxDrawdownPct}%`);

  const rDown = simulate({ bars: down, signal: alwaysLong, cfg: EXIT_CFG });
  const mDown = metrics({ trades: rDown.trades, equityCurve: rDown.equityCurve, initialEquity: DEFAULTS.equity });
  check("a falling market with a long signal loses", mDown.totalReturnPct < 0, `${mDown.totalReturnPct}%`);

  const never = simulate({ bars: up, signal: () => null });
  check("a signal that never fires yields no trades", never.trades.length === 0);
  const mNever = metrics({ trades: never.trades, equityCurve: never.equityCurve, initialEquity: DEFAULTS.equity });
  check("metrics refuse to report on zero trades", mNever.verdict === "NO_TRADES");

  // Determinism
  const a1 = simulate({ bars: up, signal: alwaysLong });
  const a2 = simulate({ bars: up, signal: alwaysLong });
  check("same input => same result", JSON.stringify(a1.trades) === JSON.stringify(a2.trades));

  // --- cfg MUST reach the signal -------------------------------------------
  // Regression guard. `simulate` once built its ctx WITHOUT a `cfg` key, so
  // every grid variant in `holdoutEvaluate` ran the strategy's defaults and the
  // gate's parameter-sensitivity criterion measured nothing at all. A signal
  // keyed on `cfg.n` is used because it cannot be confused: if cfg is forwarded
  // the trade counts MUST differ, and if they match, cfg is being dropped.
  const cfgProbe = ({ i, cfg }) => ((i % ((cfg && cfg.n) ?? 7)) === 0 ? { side: "buy" } : null);
  const p3 = simulate({ bars: up, signal: cfgProbe, cfg: { n: 3 } });
  const p40 = simulate({ bars: up, signal: cfgProbe, cfg: { n: 40 } });
  check("simulate forwards cfg to the signal",
        p3.trades.length !== p40.trades.length,
        `n=3 -> ${p3.trades.length} trades, n=40 -> ${p40.trades.length} trades`);
  check("default is used when cfg omits the key",
        simulate({ bars: up, signal: cfgProbe }).trades.length ===
        simulate({ bars: up, signal: cfgProbe, cfg: { n: 7 } }).trades.length);

  // A grid must produce genuinely different variants, not N copies of one run.
  const ho = holdoutEvaluate({ bars: up, signal: cfgProbe, cfg: {},
    grid: { n: [3, 11, 40] }, objective: "sharpe", trainFrac: 0.7 });
  check("holdoutEvaluate reports a variant count", ho.ok && ho.variantsTested === 3,
        `variantsTested=${ho.variantsTested}`);

  // A throwing signal must be visible, not silent.
  const thrower = () => { throw new Error("boom"); };
  const thr = simulate({ bars: up, signal: thrower });
  check("a throwing signal is counted, not swallowed",
        thr.signalErrors > 0 && thr.trades.length === 0,
        `signalErrors=${thr.signalErrors}, trades=${thr.trades.length}`);

  // Costs must matter
  const free = simulate({ bars: up, signal: alwaysLong, cfg: { feeBps: 0, slippageBps: 0 } });
  check("costs reduce returns", free.finalEquity >= rUp.finalEquity,
        `${free.finalEquity.toFixed(2)} >= ${rUp.finalEquity.toFixed(2)}`);

  // One position at a time
  check("never holds two positions at once",
        rUp.trades.every((t, i) => i === 0 || t.entryTime >= rUp.trades[i - 1].exitTime));

  // No lookahead: entry must be strictly after the signal bar
  check("execution is delayed one bar (no lookahead)",
        rUp.trades.every((t) => t.entryTime > t.entryTime - 86400 && t.barsHeld >= 0));

  // --- equityBefore is part of the simulator's contract
  // robustness.mjs resamples trades by compounding pnl/equityBefore. If a trade
  // record ever loses that field the bootstrap silently falls back to
  // pnl/initialEquity, which is the right number only for the first trade and
  // wrong by an order of magnitude for the rest. Pin it here, at the source.
  check("every trade records the equity it was taken against",
    rUp.trades.length > 0 && rUp.trades.every((t) => typeof t.equityBefore === "number" && t.equityBefore > 0),
    `first: ${rUp.trades[0]?.equityBefore} of ${rUp.trades[0]?.pnl} pnl`);
  check("equityBefore is monotonically non-decreasing across trades",
    rUp.trades.every((t, i) => i === 0 || t.equityBefore >= rUp.trades[i - 1].equityBefore - 1e-6));
  check("a fractional return pnl/equityBefore is far smaller than returnPct at 10x leverage",
    rUp.trades.some((t) => t.returnPct > 0 && Math.abs(t.pnl / t.equityBefore) < t.returnPct / 100),
    "notional return is not an account return — compounding it would be a 10x error");

  // Every trade-record exit path has to carry equityBefore, including the two
  // the fixtures above never reach. A falling market with a ruin threshold set
  // exercises the ruin close-out; ending mid-position exercises open_at_end.
  // Both of these were missing the field at least once, and neither was
  // covered, because DEFAULTS has no ruinEquityPct and every fixture above ends
  // flat.
  {
    const longDown = mk(1500, -0.6);
    const ruinedRun = simulate({ bars: longDown, signal: alwaysLong, cfg: { ...EXIT_CFG, ruinEquityPct: 0.9 } });
    check("a ruined run reports the ruin",
      ruinedRun.ruined && ruinedRun.ruinAtBar != null && ruinedRun.trades.some((t) => t.reason === "ruin"),
      `ruinAtBar=${ruinedRun.ruinAtBar}, ${ruinedRun.trades.length} trades`);
    check("the ruin close-out also records equityBefore",
      ruinedRun.trades.every((t) => typeof t.equityBefore === "number" && t.equityBefore > 0),
      `${ruinedRun.trades.length} trades, all with equityBefore`);
    check("every trade reason in a ruined run carries equityBefore",
      ["stop", "time", "ruin", "open_at_end"].every((why) =>
        !ruinedRun.trades.some((t) => t.reason === why) || ruinedRun.trades.filter((t) => t.reason === why).every((t) => t.equityBefore > 0)),
      [...new Set(ruinedRun.trades.map((t) => t.reason))].join(","));
  }

  // Monte Carlo determinism + bounds.
  // NOTE: MC is meaningless on a small, one-sided trade set — shuffling 9
  // identical winners gives the same final equity every run. Use a choppy
  // market so the trade outcomes actually vary, which is the only case where
  // the percentiles carry information.
  const choppy = mk(600, 0, 2.2);
  const rChop = simulate({ bars: choppy, signal: alwaysLong, cfg: { maxHoldBars: 8 } });
  const mChop = metrics({ trades: rChop.trades, equityCurve: rChop.equityCurve, initialEquity: DEFAULTS.equity });
  check("choppy market produces a mixed trade set",
        mChop.wins > 0 && mChop.losses > 0, `${mChop.wins}W/${mChop.losses}L of ${mChop.trades}`);

  const mc1 = monteCarlo({ trades: rChop.trades, initialEquity: DEFAULTS.equity, runs: 500 });
  const mc2 = monteCarlo({ trades: rChop.trades, initialEquity: DEFAULTS.equity, runs: 500 });
  const mcAlt = monteCarlo({ trades: rChop.trades, initialEquity: DEFAULTS.equity, runs: 500, seed: 999 });
  // This assertion used to read `mc1.medianFinalEquity === mc2.medianFinalEquity`.
  // monteCarlo() has no such field, so it was `undefined === undefined` — always
  // true, and the MC determinism guarantee was untested. Assert on a real
  // SEEDED statistic instead: the shuffle order depends on the seed, so
  // `p95LongestLosingStreak` and the drawdown percentiles must reproduce exactly
  // and must move when the seed moves.
  check("monte carlo is deterministic on a real seeded statistic",
    mc1.p95LongestLosingStreak === mc2.p95LongestLosingStreak
    && mc1.medianMaxDrawdownPct === mc2.medianMaxDrawdownPct
    && mc1.p95MaxDrawdownPct === mc2.p95MaxDrawdownPct,
    `p95 streak ${mc1.p95LongestLosingStreak}, median dd ${mc1.medianMaxDrawdownPct}%`);
  check("a DIFFERENT seed changes the monte carlo answer (negative control)",
    mcAlt.p95LongestLosingStreak !== mc1.p95LongestLosingStreak
    || mcAlt.medianMaxDrawdownPct !== mc1.medianMaxDrawdownPct,
    `seed 12345 -> streak ${mc1.p95LongestLosingStreak}, dd ${mc1.medianMaxDrawdownPct}%; seed 999 -> streak ${mcAlt.p95LongestLosingStreak}, dd ${mcAlt.medianMaxDrawdownPct}%`);
  check("monte carlo exposes no phantom fields (the old vacuous assertion)",
    !("medianFinalEquity" in mc1) && !("pProfitable" in mc1),
    "order-shuffling cannot report an expectancy probability — that is what v2 is for");
  check("monte carlo drawdown bounds are ordered", mc1.medianMaxDrawdownPct <= mc1.p95MaxDrawdownPct && mc1.p95MaxDrawdownPct <= mc1.worstMaxDrawdownPct,
        `median=${mc1.medianMaxDrawdownPct}% p95=${mc1.p95MaxDrawdownPct}% worst=${mc1.worstMaxDrawdownPct}%`);
  check("monte carlo spread is non-trivial on mixed outcomes", mc1.worstMaxDrawdownPct > mc1.medianMaxDrawdownPct,
        `${mc1.medianMaxDrawdownPct}% -> ${mc1.worstMaxDrawdownPct}%`);
  check("monte carlo finds a losing streak longer than observed", mc1.p95LongestLosingStreak >= mChop.losses > 0 || mc1.p95LongestLosingStreak > 0,
        `p95 streak=${mc1.p95LongestLosingStreak}`);
  check("monte carlo reports breach probability", typeof mc1.probabilityOfBreachingThreshold === "number", `${mc1.probabilityOfBreachingThreshold}%`);
  check("final equity is order-invariant (documented, not a metric)", mc1.finalEquity === Number((DEFAULTS.equity + rChop.trades.reduce((a,t)=>a+t.pnl,0)).toFixed(2)));
  check("monte carlo refuses on too few trades",
        monteCarlo({ trades: rUp.trades.slice(0, 3), initialEquity: 1000 }).runs === 0);

  // A losing strategy should show loss probability climbing
  const mcDown = monteCarlo({ trades: rDown.trades, initialEquity: DEFAULTS.equity, runs: 200 });
  check("a losing strategy ends below starting equity", mcDown.finalEquity < DEFAULTS.equity, `${mcDown.finalEquity}`);

  // ==================================================================
  // THE EQUAL-WEIGHT BOOK. Cross-checks, falsifiers, and the promise that a
  // single-symbol caller did not move.
  //
  // WHICH DIRECTION THE DEPENDENCY RUNS
  //
  //   robustness.mjs  ->  harness.mjs      (robustness.mjs:28 imports it)
  //   gate.mjs        ->  protocol.mjs     (and NOT harness.mjs)
  //   harness.mjs     ->  data.mjs, risk-engine.mjs      <- a LEAF
  //
  // harness.mjs is the bottom of the graph, so it may not statically import
  // either of the other two: importing robustness.mjs from here closes a cycle
  // (robustness.mjs imports harness.mjs), and there is a second, independent
  // blocker — robustness.mjs's `equalWeightPath` is module-private, so the
  // cross-check could not call it even without the cycle. Closing that gap is a
  // one-word change (`export`) in a file this change does not own.
  //
  // So this suite pins the model two ways that are available from the leaf:
  //
  //   1. against CLOSED FORM. Two fixtures whose every trade is the same size
  //      within a sleeve, so the shuffle cannot change the answer and the exact
  //      book drawdown is computable by hand. A test whose expected value is
  //      derived from the specification rather than from another copy of the
  //      implementation cannot drift with it.
  //   2. against gate.mjs's `equalWeightBook` — a genuinely separate
  //      implementation of the same model (index-aligned dense arrays with
  //      forward/back-fill, versus the event merge used here), reached by a
  //      DYNAMIC import so the shipped module graph is unchanged. This is the
  //      implementation that produces `evidence.agg.maxDrawdownPct`, so
  //      pinning to it is what puts the `P(dd breach)` criterion and the
  //      `max drawdown %` criterion on one provably shared basis.
  //
  // The 5x-geared model this replaced is falsified by fixture A below, and the
  // negative control proves the falsifier can tell the two models apart.

  // The pre-portfolio implementation, verbatim, as a bit-identity oracle. This
  // is not a second model to agree with — it is a copy of the OLD one, so
  // "single-symbol callers did not move" is a fact about the code and not a
  // claim about remembered numbers.
  const legacyMonteCarlo = ({ trades, initialEquity, runs = 1000, seed = 12345, ddThresholdPct = 20 }) => {
    if (trades.length < 5) return { runs: 0, note: "too few trades" };
    let s = seed >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const pnls = trades.map((t) => t.pnl);
    const finalEquity = initialEquity + pnls.reduce((a, b) => a + b, 0);
    const maxDds = [], streaks = [];
    let breached = 0;
    for (let r = 0; r < runs; r++) {
      const bag = pnls.slice();
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
      let eq = initialEquity, peak = initialEquity, dd = 0;
      let streak = 0, worstStreak = 0;
      for (const p of bag) {
        eq += p;
        if (eq > peak) peak = eq;
        if (peak > 0) dd = Math.max(dd, (peak - eq) / peak);
        streak = p <= 0 ? streak + 1 : 0;
        if (streak > worstStreak) worstStreak = streak;
      }
      maxDds.push(dd); streaks.push(worstStreak);
      if (dd * 100 >= ddThresholdPct) breached++;
    }
    const q = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; };
    return {
      runs, trades: trades.length, finalEquity: Number(finalEquity.toFixed(2)),
      medianMaxDrawdownPct: Number((q(maxDds, 0.5) * 100).toFixed(2)),
      p95MaxDrawdownPct: Number((q(maxDds, 0.95) * 100).toFixed(2)),
      worstMaxDrawdownPct: Number((Math.max(...maxDds) * 100).toFixed(2)),
      ddThresholdPct,
      probabilityOfBreachingThreshold: Number(((breached / runs) * 100).toFixed(2)),
      medianLongestLosingStreak: q(streaks, 0.5),
      p95LongestLosingStreak: q(streaks, 0.95),
      observedLongestLosingStreak: Math.max(...streaks),
    };
  };

  // A multi-symbol trade list. `time` is what the merge orders on, and it is
  // offset per symbol the way evidence.mjs offsets it, so the merge has to
  // interleave two real, interleaved windows rather than concatenate them.
  const mkSleeve = (symbol, pnls, t0) => pnls.map((p, i) => ({
    symbol, pnl: p, entryTime: t0 + i * 900, exitTime: t0 + (i + 1) * 900, time: t0 + (i + 1) * 900,
  }));
  const T0 = 1767225600;
  const uniform = { equity: 1000 };
  //   A: ten winners of +100, sleeve 1000 -> 2000, sleeve drawdown 0
  //   B: ten losers of -100, sleeve 1000 ->    0, sleeve drawdown 100%
  //   Book at step k: mean(1000+100(k+1), 1000-100(k+1)) = 1000, EXACTLY, in
  //   every ordering. Book drawdown 0, book return 0.
  const fxA = [...mkSleeve("AAA", Array(10).fill(100), T0), ...mkSleeve("BBB", Array(10).fill(-100), T0 + 4000000)];
  //   A: four winners of +50, sleeve 1000 -> 1200, then RUINED (shorter sleeve)
  //   B: ten losers of -100,  sleeve 1000 ->    0, sleeve drawdown 100%
  //   Book, on the longer sleeve's axis with A forward-filled from its own last:
  //     975 950 925 900 850 800 750 700 650 600
  //   Peak 1000 at the start, monotone down, so book drawdown 4000/1000 = 40%
  //   and book final 600. Unequal lengths, so this is what exercises the
  //   forward-fill, and a sleeve that stopped is never dropped: dropping A
  //   instead would delete its gains and report a much shallower book.
  const fxB = [...mkSleeve("AAA", Array(4).fill(50), T0), ...mkSleeve("BBB", Array(10).fill(-100), T0 + 4000000)];

  // --- 1. single-symbol callers are BIT-IDENTICAL to the old implementation
  {
    const shared = ["finalEquity", "medianMaxDrawdownPct", "p95MaxDrawdownPct", "worstMaxDrawdownPct",
      "ddThresholdPct", "probabilityOfBreachingThreshold", "medianLongestLosingStreak",
      "p95LongestLosingStreak", "observedLongestLosingStreak"];
    const sets = { rChop: rChop.trades, rUp: rUp.trades, rDown: rDown.trades };
    const diffs = [];
    for (const [name, ts] of Object.entries(sets)) {
      for (const [eq, runs, seed] of [[DEFAULTS.equity, 500, 12345], [DEFAULTS.equity, 200, 999], [2500, 300, 7]]) {
        const now = monteCarlo({ trades: ts, initialEquity: eq, runs, seed });
        const was = legacyMonteCarlo({ trades: ts, initialEquity: eq, runs, seed });
        for (const f of shared) if (now[f] !== was[f]) diffs.push(`${name}/${f}: ${was[f]} -> ${now[f]}`);
      }
    }
    check("single-symbol monteCarlo is BIT-IDENTICAL to the pre-portfolio implementation",
      diffs.length === 0,
      diffs.length ? diffs.slice(0, 4).join("; ") : `${Object.keys(sets).length} single-symbol sets x 3 configs x ${shared.length} fields`);
    check("a single-symbol caller is reported as a one-symbol book",
      monteCarlo({ trades: rChop.trades, initialEquity: DEFAULTS.equity, runs: 200 }).symbolCount === 1
      && monteCarlo({ trades: rChop.trades, initialEquity: DEFAULTS.equity, runs: 200 }).symbols[0] === "_single",
      "raw simulate() trades carry no symbol, so they form exactly one sleeve");
  }

  // --- 2. closed-form cross-check: fixture A
  {
    const mcA = monteCarlo({ trades: fxA, initialEquity: 1000, runs: 400, seed: 12345 });
    check("equal-weight book: offsetting sleeves give a FLAT book (fixture A, closed form)",
      mcA.medianMaxDrawdownPct === 0 && mcA.p95MaxDrawdownPct === 0 && mcA.worstMaxDrawdownPct === 0
      && mcA.finalEquity === 1000,
      `median/p95/worst dd ${mcA.medianMaxDrawdownPct}/${mcA.p95MaxDrawdownPct}/${mcA.worstMaxDrawdownPct}%, final ${mcA.finalEquity}`);
    check("equal-weight book: P(dd breach) is exactly 0 on fixture A",
      mcA.probabilityOfBreachingThreshold === 0, `${mcA.probabilityOfBreachingThreshold}%`);

    // NEGATIVE CONTROL. A 5x-geared replay of the same trades is a single
    // 1000-unit account taking 2583-style shocks from both symbols, so the
    // +100s and the -100s interleave and the path random-walks. It must NOT
    // reproduce the flat book, or the test above proves nothing.
    const gearedA = legacyMonteCarlo({ trades: fxA, initialEquity: 1000, runs: 400, seed: 12345 });
    check("negative control: the 5x-geared model FAILS fixture A (so the check above discriminates)",
      gearedA.medianMaxDrawdownPct > 0 && gearedA.probabilityOfBreachingThreshold > 0,
      `geared median dd ${gearedA.medianMaxDrawdownPct}%, P(breach) ${gearedA.probabilityOfBreachingThreshold}% vs book's 0%/0%`);
  }

  // --- 3. closed-form cross-check: fixture B, unequal sleeves, forward-fill
  {
    const mcB = monteCarlo({ trades: fxB, initialEquity: 1000, runs: 400, seed: 12345 });
    check("equal-weight book: a shorter sleeve is forward-filled, not dropped (fixture B, closed form)",
      mcB.medianMaxDrawdownPct === 40 && mcB.p95MaxDrawdownPct === 40 && mcB.worstMaxDrawdownPct === 40
      && mcB.finalEquity === 600,
      `dd ${mcB.medianMaxDrawdownPct}%, final ${mcB.finalEquity} (expected 40% and 600; book path 975..600)`);
    check("a book is never deeper than its worst sleeve (the theorem of the mean)",
      mcB.medianMaxDrawdownPct <= 100 && mcB.medianMaxDrawdownPct <= mcB.maxDrawdownPctComponentsMeanMedian,
      `book ${mcB.medianMaxDrawdownPct}% vs mean-of-components ${mcB.maxDrawdownPctComponentsMeanMedian}% vs worst sleeve 100%`);
  }

  // --- 4. the shuffle never migrates a trade between symbols
  {
    // Each sleeve's trades are all the same size, so a shuffle INSIDE a symbol
    // cannot change its own path — and the answer must therefore be identical
    // for every seed. A pooled shuffle would interleave the two symbols'
    // trades and the answer would move with the seed, which is exactly the bug.
    const seeds = [12345, 999, 7, 31337, 2].map((seed) =>
      monteCarlo({ trades: fxA, initialEquity: 1000, runs: 200, seed }));
    const moved = seeds.some((m) => m.medianMaxDrawdownPct !== seeds[0].medianMaxDrawdownPct
      || m.probabilityOfBreachingThreshold !== seeds[0].probabilityOfBreachingThreshold
      || m.p95LongestLosingStreak !== seeds[0].p95LongestLosingStreak);
    check("shuffling is per-symbol: a uniform-sleeve book is seed-invariant",
      !moved,
      `5 seeds -> median dd ${[...new Set(seeds.map((m) => m.medianMaxDrawdownPct))].join("/")}%, `
      + `P(breach) ${[...new Set(seeds.map((m) => m.probabilityOfBreachingThreshold))].join("/")}%`);
    const pooledSeeds = [12345, 999, 7, 31337].map((seed) =>
      legacyMonteCarlo({ trades: fxA, initialEquity: 1000, runs: 200, seed }));
    // The MEDIAN happens to be a coarse lattice value on a 20-step walk and can
    // coincide across seeds, so the control reads the tail, which cannot.
    check("negative control: the geared model IS seed-variant on the same trades",
      new Set(pooledSeeds.map((m) => `${m.p95MaxDrawdownPct}/${m.worstMaxDrawdownPct}`)).size > 1,
      `geared p95/worst dd across 4 seeds: ${pooledSeeds.map((m) => `${m.p95MaxDrawdownPct}/${m.worstMaxDrawdownPct}`).join(", ")}`);
  }

  // --- 5. the return is the MEAN of the per-symbol returns, never the product
  {
    const fxC = [
      ...mkSleeve("AAA", Array(6).fill(100), T0),
      ...mkSleeve("BBB", Array(6).fill(-50), T0 + 4000000),
      ...mkSleeve("CCC", Array(6).fill(25), T0 + 8000000),
    ];
    const mcC = monteCarlo({ trades: fxC, initialEquity: 1000, runs: 100, seed: 5 });
    const per = [100, -50, 25].map((p) => (6 * p) / 1000);
    const mean = per.reduce((a, b) => a + b, 0) / per.length;
    const product = per.reduce((a, b) => a * (1 + b), 1) - 1;
    check("portfolio return is the MEAN of the N per-symbol returns (additive, never compounded)",
      Math.abs((mcC.finalEquity / 1000 - 1) - mean) < 1e-9 && Math.abs(product - mean) > 1e-6,
      `book ${((mcC.finalEquity / 1000 - 1) * 100).toFixed(2)}% = mean ${(mean * 100).toFixed(2)}%; `
      + `the 3x-geared product would say ${(product * 100).toFixed(2)}%`);
  }

  // --- 6. cross-check against gate.mjs's own equal-weight implementation
  //
  // Same trades, two implementations, no shared code: gate.mjs averages
  // index-aligned dense arrays with its own forward/back-fill; the code above
  // merges per-sleeve event streams onto a step axis. DYNAMIC import, so the
  // shipped module graph is untouched — harness.mjs stays a leaf and nothing
  // in production code gains a dependency it does not need.
  {
    const { equalWeightBook, pathStats, equalWeightPath } = await import("./gate.mjs");
    // Rebuild the fixtures the way evidence.mjs does: one equity series per
    // symbol, `null`/absent past the end of the shorter sleeve.
    const rowsA = [...mkSleeve("AAA", Array(10).fill(100), T0), ...mkSleeve("BBB", Array(10).fill(-100), T0 + 4000000)];
    const rowsB = [...mkSleeve("AAA", Array(4).fill(50), T0), ...mkSleeve("BBB", Array(10).fill(-100), T0 + 4000000)];
    const eqSeries = (rows) => rows.map((_, i) => 1000 + rows.slice(0, i + 1).reduce((a, x) => a + x.pnl, 0));
    const alignedB = [eqSeries(rowsB.filter((t) => t.symbol === "AAA")), eqSeries(rowsB.filter((t) => t.symbol === "BBB"))];
    const bookFromGate = equalWeightBook(alignedB, { base: 1000 });
    const mcB2 = monteCarlo({ trades: fxB, initialEquity: 1000, runs: 400, seed: 12345 });
    check("harness.monteCarlo's book drawdown EQUALS gate.equalWeightBook's on the same trades",
      Math.abs(bookFromGate.maxDrawdownPct - mcB2.medianMaxDrawdownPct) < 0.005
      && Math.abs(bookFromGate.totalReturnPct - (mcB2.finalEquity / 1000 - 1) * 100) < 0.005,
      `gate ${bookFromGate.maxDrawdownPct}% / ret ${bookFromGate.totalReturnPct}%  vs  `
      + `harness ${mcB2.medianMaxDrawdownPct}% / ret ${((mcB2.finalEquity / 1000 - 1) * 100).toFixed(2)}%`);
    const bookA = equalWeightBook([eqSeries(rowsA.filter((t) => t.symbol === "AAA")), eqSeries(rowsA.filter((t) => t.symbol === "BBB"))], { base: 1000 });
    check("the two implementations also agree on the FLAT book of fixture A",
      monteCarlo({ trades: fxA, initialEquity: 1000, runs: 100, seed: 1 }).medianMaxDrawdownPct === bookA.maxDrawdownPct,
      `both report a ${bookA.maxDrawdownPct}% drawdown on offsetting sleeves`);
    const denseB = pathStats(equalWeightPath(alignedB), 1000);
    check("harness's forward-fill matches gate's forward-fill on a truncated sleeve",
      Math.abs(denseB.maxDrawdownPct - 40) < 0.005 && denseB.base === 1000,
      `gate's own dense-array fill of the same 4-vs-10 sleeve pair lands on ${denseB.maxDrawdownPct}% over ${equalWeightPath(alignedB).length} points`);
  }

  // Walk-forward
  const wf = walkForward({ bars: up, signal: alwaysLong, folds: 3 });
  check("walk-forward produces folds", wf.folds === 3, `${wf.folds}`);

  // --- REGRESSION: a silent out-of-sample fold must not be a free pass
  //
  // `consistency` used to divide by `traded.length`, so a fold the strategy
  // could not trade in was removed from the sample instead of failing it. A
  // signal long for the first three folds and silent for the fourth reported
  // consistency 100 on 3/4 folds and cleared the v1 `walk-forward consistency %`
  // criterion (MIN_WF = 50) with a perfect mark. `robustness.mjs` already pins
  // the same invariant for the v2 anchored implementation; this is the v1 copy,
  // and gate.mjs reads THIS one.
  {
    // v1 fold geometry: usable = bars.slice(warmup), size = floor(usable/folds),
    // fold f tests usable[f*size, (f+1)*size).
    const nB = 4000, wu = 100, nf = 4;
    const big = mk(nB, 0.3);
    const size = Math.floor((nB - wu) / nf);
    const lastFold = big[wu + (nf - 1) * size].time;
    const diesInLastFold = ({ bar }) => (bar.time < lastFold ? { side: "buy" } : null);
    const dead = walkForward({ bars: big, signal: diesInLastFold, folds: nf, warmup: wu });
    const silent = dead.foldsSilent ?? dead.folds - dead.foldsWithTrades;

    check("the one-dead-fold case really is one dead fold",
      silent === 1 && dead.foldsWithTrades === nf - 1,
      `folds ${dead.folds}, traded ${dead.foldsWithTrades}, silent ${silent}`);
    check("the consistency denominator is EVERY fold, not the folds that fired",
      dead.consistencyDenominator === nf && dead.foldsProfitable === nf - 1 && dead.consistency < 100,
      `${dead.foldsProfitable}/${dead.consistencyDenominator} = ${dead.consistency}%`);
    check("a silent fold is REPORTED, not silently absorbed into the denominator",
      silent === 1 && dead.foldCoveragePct === 75,
      `foldsSilent ${dead.foldsSilent}, foldCoveragePct ${dead.foldCoveragePct}%`);
    check("the run says out loud that silent folds count as failures",
      /counted as failures/.test(dead.consistencyNote || ""), dead.consistencyNote);

    // The control: nothing about a strategy that trades throughout may move.
    const live = walkForward({ bars: big, signal: alwaysLong, folds: nf, warmup: wu });
    check("a strategy that trades in every fold is unchanged: 100% on every field",
      live.consistency === 100 && live.foldsSilent === 0 && live.foldCoveragePct === 100
      && live.consistencyDenominator === nf && live.foldsWithTrades === nf,
      `consistency ${live.consistency}%, silent ${live.foldsSilent}, coverage ${live.foldCoveragePct}%`);

    // Silent in EVERY fold. This used to return `null` and the CLI verdict
    // printer treats a null as "no verdict" (`wf.consistency == null || ...`),
    // so a strategy that never traded out of sample read as neither pass nor
    // fail. It is now 0, which is what the complete-sample return is.
    const neverTrades = walkForward({ bars: big, signal: () => null, folds: nf, warmup: wu });
    check("a strategy that never trades out of sample is 0%, not a null",
      neverTrades.consistency === 0 && neverTrades.foldsSilent === nf
      && (neverTrades.consistency ?? 0) < 50,
      `consistency ${neverTrades.consistency}, silent ${neverTrades.foldsSilent}/${neverTrades.folds} `
      + `-> v1 bar >= 50 FAILS`);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
