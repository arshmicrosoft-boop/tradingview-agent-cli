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
    const m = out.match(/(\d+) passed, (\d+) failed/);
    check(`${label} selftest`, m && m[2] === "0", m ? `${m[1]}/${+m[1] + +m[2]}` : out.slice(-80));
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
const v2Archive = join(ROOT, "research", "registry-v2");
if (existsSync(v2Archive)) {
  const v2Dirs = readdirSync(v2Archive).filter((e) => e !== "state.json");
  const v2Runs = v2Dirs
    .filter((e) => existsSync(join(v2Archive, e, "runs.jsonl")))
    .flatMap((e) => readFileSync(join(v2Archive, e, "runs.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  const { PROTOCOL, PROTOCOL_V2 } = await import(pathToFileURL(join(ROOT, "research", "protocol.mjs")).href);
  check("v2 runs never carry the v1 protocol hash",
    v2Runs.length === 0 || v2Runs.every((r) => r.protocol_hash === PROTOCOL_V2.protocol_hash),
    `${v2Runs.length} v2 runs, all on ${PROTOCOL_V2.protocol_hash}`);
  check("v1 and v2 protocol hashes are distinct",
    PROTOCOL.protocol_hash !== PROTOCOL_V2.protocol_hash,
    `v1 ${PROTOCOL.protocol_hash} / v2 ${PROTOCOL_V2.protocol_hash}`);
  const v1Runs = readdirSync(join(ROOT, "research", "registry"))
    .filter((e) => existsSync(join(ROOT, "research", "registry", e, "runs.jsonl")))
    .flatMap((e) => readFileSync(join(ROOT, "research", "registry", e, "runs.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  // The LATEST run per strategy must cite the current hash. Older records are
  // allowed to cite older hashes, and should be: a re-run appends rather than
  // overwrites, so the archive is the trail of what was actually measured and
  // when. Pruning stale records because a hash function was corrected would
  // destroy the evidence the hash exists to provide — the old records are the
  // proof that the old (broken) hash was in use.
  const byStrategy = new Map();
  for (const r of v1Runs) {
    const cur = byStrategy.get(r.strategy_id);
    if (!cur || r.ts > cur.ts) byStrategy.set(r.strategy_id, r);
  }
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
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
