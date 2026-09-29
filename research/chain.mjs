/**
 * Archive hash chain.
 *
 * The archive is append-only by convention: `registry.record` only ever calls
 * `appendFileSync`. Convention is not a check, though. Nothing bound a record's
 * BODY to anything, so editing a line in place — flipping the last record of a
 * strategy to `passed: true` and adjusting four numbers — left `npm run verify`
 * green unless a card happened to contradict it.
 *
 * This makes the evidence tamper-evident. Each record carries:
 *
 *     rec_hash  = sha256(canonicalize(record with the two chain fields removed))
 *     prev_hash = the previous record's rec_hash
 *
 * and the first chained record anchors on a hash of every record written before
 * the chain existed, so deleting or editing any of those breaks the anchor too.
 * That covers all three attacks the protocol hash does not:
 *
 *   edit a record   -> its rec_hash no longer matches its content
 *   delete a record -> the next record's prev_hash points at a hash nobody has
 *   reorder records -> prev_hash linkage no longer matches position
 *
 * Records that predate the chain have no `rec_hash`. They are NOT retroactively
 * chained — rewriting history to add hashes would destroy the evidence the
 * protocol hash exists to preserve. They are instead folded into a single
 * `anchor`, so they remain covered as a group: change any one of them and the
 * anchor moves, which invalidates the first chained record.
 *
 * `canonicalize` is imported from protocol.mjs rather than reimplemented, so the
 * chain and the protocol hash agree on what "the same object" means. (The first
 * version of that hash used `JSON.stringify(obj, Object.keys(obj).sort())`, an
 * array replacer, which is a whitelist applied at every nesting level — so every
 * nested object serialised to `{}` and the hash was blind to the very thresholds
 * it protects. Do not reintroduce a serialisation shortcut here.)
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./protocol.mjs";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** The constant a strategy's first-ever record chains from, when it has no prior history. */
const GENESIS = sha256("research/archive-chain/v1");

/** The two fields the chain owns. Everything else is the record's body. */
const CHAIN_FIELDS = ["prev_hash", "rec_hash"];

/** Hash of a record's body: everything except the chain fields themselves. */
export function entryHash(entry) {
  const body = { ...entry };
  for (const f of CHAIN_FIELDS) delete body[f];
  return sha256(canonicalize(body));
}

const isChained = (r) => !!r && typeof r.rec_hash === "string" && r.rec_hash.length > 0;

/**
 * The anchor a strategy's first chained record must point at: a hash over every
 * record written before the chain existed. Empty history anchors at GENESIS, so
 * two different strategies never share a first `prev_hash` by accident.
 */
export function anchorFor(records) {
  const pre = records.filter((r) => !isChained(r));
  if (pre.length === 0) return GENESIS;
  return sha256(canonicalize(pre));
}

/**
 * Seal a new record against the history that already exists in the file.
 * Returns the two chain fields to merge into the entry before it is written.
 */
export function seal(records, entry) {
  const chained = records.filter(isChained);
  const prev_hash = chained.length > 0
    ? chained[chained.length - 1].rec_hash
    : anchorFor(records);
  const withPrev = { ...entry, prev_hash };
  return { prev_hash, rec_hash: entryHash(withPrev) };
}

/**
 * Verify a strategy's whole run history.
 *
 * `records` is the parsed runs.jsonl in file order. Returns
 * `{ ok, chained, prechain, problems }` — `problems` is a list of
 * human-readable strings, one per broken link, each naming the line.
 */
export function verifyChain(records) {
  const problems = [];
  const chained = [];
  let anchorSeen = null;

  records.forEach((r, i) => {
    if (!isChained(r)) {
      // Pre-chain record: cannot be self-verified, but it fixes the anchor.
      if (anchorSeen === null) anchorSeen = anchorFor(records.filter((x) => !isChained(x)).slice(0, i + 1));
      return;
    }
    const recomputed = entryHash(r);
    if (recomputed !== r.rec_hash) {
      problems.push(`line ${i + 1}: rec_hash does not match its content (stored ${r.rec_hash.slice(0, 12)}…, recomputed ${recomputed.slice(0, 12)}…) — the record body was edited`);
      return;
    }
    if (chained.length === 0) {
      // First chained record must anchor on the pre-chain history exactly.
      const expected = anchorFor(records.slice(0, i));
      if (r.prev_hash !== expected) {
        problems.push(`line ${i + 1}: first chained record's prev_hash does not match the pre-chain history — a record before it was added, deleted or edited`);
      }
    } else {
      const want = chained[chained.length - 1].rec_hash;
      if (r.prev_hash !== want) {
        problems.push(`line ${i + 1}: prev_hash does not match the previous record — a record was deleted, reordered or inserted`);
      }
    }
    chained.push(r);
  });

  return {
    ok: problems.length === 0,
    chained: chained.length,
    prechain: records.length - chained.length,
    problems,
  };
}

/**
 * Verify a strategy's whole run history, requiring that it is actually sealed.
 *
 * `verifyChain` alone answers "is every link intact?", which for an empty or
 * unchained file is vacuously true — the same defect as a selftest that reports
 * "0 passed, 0 failed". Deleting an entire strategy's history also leaves an
 * empty file that verifies clean, so a caller that cares about the record
 * existing must say so. `expectChained` fails when nothing is chained, and
 * `expectedCount` (the count the file had when it was last written) fails when
 * records have been removed outright.
 *
 * Returns verifyChain's shape plus `empty` and `countShortfall`.
 */
export function verifySealed(records, { expectedCount = null, expectChained = true } = {}) {
  const base = verifyChain(records);
  const problems = [...base.problems];
  const empty = records.length === 0;
  const countShortfall = expectedCount != null && records.length < expectedCount;
  if (empty) problems.push("archive is empty — every record for this strategy has been deleted");
  if (countShortfall) {
    problems.push(`archive holds ${records.length} record(s) but ${expectedCount} were written — ${expectedCount - records.length} were deleted`);
  }
  if (expectChained && base.chained === 0) {
    problems.push("no records are chained — nothing here is tamper-evident (run npm run research:all, or node research/chain-backfill.mjs)");
  }
  return { ...base, ok: problems.length === 0, problems, empty, countShortfall };
}

// ------------------------------------------------------------------ selftest
if (process.argv[1] && process.argv[1].endsWith("chain.mjs")) {
  let pass = 0, fail = 0;
  const check = (name, cond, extra = "") => {
    cond ? pass++ : fail++;
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  :: " + extra : ""}`);
  };

  // Build a realistic history: two pre-chain records, then a chain.
  const body = (n, over = {}) => ({ ts: `2026-01-0${n}T00:00:00.000Z`, strategy_id: "s", trades: n, passed: false, ...over });
  let hist = [body(1), body(2)];
  for (let n = 3; n <= 5; n++) hist = [...hist, { ...body(n), ...seal(hist, body(n)) }];

  const clean = verifyChain(hist);
  check("an untouched chain verifies", clean.ok, `chained=${clean.chained} prechain=${clean.prechain}`);
  check("  ...and reports no problems", clean.problems.length === 0);

  // Attack 1: EDIT a record in place. The protocol hash does not catch this.
  const edited = hist.map((r) => (r.trades === 4 ? { ...r, passed: true, trades: 9999 } : r));
  const e1 = verifyChain(edited);
  check("EDITING a record is caught", e1.ok === false, e1.problems[0]?.slice(0, 60));
  check("  ...specifically as a rec_hash/content mismatch",
        e1.problems.some((p) => /rec_hash does not match/.test(p)));

  // Attack 2: DELETE a record. Nothing else changes.
  const deleted = hist.filter((_, i) => i !== 3);
  const e2 = verifyChain(deleted);
  check("DELETING a record is caught", e2.ok === false, e2.problems[0]?.slice(0, 60));
  check("  ...specifically as a broken prev_hash link",
        e2.problems.some((p) => /prev_hash does not match/.test(p)));

  // Attack 3: REORDER two records.
  const reordered = [...hist];
  [reordered[2], reordered[3]] = [reordered[3], reordered[2]];
  const e3 = verifyChain(reordered);
  check("REORDERING records is caught", e3.ok === false, e3.problems[0]?.slice(0, 60));

  // Attack 4: edit a PRE-CHAIN record — the anchor must move.
  const preEdited = hist.map((r, i) => (i === 0 ? { ...r, trades: 12345 } : r));
  const e4 = verifyChain(preEdited);
  check("editing a PRE-CHAIN record is caught via the anchor", e4.ok === false, e4.problems[0]?.slice(0, 60));
  check("  ...and it is reported as an anchor break, not a content mismatch",
        e4.problems.some((p) => /pre-chain history/.test(p)));

  // Attack 5: append a forged "passed" record without re-sealing.
  const forged = [...hist, { ...body(9), passed: true, prev_hash: "deadbeef", rec_hash: "deadbeef" }];
  check("appending a forged record is caught", verifyChain(forged).ok === false);

  // verifyChain alone is vacuously true on an empty or unchained file — the same
  // defect as a selftest reporting "0 passed, 0 failed". Deleting a strategy's
  // ENTIRE history leaves an empty file that verifies clean, and an archive
  // predating the chain verifies clean while protecting nothing.
  // verifySealed closes both.
  check("verifyChain is vacuously true on an EMPTY archive", verifyChain([]).ok === true);
  const emptySealed = verifySealed([]);
  check("verifySealed FAILS an empty archive", emptySealed.ok === false && emptySealed.empty);
  check("  ...naming it as total deletion",
        emptySealed.problems.some((p) => /every record .* has been deleted/.test(p)));
  check("verifyChain is vacuously true on an UNCHAINED archive", verifyChain([body(1), body(2)]).ok === true);
  const unchained = verifySealed([body(1), body(2)]);
  check("verifySealed FAILS an unchained archive", unchained.ok === false);
  check("  ...naming it as not tamper-evident",
        unchained.problems.some((p) => /no records are chained/.test(p)));
  const shortened = verifySealed(hist, { expectedCount: hist.length + 1 });
  check("verifySealed FAILS when records are missing entirely", shortened.ok === false && shortened.countShortfall);
  check("  ...and reports how many are gone",
        shortened.problems.some((p) => /were deleted/.test(p)));
  check("verifySealed passes a healthy sealed archive", verifySealed(hist).ok === true);

  // A first-ever record (no history) anchors at GENESIS, and two different
  // strategies must not share that first prev_hash by accident.
  const freshA = { ...body(1), ...seal([], body(1)) };
  const freshB = { ...body(1), ...seal([], body(1)) };
  check("a first record verifies against an empty history", verifyChain([freshA]).ok);
  check("  ...and a lone genesis record still chains its successor",
        verifyChain([freshA, { ...body(2), ...seal([freshA], body(2)) }]).ok);
  check("two fresh strategies do not share a genesis prev_hash",
        freshA.prev_hash === freshB.prev_hash && freshA.rec_hash === freshB.rec_hash);

  // The chain must be blind to nothing: a record differing only in one field
  // must produce a different hash (this is the check the old array-replacer
  // serialisation silently failed).
  check("a one-field change moves the hash",
        entryHash(body(1, { passed: true })) !== entryHash(body(1)));
  check("a nested change moves the hash",
        entryHash({ a: { b: 1 } }) !== entryHash({ a: { b: 2 } }));

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
