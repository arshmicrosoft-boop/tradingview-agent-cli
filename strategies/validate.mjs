#!/usr/bin/env node
/**
 * validate.mjs — the card linter.
 *
 * SCHEMA.md is documentation. This file is the enforcement. A repo whose rules
 * are only written down is a repo whose rules drift, so every claim SCHEMA.md
 * makes is checked here, and a broken card is a failing `npm run verify` — the
 * same status as a leaky simulator.
 *
 * What is checked:
 *   1. every card on disk parses as front matter + a hypothesis yaml block
 *   2. required keys are present, per status
 *   3. the six hypothesis fields exist and are non-empty
 *   4. required sections exist, per status
 *   5. "Rules as numbers" is a fenced block and is not prose
 *   6. a tested card's numbers agree with the run registry it claims to report
 *   7. registry.json matches the filesystem exactly, both directions
 *
 * It cannot check that a mechanism was genuinely believed rather than
 * reverse-engineered from a P&L curve. That part is on us; see PLAYBOOK.md §3.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

let pass = 0, fail = 0;
const errors = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; return true; }
  fail++;
  errors.push(`${name}${detail ? "  :: " + detail : ""}`);
  return false;
};

// ---------------------------------------------------------------- schema

const STATUSES = ["proposed", "queued", "testing", "falsified", "promoted", "blocked"];

const ID_PREFIX = { T: "tested", C: "controls", P: "proposed" };

const REQUIRED_SECTIONS = {
  every: ["## Hypothesis", "## Rules as numbers", "## When to use", "## When not to use"],
  tested: ["## Result under v1", "## What we learned"],
  controls: ["## Result under v1", "## What we learned"],
  falsified: ["## Why it failed"],
  blocked: ["## Why it is blocked"],
};

const HYPOTHESIS_FIELDS = [
  "name",
  "market_mechanism",
  "why_should_it_exist",
  "expected_regime",
  "required_data",
  "failure_condition",
];

// Front-matter keys that a tested/control card must carry. The gate reads these
// to compare a card against the run it claims to describe.
const RESULT_KEYS = [
  "protocol", "protocol_hash", "tested_at", "dataset",
  "trades", "profit_factor", "sharpe", "max_drawdown_pct", "total_return_pct",
];

// ---------------------------------------------------------------- parsing

/** Front matter is flat key: value, parsed with a regex so a card stays
 *  readable as plain text (SCHEMA.md front-matter section). */
function parseFrontMatter(src, file) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) { errors.push(`${file}: no front matter block`); fail++; return null; }
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const kv = line.match(/^([a-z_0-9]+):\s*(.*)$/);
    if (!kv) { errors.push(`${file}: unparseable front-matter line: ${line.trim()}`); fail++; continue; }
    fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

/** The hypothesis block is a fenced ```yaml block. We check presence and that
 *  each required key has a non-empty body, without pulling in a YAML parser. */
function checkHypothesisBlock(body, file) {
  const blocks = [...body.matchAll(/```yaml\r?\n([\s\S]*?)```/g)].map((x) => x[1]);
  if (!blocks.length) { errors.push(`${file}: no yaml hypothesis block`); fail++; return; }
  const yaml = blocks[0];
  const missing = [];
  for (const f of HYPOTHESIS_FIELDS) {
    const re = new RegExp(`^${f}:\\s*(?:>\\s*\\r?\\n((?:[ \\t]+.*\\r?\\n?)+)|(\\S.*))?$`, "m");
    const hit = yaml.match(re);
    const value = hit ? (hit[1] || hit[2] || "") : "";
    if (!hit || !value.trim()) missing.push(f);
  }
  if (missing.length) {
    fail++;
    errors.push(`${file}: hypothesis block missing/empty: ${missing.join(", ")}`);
  } else pass++;
}

/** "Rules as numbers" must be a fenced block, and must not contain the vague
 *  vocabulary SCHEMA.md bans. A rule you cannot print is not a rule. */
const VAGUE = /\b(smart money|strong reversal|feels like|looks like|obvious|clearly trending|momentum building)\b/i;

function checkRulesBlock(body, file) {
  const after = body.split("## Rules as numbers")[1];
  if (!after) return;
  const seg = after.split(/^## /m)[0];
  const fences = [...seg.matchAll(/```/g)].length;
  if (fences < 2) { errors.push(`${file}: "Rules as numbers" has no fenced code block`); fail++; return; }
  const code = [...seg.matchAll(/```[a-z]*\r?\n([\s\S]*?)```/g)].map((x) => x[1]).join("\n");
  const vague = code.match(VAGUE);
  if (vague) { errors.push(`${file}: "Rules as numbers" contains prose: "${vague[0]}"`); fail++; return; }
  if (!/\bIF\b|\bTHEN\b|<|>=/.test(code)) {
    errors.push(`${file}: "Rules as numbers" has no inequality or IF/THEN`); fail++; return;
  }
  pass++;
}

// ---------------------------------------------------------------- run data

/** Load the real run records so a card's numbers can be checked against the
 *  registry rather than trusted. */
function loadRuns() {
  const dir = join(ROOT, "research", "registry");
  const byStrategy = {};
  if (!existsSync(dir)) return byStrategy;
  for (const slug of readdirSync(dir)) {
    const p = join(dir, slug, "runs.jsonl");
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        (byStrategy[r.strategy_id] ||= []).push(r);
      } catch { /* a malformed run line is research/'s problem, not ours */ }
    }
  }
  return byStrategy;
}

const runs = loadRuns();

/** A tested card must agree with the newest run of the strategy it names.
 *  Drift between a card and its run is how a knowledge base starts lying. */
function checkAgainstRuns(fm, file, dir) {
  const slug = fm.code ? fm.code.replace(/^.*strategies\//, "").replace(/\.mjs$/, "") : fm.slug;
  const recs = runs[slug];
  if (!recs || !recs.length) { errors.push(`${file}: no run records for "${slug}" in research/registry/`); fail++; return; }
  const latest = recs[recs.length - 1];
  const mismatches = [];
  const near = (a, b) => Math.abs(Number(a) - Number(b)) <= Math.max(0.02, Math.abs(Number(b)) * 0.005);
  for (const k of ["trades", "profit_factor", "sharpe", "max_drawdown_pct", "total_return_pct"]) {
    if (fm[k] === undefined) { mismatches.push(`${k} absent`); continue; }
    if (k === "trades") {
      if (Number(fm[k]) !== Number(latest[k])) mismatches.push(`${k}: card ${fm[k]} vs run ${latest[k]}`);
    } else if (!near(fm[k], latest[k])) {
      mismatches.push(`${k}: card ${fm[k]} vs run ${latest[k]}`);
    }
  }
  if (fm.protocol_hash && latest.protocol_hash && fm.protocol_hash !== latest.protocol_hash) {
    mismatches.push(`protocol_hash: card ${fm.protocol_hash} vs run ${latest.protocol_hash}`);
  }
  const expectGate = latest.passed ? "pass" : "fail";
  if (fm.gate && fm.gate !== expectGate) mismatches.push(`gate: card ${fm.gate} vs run ${expectGate}`);
  if (fm.unmet !== undefined && Number(fm.unmet) !== latest.failed.length) {
    mismatches.push(`unmet: card ${fm.unmet} vs run ${latest.failed.length}`);
  }

  if (mismatches.length) {
    fail++;
    errors.push(`${file}: disagrees with research/registry/${dir}/${slug}/runs.jsonl -> ${mismatches.join("; ")}`);
  } else pass++;
}

// ---------------------------------------------------------------- walk cards

const CARD_DIRS = ["cards/proposed", "cards/tested", "cards/controls"];
const found = []; // { file, slug, dir, fm }

for (const d of CARD_DIRS) {
  const abs = join(HERE, d);
  if (!existsSync(abs)) continue;
  for (const f of readdirSync(abs).filter((x) => x.endsWith(".md"))) {
    const file = `${d}/${f}`;
    const src = readFileSync(join(abs, f), "utf8");
    const fm = parseFrontMatter(src, file);
    if (!fm) continue;
    const body = src.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");

    // id <-> status consistency
    const prefix = (fm.id || "")[0];
    if (!(prefix in ID_PREFIX)) {
      check(`${file}: id "${fm.id}" has no known prefix (T/C/P)`, false);
    } else {
      check(`${file}: id prefix ${prefix} -> ${ID_PREFIX[prefix]}`, ID_PREFIX[prefix] === d.replace("cards/", ""));
    }
    check(`${file}: status is known`, STATUSES.includes(fm.status), fm.status);
    check(`${file}: slug matches filename`, fm.slug === basename(f, ".md"), `${fm.slug} vs ${basename(f, ".md")}`);

    // required keys
    for (const k of ["id", "name", "slug", "status"]) {
      check(`${file}: has ${k}`, Boolean(fm[k]));
    }
    // Required keys + run cross-check are keyed on the DIRECTORY, not on
    // `status`. A card in cards/tested/ is `falsified` or `promoted`, never
    // `tested` — keying off status silently skipped every real hypothesis card.
    if (d === "cards/tested" || d === "cards/controls") {
      for (const k of RESULT_KEYS) {
        check(`${file}: has result key ${k}`, fm[k] !== undefined && fm[k] !== "");
      }
      check(`${file}: has code path`, Boolean(fm.code) && fm.code !== "none", fm.code);
      checkAgainstRuns(fm, file, d.replace("cards/", ""));
    }
    if (fm.status === "proposed" || fm.status === "queued") {
      check(`${file}: not yet implemented`, fm.code === "none" || !fm.code, `code: ${fm.code}`);
    }
    if (fm.status === "blocked" && !fm.blocker) {
      check(`${file}: blocked card names its blocker`, false, "missing `blocker:` key");
    }

    checkHypothesisBlock(body, file);
    checkRulesBlock(body, file);

    const needed = [...REQUIRED_SECTIONS.every];
    if (d === "cards/tested" || d === "cards/controls") needed.push(...REQUIRED_SECTIONS.tested);
    if (fm.status === "falsified") needed.push(...REQUIRED_SECTIONS.falsified);
    if (fm.status === "blocked") needed.push(...REQUIRED_SECTIONS.blocked);
    for (const s of needed) check(`${file}: has section ${s}`, body.includes(s));

    if (!/^#\s+\S/m.test(body)) check(`${file}: has an H1 title`, false);

    found.push({ file, slug: fm.slug, dir: d, fm });
  }
}

// ---------------------------------------------------------------- registry

const regPath = join(HERE, "registry.json");
if (!check("registry.json exists", existsSync(regPath))) {
  // already counted
} else {
  let reg;
  try { reg = JSON.parse(readFileSync(regPath, "utf8")); }
  catch (e) { check("registry.json parses", false, e.message); reg = null; }

  if (reg) {
    const listed = new Map();
    for (const c of reg.cards || []) {
      if (listed.has(c.file)) check(`registry: duplicate entry ${c.file}`, false);
      listed.set(c.file, c);
    }
    const onDisk = new Set(found.map((f) => f.file));

    for (const f of found) {
      const e = listed.get(f.file);
      if (!check(`registry: ${f.file} is registered`, Boolean(e))) continue;
      check(`registry: ${f.file} slug matches card`, e.slug === f.slug, `${e.slug} vs ${f.slug}`);
      check(`registry: ${f.file} id matches card`, e.id === f.fm.id, `${e.id} vs ${f.fm.id}`);
      check(`registry: ${f.file} status matches card`, e.status === f.fm.status, `${e.status} vs ${f.fm.status}`);
    }
    for (const file of listed.keys()) {
      check(`registry: ${file} exists on disk`, onDisk.has(file));
    }

    // The headline claims must not drift from the cards.
    const byStatus = {};
    for (const f of found) byStatus[f.fm.status] = (byStatus[f.fm.status] || 0) + 1;
    if (reg.counts) {
      for (const k of Object.keys(reg.counts)) {
        const expect = k === "total" ? found.length : (byStatus[k] || 0);
        check(`registry: counts.${k} = ${expect}`, reg.counts[k] === expect, `says ${reg.counts[k]}`);
      }
    }
    // No card may claim to have passed. If one ever does, the champion field
    // has to move with it — this is the assertion that keeps the README honest.
    const passedCards = found.filter((f) => f.fm.status === "promoted");
    if (passedCards.length) {
      check("registry: a promoted card exists, so champion must be set", Boolean(reg.champion), reg.champion || "null");
    } else {
      check("registry: no promoted cards, so champion is null", reg.champion === null, String(reg.champion));
    }
  }
}

// ---------------------------------------------------------------- report

console.log("=== strategies/validate.mjs ===\n");
if (fail) {
  for (const e of errors) console.log(`  FAIL  ${e}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}
console.log(`  ${pass} checks passed across ${found.length} cards`);
console.log(`\n${pass} passed, 0 failed`);
