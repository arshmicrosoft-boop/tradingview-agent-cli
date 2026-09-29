// Adversarial tests for protocol binding. Run: node research/experiment.mjs --test
//
// The claim under test: "the same protocol_hash implies the same experiment."
// Before this module, it did not — the protocol hashed fields the pipeline never
// read, while the experiment was defined by literals in evidence.mjs, harness.mjs
// and gate.mjs, and by CLI flags.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveExperiment, experimentFromProtocol, simCfgFromExperiment,
  experimentFingerprint, parseArgv,
} from "./experiment.mjs";
import { canonicalize, PROTOCOL } from "./protocol.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const raw = () => JSON.parse(readFileSync(join(HERE, "protocol.v1.json"), "utf8"));
const hashOf = (p) => createHash("sha256").update(canonicalize(p)).digest("hex").slice(0, 16);
let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  :: " + extra : ""}`);
};

// --- TEST 1: the protocol/code mismatch, both directions -------------------
// 1a. Editing the protocol moves the hash, so two different experiments can
//     never share an identity.
{
  const before = hashOf(raw());
  const m1 = raw(); m1.risk.risk_per_trade_pct = 0.05;
  const m2 = raw(); m2.costs.fee_bps = 0;
  const m3 = raw(); m3.data.symbols = m3.data.symbols.slice(0, 3);
  const m4 = raw(); m4.data.as_of = "2026-01-01T00:00:00Z";
  const m5 = raw(); m5.regimes.bull_slope = 0.02;
  check("TEST 1a editing risk_per_trade_pct moves the hash", hashOf(m1) !== before);
  check("       editing fee_bps moves the hash", hashOf(m2) !== before);
  check("       dropping a symbol moves the hash", hashOf(m3) !== before);
  check("       moving the data window (as_of) moves the hash", hashOf(m4) !== before);
  check("       editing a regime threshold moves the hash", hashOf(m5) !== before);
  // Formatting must NOT move it, or the hash would be noise.
  const reordered = { regimes: raw().regimes, ...raw() };
  check("       key reordering does NOT move the hash (not noise)", hashOf(reordered) === before);
}

// 1b. The resolved experiment is a pure function of the protocol: no literal in
//     the codebase can change a result without moving the hash.
{
  const x = experimentFromProtocol(PROTOCOL);
  const y = experimentFromProtocol(PROTOCOL);
  check("TEST 1b resolution is deterministic", experimentFingerprint(x) === experimentFingerprint(y));
  check("       every protocol field survives into the experiment",
    x.symbols.length === PROTOCOL.data.symbols.length
    && x.riskPct === PROTOCOL.risk.risk_per_trade_pct
    && x.feeBps === PROTOCOL.costs.fee_bps
    && x.warmup === PROTOCOL.split.warmup_bars
    && x.maxHoldBars === PROTOCOL.risk.max_hold_bars
    && x.as_of === PROTOCOL.data.as_of
    && x.bullSlope === PROTOCOL.regimes.bull_slope);
  check("       the data window is now a protocol value, not a default arg",
    typeof PROTOCOL.data.as_of === "string" && PROTOCOL.data.as_of.length > 0);
  // The two fields where harness DEFAULTS used to disagree with the protocol.
  check("       DEFAULTS no longer contradicts the protocol on warmup/hold",
    simCfgFromExperiment(x).warmup === PROTOCOL.split.warmup_bars
    && simCfgFromExperiment(x).maxHoldBars === PROTOCOL.risk.max_hold_bars);
}

// --- TEST 2: the CLI override attack ---------------------------------------
// The headline failure: `--equity 999999` used to produce a different book
// under the same hash. It must now be refused.
{
  const attacks = [
    ["--equity", "999999"], ["--equity", "1"], ["--risk", "0.5"], ["--risk", "2"],
    ["--hold", "4"], ["--tf", "1d"], ["--days", "30"], ["--to", "2020-01-01T00:00:00Z"],
    ["--fee-bps", "0"], ["--slippage-bps", "0"], ["--leverage", "50"],
    ["--stop", "0"], ["--atr", "2"], ["--mc-runs", "1"], ["--mc-seed", "1"],
  ];
  let refused = 0;
  const detail = [];
  for (const [flag, val] of attacks) {
    try { resolveExperiment([flag, val]); detail.push(`${flag}=${val} ACCEPTED`); }
    catch (e) { if (e.code === "PROTOCOL_MISMATCH") refused++; else detail.push(`${flag} wrong error`); }
  }
  check("TEST 2 every parameter override is refused", refused === attacks.length,
        `${refused}/${attacks.length} refused` + (detail.length ? ` :: ${detail.join(", ")}` : ""));

  // And it must be refused with an actionable message, not a stack trace.
  try { resolveExperiment(["--risk", "2"]); check("       (no throw — BUG)", false); }
  catch (e) {
    check("       the refusal names the flag and the protocol value",
      e.message.includes("--risk=2") && e.message.includes("0.01"), e.message.split("\n")[1]?.trim().slice(0, 70));
    check("       the refusal explains how to run a different experiment",
      /edit research\/protocol\.v1\.json/.test(e.message) && /protocol_hash/.test(e.message));
  }

  // Reproducing a protocol value exactly is allowed — that is legitimate.
  let ok = true, why = "";
  try { resolveExperiment(["--equity", String(PROTOCOL.risk.equity), "--risk", String(PROTOCOL.risk.risk_per_trade_pct)]); }
  catch (e) { ok = false; why = e.message.split("\n")[1]?.trim(); }
  check("       a flag that REPRODUCES the protocol value is allowed", ok, why);

  // Selector flags must not be mistaken for parameters. `--all` is bare (its
  // following token is another flag), while `--strategy X` and `--version 2`
  // legitimately take a value — so classification is "is it a selector name",
  // not "did it carry a value".
  const sel = parseArgv(["--all", "--strategy", "sma-cross", "--version", "2"]);
  const names = new Set([...sel.bare, ...sel.values.keys()]);
  check("       selector flags are classified as selectors, not parameters",
    names.has("--all") && names.has("--strategy") && names.has("--version")
    && !names.has("--risk") && !names.has("--equity"));
  let selOk = true, selWhy = "";
  try { resolveExperiment(["--all", "--strategy", "sma-cross", "--version", "2"]); }
  catch (e) { selOk = false; selWhy = e.message.split("\n")[1]?.trim().slice(0, 60); }
  check("       --all / --strategy / --version are accepted", selOk, selWhy);

  // An unknown flag is refused rather than ignored: a flag the code does not
  // understand could change the experiment.
  let unknownRefused = false;
  try { resolveExperiment(["--leverage-boost", "3"]); } catch (e) { unknownRefused = e.code === "PROTOCOL_MISMATCH"; }
  check("       an UNKNOWN flag is refused, not ignored", unknownRefused);
}

// --- TEST 3: the literal-drift test ----------------------------------------
// The failure mode: someone hardcodes a value in code that the protocol also
// states, they disagree, and nothing notices. The defence is that the code
// READS the protocol, so there is no second copy to drift.
{
  // No experiment parameter may be a bare numeric literal in the consumers.
  // The check targets the executable path, not the selftest block. A selftest
  // that deliberately runs a cost-free or short-hold simulation is stating a
  // fixture, not defining the experiment — those live below the selftest
  // banner, so they are excluded. Flagging them would be flagging the tests
  // that prove the parameters are honoured.
  const consumers = ["evidence.mjs", "harness.mjs", "gate.mjs", "run.mjs", "run-v2.mjs"];
  const banned = [
    [/riskPct:\s*0\.\d/, "riskPct literal"],
    [/feeBps:\s*\d+/, "feeBps literal"],
    [/slippageBps:\s*\d+/, "slippageBps literal"],
    [/maxHoldBars:\s*\d+/, "maxHoldBars literal"],
    [/trendLen\s*=\s*\d+/, "trendLen literal"],
    [/bullSlope\s*=\s*0\.\d+/, "bullSlope literal"],
    [/SYMBOLS\s*=\s*\[["']/, "SYMBOLS array literal"],
  ];
  const hits = [];
  for (const file of consumers) {
    let src;
    try { src = readFileSync(join(HERE, file), "utf8"); } catch { continue; }
    const lines = src.split("\n");
    // Everything after the selftest banner is test code; before it is the module.
    const selftestAt = lines.findIndex((l) => /^\/\/ -+ selftest/.test(l));
    const module_ = (selftestAt >= 0 ? lines.slice(0, selftestAt) : lines)
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))   // drop comment-only lines
      .join("\n");
    for (const [rx, what] of banned) {
      if (rx.test(module_)) hits.push(`${file}: ${what}`);
    }
  }
  check("TEST 3 no experiment parameter is hardcoded outside the selftests", hits.length === 0,
        hits.length ? hits.join("; ") : `${consumers.length} modules scanned, selftest blocks excluded`);

  // harness DEFAULTS must be a projection of the protocol, not a copy of it.
  const hsrc = readFileSync(join(HERE, "harness.mjs"), "utf8");
  const defaultsBlock = hsrc.slice(hsrc.indexOf("const DEFAULTS"), hsrc.indexOf("const DEFAULTS") + 900);
  check("       harness DEFAULTS assigns no bare numeric literal",
    !/\b(equity|riskPct|stopAtrMult|atrPeriod|leverage|feeBps|slippageBps|maxHoldBars|warmup):\s*\d/.test(defaultsBlock),
    defaultsBlock.match(/\b(equity|riskPct|feeBps|maxHoldBars|warmup):\s*[^,\n]+/g)?.join(" ") ?? "");

  // And the direction that matters: the consumers must actually import it.
  const ev = readFileSync(join(HERE, "evidence.mjs"), "utf8");
  check("       evidence.mjs imports the experiment resolver", /from "\.\/experiment\.mjs"/.test(ev));
  const ha = readFileSync(join(HERE, "harness.mjs"), "utf8");
  check("       harness.mjs DEFAULTS derives from the protocol", /experimentFromProtocol\(\)/.test(ha));
  const ga = readFileSync(join(HERE, "gate.mjs"), "utf8");
  check("       gate.mjs regime defaults derive from the protocol", /experimentFromProtocol\(\)/.test(ga));
}

// --- TEST 4: the record states what was actually run ------------------------
// A protocol hash is a claim; the fingerprint is the evidence.
{
  const x = experimentFromProtocol(PROTOCOL);
  const fp = experimentFingerprint(x);
  check("TEST 4 the experiment fingerprint is stable", fp === experimentFingerprint(experimentFromProtocol(PROTOCOL)));
  check("       a changed risk value changes the fingerprint",
    experimentFingerprint({ ...x, riskPct: 0.05 }) !== fp);
  check("       a changed symbol list changes the fingerprint",
    experimentFingerprint({ ...x, symbols: x.symbols.slice(0, 3) }) !== fp);
  check("       a changed data window changes the fingerprint",
    experimentFingerprint({ ...x, as_of: "2020-01-01T00:00:00Z" }) !== fp);
  check("       a changed fee changes the fingerprint",
    experimentFingerprint({ ...x, feeBps: 0 }) !== fp);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
