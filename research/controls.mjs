/**
 * controls.mjs — the meta-test.
 *
 * A backtest harness that accepts a random number generator is worthless, and
 * you cannot know yours is worthless by reading its output. You know by trying
 * to break it.
 *
 * This asserts the invariant:
 *   NO NEGATIVE CONTROL MAY EVER PASS THE GATE.
 *
 * A control is a strategy with no possible edge: seeded pseudo-random, and
 * unconditional buy-and-hold. If one of these is ever promoted to champion, the
 * gate is defective — not the control.
 *
 * Exits non-zero if a control has ever passed, or if a control is absent from
 * the registry (which would mean the check was never actually exercised).
 */

import { existsSync } from "node:fs";
import { allStrategies, runsFor, currentState } from "./registry.mjs";
import { PROTOCOL } from "./protocol.mjs";

export const CONTROLS = ["_control_random", "_control_alwayslong"];

let failed = 0;
let presentChecks = 0;
function check(name, ok, detail = "") {
  presentChecks++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  :: " + detail : ""}`);
  if (!ok) failed++;
}

export function verifyControls() {
  const known = allStrategies();
  const present = CONTROLS.filter((c) => known.includes(c));
  const absent = CONTROLS.filter((c) => !known.includes(c));

  for (const c of present) {
    const runs = runsFor(c);
    const anyPass = runs.filter((r) => r.passed);
    check(`control rejected: ${c}`,
      runs.length > 0 && anyPass.length === 0,
      runs.length === 0 ? "no runs recorded — control never exercised"
        : anyPass.length ? `${anyPass.length}/${runs.length} runs PASSED the gate — GATE IS BROKEN`
        : `${runs.length}/${runs.length} runs rejected`);

    // A control should not be *trivially* rejected either. If it never trades,
    // it proves nothing about the gate's ability to reject a real edge claim.
    const traded = runs.filter((r) => Number(r.trades) > 0);
    check(`control actually traded (not vacuously rejected): ${c}`,
      traded.length > 0,
      traded.length ? `${traded.length} runs with trades` : "control never traded — vacuous test");
  }
  for (const c of absent) {
    check(`control present in registry: ${c}`, false, "never run — run `node research/run.mjs --strategy " + c + " --tf 15m`");
  }

  const state = currentState(PROTOCOL.protocol_hash);
  const championIsControl = state.champion && CONTROLS.includes(state.champion.strategy_id);
  check("champion is not a negative control", !championIsControl,
    state.champion ? `champion is ${state.champion.strategy_id}` : "no champion yet");

  return failed;
}

if (process.argv[1] && process.argv[1].endsWith("controls.mjs")) {
  console.log("negative controls (meta-test: the gate must reject nonsense)\n");
  const f = verifyControls();
  const total = presentChecks;
  console.log(`\n${total - f} passed, ${f} failed`);
  console.log(f === 0
    ? "  controls held: the gate rejects strategies that cannot work"
    : "  CONTROL FAILURE: the gate accepted a strategy with no possible edge");
  process.exit(f === 0 ? 0 : 1);
}
