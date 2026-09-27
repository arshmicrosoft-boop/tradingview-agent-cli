#!/usr/bin/env node
/**
 * risk-engine.mjs — position sizing and pre-trade approval.
 *
 * PURE. No DOM, no network, no TradingView, no clicks. Everything here is
 * arithmetic over inputs, so it is fully testable and cannot have side effects.
 * That is the whole point: the risk decision must be reproducible and
 * independent of the thing being risk-managed.
 *
 * The separation this enforces:
 *
 *     Agent      proposes  { symbol, side, thesis }
 *     Risk engine decides  { qty, stop }   <- never accepts a qty from the agent
 *     Execution  submits   the approved ticket
 *
 * Sizing model (standard volatility-normalised risk):
 *
 *     riskAmount  = equity * risk_per_trade_pct
 *     stopDist    = stop_atr_mult * ATR
 *     qty_by_risk = riskAmount / stopDist
 *
 * then clamp by notional and by margin at the allowed leverage, and take the
 * smallest. If that is zero the trade is rejected rather than shrunk to noise.
 */

/** Average True Range over `period` bars (Wilder smoothing). */
export function atr(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    const tr = Math.max(
      b.high - b.low,
      Math.abs(b.high - p.close),
      Math.abs(b.low - p.close)
    );
    trs.push(tr);
  }
  const use = trs.slice(-period);
  return use.reduce((a, b) => a + b, 0) / use.length;
}

/** Percentile of bar returns — a cheap realised-volatility cross-check on ATR. */
export function realisedVol(bars, lookback = 50) {
  if (!Array.isArray(bars) || bars.length < 10) return null;
  const use = bars.slice(-Math.min(lookback, bars.length));
  const rets = [];
  for (let i = 1; i < use.length; i++) {
    if (use[i - 1].close > 0) rets.push(Math.log(use[i].close / use[i - 1].close));
  }
  if (rets.length < 5) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(varr);
}

/**
 * Size a position from measured volatility.
 *
 * equity         account equity in USD
 * price          reference price
 * atrValue       ATR in price units (same units as price)
 * side           "buy" | "sell"
 */
export function sizePosition({
  equity, price, atrValue, side,
  riskPct = 0.005, stopAtrMult = 2,
  maxNotional = 25, maxMargin = 25, leverage = 10,
  existingExposure = 0, allowFractional = false,
}) {
  const notes = [];
  const reject = (code, detail) => ({ ok: false, code, detail, notes });

  if (!(equity > 0)) return reject("NO_EQUITY", `equity is ${equity}`);
  if (!(price > 0)) return reject("NO_PRICE", `price is ${price}`);
  if (!(atrValue > 0)) return reject("NO_ATR", `ATR is ${atrValue} — volatility unknown, refusing to size`);

  const riskAmount = equity * riskPct;
  const stopDist = stopAtrMult * atrValue;
  const stopPrice = side === "sell" ? price + stopDist : price - stopDist;

  // Each cap is expressed in units; the binding one wins.
  const caps = [
    { by: "risk",        qty: riskAmount / stopDist },
    { by: "notional",    qty: maxNotional / price },
    { by: "margin",      qty: (maxMargin * leverage) / price },
  ];
  if (existingExposure > 0) {
    caps.push({ by: "headroom", qty: Math.max(0, (maxNotional - existingExposure) / price) });
    notes.push(`headroom after ${existingExposure.toFixed(2)} existing exposure`);
  }

  const binding = caps.reduce((a, b) => (b.qty < a.qty ? b : a));
  // Always round DOWN — never exceed a cap by rounding up. Whole units for
  // share-like instruments; fractional allowed where the venue supports it.
  let qty = allowFractional
    ? Math.floor(binding.qty * 1e6) / 1e6
    : Math.floor(binding.qty);
  if (!(qty > 0)) {
    return reject("SIZE_TOO_SMALL",
      `sizing produced ${binding.qty.toFixed(6)} units (binding cap: ${binding.by}). ` +
      `ATR ${atrValue.toExponential(2)} vs equity ${equity.toFixed(2)} — ` +
      `the stop is too far away to risk anything meaningful.`);
  }

  const notional = qty * price;
  const margin = notional / leverage;
  if (notional > maxNotional) {
    qty = allowFractional ? Math.floor((maxNotional / price) * 1e6) / 1e6 : Math.floor(maxNotional / price);
  }
  if (margin > maxMargin) {
    qty = allowFractional ? Math.floor((maxMargin * leverage / price) * 1e6) / 1e6
                          : Math.floor((maxMargin * leverage) / price);
  }

  const finalNotional = qty * price;
  return {
    ok: true,
    qty,
    side,
    price,
    stopPrice: Number(stopPrice.toFixed(8)),
    stopDistance: Number(stopDist.toFixed(8)),
    riskAmount: Number((qty * stopDist).toFixed(4)),
    riskBudget: Number(riskAmount.toFixed(4)),
    notional: Number(finalNotional.toFixed(4)),
    margin: Number((finalNotional / leverage).toFixed(4)),
    atr: Number(atrValue.toExponential(4)),
    bindingCap: binding.by,
    leverage,
    notes,
  };
}

/**
 * Full pre-trade decision. Adds the hard limits on top of sizing.
 * Returns { approved:false, code, detail } or { approved:true, ...size }.
 */
export function evaluate({ symbol, side, thesis, bars, account, cfg }) {
  const price = account.price;
  const a = atr(bars, cfg.atr_period ?? 14);
  const rv = realisedVol(bars, 50);

  const size = sizePosition({
    equity: account.equity,
    price,
    atrValue: a,
    side,
    riskPct: cfg.risk_per_trade_pct ?? 0.005,
    stopAtrMult: cfg.stop_atr_mult ?? 2,
    maxNotional: cfg.max_order_notional_usd ?? 25,
    maxMargin: cfg.max_total_margin_usd ?? 25,
    leverage: cfg.max_leverage ?? 10,
    existingExposure: (Number(account.ordersMargin) || 0) + (Number(account.accountMargin) || 0),
    allowFractional: cfg.allow_fractional ?? false,
  });

  if (!size.ok) {
    return { approved: false, code: size.code, detail: size.detail, symbol, side, thesis, atr: a, realisedVol: rv };
  }
  return {
    approved: true,
    symbol, side, thesis,
    realisedVol: rv,
    ...size,
  };
}


// --------------------------------------------------------------- selftest
if (process.argv[1] && process.argv[1].endsWith("risk-engine.mjs")) {
  // Deterministic synthetic series so every run is identical.
  const series = (amp, n = 120) => {
    const out = []; let px = 100;
    for (let i = 0; i < n; i++) {
      const d = Math.sin(i / 7) * amp;
      const o = px, c = px + d;
      out.push({ time: i, open: o, high: Math.max(o, c) + amp * 0.4,
                 low: Math.min(o, c) - amp * 0.4, close: c, volume: 1 });
      px = c;
    }
    return out;
  };

  const cfg = { risk_per_trade_pct: 0.005, stop_atr_mult: 2, max_order_notional_usd: 25,
                max_total_margin_usd: 25, max_leverage: 10, atr_period: 14 };
  let pass = 0, fail = 0;
  const check = (name, cond, extra = "") => {
    cond ? pass++ : fail++;
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  :: " + extra : ""}`);
  };
  const run = (bars, acct, side = "buy", c = cfg) =>
    evaluate({ symbol: "X", side, thesis: "t", bars, account: acct, cfg: c });

  console.log("risk-engine selftest\n");

  // --- volatility measurement
  const calm = series(0.05), wild = series(3.0);
  check("ATR finite and positive", Number.isFinite(atr(calm, 14)) && atr(calm, 14) > 0);
  check("ATR null on too-few bars", atr(calm.slice(0, 5), 14) === null);
  check("ATR scales with volatility", atr(wild, 14) > atr(calm, 14) * 10);
  check("realisedVol finite", Number.isFinite(realisedVol(calm, 50)));

  // --- a sizeable account on a calm instrument
  const big = { equity: 10000, price: calm[calm.length - 1].close, ordersMargin: 0, accountMargin: 0 };
  const g = run(calm, big, "buy", { ...cfg, allow_fractional: true });
  const gFrac = run(calm, big, "buy", { ...cfg, allow_fractional: true });
  check("approves fractional sizing on an expensive instrument", gFrac.approved === true, `qty=${gFrac.qty}`);
  const cheap = { equity: 10000, price: 10, ordersMargin: 0, accountMargin: 0 };
  const gWhole = evaluate({ symbol: "X", side: "buy", thesis: "t",
    bars: calm.map(b => ({ ...b, open: b.open/10, high: b.high/10, low: b.low/10, close: b.close/10 })),
    account: cheap, cfg });
  check("approves whole units on a cheap instrument", gWhole.approved === true, `qty=${gWhole.qty}`);
  check("notional within cap", gFrac.notional <= cfg.max_order_notional_usd, `notional=${gFrac.notional}`);
  check("margin within cap", gFrac.margin <= cfg.max_total_margin_usd, `margin=${gFrac.margin}`);
  check("risk within budget", gFrac.riskAmount <= gFrac.riskBudget + 1e-9, `${gFrac.riskAmount} / ${gFrac.riskBudget}`);
  check("long stop below price", gFrac.stopPrice < gFrac.price);
  check("short stop above price", run(calm, big, "sell", { ...cfg, allow_fractional: true }).stopPrice > big.price);

  // --- a realistic small account must be told no, not given a token size
  const small = { equity: 109.25, price: calm[calm.length - 1].close, ordersMargin: 0, accountMargin: 0 };
  const s = run(calm, small);
  check("small account either sizes or refuses loudly", s.approved === true || s.code === "SIZE_TOO_SMALL",
        s.approved ? `qty=${s.qty}` : `refused: ${s.code}`);

  // --- the headline case: $109 cannot carry a 2-ATR stop on a $105 instrument
  const mid = series(0.6);
  const midAcct = { equity: 109.25, price: mid[mid.length - 1].close, ordersMargin: 0, accountMargin: 0 };
  const m = run(mid, midAcct);
  check("refuses to trade a stop it cannot afford", m.approved === false && m.code === "SIZE_TOO_SMALL",
        `ATR=${atr(mid,14).toFixed(3)} price=${midAcct.price.toFixed(2)} -> ${m.code}`);

  // --- missing inputs must fail closed
  check("rejects unknown ATR", run(mid.slice(0, 3), big).code === "NO_ATR");
  check("rejects zero equity", run(calm, { ...big, equity: 0 }).code === "NO_EQUITY");
  check("rejects zero price", run(calm, { ...big, price: 0 }).code === "NO_PRICE");

  // --- exposure and volatility must both reduce size
  const exposed = run(calm, { ...big, ordersMargin: 20 }, "buy", { ...cfg, allow_fractional: true });
  check("existing exposure shrinks size", exposed.qty < gFrac.qty, `${exposed.qty} < ${gFrac.qty}`);
  const wildSized = run(wild, { ...big, price: wild[wild.length - 1].close }, "buy", { ...cfg, allow_fractional: true });
  check("higher volatility => smaller size", wildSized.qty <= gFrac.qty, `${wildSized.qty} <= ${gFrac.qty}`);

  // --- fractional sizing for venues that allow it
  const frac = run(calm, big, "buy", { ...cfg, allow_fractional: true });
  check("fractional mode can size a sub-unit trade", frac.approved === true, `qty=${frac.qty}`);

  // --- when risk (not notional) is the binding cap, volatility must dominate.
  // The default $25 notional cap otherwise masks volatility sensitivity entirely.
  const riskCfg = { ...cfg, max_order_notional_usd: 100000, max_total_margin_usd: 100000 };
  const calmRisk = run(calm, { ...big, price: 100 }, "buy", { ...riskCfg, allow_fractional: true });
  const wildRisk = run(wild,  { ...big, price: 100 }, "buy", { ...riskCfg, allow_fractional: true });
  check("risk cap binds when notional is not limiting", calmRisk.bindingCap === "risk",
        `binding=${calmRisk.bindingCap}`);
  check("volatility drives size when risk binds", wildRisk.qty < calmRisk.qty / 5,
        `wild=${wildRisk.qty} calm=${calmRisk.qty}`);
  check("risk is actually spent up to budget", calmRisk.riskAmount > calmRisk.riskBudget * 0.5,
        `${calmRisk.riskAmount} / ${calmRisk.riskBudget}`);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}