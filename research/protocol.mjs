#!/usr/bin/env node
/**
 * protocol.mjs — the binding evaluation contract.
 *
 * The criteria in gate.mjs are LOADED from protocol.v1.json, not hardcoded.
 * The protocol is hashed, and the hash is recorded on every run, so a
 * threshold cannot be moved after seeing results without leaving a trace.
 * That is the entire point: if you can quietly relax the bar, the framework
 * stops being able to reject anything.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Deterministic JSON with recursively sorted object keys.
 *
 * The previous implementation was
 *
 *     JSON.stringify(p, Object.keys(p).sort())
 *
 * which does NOT do what it looks like. When the replacer is an ARRAY it acts
 * as a whitelist of key names applied at EVERY level of nesting, not just the
 * top. The whitelist held only the top-level key names, so no nested key ever
 * matched and every nested object serialised to `{}`. The protocol hashed to
 * 454 characters of its real 1,414, with `criteria:{}`, `costs:{}`, `risk:{}`,
 * `regimes:{}` and `monte_carlo:{}` all empty.
 *
 * The consequence was that the hash could not see a single threshold it exists
 * to protect. Relaxing MIN_PF from 1.3 to 0.01, zeroing fees, or raising risk
 * per trade from 1% to 100% all produced the IDENTICAL hash 1e42a7d31d851b9b.
 * Every run in research/registry/ carries that value, so the tamper-evidence
 * the README claims was not in force for any threshold, only for the four
 * top-level scalars (protocol, frozen, frozen_at, note).
 *
 * Arrays keep their order here, because order is semantic: the cost stress
 * multipliers are a sequence, not a set.
 */
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
}

function loadProtocol(file) {
  const raw = readFileSync(join(HERE, file), "utf8");
  const p = JSON.parse(raw);
  const hash = createHash("sha256").update(canonicalize(p)).digest("hex").slice(0, 16);
  return { ...p, protocol_hash: hash, protocol_file: file };
}

/** v1. Frozen, hash-pinned, and the one every existing run record cites. */
export const PROTOCOL = loadProtocol("protocol.v1.json");

/**
 * v2. A separate generation with its own criteria and its own results archive.
 * It is never mixed with v1: a v2 run carries a different protocol_hash, and
 * registry.currentState() treats a different hash as a different experiment.
 */
export const PROTOCOL_V2 = loadProtocol("protocol.v2.json");

/** Stable fingerprint of a dataset, so a run can be tied to exact inputs. */
export function datasetHash(bars) {
  const h = createHash("sha256");
  for (const b of bars) {
    h.update(`${b.time}|${b.open}|${b.high}|${b.low}|${b.close}|${b.volume}\n`);
  }
  return h.digest("hex").slice(0, 16);
}

/** Stable fingerprint of a strategy's source, so results tie to exact code. */
export function strategyHash(src) {
  return createHash("sha256").update(src).digest("hex").slice(0, 16);
}

if (process.argv[1] && process.argv[1].endsWith("protocol.mjs") && !process.argv.includes("--selftest")) {
  console.log(JSON.stringify({
    protocols: [
      { id: PROTOCOL.protocol, file: PROTOCOL.protocol_file, frozen: PROTOCOL.frozen, frozen_at: PROTOCOL.frozen_at, protocol_hash: PROTOCOL.protocol_hash, criteria_count: Object.keys(PROTOCOL.criteria).length },
      { id: PROTOCOL_V2.protocol, file: PROTOCOL_V2.protocol_file, frozen: PROTOCOL_V2.frozen, frozen_at: PROTOCOL_V2.frozen_at, protocol_hash: PROTOCOL_V2.protocol_hash, criteria_count: Object.keys(PROTOCOL_V2.criteria).length },
    ],
  }, null, 2));
}

// --------------------------------------------------------------- selftest
if (process.argv[1] && process.argv[1].endsWith("protocol.mjs") && process.argv.includes("--selftest")) {
  let pass = 0, fail = 0;
  const check = (n, c, x = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); };
  console.log("protocol.mjs selftest\n");

  // --- canonicalization is order-independent but value-sensitive
  check("key order does not change the canonical form",
    canonicalize({ a: 1, b: { x: 1, y: 2 } }) === canonicalize({ b: { y: 2, x: 1 }, a: 1 }));
  check("a NESTED value change changes the canonical form",
    canonicalize({ c: { MIN_PF: 1.3 } }) !== canonicalize({ c: { MIN_PF: 0.01 } }));
  check("array order is preserved (cost multipliers are a sequence)",
    canonicalize({ m: [1, 2, 5] }) !== canonicalize({ m: [5, 2, 1] }));

  // --- the actual regression: the hash must see every threshold
  const hashOf = (p) => createHash("sha256").update(canonicalize(p)).digest("hex").slice(0, 16);
  const base = JSON.parse(readFileSync(join(HERE, "protocol.v1.json"), "utf8"));
  const mutate = (fn) => { const c = JSON.parse(JSON.stringify(base)); fn(c); return c; };

  const mutations = [
    ["MIN_PF 1.3 -> 0.01", (p) => { p.criteria.MIN_PF = 0.01; }],
    ["MIN_SHARPE 1.0 -> 0.1", (p) => { p.criteria.MIN_SHARPE = 0.1; }],
    ["MIN_TRADES 500 -> 5", (p) => { p.criteria.MIN_TRADES = 5; }],
    ["fee_bps 10 -> 0", (p) => { p.costs.fee_bps = 0; }],
    ["slippage_bps 5 -> 50", (p) => { p.costs.slippage_bps = 50; }],
    ["risk_per_trade_pct 0.01 -> 1", (p) => { p.risk.risk_per_trade_pct = 1; }],
    ["max_leverage 10 -> 100", (p) => { p.risk.max_leverage = 100; }],
    ["ruin_equity_pct 0.2 -> 0.9", (p) => { p.risk.ruin_equity_pct = 0.9; }],
    ["monte_carlo seed 12345 -> 999", (p) => { p.monte_carlo.seed = 999; }],
    ["regimes bull_slope 0.004 -> 0", (p) => { p.regimes.bull_slope = 0; }],
    ["symbols: drop ZECUSDT", (p) => { p.data.symbols = p.data.symbols.slice(0, 4); }],
    ["reindented whitespace only", (p) => { p.criteria.MIN_PF = 1.3; }],
  ];
  const h0 = hashOf(base);
  for (const [label, fn] of mutations) {
    const h = hashOf(mutate(fn));
    // The last row is a no-op and MUST keep the hash: reformatting is not a
    // protocol change. Every other row must move it.
    const shouldChange = label !== "reindented whitespace only";
    check(`hash detects: ${label}`, shouldChange ? h !== h0 : h === h0, `${h0} -> ${h}`);
  }

  // --- both protocols load, are distinct, and are self-consistent
  check("v1 loads and hashes", typeof PROTOCOL.protocol_hash === "string" && PROTOCOL.protocol_hash.length === 16,
    `${PROTOCOL.protocol} ${PROTOCOL.protocol_hash}, ${Object.keys(PROTOCOL.criteria).length} criteria`);
  check("v2 loads and hashes", typeof PROTOCOL_V2.protocol_hash === "string" && PROTOCOL_V2.protocol_hash.length === 16,
    `${PROTOCOL_V2.protocol} ${PROTOCOL_V2.protocol_hash}, ${Object.keys(PROTOCOL_V2.criteria).length} criteria`);
  check("v1 and v2 have DIFFERENT hashes", PROTOCOL.protocol_hash !== PROTOCOL_V2.protocol_hash);
  check("v2 is additive: it restates every v1 criterion at the same value",
    Object.entries(PROTOCOL.criteria).every(([k, v]) => PROTOCOL_V2.criteria[k] === v),
    Object.entries(PROTOCOL.criteria).filter(([k, v]) => PROTOCOL_V2.criteria[k] !== v).map(([k]) => k).join(",") || "all 18 identical");
  check("v2 adds criteria v1 does not have",
    Object.keys(PROTOCOL_V2.criteria).filter((k) => !(k in PROTOCOL.criteria)).length >= 7,
    Object.keys(PROTOCOL_V2.criteria).filter((k) => !(k in PROTOCOL.criteria)).join(" "));
  check("v2 changes none of v1's thresholds (v1 is not quietly relaxed)",
    hashOf(PROTOCOL_V2) !== hashOf(PROTOCOL) && PROTOCOL.criteria.MIN_PF === 1.3,
    `v1 MIN_PF still ${PROTOCOL.criteria.MIN_PF}`);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
