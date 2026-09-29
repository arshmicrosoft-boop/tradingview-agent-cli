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
 * Parse a monetary amount that may arrive as a formatted string.
 *
 * `Number("1,234.56")` is NaN, and the idiom `Number(x) || 0` turned that NaN
 * into a clean zero. On the live order path that meant an account holding
 * $1,234.56 of margin was treated as holding none, so the cumulative-exposure
 * cap was never even constructed. paper-trade.mjs captures the ticket's raw
 * text with a regex that permits thousands separators, so the fail-open fired
 * on any exposure >= $1,000.
 *
 * Throws on anything that is not a finite number. Callers on the order path
 * catch and REJECT; they must never fall back to a default.
 */
export function parseAmount(value, label = "amount") {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} is not finite: ${value}`);
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    // Number("") is 0 and Number(" ") is 0 — an empty margin field must be a
    // rejection, not a clean zero, or the exposure cap is skipped again.
    if (trimmed === "") throw new Error(`${label} is an empty string, not an amount`);
    const n = Number(trimmed.replace(/[,\s]/g, ""));
    if (!Number.isFinite(n)) throw new Error(`${label} is not a parseable number: ${JSON.stringify(value)}`);
    return n;
  }
  throw new Error(`${label} has non-numeric type ${typeof value}`);
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

  // Fail closed on a non-finite cap. `caps.reduce((a, b) => b.qty < a.qty ? b : a)`
  // never selects a NaN cap (NaN < x is always false) AND the post-hoc
  // `notional > maxNotional` clamp is `250 > NaN`, also false — so a single
  // typo in config/risk.json silently disabled the cap and the order reported
  // the cap as honoured. loadRiskConfig copies raw JSON with no validation.
  for (const [name, v] of Object.entries({
    maxNotional, maxMargin, leverage, riskPct, stopAtrMult, existingExposure,
  })) {
    if (!Number.isFinite(v)) {
      return reject("INVALID_RISK_CONFIG", `${name} is not a finite number (${v}) — refusing to size`);
    }
  }
  if (!(equity > 0)) return reject("NO_EQUITY", `equity is ${equity}`);
  if (!(price > 0)) return reject("NO_PRICE", `price is ${price}`);
  if (!(atrValue > 0)) return reject("NO_ATR", `ATR is ${atrValue} — volatility unknown, refusing to size`);

  const riskAmount = equity * riskPct;
  const stopDist = stopAtrMult * atrValue;
  const stopPrice = side === "sell" ? price + stopDist : price - stopDist;
  // NOTE: the stop-reachability / stop-side checks live in `evaluate`, NOT here.
  // `sizePosition` is a pure sizing function and is called by the backtest
  // harness; enforcing "stop must be > 0" here would refuse to open a position
  // during a crash, silently changing historical backtest results. The live
  // order path validates the stop in `evaluate` before sizing is trusted.

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

  // Cumulative exposure must be parsed, not coerced. The previous
  // `(Number(x) || 0) + (Number(y) || 0)` mapped a formatted string like
  // "1,234.56" to 0, so the headroom cap was skipped entirely and an account
  // with real margin was approved for a full order. Fail closed: an
  // unparseable margin rejects the order; it never becomes zero.
  let existingExposure;
  try {
    existingExposure = parseAmount(account.ordersMargin ?? 0, "ordersMargin")
                     + parseAmount(account.accountMargin ?? 0, "accountMargin");
  } catch (e) {
    return { approved: false, code: "INVALID_ACCOUNT_MARGIN", detail: e.message, symbol, side, thesis, atr: a, realisedVol: rv };
  }

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
    existingExposure,
    allowFractional: cfg.allow_fractional ?? false,
  });

  if (!size.ok) {
    return { approved: false, code: size.code, detail: size.detail, symbol, side, thesis, atr: a, realisedVol: rv };
  }

  // Stop reachability and side — a LIVE-ORDER concern, enforced here rather
  // than in sizePosition (which the backtest also calls). A long whose ATR stop
  // sits at or below zero has a stop the market can never reach, yet the order
  // would still report "risk within budget" because riskAmount looked fine.
  if (!(size.stopPrice > 0)) {
    return { approved: false, code: "STOP_UNREACHABLE", symbol, side, thesis, atr: a, realisedVol: rv,
      detail: `stop ${size.stopPrice} is at or below zero for a ${side} at ${price} ` +
              `(ATR ${a?.toExponential?.(2)}). A stop the market cannot reach is not a stop.` };
  }
  const stopOnCorrectSide = side === "sell" ? size.stopPrice > price : size.stopPrice < price;
  if (!stopOnCorrectSide) {
    return { approved: false, code: "STOP_WRONG_SIDE", symbol, side, thesis, atr: a, realisedVol: rv,
      detail: `stop ${size.stopPrice} is not on the correct side of entry ${price} for a ${side}` };
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

  // --- fail-closed: the three ways a formatted input could delete a cap -------
  // Each of these previously produced an APPROVED order that ignored a limit
  // which was in force. They are pinned here so the fail-open cannot return.
  const ohlc = series(0.8);
  const acct = (o = {}) => ({ equity: 10000, price: 20, ordersMargin: 0, accountMargin: 0, ...o });

  // C1: a comma-formatted margin became 0, so the exposure cap was never built.
  const commaMargin = run(ohlc, acct({ ordersMargin: "1,234.56", accountMargin: "0.00" }));
  check("a comma-formatted margin does not vanish into zero", commaMargin.approved === false,
        commaMargin.approved ? `APPROVED qty=${commaMargin.qty}` : `REJECT ${commaMargin.code}`);
  check("  ...and the same account with a parsed margin is treated identically",
        run(ohlc, acct({ ordersMargin: 1234.56 })).approved === commaMargin.approved);
  for (const bad of ["", "   ", "abc", "1.2.3", true, null, undefined, NaN]) {
    check(`parseAmount(${JSON.stringify(bad)}) throws rather than defaulting`,
          (() => { try { parseAmount(bad, "m"); return false; } catch { return true; } })());
  }
  check("parseAmount strips thousands separators", parseAmount("1,234.56", "m") === 1234.56);

  // C2: a stop at or below zero, or on the wrong side of entry. Enforced in
  // `evaluate` (the live-order path), so these go through run() rather than
  // sizePosition(). A cheap instrument with a wide ATR puts the stop below zero.
  const wideAtr = series(4.0);
  const cheapStop = run(wideAtr, { equity: 10000, price: 0.5, ordersMargin: 0, accountMargin: 0 });
  check("a stop at or below zero is refused", cheapStop.approved === false && cheapStop.code === "STOP_UNREACHABLE",
        cheapStop.approved ? "APPROVED" : `REJECT ${cheapStop.code}`);
  const inverted = run(ohlc, acct(), "buy", { ...cfg, stop_atr_mult: 0 });   // zero stop dist => stop sits AT entry
  check("a stop on the wrong side of entry is refused",
        inverted.approved === false && inverted.code === "STOP_WRONG_SIDE",
        inverted.approved ? "APPROVED" : `REJECT ${inverted.code}`);

  // M8: a non-finite cap was silently skipped by the reduce AND by the
  // post-hoc clamp, so the order reported a cap it was not obeying.
  for (const [k, v] of Object.entries({
    max_order_notional_usd: NaN, max_total_margin_usd: NaN,
    max_leverage: NaN, risk_per_trade_pct: NaN, stop_atr_mult: NaN,
  })) {
    const r = run(ohlc, acct(), "buy", { ...cfg, [k]: v });
    check(`a non-finite ${k} refuses the order`, r.approved === false && r.code === "INVALID_RISK_CONFIG",
          r.approved ? "APPROVED" : `REJECT ${r.code}`);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}