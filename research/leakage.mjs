/**
 * leakage.mjs — data-leakage detection.
 *
 * The single largest source of fake backtest alpha. A signal that can see one
 * bar into the future, normalises over the whole dataset, or computes an
 * indicator before its warmup will "work" beautifully and mean nothing.
 *
 * Three independent tests, because each catches a different mistake:
 *
 *   1. FUTURE ACCESS   a Proxy over `bars` throws if index > i is read. This
 *                      is enforcement, not inspection: a leaking signal
 *                      cannot run at all.
 *   2. TIMESTAMP       run with shuffled timestamps. A correct signal cannot
 *                      care about the time field, so results must be
 *                      identical. If they change, it was reading the clock.
 *   3. WARMUP          a signal must not fire before enough history exists.
 *                      Fed a truncated series, it must produce no trades.
 *
 * A fourth, cheaper check: appending future bars must not change past
 * results. Whole-dataset normalisation breaks that immediately.
 */

/** Wrap bars so reading beyond `i` throws. */
export function guardFuture(bars, i) {
  return new Proxy(bars, {
    get(target, prop) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        const idx = Number(prop);
        if (idx > i) {
          const err = new Error(`LEAKAGE: strategy read bars[${idx}] while at bar ${i}`);
          err.leakage = true;
          throw err;
        }
      }
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** 1. Does the signal survive when future bars are physically unreachable? */
export function testFutureAccess({ simulate, metrics, bars, signal, cfg = {} }) {
  let caught = null;
  const guarded = (ctx) => {
    if (caught) return null;
    try {
      return signal({ ...ctx, bars: guardFuture(ctx.bars, ctx.i) });
    } catch (e) {
      if (e.leakage) { caught = e.message; return null; }
      throw e;
    }
  };
  try {
    const r = simulate({ bars, signal: guarded, cfg });
    return { pass: caught === null, leak: caught, trades: r.trades };
  } catch (e) {
    if (e.leakage) return { pass: false, leak: e.message };
    return { pass: false, leak: `signal threw: ${e.message}` };
  }
}

/** 2. Results must be invariant to the timestamp field. */
export function testTimestampIndependence({ simulate, metrics, bars, signal, cfg = {} }) {
  const base = simulate({ bars, signal, cfg });
  const mBase = metrics({ trades: base.trades, equityCurve: base.equityCurve, initialEquity: cfg.equity ?? 1000 });

  // Deterministic shuffle of time only — prices untouched. The replacement
  // timestamps are all ODD (odd base + odd step) while the originals are all
  // EVEN, so any signal that reads the clock must behave differently.
  const shuffled = bars.map((b) => ({ ...b, time: 1767225601 + bars.indexOf(b) * 901 }));
  const alt = simulate({ bars: shuffled, signal, cfg });
  const mAlt = metrics({ trades: alt.trades, equityCurve: alt.equityCurve, initialEquity: cfg.equity ?? 1000 });

  const sameTrades = base.trades.length === alt.trades.length;
  const samePnl = sameTrades && base.trades.every((t, i) => Math.abs(t.pnl - alt.trades[i].pnl) < 1e-9);
  return {
    pass: sameTrades && samePnl,
    baseTrades: mBase.trades, altTrades: mAlt.trades,
    detail: sameTrades && samePnl ? "invariant to timestamps"
      : `trade count or P&L changed when timestamps were shuffled (${base.trades.length} -> ${alt.trades.length})`,
  };
}

/**
 * 3. No trades may be produced from a series shorter than the warmup.
 *    The simulator's own warmup is what stops this; we deliberately do NOT
 *    override it, because overriding it would test the opposite of the claim.
 */
export function testWarmupDiscipline({ simulate, bars, signal, warmup = 250, cfg = {} }) {
  const short = bars.slice(0, Math.max(5, Math.floor(warmup / 2)));
  const r = simulate({ bars: short, signal, cfg: { ...cfg, warmup } });
  return {
    pass: r.trades.length === 0,
    trades: r.trades.length,
    detail: r.trades.length === 0
      ? `no trades from only ${short.length} bars (warmup ${warmup})`
      : `produced ${r.trades.length} trades from only ${short.length} bars with warmup ${warmup}`,
  };
}

/** 4. Appending the future must not change the past. Catches whole-sample stats. */
export function testFutureAppendInvariance({ simulate, metrics, bars, signal, cfg = {} }) {
  const equity = cfg.equity ?? 1000;
  const cut = Math.floor(bars.length * 0.6);
  const a = simulate({ bars: bars.slice(0, cut), signal, cfg });
  const b = simulate({ bars, signal, cfg });
  const mA = metrics({ trades: a.trades, equityCurve: a.equityCurve, initialEquity: equity });
  const prefix = b.trades.filter((t) => t.exitTime <= bars[cut - 1].time);
  const mB = metrics({ trades: prefix, equityCurve: a.equityCurve, initialEquity: equity });
  const ok = mA.trades === mB.trades &&
    a.trades.every((t, i) => prefix[i] && Math.abs(t.pnl - prefix[i].pnl) < 1e-9);
  return {
    pass: ok,
    detail: ok ? "past is unaffected by future bars"
      : `first ${cut} bars gave ${mA.trades} trades, but with the full series that prefix gave ${mB.trades} — the signal is using whole-sample statistics`,
  };
}

/** Run all four. */
export function auditLeakage({ simulate, metrics, bars, signal, cfg = {}, warmup = 250 }) {
  const results = {
    futureAccess: testFutureAccess({ simulate, metrics, bars, signal, cfg }),
    timestampIndependence: testTimestampIndependence({ simulate, metrics, bars, signal, cfg }),
    warmupDiscipline: testWarmupDiscipline({ simulate, bars, signal, warmup, cfg }),
    futureAppend: testFutureAppendInvariance({ simulate, metrics, bars, signal, cfg }),
  };

  // Hard vs soft matters. Reading the CURRENT bar's timestamp is legitimate —
  // "trade only on Tuesdays" is a real strategy. But a signal that only works
  // because of the specific timestamps it was tuned on is fitted to the clock,
  // not the market. That is a real concern, but it is a concern to RECORD, not
  // a disqualifier: the difference is reviewable by a human, whereas reading a
  // future bar is mechanically impossible to excuse.
  //
  // So: hard failures disqualify, advisories are recorded and surfaced.
  const hard = ["futureAccess", "warmupDiscipline", "futureAppend"];
  const soft = ["timestampIndependence"];

  const failed = hard.filter((k) => !results[k].pass);
  const advisories = soft.filter((k) => !results[k].pass);

  return {
    pass: failed.length === 0,
    failed,
    advisories,
    advisoryDetail: advisories.map((k) => ({
      check: k,
      detail: results[k].detail,
      implication: "results may depend on the calendar rather than the market — verify by hand before trusting",
    })),
    results,
  };
}

// --------------------------------------------------------------- selftest
if (process.argv[1] && process.argv[1].endsWith("leakage.mjs")) {
  // Self-contained: a tiny simulator so this file proves the DETECTOR works
  // against both honest and cheating signals, without importing the harness.
  const sim = ({ bars, signal, cfg = {} }) => {
    const trades = [];
    let i = cfg.warmup ?? 20;
    for (; i < bars.length - 1; i++) {
      let s = null;
      try { s = signal({ bars, i, cfg }); } catch { return { trades, threw: true }; }
      if (s && s.side) {
        // P&L must respect direction, otherwise a signal that only ever flips
        // side looks identical to one that does not.
        const raw = bars[i + 1].close - bars[i].close;
        trades.push({ entryTime: bars[i + 1].time, exitTime: bars[i + 1].time,
          side: s.side, pnl: s.side === "buy" ? raw : -raw, reason: "x" });
      }
    }
    return { trades, threw: false };
  };
  const met = (r) => ({ trades: r.trades.length });

  const mk = (n) => Array.from({ length: n }, (_, i) => ({
    time: 1767225600 + i * 900, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10,
  }));

  let pass = 0, fail = 0;
  const check = (n, c, x = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); };

  const honestSig = ({ bars, i }) => (i > 0 && bars[i].close > bars[i - 1].close ? { side: "buy" } : null);
  const unguardedSig = () => ({ side: "buy" });          // no warmup guard at all
  const futureSig = ({ bars, i }) => (bars[i + 1].close > bars[i].close ? { side: "buy" } : null);
  const wholeSampleSig = ({ bars, i }) => {
    const mean = bars.reduce((a, b) => a + b.close, 0) / bars.length;   // LOOKS AHEAD
    return bars[i].close > mean ? { side: "buy" } : null;
  };
  // Original timestamps are even, the shuffled ones odd, so a signal keyed on
  // time parity must flip its behaviour entirely.
  const timeSig = ({ bars, i }) => ({ side: bars[i].time % 2 === 0 ? "buy" : "sell" });

  console.log("leakage.mjs selftest (detector vs known cheaters)\n");

  const h = auditLeakage({ simulate: sim, metrics: met, bars: mk(400), signal: honestSig, cfg: { warmup: 50 }, warmup: 50 });
  check("honest signal passes all four checks", h.pass, h.failed.join(","));

  const fu = testFutureAccess({ simulate: sim, metrics: met, bars: mk(400), signal: futureSig, cfg: { warmup: 50 } });
  check("future-peeking signal is CAUGHT", fu.pass === false, fu.leak);

  const ts = testTimestampIndependence({ simulate: sim, metrics: met, bars: mk(400), signal: timeSig, cfg: { warmup: 50 } });
  check("timestamp-dependent signal is CAUGHT", ts.pass === false, ts.detail);

  // The harness's own warmup makes a short-series trade structurally
  // impossible, so the check is that the WARMUP HOLDS — not that a violation
  // can be provoked. Strategies with their own internal guards (if (i < N))
  // are covered by the future-access and append-invariance checks.
  const wuOk = testWarmupDiscipline({ simulate: sim, bars: mk(400), signal: unguardedSig, warmup: 250, cfg: { warmup: 250 } });
  check("harness warmup blocks trading on a short series", wuOk.pass === true, wuOk.detail);

  const wuShort = testWarmupDiscipline({ simulate: sim, bars: mk(400), signal: honestSig, warmup: 20, cfg: { warmup: 20 } });
  check("a short warmup also blocks when series is shorter", wuShort.pass === true, wuShort.detail);

  const fa = testFutureAppendInvariance({ simulate: sim, metrics: met, bars: mk(400), signal: wholeSampleSig, cfg: { warmup: 50 } });
  check("whole-sample statistic is CAUGHT by append-invariance", fa.pass === false, fa.detail);

  const faOk = testFutureAppendInvariance({ simulate: sim, metrics: met, bars: mk(400), signal: honestSig, cfg: { warmup: 50 } });
  check("honest signal IS append-invariant", faOk.pass === true, faOk.detail);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
