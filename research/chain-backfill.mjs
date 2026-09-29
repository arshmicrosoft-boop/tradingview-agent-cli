/**
 * One-shot: seal the existing archive into the hash chain.
 *
 * Every record written before the chain existed has no rec_hash, so nothing in
 * the archive was tamper-evident and `verify` reported a vacuous pass. This adds
 * `prev_hash`/`rec_hash` to each existing record IN PLACE.
 *
 * It is additive only. No measurement, verdict, metric, timestamp or failed
 * list is altered — the script refuses to write unless every field other than
 * the two chain fields is byte-identical afterwards, and it prints a diff count.
 *
 * Idempotent: a record that is already chained is left exactly as it is, so
 * re-running is a no-op. Run it with --dry-run first.
 *
 *   node research/chain-backfill.mjs --dry-run
 *   node research/chain-backfill.mjs
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { seal, verifyChain, entryHash } from "./chain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes("--dry-run");

const body = (r) => { const c = { ...r }; delete c.prev_hash; delete c.rec_hash; return c; };
const sameBody = (a, b) => JSON.stringify(body(a)) === JSON.stringify(body(b));

let files = 0, sealed = 0, already = 0;
const changes = [];

for (const archive of ["registry", "registry-v2"]) {
  const root = join(HERE, archive);
  if (!existsSync(root)) continue;
  for (const strategy of readdirSync(root)) {
    const p = join(root, strategy, "runs.jsonl");
    if (!existsSync(p)) continue;
    files++;
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    const recs = lines.map((l) => JSON.parse(l));
    if (recs.every((r) => r.rec_hash)) { already += recs.length; continue; }

    // Seal in file order. `hist` is the running record of what the file looked
    // like BEFORE this line was sealed, which is what the next line anchors on.
    const out = [];
    let hist = [];
    for (const r of recs) {
      if (r.rec_hash) { out.push(r); hist.push(r); continue; }
      const sealedRec = { ...r, ...seal(hist, r) };
      if (!sameBody(r, sealedRec)) throw new Error(`${archive}/${strategy}: seal altered a non-chain field — refusing`);
      if (entryHash(sealedRec) !== sealedRec.rec_hash) throw new Error(`${archive}/${strategy}: seal is not self-consistent`);
      out.push(sealedRec);
      hist.push(sealedRec);
      sealed++;
    }
    const res = verifyChain(out);
    if (!res.ok) throw new Error(`${archive}/${strategy}: chain broken immediately after backfill: ${res.problems[0]}`);

    changes.push({ archive, strategy, before: recs, after: out });
    if (!DRY) writeFileSync(p, out.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
}

console.log(`\n${DRY ? "DRY RUN" : "SEALED"}: ${files} file(s), ${sealed} record(s) sealed, ${already} already chained`);
if (!DRY) {
  // Prove nothing but the chain fields moved, across every record we touched.
  let bodyDiffs = 0;
  for (const c of changes) {
    c.before.forEach((b, i) => { if (!sameBody(b, c.after[i])) bodyDiffs++; });
  }
  console.log(`records whose non-chain content changed: ${bodyDiffs} (must be 0)`);
  console.log(`chain verifies: ${changes.every((c) => verifyChain(c.after).ok)}`);
}
