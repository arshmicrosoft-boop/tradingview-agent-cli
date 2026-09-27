#!/usr/bin/env node
/**
 * data.mjs — historical OHLCV providers with an on-disk cache.
 *
 * WHY THIS EXISTS
 * TradingView's MCP caps history at 300 bars per read (299 days on D, 3 days on
 * 15m). That is enough to smoke-test a harness and nowhere near enough to
 * distinguish edge from noise. So the harness reads from providers that can
 * actually supply history, and treats TradingView as a fallback only.
 *
 * Measured ceilings (2026-09-27):
 *   (tradingview 300 bars D=299d 4h=50d 1h=12d 15m=3d -- too thin, and
 *                deliberately NOT available in this layer)
 *   yahoo        ~1250 bars daily (5y request)                   <- fine
 *   binance      1000 bars/call, pageable via startTime           <- effectively unlimited
 *
 * Bars are normalised to { time, open, high, low, close, volume } with `time`
 * in unix SECONDS, ascending, de-duplicated and gap-audited.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, "data");

const TF = { "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
             "1h": 3600, "4h": 14400, "1d": 86400 };

async function getJson(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 25000);
      const res = await fetch(url, { signal: ac.signal, headers: { "User-Agent": "Mozilla/5.0" } });
      clearTimeout(to);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 800 * (i + 1))); }
  }
  throw new Error(`fetch failed ${url}: ${lastErr?.message}`);
}

// --------------------------------------------------------------- providers

/** Binance public klines. Pageable via startTime/endTime. No API key. */
async function binance(symbol, tf, { limit = 5000, from, to } = {}) {
  const pair = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!pair.endsWith("USDT")) pair += "USDT";
  const interval = tf;
  const out = [];
  let start = from ?? null;
  const endMs = to != null ? to * 1000 : null;

  // Binance caps one klines call at 1000 rows; page forward through the range.
  const wantPages = Math.max(1, Math.ceil(limit / 1000));
  for (let page = 0; page < wantPages; page++) {
    let url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=1000`;
    if (start != null) url += `&startTime=${Math.floor(start * 1000)}`;
    if (endMs != null) url += `&endTime=${endMs}`;
    const rows = await getJson(url);
    if (!rows.length) break;
    for (const r of rows) {
      out.push({ time: Math.floor(r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] });
    }
    const lastSec = Math.floor(rows[rows.length - 1][0] / 1000);
    if (rows.length < 1000) break;
    if (endMs != null && lastSec * 1000 >= endMs) break;
    start = lastSec + 1;                    // move forward, page by page
  }
  return { symbol: pair, bars: out, provider: "binance" };
}

/** Yahoo Finance chart API. Free, no key. Good for equities, ~5y daily. */
async function yahoo(symbol, tf) {
  const range = tf === "1d" ? "5y" : tf === "1wk" ? "10y" : "60d";
  const interval = tf === "1d" ? "1d" : tf === "1wk" ? "1wk" : "1m";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
              `?range=${range}&interval=${interval}`;
  const j = await getJson(url);
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(`yahoo returned no data for ${symbol}: ${JSON.stringify(j).slice(0, 200)}`);
  const q = res.indicators.quote[0];
  const bars = [];
  res.timestamp.forEach((t, i) => {
    if (q.close[i] == null) return;                 // holiday / missing row
    bars.push({ time: t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] ?? 0 });
  });
  return { symbol: res.meta.symbol, bars, provider: "yahoo" };
}

// NOTE: there is deliberately no TradingView provider in this layer.
//
// TradingView via the MCP CLI is capped at 300 bars (299d on D, 3d on 15m),
// which cannot support research, and letting this layer reach the app would
// break the "research cannot touch TradingView" invariant enforced by
// verify.mjs. Chart data for the eyes belongs in execution/ instead.

// --------------------------------------------------------------- hygiene

function normalise(bars, tf) {
  const step = TF[tf] ?? 86400;
  const seen = new Map();
  for (const b of bars) {
    if (!Number.isFinite(b.close) || b.close <= 0) continue;
    if (b.high == null || b.low == null) continue;
    seen.set(b.time, { time: b.time, open: +b.open, high: +b.high, low: +b.low, close: +b.close, volume: +b.volume || 0 });
  }
  const out = [...seen.values()].sort((a, b) => a.time - b.time);

  // Gap audit — a backtest across unknown gaps silently invents edge.
  const gaps = [];
  for (let i = 1; i < out.length; i++) {
    const d = out[i].time - out[i - 1].time;
    if (d > step * 1.6) gaps.push({ from: out[i - 1].time, to: out[i].time, missing: Math.round(d / step) - 1 });
  }
  return { bars: out, gaps };
}

function audit(bars, gaps, tf) {
  const step = TF[tf] ?? 86400;
  const span = bars.length > 1 ? (bars[bars.length - 1].time - bars[0].time) / 86400 : 0;
  const gapBars = gaps.reduce((a, g) => a + g.missing, 0);
  return {
    bars: bars.length,
    spanDays: Number(span.toFixed(1)),
    from: new Date(bars[0]?.time * 1000 ?? 0).toISOString().slice(0, 10),
    to: new Date(bars[bars.length - 1]?.time * 1000 ?? 0).toISOString().slice(0, 10),
    gaps: gaps.length,
    missingBars: gapBars,
    // Rough trades a swing strategy might produce; the real number comes from
    // the harness, but this is the go/no-go on whether to bother.
    roughTradeCapacity: bars.length > 20 ? Math.floor(bars.length / 5) : 0,
    sufficientForBacktest: bars.length >= 250 && span >= 180,
  };
}

// ------------------------------------------------------------------ API

export async function load({ provider = "binance", symbol, tf = "1d", limit = 5000, cache = true, from, to }) {
  if (!symbol) throw new Error("symbol is required");
  const key = `${provider}-${symbol}-${tf}${from ? `-${from}` : ""}${to ? `-${to}` : ""}`.replace(/[^\w.-]/g, "_");
  const file = join(CACHE, `${key}.json`);

  if (cache && existsSync(file)) {
    try {
      const c = JSON.parse(readFileSync(file, "utf8"));
      return { ...c, fromCache: true };
    } catch { /* fall through and refetch */ }
  }

  const fetchers = { binance, yahoo };
  const fn = fetchers[provider];
  if (!fn) throw new Error(`unknown provider "${provider}" (have: ${Object.keys(fetchers).join(", ")})`);

  const raw = await fn(symbol, tf, { limit, from, to });
  const { bars, gaps } = normalise(raw.bars, tf);
  if (bars.length < 30) throw new Error(`${provider}/${symbol}/${tf}: only ${bars.length} bars`);

  const out = { symbol: raw.symbol, requested: symbol, tf, provider, from, to, bars, gaps, audit: audit(bars, gaps, tf) };
  if (cache) {
    try { if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true }); writeFileSync(file, JSON.stringify(out)); }
    catch { /* cache is an optimisation, not a requirement */ }
  }
  return out;
}

/** Fetch several symbols, tolerating individual failures. */
export async function loadMany({ provider = "binance", symbols, tf = "15m", from, to, limit = 60000, cache = true }) {
  const results = [];
  for (const s of symbols) {
    try {
      const d = await load({ provider, symbol: s, tf, from, to, limit, cache });
      results.push({ ok: true, symbol: d.symbol, audit: d.audit, data: d });
    } catch (e) {
      results.push({ ok: false, symbol: s, error: e.message });
    }
  }
  return results;
}

// --------------------------------------------------------------- selftest
if (process.argv[1] && process.argv[1].endsWith("data.mjs")) {
  let pass = 0, fail = 0;
  const check = (n, c, x = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); };
  console.log("data.mjs selftest (offline checks only — no network)\n");

  const D = 86400, T0 = 1767225600;   // real daily timestamps
  const n = normalise([
    { time: T0 + 3 * D, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
    { time: T0 + 0,      open: 1, high: 2, low: 0.5, close: 1.4, volume: 10 },
    { time: T0 + 1 * D,  open: 1, high: 2, low: 0.5, close: 1.2, volume: 10 },
    { time: T0 + 1 * D,  open: 1, high: 2, low: 0.5, close: 1.2, volume: 10 },   // dupe
    { time: T0 + 9 * D,  open: 1, high: 2, low: 0.5, close: null, volume: 10 },  // null close
  ], "1d");
  check("sorts ascending", n.bars.map((b) => b.time).join(",") === [0, 1, 3].map((d) => T0 + d * D).join(","));
  check("de-duplicates", n.bars.length === 3, `got ${n.bars.length}`);
  check("drops null close", !n.bars.some((b) => b.close == null));
  check("flags a gap", n.gaps.length === 1, `gaps=${n.gaps.length}`);
  // After the null-close bar at T0+9D is dropped, the surviving gap runs
  // T0+1D -> T0+3D, i.e. one missing daily bar.
  check("counts missing bars in a gap", n.gaps[0]?.missing === 1, `missing=${n.gaps[0]?.missing}`);

  const small = audit([{ time: 1767225600 }], [], "1d");
  check("insufficient data is reported as such", small.sufficientForBacktest === false);
  const big = audit(
    Array.from({ length: 400 }, (_, i) => ({ time: 1767225600 + i * 86400 })), [], "1d");
  check("sufficient data is reported as such", big.sufficientForBacktest === true,
        `${big.bars} bars / ${big.spanDays}d`);
  check("audit reports the span", big.spanDays === 399, `${big.spanDays}`);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
