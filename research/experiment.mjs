/**
 * The experiment, resolved from the protocol.
 *
 * THE BUG THIS FIXES. `protocol.v1.json` hashed its `data`, `costs`, `risk`,
 * `split` and `regimes` sections, so editing any of them moved the hash. But
 * the v1 pipeline never READ them. The experiment was actually defined by
 * literals in three places:
 *
 *   evidence.mjs:51   SYMBOLS = ["BTCUSDT", ...]           (a literal)
 *   evidence.mjs:136  simCfgFor()  equity/risk/hold        (defaults, argv-overridable)
 *   harness.mjs       DEFAULTS      feeBps/slippageBps/... (a literal)
 *   gate.mjs:75       trendLen/slopeLen/bullSlope/...      (a literal)
 *
 * So `node research/run.mjs --risk 0.5 --equity 99999` produced a materially
 * different book while every record still cited the frozen protocol hash, and
 * `notes` recorded only `days/tf/symbolCount` — the parameters that produced
 * the number were not in the archive at all. Same hash, different experiment.
 * That is strictly worse than the documented "the hash covers thresholds, not
 * computation" limitation, because the thresholds' own stated inputs were
 * outside the hash too. The protocol was a signed-looking document describing
 * an experiment defined somewhere else.
 *
 * THE RULE NOW. Every experiment-defining value comes from the protocol. CLI
 * flags may REPRODUCE a protocol value, and are rejected if they depart from
 * it. To run a different experiment, change the protocol: that moves the hash,
 * which is the point.
 *
 *   node research/run.mjs --risk 0.5
 *     -> ERROR: --risk=0.5 departs from protocol risk.risk_per_trade_pct=0.01.
 *        To run a different experiment, edit research/protocol.v1.json; that
 *        moves protocol_hash and creates a new lineage in the archive.
 */
import { PROTOCOL } from "./protocol.mjs";
import { canonicalize } from "./protocol.mjs";

/** Flags that only select WHICH work to do. They cannot change the experiment. */
const SELECTOR_FLAGS = new Set(["--all", "--strategy", "--version", "--help", "-h"]);

/**
 * CLI flags that name an experiment parameter, mapped to the protocol field that
 * governs it. A flag is permitted only when its value EQUALS the protocol's.
 */
const PARAM_FLAGS = {
  "--tf": { section: ["data", "timeframe"], kind: "string" },
  "--days": { section: ["data", "period_days"], kind: "number" },
  "--to": { section: ["data", "as_of"], kind: "string" },
  "--equity": { section: ["risk", "equity"], kind: "number" },
  "--risk": { section: ["risk", "risk_per_trade_pct"], kind: "number" },
  "--hold": { section: ["risk", "max_hold_bars"], kind: "number" },
  "--stop": { section: ["risk", "stop_atr_mult"], kind: "number" },
  "--atr": { section: ["risk", "atr_period"], kind: "number" },
  "--leverage": { section: ["risk", "max_leverage"], kind: "number" },
  "--fee-bps": { section: ["costs", "fee_bps"], kind: "number" },
  "--slippage-bps": { section: ["costs", "slippage_bps"], kind: "number" },
  "--mc-runs": { section: ["monte_carlo", "runs"], kind: "number" },
  "--mc-seed": { section: ["monte_carlo", "seed"], kind: "number" },
};

const at = (obj, [a, b]) => (b === undefined ? obj?.[a] : obj?.[a]?.[b]);

/** Parse argv into a flat map of flag -> value, plus the set of bare flags. */
export function parseArgv(argv = []) {
  const values = new Map();
  const bare = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== "string" || !a.startsWith("--")) { bare.add(a); continue; }
    const eq = a.indexOf("=");
    if (eq > 0) { values.set(a.slice(0, eq), a.slice(eq + 1)); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { values.set(a, next); i++; }
    else bare.add(a);
  }
  return { values, bare };
}

/**
 * Reject any flag that would change the experiment.
 * Returns the resolved experiment, or throws with an actionable message.
 */
export function resolveExperiment(argv = [], protocol = PROTOCOL) {
  const { values, bare } = parseArgv(argv);
  const violations = [];

  for (const [flag, raw] of values) {
    const spec = PARAM_FLAGS[flag];
    if (!spec) {
      if (SELECTOR_FLAGS.has(flag)) continue;
      violations.push(`unknown flag ${flag} — refusing to run, because an unrecognised flag could change the experiment`);
      continue;
    }
    const want = at(protocol, spec.section);
    if (want === undefined) {
      violations.push(`${flag} has no counterpart in protocol.${spec.section.join(".")} — refusing to run`);
      continue;
    }
    const got = spec.kind === "number" ? Number(raw) : String(raw);
    const equal = spec.kind === "number" ? Number.isFinite(got) && got === Number(want) : got === String(want);
    if (!equal) {
      violations.push(
        `${flag}=${raw} departs from protocol.${spec.section.join(".")}=${want}. ` +
        `The experiment is defined by the protocol, not the command line. To run a ` +
        `different experiment, edit research/protocol.v1.json — that moves ` +
        `protocol_hash (currently ${protocol.protocol_hash}) and opens a new lineage.`
      );
    }
  }

  for (const a of bare) {
    if (SELECTOR_FLAGS.has(a) || PARAM_FLAGS[a]) continue;
    violations.push(`unknown flag ${a} — refusing to run`);
  }

  if (violations.length) {
    const e = new Error(
      `EXPERIMENT/PROTOCOL MISMATCH — refusing to run.\n` +
      violations.map((v) => `  - ${v}`).join("\n")
    );
    e.code = "PROTOCOL_MISMATCH";
    throw e;
  }

  return experimentFromProtocol(protocol);
}

/** Build the fully-resolved experiment from protocol fields. No literals. */
export function experimentFromProtocol(protocol = PROTOCOL) {
  const d = protocol.data, r = protocol.risk, c = protocol.costs;
  const s = protocol.split, m = protocol.monte_carlo, g = protocol.regimes;
  return {
    // data
    symbols: [...d.symbols],
    timeframe: d.timeframe,
    period_days: d.period_days,
    as_of: d.as_of,
    min_symbols: d.min_symbols,
    require_zero_gaps: d.require_zero_gaps,
    // sizing / risk
    equity: r.equity,
    riskPct: r.risk_per_trade_pct,
    stopAtrMult: r.stop_atr_mult,
    atrPeriod: r.atr_period,
    leverage: r.max_leverage,
    maxHoldBars: r.max_hold_bars,
    ruinEquityPct: r.ruin_equity_pct,
    maxOpenPositions: r.max_open_positions,
    allowFractional: r.allow_fractional,
    // costs
    feeBps: c.fee_bps,
    slippageBps: c.slippage_bps,
    // evaluation shape
    warmup: s.warmup_bars,
    trainFraction: s.train_fraction,
    holdoutIsUntouched: s.holdout_is_untouched,
    mcRuns: m.runs,
    mcSeed: m.seed,
    mcDdThresholdPct: m.dd_threshold_pct,
    // regime labelling
    trendLen: g.trend_len,
    slopeLen: g.slope_len,
    bullSlope: g.bull_slope,
    bearSlope: g.bear_slope,
    volLen: g.vol_len,
    volHighPct: g.vol_high_pct,
    protocol_hash: protocol.protocol_hash,
  };
}

/** The sim config the harness consumes. Derived entirely from the protocol. */
export function simCfgFromExperiment(x) {
  return {
    equity: x.equity,
    riskPct: x.riskPct,
    maxHoldBars: x.maxHoldBars,
    warmup: x.warmup,
    ruinEquityPct: x.ruinEquityPct,
    stopAtrMult: x.stopAtrMult,
    atrPeriod: x.atrPeriod,
    leverage: x.leverage,
    allowFractional: x.allowFractional,
    feeBps: x.feeBps,
    slippageBps: x.slippageBps,
    maxOpenPositions: x.maxOpenPositions,
  };
}

/**
 * A stable fingerprint of the RESOLVED experiment, for stamping into every
 * record. This is what makes "same hash, different experiment" detectable even
 * if someone later finds another unbound input: the record states what was
 * actually run, and a disagreement with the protocol is visible.
 */
export function experimentFingerprint(x) {
  return canonicalize({
    symbols: x.symbols, timeframe: x.timeframe, period_days: x.period_days, as_of: x.as_of,
    equity: x.equity, riskPct: x.riskPct, stopAtrMult: x.stopAtrMult, atrPeriod: x.atrPeriod,
    leverage: x.leverage, maxHoldBars: x.maxHoldBars, ruinEquityPct: x.ruinEquityPct,
    allowFractional: x.allowFractional, feeBps: x.feeBps, slippageBps: x.slippageBps,
    warmup: x.warmup, mcRuns: x.mcRuns, mcSeed: x.mcSeed, mcDdThresholdPct: x.mcDdThresholdPct,
    trendLen: x.trendLen, slopeLen: x.slopeLen, bullSlope: x.bullSlope, bearSlope: x.bearSlope,
    volLen: x.volLen, volHighPct: x.volHighPct,
  });
}

/** The window end as a unix second, from the protocol's `as_of`. */
export function windowEndFromProtocol(x) {
  return Math.floor(Date.parse(x.as_of) / 1000);
}
