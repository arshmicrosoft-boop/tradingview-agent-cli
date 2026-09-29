#!/usr/bin/env node
/**
 * gate-v2.mjs — the second-generation verdict.
 *
 * This file cannot place an order. It imports gate.mjs (pure arithmetic over a
 * metrics bundle) and protocol.mjs. There is no code path to TradingView.
 *
 * WHY A SEPARATE GATE INSTEAD OF EDITING v1
 *
 * v1 is frozen and every card in strategies/ is reconciled against a run made
 * under its hash. Adding a criterion to v1 would change that hash and
 * invalidate all 15 cards. So v2 evaluates the SAME corrected v1 checks (so the
 * two verdicts are comparable on the shared 18) and adds seven robustness
 * criteria on top, reporting the two groups SEPARATELY. A v2 failure is never
 * presentable as a v1 failure, and the 21 v1 criteria keep their meaning.
 *
 * WHAT v2 ADDS, AND WHY EACH ONE IS UNREACHABLE IN v1
 *
 *   anchored walk-forward consistency / efficiency / fold Sharpe
 *       v1's fold count never re-optimises parameters, so it cannot see a
 *       strategy that is only right for the average of the sample.
 *   bootstrap P(profitable) / P(Sharpe > 0)
 *       v1's Monte Carlo reshuffles a fixed P&L set, and the sum of a fixed
 *       P&L set is a constant. It measures the path and structurally cannot
 *       reach expectancy, profit factor or Sharpe.
 *   deflated Sharpe
 *       Neither v1 nor v2 asks "how large a Sharpe does pure luck produce when
 *       you take the best of N?" This repo has tried 15 cards; the best profit
 *       factor is 1.013. Without the correction, that reads exactly like an edge.
 *   P(drawdown breach) under fill and size error
 *       v1's cost stress scales costs deterministically. This asks the
 *       different question: what if my fills are worse than modelled, randomly,
 *       on some trades?
 */

import { evaluateGate } from "./gate.mjs";
import { PROTOCOL_V2 } from "./protocol.mjs";

export const CRITERIA_V2 = PROTOCOL_V2.criteria;

const fmt = (x, d = 2) => (x == null ? "n/a" : typeof x === "number" ? Number(x.toFixed(d)) : x);

/**
 * The seven v2 criteria. Kept separate from gate.mjs so the two generations
 * never share a code path, and so a mistake here cannot loosen v1.
 */
export function evaluateRobustness({ wf, mc, dsr, fill }) {
  const C = CRITERIA_V2;
  const checks = [
    ["anchored walk-forward consistency %", fmt(wf?.consistency, 1), `>= ${C.MIN_WF_CONSISTENCY}`,
      (wf?.consistency ?? 0) >= C.MIN_WF_CONSISTENCY],
    // Without this, a strategy that goes silent out of sample scores 100%
    // consistency across the folds that did fire and clears the walk-forward
    // tests with perfect marks. Verified: a signal silent for the final 37% of
    // the sample reported consistency 100, meanOosSharpe 2.72, efficiency 1.31.
    ["walk-forward fold coverage %", fmt(wf?.foldCoverage, 1), `>= ${C.MIN_WF_COVERAGE}`,
      (wf?.foldCoverage ?? 0) >= C.MIN_WF_COVERAGE],
    ["OOS/IS efficiency ratio",
      wf?.efficiencyRatio == null ? (wf?.efficiencyNote ?? "n/a") : fmt(wf.efficiencyRatio, 3),
      `>= ${C.MIN_WF_EFFICIENCY}`,
      (wf?.efficiencyRatio ?? -99) >= C.MIN_WF_EFFICIENCY],
    ["mean OOS fold Sharpe", fmt(wf?.meanOosSharpe, 3), `>= ${C.MIN_WF_FOLD_SHARPE}`,
      (wf?.meanOosSharpe ?? -99) >= C.MIN_WF_FOLD_SHARPE],
    ["bootstrap P(profitable) %", fmt(mc?.pProfitable, 1), `>= ${C.MIN_MC_PROFITABLE * 100}`,
      (mc?.pProfitable ?? -99) >= C.MIN_MC_PROFITABLE * 100],
    ["bootstrap P(Sharpe > 0) %", fmt(mc?.pSharpePositive, 1), `>= ${C.MIN_MC_SHARPE_P * 100}`,
      (mc?.pSharpePositive ?? -99) >= C.MIN_MC_SHARPE_P * 100],
    ["deflated Sharpe (vs trials tried)", fmt(dsr?.dsr, 4), `>= ${C.MIN_DEFLATED_SHARPE}`,
      (dsr?.ok === true ? dsr.dsr : -99) >= C.MIN_DEFLATED_SHARPE],
    ["P(dd breach) under fill error %", fmt(fill?.pBreach, 1), `< ${C.MIN_FILL_DD_BREACH}`,
      (fill?.pBreach ?? 999) < C.MIN_FILL_DD_BREACH],
  ];
  const failed = checks.filter((c) => !c[3]);
  return {
    passed: failed.length === 0,
    checks: checks.map(([name, actual, expected, ok]) => ({ name, actual, expected, ok })),
    failedCount: failed.length,
    failedNames: failed.map((c) => c[0]),
  };
}

/**
 * The v2 verdict: v1's checks (identical code, identical thresholds) plus the
 * seven robustness criteria, reported as two separate groups.
 */
export function evaluateGateV2({ evidence, robustness }) {
  const v1 = evaluateGate({
    metrics: evidence.agg, mc: evidence.mc, wf: evidence.wf,
    regimes: evidence.regimes, volRegimes: evidence.volRegimes,
    bench: evidence.bench, benchByRegime: evidence.benchByRegime,
    symbolCount: evidence.symbolCount,
    ruined: evidence.ruinSymbols > 0, ruinSymbols: evidence.ruinSymbols,
    holdout: evidence.holdout, stress: evidence.stress, perSymbol: evidence.perSymbol,
    leakagePass: evidence.leakage.pass, leakageAdvisories: evidence.leakage.advisoryDetail,
    initialEquity: evidence.initialEquity,
  });
  const v2 = evaluateRobustness(robustness);

  return {
    passed: v1.passed && v2.passed,
    v1Passed: v1.passed,
    v2Passed: v2.passed,
    tstat: v1.tstat, sharpeLcb: v1.sharpeLcb,
    groups: { v1, v2 },
    // Flat list for the run record and for the README table.
    checks: [...v1.checks, ...v2.checks],
    failedCount: v1.failedCount + v2.failedCount,
    failedNames: [...v1.failedNames, ...v2.failedNames],
    criteriaCount: { v1: v1.checks.length, v2: v2.checks.length, total: v1.checks.length + v2.checks.length },
  };
}

// --------------------------------------------------------------- selftest
if (process.argv[1] && process.argv[1].endsWith("gate-v2.mjs")) {
  let pass = 0, fail = 0;
  const check = (n, c, x = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); };
  console.log("gate-v2.mjs selftest\n");

  // A v1-clean evidence bundle, so the ONLY thing under test is v2's own logic.
  const ev = {
    agg: { trades: 900, profitFactor: 1.8, sharpe: 1.6, maxDrawdownPct: 18, totalReturnPct: 70 },
    mc: { probabilityOfBreachingThreshold: 6 },
    wf: { consistency: 80, foldCoveragePct: 100 },
    regimes: { bull: { trades: 300, pnl: 3000 }, bear: { trades: 300, pnl: 2000 }, sideways: { trades: 300, pnl: 2500 } },
    volRegimes: { high: { trades: 400, pnl: 40 }, low: { trades: 500, pnl: 37 } },
    bench: { calmar: 1.0 },
    benchByRegime: { bull: { calmar: 1.0, returnPct: 50 }, bear: { calmar: 1.0, returnPct: -5 }, sideways: { calmar: 0.5, returnPct: 2 } },
    symbolCount: 5,
    holdout: { ok: true, test: { trades: 300, sharpe: 1.1 }, testRuin: false, degradation: 0.7, sensitivity: 0.6 },
    stress: { survivalRate: 0.7, maxSurvivableFeeBps: 30, maxSurvivableSlippageBps: 15 },
    perSymbol: [{ symbol: "BTCUSDT", profitFactor: 1.6, sharpe: 1.2, trades: 200, ruined: false },
                { symbol: "ETHUSDT", profitFactor: 1.5, sharpe: 1.1, trades: 180, ruined: false },
                { symbol: "DOGEUSDT", profitFactor: 1.4, sharpe: 1.0, trades: 170, ruined: false },
                { symbol: "SOLUSDT", profitFactor: 1.4, sharpe: 1.0, trades: 180, ruined: false },
                { symbol: "ZECUSDT", profitFactor: 1.3, sharpe: 0.9, trades: 170, ruined: false }],
    leakage: { pass: true, advisoryDetail: [] },
    ruinSymbols: 0,
    initialEquity: 1000,
  };
  const goodRobust = {
    // `foldCoverage` is the v2 name; `foldCoveragePct` is the v1 name for the
  // same quantity. The same object is evaluated by both gates, so a fixture
  // that satisfies only one of them fails the other on MIN_WF_COVERAGE.
  wf: { consistency: 80, foldCoverage: 100, foldCoveragePct: 100, efficiencyRatio: 0.72, meanOosSharpe: 0.55 },
    mc: { pProfitable: 97, pSharpePositive: 95 },
    dsr: { ok: true, dsr: 0.988 },
    fill: { pBreach: 6 },
  };

  const g0 = evaluateGateV2({ evidence: ev, robustness: goodRobust });
  check("strong v1 + strong v2 evidence PASSES", g0.passed === true, g0.failedNames.join("; "));
  check("both groups are reported separately",
    g0.groups.v1.checks.length > 0 && g0.groups.v2.checks.length === 8
    && g0.criteriaCount.total === g0.groups.v1.checks.length + 8,
    `v1 ${g0.criteriaCount.v1} + v2 ${g0.criteriaCount.v2} = ${g0.criteriaCount.total}`);
  check("v2 adds exactly eight criteria", g0.groups.v2.checks.length === 8,
    g0.groups.v2.checks.map((c) => c.name).length + " checks");
  check("v1's threshold set is unchanged by v2 (MIN_PF still 1.3)",
    CRITERIA_V2.MIN_PF === 1.3 && CRITERIA_V2.MIN_SHARPE === 1.0, `MIN_PF=${CRITERIA_V2.MIN_PF}`);
  check("the deflated Sharpe bar matches the standard robustness.mjs argues for",
    CRITERIA_V2.MIN_DEFLATED_SHARPE === 0.95,
    `bar is ${CRITERIA_V2.MIN_DEFLATED_SHARPE}; a bar of 0 would only require beating E[max of N] trials, which at N=74 is 2.31 per trade — a constant 0 for every strategy`);

  // --- each v2 criterion must be independently able to fail
  const one = (patch) => evaluateGateV2({ evidence: ev, robustness: { ...goodRobust, ...patch } });
  const failsOn = (patch, re) => {
    const g = one(patch);
    return g.passed === false && g.v1Passed === true && g.groups.v2.failedNames.some((f) => re.test(f));
  };
  check("low walk-forward consistency FAILS v2 only", failsOn({ wf: { ...goodRobust.wf, consistency: 40 } }, /consistency/),
    one({ wf: { ...goodRobust.wf, consistency: 40 } }).groups.v2.failedNames.join("; "));
  check("a strategy that goes silent out of sample FAILS on coverage", failsOn({ wf: { ...goodRobust.wf, foldCoverage: 50 } }, /coverage/));
  check("100% consistency with only half the folds trading is NOT a pass",
    failsOn({ wf: { ...goodRobust.wf, consistency: 100, foldCoverage: 50 } }, /coverage/));
  check("missing fold coverage FAILS (a null must not read as 100%)",
    failsOn({ wf: { ...goodRobust.wf, foldCoverage: null } }, /coverage/));
  check("poor OOS/IS efficiency FAILS v2 only", failsOn({ wf: { ...goodRobust.wf, efficiencyRatio: 0.1 } }, /efficiency/));
  check("a negative mean OOS fold Sharpe FAILS v2 only", failsOn({ wf: { ...goodRobust.wf, meanOosSharpe: -0.2 } }, /fold Sharpe/));
  check("a low P(profitable) FAILS v2 only", failsOn({ mc: { ...goodRobust.mc, pProfitable: 55 } }, /P\(profitable\)/));
  check("a low P(Sharpe>0) FAILS v2 only", failsOn({ mc: { ...goodRobust.mc, pSharpePositive: 60 } }, /Sharpe > 0/));
  check("a deflated Sharpe of 0.5 FAILS v2 only", failsOn({ dsr: { ok: true, dsr: 0.5 } }, /deflated Sharpe/));
  check("a missing deflated Sharpe FAILS v2 only", failsOn({ dsr: { ok: false, reason: "too few trades" } }, /deflated Sharpe/));
  check("a high fill-error breach rate FAILS v2 only", failsOn({ fill: { pBreach: 61 } }, /fill error/));

  // --- a robustness result that is entirely absent must fail, never default to pass
  for (const [label, patch] of [
    ["no walk-forward", { wf: null }],
    ["no bootstrap", { mc: null }],
    ["no fill perturbation", { fill: null }],
  ]) {
    const g = one(patch);
    check(`missing evidence (${label}) FAILS rather than defaulting to pass`, g.passed === false,
      g.groups.v2.failedNames.join("; "));
  }

  // --- the groups must not be able to mask each other
  const badV1 = evaluateGateV2({ evidence: { ...ev, agg: { ...ev.agg, profitFactor: 0.9, sharpe: -0.1 } }, robustness: goodRobust });
  check("a v1 failure cannot be hidden by v2 passing", badV1.passed === false && badV1.v2Passed === true,
    `v1Passed=${badV1.v1Passed} v2Passed=${badV1.v2Passed}`);
  const badBoth = evaluateGateV2({ evidence: ev, robustness: { ...goodRobust, mc: { pProfitable: 10, pSharpePositive: 10 } } });
  check("both groups failing is reported as both", badBoth.v1Passed === true && badBoth.v2Passed === false,
    `v1Passed=${badBoth.v1Passed} v2Passed=${badBoth.v2Passed}`);

  // --- a null-valued robustness field must not read as a pass via comparison
  check("a null efficiency ratio does not slip through a >= comparison",
    one({ wf: { ...goodRobust.wf, efficiencyRatio: null } }).groups.v2.failedNames.some((f) => /efficiency/.test(f)));
  check("a null pProfitable does not slip through",
    one({ mc: { ...goodRobust.mc, pProfitable: null } }).groups.v2.failedNames.some((f) => /P\(profitable\)/.test(f)));

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
