#!/usr/bin/env node
/**
 * verify.mjs — one command to prove the repo is in a known-good state.
 *
 * Runs every layer's selftest AND enforces the architectural invariant that
 * makes the whole separation meaningful:
 *
 *     research/  must never import execution/
 *
 * Without that check, the "research cannot place orders" claim is just a
 * comment. With it, it is enforced.
 */

import { readdirSync, readFileSync, statSync, mkdirSync, openSync, closeSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (n, c, x = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); };

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "data" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(mjs|js)$/.test(e)) out.push(p);
  }
  return out;
}

console.log("=== layer selftests ===\n");
const suites = [
  ["research/data.mjs",       "data"],
  ["research/risk-engine.mjs","risk engine"],
  ["research/harness.mjs",    "harness"],
  ["research/gate.mjs",       "gate"],
  ["research/gate-v2.mjs",    "gate v2"],
  ["research/robustness.mjs", "robustness"],
  ["research/protocol.mjs",   "protocol", ["--selftest"]],
  ["research/registry.mjs",   "registry", ["--selftest"]],
  ["research/leakage.mjs",    "leakage"],
  ["research/controls.mjs",   "negative controls"],
  ["strategies/validate.mjs", "strategy cards"],
];
for (const [file, label, extra = []] of suites) {
  try {
    const out = execFileSync("node", [join(ROOT, file), ...extra], { encoding: "utf8", timeout: 120000 });
    // Take the LAST summary, not the first: a suite that prints its own banner
    // containing "N passed, M failed" would otherwise be judged on the banner.
    const all = [...out.matchAll(/(\d+) passed, (\d+) failed/g)];
    const m = all.length ? all[all.length - 1] : null;
    // A suite that runs ZERO checks is not a pass. `m && m[2] === "0"` reported
    // "0 passed, 0 failed" as green, which is indistinguishable from a suite
    // that never ran its assertions.
    check(`${label} selftest`, !!m && m[2] === "0" && +m[1] > 0,
      m ? (+m[1] === 0 ? "ran 0 checks" : `${m[1]}/${+m[1] + +m[2]}`) : out.slice(-80));
  } catch (e) {
    check(`${label} selftest`, false, (e.stdout || e.message || "").toString().slice(-100));
  }
}
try {
  const out = execFileSync("node", [join(ROOT, "execution", "paper-trade.mjs"), "selftest"], { encoding: "utf8", timeout: 120000 });
  const m = out.match(/(\d+) passed, (\d+) failed/);
  check("execution risk gate selftest", m && m[2] === "0", m ? `${m[1]}/${+m[1] + +m[2]}` : "");
} catch (e) {
  check("execution risk gate selftest", false, (e.message || "").slice(-100));
}

console.log("\n=== architectural invariants ===\n");

const researchFiles = walk(join(ROOT, "research"));
const offenders = [];
for (const f of researchFiles) {
  const src = readFileSync(f, "utf8");
  const re = /(?:^|\n)\s*(?:import[^'"]*from\s*|import\s*\(\s*)["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1];
    if (spec.includes("execution") || spec.includes("paper-trade") || spec.includes("launch-tv")) {
      offenders.push(`${relative(ROOT, f)} -> ${spec}`);
    }
  }
}
check("research/ never imports execution/", offenders.length === 0, offenders.join("; "));

// The execution layer must depend on the research layer, never the reverse.
const execFiles = walk(join(ROOT, "execution"));
const execUsesResearch = execFiles.some((f) => readFileSync(f, "utf8").includes("../research/"));
check("execution/ may import research/ (shares the risk engine)", execUsesResearch);

// No research file may reach a TradingView surface.
const tvReach = researchFiles.filter((f) => {
  const src = readFileSync(f, "utf8");
  return /tv\.cmd|remote-debugging-port|:9222|chrome-remote-interface/.test(src);
});
check("research/ cannot reach TradingView", tvReach.length === 0,
      tvReach.map((f) => relative(ROOT, f)).join("; "));

// Config and audit must exist where both layers expect them.
// audit.jsonl is append-only runtime state and is not tracked in git, so a
// fresh clone has none. Create it rather than failing a clean setup.
for (const p of ["config", "config/risk.json", "research/strategies", "execution/launch-tv.ps1"]) {
  try { statSync(join(ROOT, p)); check(`exists: ${p}`, true); }
  catch { check(`exists: ${p}`, false); }
}
const auditPath = join(ROOT, "config", "audit.jsonl");
if (!existsSync(auditPath)) {
  mkdirSync(dirname(auditPath), { recursive: true });
  closeSync(openSync(auditPath, "a"));
  console.log("  (created config/audit.jsonl — git-ignored runtime state)");
}
check("config/audit.jsonl writable", (() => {
  try { closeSync(openSync(auditPath, "a")); return true; } catch { return false; }
})());

// Every strategy must be loadable and export a function.
const stratDir = join(ROOT, "research", "strategies");
const bad = [];
for (const f of readdirSync(stratDir).filter((x) => x.endsWith(".mjs"))) {
  try {
    const mod = await import(pathToFileURL(join(stratDir, f)).href);
    if (typeof mod.default !== "function") bad.push(`${f}: default export is not a function`);
  } catch (e) { bad.push(`${f}: ${e.message.slice(0, 60)}`); }
}
check("every strategy exports a signal function", bad.length === 0, bad.join("; "));

// The v2 results archive must stay separate. If a v2 run could end up in the v1
// leaderboard, "best challenger" would rank numbers produced under two
// different frozen protocols, which is not a comparison.
// A record is well-formed only if `ts` is a string that round-trips through
// Date — i.e. it really is the `new Date().toISOString()` that registry.record
// stamps, not a number, not a locale string, not an invented value. Comparing
// to the re-serialised form rejects all of those in one test.
const isIsoTs = (v) => typeof v === "string" && v !== ""
  && !Number.isNaN(new Date(v).getTime()) && new Date(v).toISOString() === v;
const present = (v) => typeof v === "string" && v.trim() !== "";

// Reads one archive directory into records plus a parallel array of
// "<dir>:line" locations, so a failing check can name the offending record
// instead of only counting. The location is NOT attached to the record: these
// objects are the ones the hash checks below read, and they should stay
// exactly the bytes the archive holds.
const loadArchive = (archiveName) => {
  const dir = join(ROOT, "research", archiveName);
  const recs = [], at = [];
  for (const e of readdirSync(dir)) {
    const f = join(dir, e, "runs.jsonl");
    if (!existsSync(f)) continue;
    readFileSync(f, "utf8").split("\n").filter(Boolean)
      .forEach((l, i) => { recs.push(JSON.parse(l)); at.push(e + ":" + (i + 1)); });
  }
  return { recs, at };
};

// Deterministic latest-per-strategy selection.
//
// The earlier form was `if (!cur || r.ts > cur.ts)`, which has two degenerate
// shapes. A record with a MISSING or unparseable `ts` never wins the `>` and is
// therefore never selected as latest, so a hand-appended record escapes the
// per-strategy hash check entirely; and two records that tie on `ts` resolve to
// whichever was read first, which is directory order rather than evidence. Both
// are silent passes on tampered input.
//
// This version makes the choice total and reproducible: the newest `ts` wins,
// and a tie is broken by archive position (a later line is a later append), so
// the result never depends on readdir order. A tie is still not evidence of
// anything, so it is reported by the well-formedness check below rather than
// quietly resolved in favour of one record.
const latestPerStrategy = (recs) => {
  const by = new Map();
  recs.forEach((r, i) => {
    const cur = by.get(r.strategy_id);
    const newer = !cur
      || (isIsoTs(r.ts) && isIsoTs(cur.ts)
          ? r.ts > cur.ts || (r.ts === cur.ts && i > cur.i)
          : i > cur.i);
    if (newer) by.set(r.strategy_id, { ...r, i });
  });
  return by;
};

// The v1 archive-integrity checks must run UNCONDITIONALLY. They were previously
// nested inside `if (existsSync(v2Archive)) { ... }`, so deleting (or renaming, or
// failing to clone) research/registry-v2/ silently skipped every check in this
// block — the v1 latest-hash check, the superseded-retention check, and the
// ts/strategy_id tamper-evidence check all disappeared, and `verify` exited 0 on
// a fully tampered v1 archive. The v2 checks below are now gated on v2's own
// presence; the v1 checks are not gated on anything.
const v2Archive = join(ROOT, "research", "registry-v2");
const v2Present = existsSync(v2Archive);
const v2Loaded = v2Present ? loadArchive("registry-v2") : { recs: [], at: [] };
const v2Runs = v2Loaded.recs;
const { PROTOCOL, PROTOCOL_V2 } = await import(pathToFileURL(join(ROOT, "research", "protocol.mjs")).href);
  // Same rule as the v1 check below, applied to v2: the LATEST v2 run per
  // strategy must cite the current v2 hash, and no v2 run may carry the v1
  // hash. Older v2 records are allowed to cite older v2 hashes — a re-run
  // appends, so the archive is the trail of what was actually measured.
  //
  // The previous form was `v2Runs.every((r) => r.protocol_hash ===
  // PROTOCOL_V2.protocol_hash)`, which demands EVERY retained record carry the
  // CURRENT v2 hash. That can never pass once any history exists: the 11 runs
  // archived 2026-09-27 legitimately cite the older v2 hash
  // 38af9ecab50361fa, so a fully-correct re-run still failed this check. The
  // v1 side of this file had already been fixed to the latest-per-strategy
  // rule; this brings v2 in line. The old detail string also printed
  // PROTOCOL_V2.protocol_hash unconditionally, so it read "all on <current>"
  // even when the archive disagreed — which is why the failure was confusing.
  const v2ByStrategy = latestPerStrategy(v2Runs);
  const v2Stale = [...v2ByStrategy.values()].filter((r) => r.protocol_hash !== PROTOCOL_V2.protocol_hash);
  const v2CarriesV1 = v2Runs.filter((r) => r.protocol_hash === PROTOCOL.protocol_hash);
  if (v2Present) {
    check("v2 runs never carry the v1 protocol hash; latest v2 run per strategy cites the current v2 hash",
      v2Runs.length === 0 || (v2CarriesV1.length === 0 && v2Stale.length === 0),
      v2CarriesV1.length ? `${v2CarriesV1.length} v2 record(s) wrongly carry the v1 hash`
        : v2Stale.length ? `${v2Stale.map((r) => r.strategy_id).join(", ")} - re-run npm run research:all:v2`
        : `${v2ByStrategy.size} strategies current, ${v2Runs.length} total v2 records in the archive`);
  }
  check("v1 and v2 protocol hashes are distinct",
    PROTOCOL.protocol_hash !== PROTOCOL_V2.protocol_hash,
    `v1 ${PROTOCOL.protocol_hash} / v2 ${PROTOCOL_V2.protocol_hash}`);
  const v1Loaded = loadArchive("registry");
  const v1Runs = v1Loaded.recs;
  // The LATEST run per strategy must cite the current hash. Older records are
  // allowed to cite older hashes, and should be: a re-run appends rather than
  // overwrites, so the archive is the trail of what was actually measured and
  // when. Pruning stale records because a hash function was corrected would
  // destroy the evidence the hash exists to provide — the old records are the
  // proof that the old (broken) hash was in use.
  const v1ByStrategy = latestPerStrategy(v1Runs);
  const byStrategy = v1ByStrategy;
  const stale = [...byStrategy.values()].filter((r) => r.protocol_hash !== PROTOCOL.protocol_hash);
  check("the latest v1 run per strategy cites the current v1 protocol hash", stale.length === 0,
    stale.length ? `${stale.map((r) => r.strategy_id).join(", ")} — re-run npm run research:all`
                 : `${byStrategy.size} strategies current, ${v1Runs.length} total records in the archive`);
  const superseded = v1Runs.length - byStrategy.size;
  // `>= 0` on a difference of two counts is a tautology and can never fail —
  // the same defect that was removed from harness.mjs in this changeset. The
  // real invariant is that history exists at all, i.e. at least one superseded
  // record is still on file.
  check("superseded v1 runs are retained, not overwritten", superseded > 0,
    superseded > 0
      ? `${superseded} historical record(s) kept alongside the current ones`
      : "every v1 record cites the current hash — history has been overwritten, which is what a rewrite would look like");

  // The tamper-evidence the hash checks above rest on. Those checks decide which
  // record is "the latest run per strategy" and then assert that record cites
  // the current hash. A hand-edited or hand-appended record is only caught if
  // it actually gets selected — so selection is only sound if every record
  // carries a usable `ts` and `strategy_id`. Neither is a formality:
  //
  //   - a record with a missing or unparseable `ts` loses the `>` comparison
  //     and is never selected, so its protocol_hash is never examined at all;
  //   - a record with no `strategy_id` is filed under `undefined` and compared
  //     against every other unfiled record rather than against its own history;
  //   - two records for one strategy sharing a `ts` make "latest" a coin flip,
  //     so the archive no longer says what order things happened in.
  //
  // `registry.record` always stamps `new Date().toISOString()` and a real
  // strategy_id, so none of this is reachable through the normal writer. It is
  // reachable by hand, which is precisely the case a tamper-evidence check
  // exists for: this must FAIL LOUDLY on malformed input, not quietly pass.
  const malformed = [];
  const ambiguous = [];
  for (const [label, { recs, at }] of [["v1", v1Loaded], ["v2", v2Loaded]]) {
    const seen = new Map();
    recs.forEach((r, i) => {
      const where = at[i];
      if (!isIsoTs(r.ts)) malformed.push(`${label} ${where} ts=${JSON.stringify(r.ts)}`);
      if (!present(r.strategy_id)) malformed.push(`${label} ${where} strategy_id=${JSON.stringify(r.strategy_id)}`);
      if (isIsoTs(r.ts) && present(r.strategy_id)) {
        const k = r.strategy_id + "|" + r.ts;
        if (seen.has(k)) ambiguous.push(`${label} ${r.strategy_id} ts=${r.ts} (${seen.get(k)} and ${where})`);
        else seen.set(k, where);
      }
    });
  }
  check("every archived v1 and v2 record has a parseable ISO-8601 ts and a strategy_id, with no per-strategy ts ties",
    malformed.length === 0 && ambiguous.length === 0,
    malformed.length
      ? `${malformed.length} malformed record(s): ${malformed.slice(0, 3).join("; ")}${malformed.length > 3 ? " ..." : ""}`
      : ambiguous.length
      ? `${ambiguous.length} ambiguous ts tie(s): ${ambiguous.slice(0, 3).join("; ")}${ambiguous.length > 3 ? " ..." : ""}`
      : `${v1Runs.length + v2Runs.length} records (${v1Runs.length} v1 + ${v2Runs.length} v2) carry a well-formed ts and strategy_id`);

// A run that silently skipped its own archive checks must never report green.
// The v1 checks above are deliberately un-gated, so this is a standing
// assertion that the block executed and found a non-empty v1 archive to check —
// the exact condition that a deleted/misnamed registry/ would violate.
check("archive-integrity checks actually ran against a non-empty v1 archive",
  v1Runs.length > 0 && v1ByStrategy.size > 0,
  v1Runs.length === 0 ? "v1 archive is EMPTY — no integrity check could have run" : `${v1Runs.length} v1 records across ${v1ByStrategy.size} strategies`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
