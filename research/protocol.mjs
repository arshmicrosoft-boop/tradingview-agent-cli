/**
 * protocol.mjs — the binding evaluation contract.
 *
 * The criteria in gate.mjs are LOADED from protocol.v1.json, not hardcoded.
 * The protocol is hashed, and the hash is recorded in every run, so a
 * threshold cannot be moved after seeing results without leaving a trace.
 * That is the entire point: if you can quietly relax the bar, the framework
 * stops being able to reject anything.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function load() {
  const raw = readFileSync(join(HERE, "protocol.v1.json"), "utf8");
  const p = JSON.parse(raw);
  // Hash the semantic content, not the formatting, so reindenting does not
  // masquerade as a protocol change.
  const canonical = JSON.stringify(p, Object.keys(p).sort());
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return { ...p, protocol_hash: hash, protocol_file: "protocol.v1.json" };
}

export const PROTOCOL = load();

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

if (process.argv[1] && process.argv[1].endsWith("protocol.mjs")) {
  console.log(JSON.stringify({
    protocol: PROTOCOL.protocol,
    frozen: PROTOCOL.frozen,
    frozen_at: PROTOCOL.frozen_at,
    protocol_hash: PROTOCOL.protocol_hash,
    criteria_count: Object.keys(PROTOCOL.criteria).length,
  }, null, 2));
}
