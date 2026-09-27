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
  ["research/leakage.mjs",    "leakage"],
  ["research/controls.mjs",   "negative controls"],
  ["strategies/validate.mjs", "strategy cards"],
];
for (const [file, label] of suites) {
  try {
    const out = execFileSync("node", [join(ROOT, file)], { encoding: "utf8", timeout: 120000 });
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
