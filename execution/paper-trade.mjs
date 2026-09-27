#!/usr/bin/env node
/**
 * paper-trade.mjs — CLI for the TradingView Desktop paper-trading broker.
 *
 * Drives the real order ticket in the TradingView Desktop renderer over CDP.
 * There is no order-entry REST API, so this automates the ticket UI. It
 * refuses to submit anything whose ticket label does not match what you asked
 * for, so a mis-click can never become an unintended order.
 *
 *   node paper-trade.mjs status
 *   node paper-trade.mjs account
 *   node paper-trade.mjs positions
 *   node paper-trade.mjs buy  <qty> <symbol> [--limit <price>] [--rth]
 *   node paper-trade.mjs sell <qty> <symbol> [--limit <price>] [--rth]
 *
 * Notes
 *  - Fills require a live market. US equities/ETFs are RTH-only, so use a
 *    24/7 symbol (crypto) or trade while the exchange is open.
 *  - "Fill order outside RTH" is toggled via JS because the real input is
 *    visually hidden behind a styled element and misses synthetic mouse clicks.
 */

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { evaluate } from "../research/risk-engine.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const RISK_PATH = join(HERE, "..", "config", "risk.json");
const AUDIT_PATH = join(HERE, "..", "config", "audit.jsonl");

const CDP_URL = "http://localhost:9222";

// ---------------------------------------------------------------------------
// Market data adapter — TradingView is the EYES here, not the hands.
// Reads OHLCV from the chart via the MCP CLI. This is the only place the
// execution path touches TradingView for data, and it cannot place an order.
// ---------------------------------------------------------------------------
import { execFileSync } from "node:child_process";

const TV_CLI = "C:\\Users\\ez\\AppData\\Roaming\\npm\\tv.cmd";

// Windows cannot execFileSync a .cmd directly (EINVAL) — go through cmd.exe.
const tv = (args, timeoutMs = 60000) =>
  execFileSync("cmd.exe", ["/c", TV_CLI, ...args], { timeout: timeoutMs, encoding: "utf8" });

export function fetchOhlcv({ symbol, bars = 100, timeoutMs = 90000 }) {
  // `tv ohlcv` reads whatever symbol the chart is on, so switch first — then
  // VERIFY the switch landed before trusting the bars. Reading the wrong
  // instrument's price would size the trade off the wrong volatility.
  tv(["symbol", symbol], timeoutMs);

  const q = JSON.parse(tv(["quote"], timeoutMs));
  if (!q.success || !new RegExp(`(^|:)${symbol}$`, "i").test(String(q.symbol))) {
    throw new Error(
      `symbol switch did not take effect: asked for ${symbol}, chart reports ${q.symbol}. ` +
      `Refusing to size against the wrong instrument.`
    );
  }

  const j = JSON.parse(tv(["ohlcv"], timeoutMs));
  if (!j.success || !Array.isArray(j.bars) || j.bars.length < 20) {
    throw new Error(`could not read OHLCV for ${symbol} (got ${j.bars?.length ?? 0} bars)`);
  }
  return { bars: j.bars.slice(-bars), symbol: q.symbol, price: q.close ?? q.last };
}

// ---------------------------------------------------------------------------
// Audit log — append-only JSONL. Written for every action, including refusals.
// ---------------------------------------------------------------------------
function audit(entry) {
  const line = JSON.stringify({ time: new Date().toISOString(), ...entry });
  try { appendFileSync(AUDIT_PATH, line + "\n"); } catch { /* never fail a trade on logging */ }
  console.error("audit: " + line);
}

function loadRiskConfig() {
  const d = {
    kill_switch: false,
    max_open_orders: 1,
    max_total_margin_usd: 25,
    max_order_notional_usd: 25,
  };
  if (!existsSync(RISK_PATH)) return d;
  try {
    const raw = JSON.parse(readFileSync(RISK_PATH, "utf8"));
    for (const k of Object.keys(d)) if (k in raw) d[k] = raw[k];
  } catch (e) {
    console.error(`risk.json unreadable (${e.message}) — using conservative defaults`);
  }
  return d;
}

// ---------------------------------------------------------------------------
// Risk gate — PURE. No DOM, no clicks, no side effects.
//
// This runs before ensureTradePanel/ensureOrderTab, i.e. before the process
// touches the UI at all. That ordering is the whole point: the duplicate-order
// incident happened because clicks happened with no gate in front of them.
// ---------------------------------------------------------------------------
function riskGate({ intent, state, cfg }) {
  const closing = intent.closing === true;
  // FAIL CLOSED. If the account state could not be read we do NOT assume zero
  // exposure — that would let a gate pass on missing data, which is precisely
  // how a kill switch becomes decorative.
  if (!state.readable) {
    return {
      action: "BLOCK", code: "STATE_UNREADABLE",
      detail: "could not read Orders margin / Account margin from the account summary. " +
              "The Paper Trading panel at the bottom of the chart is collapsed. " +
              "Expand it (the chevron next to 'Paper Trading') and re-run. " +
              "Refusing to assume zero exposure.",
      account_margin: null,
      max_allowed_margin: cfg.max_total_margin_usd,
    };
  }

  const orders = Number(state.ordersMargin) || 0;
  const position = Number(state.accountMargin) || 0;
  const committed = orders + position;
  const notional = intent.qty * (intent.price || 0);

  const block = (code, detail) => ({
    action: "BLOCK", code, detail,
    account_margin: committed,
    max_allowed_margin: cfg.max_total_margin_usd,
  });

  if (cfg.kill_switch) {
    return block("KILL_SWITCH", "kill_switch is true in risk.json");
  }
  // Reconciliation: the account summary is authoritative for exposure; the
  // positions table is authoritative for WHAT. If they disagree — or if we are
  // exposed and cannot read the table at all — we do not know what we are
  // holding, so we must not trade. Being flat needs no reconciliation.
  if (state.recon) {
    const { rendered, positionCount, marginFromRows, accountMargin } = state.recon;
    const acct = Number(accountMargin) || 0;
    const exposed = acct > 0.001;
    if (exposed && !rendered) {
      return block("RECONCILIATION_UNAVAILABLE",
        `exposed (account margin ${acct.toFixed(2)}) but the positions table is not ` +
        `rendered, so the holding is unknown. Expand the Paper Trading panel and ` +
        `reconcile by hand before trading.`);
    }
    if (rendered) {
      const tbl = Number(marginFromRows) || 0;
      const countMismatch = (acct > 0.001) !== (positionCount > 0);
      const marginMismatch = Math.abs(acct - tbl) > Math.max(0.05, acct * 0.05);
      if (countMismatch || marginMismatch) {
        return block("RECONCILIATION_MISMATCH",
          `account margin ${acct.toFixed(2)} vs positions table ${tbl.toFixed(2)} ` +
          `across ${positionCount} row(s). Exposure is known but the holding is not. ` +
          `Reconcile manually before trading.`);
      }
    }
  }
  if (intent.price == null) {
    return block("PRICE_UNKNOWN",
      "could not read the ticket price to size the order; refusing to place an unsized order. " +
      "Pass --est-price <price> to size the risk check.");
  }
  // "One at a time" means one unit of *exposure*: a resting order OR an open
  // position. Counting only resting orders let a second position stack up.
  //
  // A --close order reduces exposure, so it is exempt from the "adding
  // exposure" caps. Without this the gate would trap you: you could not close
  // a position precisely because one was open. It is NOT exempt from the kill
  // switch, state readability, or price — only from the caps below.
  if (!closing && committed > 0 && cfg.max_open_orders <= 1) {
    return block("MAX_OPEN_ORDERS",
      `already exposed: ${orders} USD resting + ${position} USD position margin. ` +
      `max_open_orders=${cfg.max_open_orders} means flat before the next order. ` +
      `Close the position with --close, or cancel the order by hand.`);
  }
  if (!closing && notional > cfg.max_order_notional_usd) {
    return block("MAX_ORDER_NOTIONAL",
      `order notional ${notional.toFixed(2)} > max_order_notional_usd ${cfg.max_order_notional_usd}`);
  }
  if (!closing && committed + notional > cfg.max_total_margin_usd) {
    return block("MAX_TOTAL_MARGIN",
      `committed ${committed.toFixed(2)} + notional ${notional.toFixed(2)} = ` +
      `${(committed + notional).toFixed(2)} > max_total_margin_usd ${cfg.max_total_margin_usd}`);
  }
  return {
    action: "ALLOW",
    account_margin: committed,
    max_allowed_margin: cfg.max_total_margin_usd,
    notional: Number(notional.toFixed(2)),
  };
}

// Read a reference price WITHOUT clicking, for sizing the risk check.
//
// Only the ticket's own side control is trusted — it is the price this order
// would actually trade at. A DOM-wide scrape for "the last price" is NOT used:
// it picks up unrelated values (the watchlist's Last column), and a plausible
// but wrong price would size the risk check incorrectly. If it cannot be read,
// the gate blocks and asks for --est-price.
async function readTicketPrice(ev) {
  try {
    const v = await ev(`(() => {
      const side = document.querySelector('[data-name="side-control-buy"]');
      if (!side) return null;
      const m = (side.innerText||'').match(/(\\d[\\d,]*\\.\\d+)/);
      return m ? m[1].replace(/,/g,'') : null;
    })()`);
    return v == null ? null : parseFloat(v);
  } catch { return null; }
}

// Read open positions RELIABLY.
//
// Paper.positions-table is only meaningful when it is actually rendered: when
// the account manager is collapsed the element exists with width 0 and keeps
// serving stale rows. That is the source of the "closed position still shows in
// the table" bug. So: expand the account manager, activate the Positions tab,
// and only then read. Both steps are VIEW-ONLY.
//
// Returns { rendered, rows, positions, marginFromRows } so the gate can
// cross-check the table against the authoritative account margin.
async function readPositionsLive(ev, clickAt) {
  // 1. make the panel visible
  const rendered = () => ev(`(() => {
    const tb = document.querySelector('[data-name="Paper.positions-table"]');
    if (!tb) return { ok: false, w: 0 };
    const r = tb.getBoundingClientRect();
    return { ok: r.width > 0, w: Math.round(r.width) };
  })()`);

  let r = await rendered();
  if (!r.ok) {
    const c = await ev(`(() => {
      const b = [...document.querySelectorAll('button')].find(x =>
        /account manager/i.test(x.getAttribute('aria-label')||'') && x.getBoundingClientRect().width > 0);
      if (!b) return null; const br = b.getBoundingClientRect();
      return { x: Math.round(br.x + br.width/2), y: Math.round(br.y + br.height/2) };
    })()`);
    if (c && clickAt) { await clickAt(c.x, c.y); await sleep(1500); r = await rendered(); }
  }
  if (!r.ok) return { rendered: false, rows: null, positions: [], marginFromRows: 0 };

  // 2. activate the Positions tab (view-only)
  const posTab = await ev(`(() => {
    const b = [...document.querySelectorAll('button,[role="tab"]')].find(e =>
      /^Positions/i.test((e.innerText||'').trim()) && e.getBoundingClientRect().width > 0);
    if (!b) return null; const br = b.getBoundingClientRect();
    return { x: Math.round(br.x + br.width/2), y: Math.round(br.y + br.height/2) };
  })()`);
  if (posTab && clickAt) { await clickAt(posTab.x, posTab.y); await sleep(1200); }

  // 3. read
  const rows = await ev(rowsSql("Paper.positions-table"));
  const positions = [];
  let marginFromRows = 0;
  if (Array.isArray(rows)) {
    for (const line of rows.slice(1)) {          // row 0 is the header
      if (/no open positions|no trading data/i.test(line)) continue;
      const cells = line.split(/\s+/).filter(Boolean);
      if (cells.length < 3) continue;
      const margin = cells.find((c) => /USD$/i.test(c) && /^\d/i.test(c));
      positions.push({ raw: line, symbol: cells[0], margin: margin ? parseFloat(margin) : null });
      if (margin) marginFromRows += parseFloat(margin);
    }
  }
  return { rendered: true, rows, positions, marginFromRows };
}

// Read account state for the risk gate.
//
// The account summary lives in the Paper Trading panel, which collapses on its
// own after some actions. Expanding it is a VIEW-ONLY step: the control is
// precisely identifiable by aria-label and cannot place, modify or cancel an
// order. This is the one click permitted before the gate, because reading the
// state is a precondition for evaluating it. If it still cannot be read, the
// gate blocks.
async function readAccountState(ev, clickAt) {
  let acct = await readAccount(ev);
  if (acct && acct["Orders margin"] !== undefined && acct["Account margin"] !== undefined) {
    return { readable: true, ordersMargin: acct["Orders margin"], accountMargin: acct["Account margin"], account: acct };
  }
  const c = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x =>
      /^(Open|Close) account manager$/i.test((x.getAttribute('aria-label')||''))
      && /^Open/i.test(x.getAttribute('aria-label')||''));
    if (!b) return null; const r = b.getBoundingClientRect();
    if (r.width === 0) return null;
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
  })()`);
  if (c && clickAt) {
    await clickAt(c.x, c.y);
    await sleep(1500);
    acct = await readAccount(ev);
  }
  const readable = !!(acct && acct["Orders margin"] !== undefined && acct["Account margin"] !== undefined);
  return {
    readable,
    ordersMargin: acct?.["Orders margin"] ?? 0,
    accountMargin: acct?.["Account margin"] ?? 0,
    account: acct,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  let list;
  try {
    list = await (await fetch(`${CDP_URL}/json/list`)).json();
  } catch {
    throw new Error(
      `Cannot reach TradingView CDP on ${CDP_URL}.\n` +
      `Start it with:  .\\launch-tv.ps1`
    );
  }
  const target = list.find((t) => t.type === "page" && /tradingview\.com\/chart/i.test(t.url));
  if (!target) {
    throw new Error(
      "No chart tab open. The MCP only works against a real chart.\n" +
      `Run:  node ensure-chart.mjs <SYMBOL>`
    );
  }
  const { default: CDP } = await import(
    "file:///C:/Users/ez/AppData/Roaming/npm/node_modules/tradingview-mcp/node_modules/chrome-remote-interface/index.js"
  );
  const client = await CDP({ host: "localhost", port: 9222, target: target.id });
  const { Runtime, Input } = client;
  await Runtime.enable();
  return { client, Runtime, Input };
}

const makeHelpers = ({ Runtime, Input }) => {
  const ev = async (expression) => {
    const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  };

  const clickAt = async (x, y) => {
    await Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
    await sleep(180);
    await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await sleep(110);
    await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await sleep(1500);
  };

  const centerOf = (expr) =>
    ev(`(() => { const e = ${expr}; if (!e) return null;
       const r = e.getBoundingClientRect();
       if (r.width === 0) return null;
       return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);

  const setField = async (id, value) => {
    const st = await ev(`(() => { const el = document.getElementById('${id}'); if (!el) return null;
       const r = el.getBoundingClientRect();
       return { ro: el.readOnly, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!st) return false;
    if (st.ro) return false;
    await clickAt(st.x, st.y);
    for (const [type, key, code, vk, mod] of [
      ["keyDown", "Control", "ControlLeft", 17, 2],
      ["keyDown", "a", "KeyA", 65, 2],
      ["keyUp", "a", "KeyA", 65, 0],
      ["keyUp", "Control", "ControlLeft", 17, 0],
    ]) {
      await Input.dispatchKeyEvent({ type, key, code, windowsVirtualKeyCode: vk, modifiers: mod });
    }
    await sleep(180);
    for (const ch of String(value)) {
      await Input.dispatchKeyEvent({ type: "keyDown", text: ch, key: ch, unmodifiedText: ch });
      await Input.dispatchKeyEvent({ type: "keyUp", key: ch });
      await sleep(55);
    }
    await Input.dispatchKeyEvent({ type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await Input.dispatchKeyEvent({ type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await sleep(1400);
    return true;
  };

  return { ev, clickAt, centerOf, setField };
};

const rowsSql = (table) => `(() => {
  const tb = document.querySelector('[data-name="${table}"]'); if (!tb) return null;
  return [...tb.querySelectorAll('tr')].map(r => (r.innerText||'').replace(/\\s+/g,' ').trim()).filter(Boolean);
})()`;

const readAccount = (ev) => ev(`(() => {
  const t = [...document.querySelectorAll('*')].find(e =>
    /Account balance/i.test(e.textContent||'') && (e.textContent||'').length < 300 && e.children.length <= 12);
  if (!t) return null;
  const raw = (t.innerText||'').replace(/locking in\\s*\\w+/gi, '').replace(/\\s+/g, ' ').trim();
  // Labels are fixed-vocabulary; pull "<label> <number>" pairs in order.
  const LABELS = ['Account balance','Equity','Realized PnL','Unrealized PnL',
                  'Account margin','Available funds','Orders margin','Margin buffer'];
  const o = {};
  for (const L of LABELS) {
    const i = raw.indexOf(L);
    if (i < 0) continue;
    const m = raw.slice(i + L.length).match(/^\\s*([+-]?[\\d.,]+)/);
    if (m) o[L] = m[1];
  }
  return { ...o, raw };
})()`);

// The Trade panel can be closed entirely (the right pane falls back to the
// watchlist). The submit button is the reliable "panel is usable" signal --
// the Order/DOM tab strip comes and goes, so it is not a dependable check.
async function ensureTradePanel(ev, clickAt) {
  const ready = () => ev(`!!document.querySelector('[data-name="place-and-modify-button"]')`);
  if (await ready()) return true;
  const c = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(e => {
      if (!/^Trade$/i.test((e.innerText||'').trim())) return false;
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.y < 60;   // header button only
    });
    if (!b) return null; const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
  })()`);
  if (!c) return false;
  await clickAt(c.x, c.y);
  await sleep(2500);
  return await ready();
}

// Ticket controls are located by stable identity (data-name / role / exact
// text), never by absolute x — the panel moves when the window is resized.

// Only the Order view exposes side-control-buy / sell. If those are present we
// are already there, whether or not the tab strip happens to be rendered.
async function ensureOrderTab(ev, clickAt) {
  const onOrderView = () => ev(`!!document.querySelector('[data-name="side-control-buy"]')`);
  if (await onOrderView()) return true;

  const c = await ev(`(() => {
    const b = [...document.querySelectorAll('button,[role="radio"],[role="tab"]')].find(e =>
      /^Order$/i.test((e.innerText||'').trim()) && e.getBoundingClientRect().width > 0);
    if (!b) return null; const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
  })()`);
  if (!c) return false;                      // no tab strip and not on Order view
  await clickAt(c.x, c.y);
  return await onOrderView();
}

async function ensureSide(ev, clickAt, side) {
  const key = `side-control-${side}`;
  const active = await ev(`(() => { const e = document.querySelector('[data-name="${key}"]');
    if (!e) return null;
    return /active|selected|checked/i.test(e.className||'') || e.getAttribute('aria-pressed') === 'true'
      || e.getAttribute('aria-checked') === 'true'; })()`);
  if (!active) {
    const c = await ev(`(() => { const e = document.querySelector('[data-name="${key}"]'); if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`);
    if (!c) throw new Error(`Could not find the ${side} side control — is the Trade panel open?`);
    await clickAt(c.x, c.y);
  }
}

async function ensureRth(ev, clickAt, want) {
  let present = await ev(`!![...document.querySelectorAll('label')].find(l => /Fill order outside RTH/i.test(l.textContent||''))`);
  if (!present) {
    const c = await ev(`(() => { const b = [...document.querySelectorAll('button')]
      .find(e => /^Extra settings$/i.test((e.innerText||'').trim()) && e.getBoundingClientRect().width > 0);
      if (!b) return null; const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`);
    if (!c) return false;
    await clickAt(c.x, c.y);
  }
  const st = await ev(`(() => {
    const lab = [...document.querySelectorAll('label')].find(l => /Fill order outside RTH/i.test(l.textContent||''));
    const b = lab && lab.querySelector('input[type="checkbox"]');
    if (!b) return null;
    if (b.checked !== ${want}) b.click();
    return b.checked;
  })()`);
  return st;
}

async function placeOrder({ side, qty, symbol, limit, rth, estPrice, closing, engineSized, thesis, stopPrice }) {
  const { client, ...conn } = await connect();
  const { ev, clickAt, setField } = makeHelpers(conn);
  try {
    // ---- GATE FIRST -------------------------------------------------------
    // Read-only. Nothing is clicked until the gate returns ALLOW.
    const cfg = loadRiskConfig();
    const st0 = await readAccountState(ev, clickAt);
    const before = st0.account;
    // Reconciliation source: read the table live so it is actually rendered.
    const recon = await readPositionsLive(ev, clickAt);
    const state = {
      readable: st0.readable,
      ordersMargin: st0.ordersMargin,
      accountMargin: st0.accountMargin,
      recon: {
        rendered: recon.rendered,
        positionCount: recon.positions.length,
        marginFromRows: recon.marginFromRows,
        accountMargin: st0.accountMargin,
      },
    };
    // Price for the notional estimate: a limit order has one by definition; a
    // market order is estimated from the ticket's own price field when the
    // panel happens to be open, else from the conservative notional cap.
    const px = limit ? parseFloat(limit) : (estPrice ?? await readTicketPrice(ev));
    const intent = { side, qty: parseFloat(qty), symbol, type: limit ? "LIMIT" : "MARKET", price: px, closing: !!closing };

    const gate = riskGate({ intent, state, cfg });
    audit({
      action: side.toUpperCase(), symbol, qty, type: intent.type,
      requested_price: limit ?? null,
      orders_margin: state.readable ? Number(state.ordersMargin) : null,
      account_margin: state.readable ? Number(state.accountMargin) : null,
      state_readable: state.readable,
      recon_rendered: state.recon.rendered,
      recon_positions: state.recon.positionCount,
      recon_margin_from_rows: state.recon.marginFromRows,
      gate: gate.action, gate_code: gate.code ?? null, gate_detail: gate.detail ?? null,
      sized_by: engineSized ? "risk-engine" : "agent-explicit",
      thesis: thesis ?? null, engine_stop: stopPrice ?? null,
    });

    if (gate.action === "BLOCK") {
      throw new Error(
        `BLOCKED BY RISK GATE [${gate.code}]\n  ${gate.detail}\n` +
        `  committed margin : ${gate.account_margin}\n` +
        `  max allowed      : ${gate.max_allowed_margin}\n\n` +
        `No clicks were made. Fix the account state or raise the limits in risk.json.`
      );
    }
    // ---- GATE PASSED: UI automation may begin ------------------------------

    if (!await ensureTradePanel(ev, clickAt)) {
      throw new Error("Trade panel is not open and could not be opened.");
    }
    if (!await ensureOrderTab(ev, clickAt)) {
      throw new Error("Could not reach the Order tab — is the Trade panel open?");
    }

    // order type
    const typeId = limit ? "Limit" : "Market";
    const tc = await ev(`(() => { const b = document.getElementById('${typeId}'); if (!b) return null;
      const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`);
    if (tc) await clickAt(tc.x, tc.y);

    await ensureSide(ev, clickAt, side);

    if (limit) {
      // price field id varies; find the one above the qty field
      const ok = await setField("price-field", limit);
      if (!ok) {
        const p = await ev(`(() => {
          const q = document.getElementById('quantity-field'); if (!q) return null;
          const qr = q.getBoundingClientRect();
          const cand = [...document.querySelectorAll('input[type="text"]')].filter(i => {
            const r = i.getBoundingClientRect();
            return r.width > 0 && r.x > qr.x - 20 && r.x < qr.x + 20 && r.y < qr.y && r.y > qr.y - 200;
          }).sort((a,b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)[0];
          if (!cand) return null;
          if (!cand.id) cand.id = 'price-field';
          return { x: Math.round(cand.getBoundingClientRect().x + cand.getBoundingClientRect().width/2),
                   y: Math.round(cand.getBoundingClientRect().y + cand.getBoundingClientRect().height/2) };
        })()`);
        if (p) { await clickAt(p.x, p.y);
          await conn.Input.dispatchKeyEvent({ type: "keyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2 });
          await conn.Input.dispatchKeyEvent({ type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
          await conn.Input.dispatchKeyEvent({ type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
          await conn.Input.dispatchKeyEvent({ type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 });
          await sleep(150);
          for (const ch of String(limit)) {
            await conn.Input.dispatchKeyEvent({ type: "keyDown", text: ch, key: ch, unmodifiedText: ch });
            await conn.Input.dispatchKeyEvent({ type: "keyUp", key: ch });
            await sleep(55);
          }
          await sleep(400);
        }
      }
    }

    // quantity: make sure the field is editable
    for (let i = 0; i < 4; i++) {
      const st = await ev(`(() => { const el = document.getElementById('quantity-field'); if (!el) return null;
        return { ro: el.readOnly, aria: el.getAttribute('aria-label'),
                 x: Math.round(el.getBoundingClientRect().x + el.getBoundingClientRect().width/2),
                 y: Math.round(el.getBoundingClientRect().y + el.getBoundingClientRect().height/2) }; })()`);
      if (!st || !st.ro) break;
      const tb = await ev(`(() => { const el = document.getElementById('quantity-field'); const r = el.getBoundingClientRect();
        const b = [...document.querySelectorAll('button')].find(x => { const br = x.getBoundingClientRect();
          return br.x > r.x + r.width && br.x < r.x + r.width + 30 && Math.abs(br.y - r.y) < 20; });
        if (!b) return null; const br = b.getBoundingClientRect();
        return { x: Math.round(br.x + br.width/2), y: Math.round(br.y + br.height/2) }; })()`);
      if (!tb) break;
      await clickAt(tb.x, tb.y);
    }
    await setField("quantity-field", qty);

    if (rth) await ensureRth(ev, clickAt, true);

    // GUARD — never submit a ticket that isn't what was asked for.
    const label = await ev(`(() => { const b = document.querySelector('[data-name="place-and-modify-button"]');
      if (!b) return null; const r = b.getBoundingClientRect();
      return { text: (b.innerText||'').replace(/\\s+/g,' ').trim(), disabled: b.disabled === true,
               x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`);
    if (!label) throw new Error("Submit button not found — is the Trade panel open?");
    if (label.disabled) throw new Error("Ticket is disabled: " + label.text);

    const want = new RegExp(`^${side === "buy" ? "Buy" : "Sell"}\\s+${qty}\\s+${symbol}`, "i");
    const wantType = limit ? /LIMIT/i : /MARKET/i;
    if (!want.test(label.text) || !wantType.test(label.text)) {
      audit({ action: side.toUpperCase(), symbol, qty, type: intent.type,
              result: "REFUSED", reason: "TICKET_MISMATCH",
              ticket: label.text, expected: `${side.toUpperCase()} ${qty} ${symbol} ${intent.type}` });
      throw new Error(
        `REFUSING TO SUBMIT.\n  ticket says: "${label.text}"\n` +
        `  expected   : ${side.toUpperCase()} ${qty} ${symbol} ${limit ? "LIMIT" : "MARKET"}`
      );
    }

    // Price guard. The ticket's price input is a readonly, id-less field that
    // cannot be driven programmatically, so a requested --limit may silently
    // end up as the ticket's default. Refuse rather than trade the wrong price.
    if (limit) {
      const ticketPrice = (label.text.match(/@\s*([\d.,]+)/) || [])[1];
      if (!ticketPrice || Math.abs(parseFloat(ticketPrice) - parseFloat(limit)) > 1e-6) {
        audit({ action: side.toUpperCase(), symbol, qty, type: intent.type,
                result: "REFUSED", reason: "PRICE_MISMATCH",
                requested_price: limit, ticket_price: ticketPrice ?? null });
        throw new Error(
          `REFUSING TO SUBMIT — wrong price.\n` +
          `  requested : ${limit}\n` +
          `  ticket    : ${ticketPrice ?? "(none)"}  ["${label.text}"]\n\n` +
          `The price field is readonly and cannot be set over CDP. Set the price\n` +
          `by hand in the ticket, then re-run — or drop --limit for a market order.`
        );
      }
    }
    console.log(`submitting: ${label.text}`);
    await clickAt(label.x, label.y);
    await sleep(6000);

    const after = await readAccount(ev);
    const num = (v) => parseFloat(v ?? "0") || 0;
    const dOrders = num(after?.["Orders margin"]) - num(before?.["Orders margin"]);
    const dMargin = num(after?.["Account margin"]) - num(before?.["Account margin"]);
    // A resting order shows up in Orders margin; a fill in Account margin.
    // A close DEcreases margin, so direction matters, not just "changed".
    const result =
      dOrders > 0.001 ? "SUBMITTED_RESTING" :
      dMargin > 0.001 ? "FILLED_OPEN" :
      dMargin < -0.001 ? "FILLED_CLOSE" :
      Math.abs(dOrders) > 0.001 ? "ORDER_CANCELLED" : "NO_EFFECT";

    audit({
      action: side.toUpperCase(), symbol, qty, type: intent.type,
      requested_price: limit ?? null,
      ticket_price: (label.text.match(/@\s*([\d.,]+)/) || [])[1] ?? null,
      ticket: label.text, verified: true, result,
      orders_margin_before: before?.["Orders margin"] ?? null,
      orders_margin_after: after?.["Orders margin"] ?? null,
      account_margin_after: after?.["Account margin"] ?? null,
    });

    return { submitted: label.text, result, account: after, positions: await ev(rowsSql("Paper.positions-table")) };
  } finally {
    await client.close();
  }
}

// Cancelling is intentionally NOT automated.
//
// TradingView draws the working-order line and its cancel "x" on a <canvas>,
// and the price axis is canvas too, so there is no DOM handle for either.
// Locating the "x" means probing chart coordinates, and probing a live trading
// UI is not safe: during development that probe opened the chart's timezone
// dropdown, nearly hit the account-deletion control, and placed a duplicate
// order. There is no reliable DOM-only path -- the account manager's Orders
// table renders empty, and "CXL All" only exists on the ticket's DOM tab.
//
// Cancelling is two clicks, by hand:
//   1. hover the order line on the chart, click its "x"
//   2. in the "Cancel order" dialog, click "Cancel order" (not "Keep order")
async function cancelOrder() {
  audit({ action: "CANCEL", method: "manual_required", result: "REFUSED",
          reason: "canvas_element_no_DOM_reference" });
  return {
    cancelled: false,
    reason:
      "automatic cancel is not supported — the order line is canvas-drawn and " +
      "probing coordinates is unsafe. Cancel by hand: click the order line's x, " +
      'then click "Cancel order" in the dialog.',
  };
}

// ---------------------------------------------------------------- CLI
const [, , cmd, ...rest] = process.argv;

try {
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(`paper-trade — TradingView Desktop paper trading over CDP

  status                     connection + chart
  account                    balance / equity / PnL / margin
  positions                  open positions
  cancel                     (not supported — see note below)
  [propose] --est-price <p>    size the risk check when the ticket price is unreadable
  [propose/buy/sell] --close   exempt from exposure caps (risk reduction)
  [propose] --limit <p>        limit order (price must be set by hand in the ticket)

Examples
  node paper-trade.mjs account
  node paper-trade.mjs buy 300 DOGEUSD
  node paper-trade.mjs sell 300 DOGEUSD
  node paper-trade.mjs buy 5 F --limit 12.71 --rth

Notes
  - --limit is guarded on price. The ticket's price field is readonly and
    cannot be driven over CDP, so if the ticket price is not the one you asked
    for the tool refuses rather than trading the wrong price.
  - cancel is NOT automated: the order line is canvas-drawn, and probing for it
    is unsafe. Cancel by hand — click the order line's x, then "Cancel order".`);
    process.exit(0);
  }

  if (cmd === "propose") {
    // The agent proposes a THESIS. It never proposes a size.
    //   node paper-trade.mjs propose buy DOGEUSD --thesis "liquidity sweep"
    // `propose <buy|sell> <symbol> --thesis "..." [--dry-run]`
    // The agent supplies a direction and a reason. Never a size.
    const side = rest[0];
    const symbol = rest[1];
    if (side !== "buy" && side !== "sell") {
      throw new Error(`usage: paper-trade.mjs propose <buy|sell> <symbol> --thesis "..."`);
    }
    if (!symbol) throw new Error("symbol is required");
    const ti = rest.indexOf("--thesis");
    // thesis runs until the next flag, so flags after it are not swallowed
    const tail = ti >= 0 ? rest.slice(ti + 1) : [];
    const end = tail.findIndex((a) => a.startsWith("--"));
    const thesis = (end >= 0 ? tail.slice(0, end) : tail).join(" ").trim();
    if (!thesis) throw new Error("--thesis is required: the risk engine needs a stated reason");

    const cfg = loadRiskConfig();
    const { bars, price, symbol: actual } = fetchOhlcv({ symbol });

    // account state (read-only)
    const { client, ...conn } = await connect();
    const { ev } = makeHelpers(conn);
    const acct = await readAccountState(ev, null);
    await client.close();
    if (!acct.readable) throw new Error("cannot read account state; refusing to size a trade");

    const decision = evaluate({
      symbol: actual, side, thesis, bars,
      account: {
        equity: parseFloat(acct.account["Equity"] ?? 0),
        price,
        ordersMargin: acct.ordersMargin,
        accountMargin: acct.accountMargin,
      },
      cfg,
    });

    console.log(JSON.stringify(decision, null, 2));
    audit({
      action: "PROPOSE", symbol: actual, side, thesis,
      price, atr: decision.atr ?? null, realised_vol: decision.realisedVol ?? null,
      approved: decision.approved, code: decision.code ?? null,
      engine_qty: decision.qty ?? null, engine_stop: decision.stopPrice ?? null,
      engine_notional: decision.notional ?? null, engine_risk: decision.riskAmount ?? null,
      binding_cap: decision.bindingCap ?? null,
    });

    if (!decision.approved) {
      console.error(`\nRisk engine declined [${decision.code}]: ${decision.detail}`);
      process.exit(3);
    }

    if (rest.includes("--dry-run")) {
      console.error("\n--dry-run: risk engine approved, nothing was submitted.");
      process.exit(0);
    }

    // Only now does anything touch the order path, and only with the
    // engine's own quantity.
    const out2 = await placeOrder({
      side: decision.side,
      qty: String(decision.qty),
      symbol: actual, limit: null, rth: false, estPrice: price,
      closing: false, engineSized: true,
      thesis, stopPrice: decision.stopPrice,
    });
    console.log(JSON.stringify(out2, null, 2));
    process.exit(0);
  }

  if (cmd === "selftest") {
    // Exercise the risk gate against synthetic state. Touches no UI, so it is
    // safe to run at any time — and it is the only honest way to prove the
    // gate blocks without actually placing orders.
    const cfg = loadRiskConfig();
    const intent = { side: "buy", qty: 1, symbol: "DOGEUSD", type: "MARKET", price: 0.1 };
    const cases = [
      ["clean account, tiny order",        { readable: true, ordersMargin: 0, accountMargin: 0 }],
      ["unreadable state (must block)",    { readable: false, ordersMargin: 0, accountMargin: 0 }],
      ["one resting order (must block)",   { readable: true, ordersMargin: 12.71, accountMargin: 0 }],
      ["one open position (must block)",    { readable: true, ordersMargin: 0, accountMargin: 1.95 }],
      ["open position (must block)",       { readable: true, ordersMargin: 0, accountMargin: 29.07 }],
      ["over notional cap (must block)",   { readable: true, ordersMargin: 0, accountMargin: 0 }],
      ["unknown price (must block)",       { readable: true, ordersMargin: 0, accountMargin: 0 }],
      ["recon unavailable (must block)",   { readable: true, ordersMargin: 0, accountMargin: 0 }],
      ["recon mismatch (must block)",      { readable: true, ordersMargin: 0, accountMargin: 0 }],
    ];
    let pass = 0, fail = 0;
    for (const [name, state] of cases) {
      const it = name.includes("notional") ? { ...intent, qty: 100000 } :
                 name.includes("price")   ? { ...intent, price: null } : intent;
      // Reconciliation scenarios: exposed, but the table is either unrendered
      // or disagrees with the authoritative account margin.
      if (name.includes("recon unavailable"))
        state.recon = { rendered: false, positionCount: 0, marginFromRows: 0, accountMargin: 5 };
      if (name.includes("recon mismatch"))
        state.recon = { rendered: true, positionCount: 0, marginFromRows: 0, accountMargin: 5 };
      if (name.includes("recon")) state.accountMargin = 5;
      const g = riskGate({ intent: it, state, cfg });
      const expectBlock = name.includes("must block");
      const ok = expectBlock ? g.action === "BLOCK" : g.action === "ALLOW";
      ok ? pass++ : fail++;
      console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(34)} -> ${g.action}${g.code ? " [" + g.code + "]" : ""}`);
    }
    const kill = riskGate({ intent, state: { readable: true, ordersMargin: 0, accountMargin: 0 }, cfg: { ...cfg, kill_switch: true } });
    (kill.action === "BLOCK" ? pass++ : fail++);
    console.log(`  ${kill.action === "BLOCK" ? "PASS" : "FAIL"}  ${"kill switch engaged".padEnd(34)} -> ${kill.action}${kill.code ? " [" + kill.code + "]" : ""}`);
    console.log(`\n  ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }

  if (cmd === "cancel") {
    const out = await cancelOrder();
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.cancelled ? 0 : 1);
  }

  if (cmd === "buy" || cmd === "sell") {
    const pos = rest.filter((a) => !a.startsWith("--"));
    const qty = pos[0];
    const symbol = pos[1];
    if (!qty || !symbol) throw new Error(`usage: paper-trade.mjs ${cmd} <qty> <symbol>`);

    // Read the value from the FULL argv, not from a --only-filtered list,
    // otherwise "--limit 11.00" loses its value and silently becomes a market order.
    const li = rest.indexOf("--limit");
    let limit = null;
    if (li >= 0) {
      limit = rest[li + 1];
      if (limit === undefined || !isFinite(parseFloat(limit))) {
        throw new Error(`--limit needs a numeric price (got ${JSON.stringify(limit)})`);
      }
    }
    const rth = rest.includes("--rth");
    const ei = rest.indexOf("--est-price");
    const estPrice = ei >= 0 ? parseFloat(rest[ei + 1]) : null;
    if (ei >= 0 && !isFinite(estPrice)) {
      throw new Error(`--est-price needs a number (got ${JSON.stringify(rest[ei + 1])})`);
    }

    const closing = rest.includes("--close");
    const out = await placeOrder({ side: cmd, qty, symbol, limit, rth, estPrice, closing });
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  const { client, ...conn } = await connect();
  const { ev } = makeHelpers(conn);
  const out = {};
  if (cmd === "status") {
    out.chart = await ev(`({ url: location.href, title: document.title })`);
    out.tradePanel = await ev(`!!document.querySelector('[data-name="place-and-modify-button"]')`);
    out.broker = await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/Paper Trading/i.test(x.innerText||''));
      return b ? 'Paper Trading' : 'unknown'; })()`);
  } else if (cmd === "account") {
    out.account = await readAccount(ev);
  } else if (cmd === "positions") {
    out.positions = await ev(rowsSql("Paper.positions-table"));
  } else {
    throw new Error(`unknown command: ${cmd}`);
  }
  console.log(JSON.stringify(out, null, 2));
  await client.close();
  process.exit(0);
} catch (err) {
  console.error("error: " + err.message);
  process.exit(1);
}
