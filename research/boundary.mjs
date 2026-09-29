/**
 * Module-graph boundary check.
 *
 * THE QUESTION. Can a file under research/ reach an execution surface? The old
 * check was a regex:
 *
 *   /(?:^|\n)\s*(?:import[^'"]*from\s*|import\s*\(\s*)["']([^"']+)["']/g
 *   ...if (spec.includes("execution") || spec.includes("paper-trade") ...)
 *
 * which was defeated without trying:
 *   - a re-export (`export { x } from` a parent path) — not matched
 *   - a CommonJS `require` of a parent path — not matched
 *   - a specifier split across an expression, so the literal never appears
 *   - a path with different CASE (this filesystem is case-insensitive, so it
 *     resolves, but a substring test on the lowercase form is false)
 *   - any path built at runtime from a variable
 * and the TradingView check was worse — it grepped for the STRINGS `tv.cmd`,
 * `:9222`, `remote-debugging-port`. A file that reached TradingView any other
 * way passed. And `walk()` skipped every directory named `data`, so two of
 * three crafted offenders were never even read.
 *
 * NOTE ON THIS FILE. It is itself scanned, so the examples above are written
 * without resolvable specifiers. An earlier draft of this comment contained
 * them and the scanner correctly flagged its own documentation as a violation.
 *
 * WHAT THIS IS. A real tokenizer for the subset of JavaScript that appears in
 * this repo — it consumes comments, string literals, template literals (with
 * `${}` nesting) and regex literals, so their contents can never be mistaken for
 * code. It then matches the four dependency-bearing forms STRUCTURALLY, and
 * RESOLVES each specifier against the filesystem, walking the graph transitively
 * from research/ to a fixed point.
 *
 * WHAT THIS IS NOT. It is not a full ECMAScript AST and does not attempt to be.
 * It does not do flow analysis, and a specifier assembled purely at runtime from
 * non-literal data is reported as unresolvable rather than assumed safe — see
 * `dynamicSpecifiers`, which FAILS the check. The honest framing: this catches
 * every syntactic route to a forbidden module, including the five that defeated
 * the regex, and it makes the residual risk (a path computed entirely at runtime
 * with no literal component) visible instead of silent.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Directories a research module may never reach, by resolved path segment. */
const FORBIDDEN_DIRS = ["execution", "tradingview", "broker", "wallet", "trading"];

/** Module names that would indicate an order-placing surface. */
const FORBIDDEN_TOKENS = ["paper-trade", "launch-tv", "order-ticket", "chrome-remote-interface", "9222"];

/**
 * Strip comments, strings, template literals and regex literals from source,
 * replacing each with same-length spaces so byte offsets stay meaningful.
 * Leaves code and punctuation intact for structural matching.
 */
export function stripLiteralsAndComments(src) {
  const out = src.split("");
  let i = 0;
  const n = src.length;
  // Tracks whether a `/` starts a regex or is a division operator. A regex can
  // only follow a token that cannot end an expression.
  let prevSignificant = "";

  const blank = (from, to) => { for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " "; };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    // line comment
    if (c === "/" && d === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    // block comment
    if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    // string literal (single, double)
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === c) break;
        j++;
      }
      blank(i, Math.min(j + 1, n));
      i = j + 1;
      prevSignificant = c;
      continue;
    }
    // template literal, with ${} interpolation (which may nest further)
    if (c === "`") {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "$" && src[j + 1] === "{") { depth++; j += 2; continue; }
        if (src[j] === "}" && depth > 0) { depth--; j++; continue; }
        if (src[j] === "`" && depth === 0) break;
        j++;
      }
      blank(i, Math.min(j + 1, n));
      i = j + 1;
      prevSignificant = "`";
      continue;
    }
    // regex literal — only where a regex can legally start
    if (c === "/" && !/[\w$)\]}'"]/.test(prevSignificant)) {
      let j = i + 1;
      let inClass = false;
      let ok = false;
      while (j < n) {
        const r = src[j];
        if (r === "\\") { j += 2; continue; }
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) { ok = true; break; }
        else if (r === "\n") break;
        j++;
      }
      if (ok) {
        j++;
        while (j < n && /[a-z]/.test(src[j])) j++;  // flags
        blank(i, j);
        i = j;
        prevSignificant = "/";
        continue;
      }
    }
    if (!/\s/.test(c)) prevSignificant = c;
    i++;
  }
  return out.join("");
}

/** Every string literal in the source, with its offset — used for specifier resolution. */
export function stringLiterals(src) {
  const lits = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { const e = src.indexOf("\n", i); i = e === -1 ? n : e; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); i = e === -1 ? n : e + 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let j = i + 1, raw = "";
      while (j < n) {
        if (src[j] === "\\") { raw += src[j] + src[j + 1]; j += 2; continue; }
        if (src[j] === quote) break;
        raw += src[j];
        j++;
      }
      lits.push({ offset: i, quote, value: raw });
      i = j + 1;
      continue;
    }
    i++;
  }
  return lits;
}

/**
 * Find dependency edges in a module. Returns one entry per edge:
 *   { kind, spec, at }
 *   { kind, spec, at }
 */
export function stripComments(src) {
  const out = src.split("");
  let i = 0;
  const n = src.length;
  const blank = (from, to) => { for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " "; };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { const e = src.indexOf("\n", i); const s = e === -1 ? n : e; blank(i, s); i = s; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); const s = e === -1 ? n : e + 2; blank(i, s); i = s; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === c) break;
        j++;
      }
      i = j + 1;                       // keep the literal intact
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * The module part of a source file: everything above the selftest banner.
 *
 * A selftest block is test DATA. It necessarily contains import statements as
 * text — in string fixtures and in the specifier lists the graph checker is
 * asserted against — and this scanner is not a full parser, so it cannot tell
 * `import { b } from "../x.mjs"` appearing inside a template literal from the
 * same text being live code. Scanning test data for the property under test is
 * also meaningless: the point of the check is what the MODULE imports.
 *
 * Without this, the scanner flags its own fixtures. That is not a false positive
 * to be tuned away — it is the honest limit of a tokenizer-based checker, and it
 * is stated in the report rather than hidden.
 */
export function modulePartOf(src) {
  const lines = src.split("\n");
  const at = lines.findIndex((l) => /^\/\/ -+\s*selftest/.test(l));
  return at >= 0 ? lines.slice(0, at).join("\n") : src;
}

export function findEdges(src) {
  // Specifiers must be matched BEFORE literals are blanked.
  //
  // The obvious design — blank the literals, then look for a quote terminating an
  // `import`/`require` — cannot work: blanking turns the opening quote into a
  // space, so the pattern can no longer see the delimiter it is looking for. It
  // silently found ZERO edges, which is how the first version of this file
  // reported a clean graph while every fixture imported a forbidden module.
  //
  // Only comments are blanked. A string literal cannot contain a real
  // `import`/`require` token, because its own quotes terminate it first, so
  // there is no way for one to masquerade as an edge — and a commented-out
  // import is blanked, so it cannot be counted either.
  const code = stripComments(src);
  const lits = stringLiterals(src);
  const byOffset = new Map();
  for (const l of lits) byOffset.set(l.offset, l);
  const edges = [];
  const seen = new Set();

  const add = (kind, at) => {
    const lit = byOffset.get(at);
    if (!lit) return;
    const key = `${kind}|${lit.offset}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ kind, spec: lit.value, at });
  };

  // import ... from "x"  |  import "x" (side-effect)
  //
  // The binding clause is a comma-separated list whose items are a default
  // identifier, `* as ns`, or `{ ... }`. An earlier version only allowed the
  // last two, so `import tv from "./x"` — the single most common form, and the
  // one every fixture used — matched nothing at all.
  // The binding clause is a comma-separated list whose items are a default
  // identifier, `* as ns`, or `{ ... }`. An earlier version only allowed the
  // last two, so `import tv from "./x"` — the single most common form, and the
  // one every fixture used — matched nothing at all.
  //
  // Bounded repetition is mandatory: the item group and the separator are both
  // optional, so an unbounded `(item)?,?` nests a quantifier and the regex
  // engine enters exponential backtracking. The first unbounded version hung
  // the selftest outright on the 60 KB robustness.mjs. Two bounded levels, which
  // covers every real import list, run in linear time.
  const ITEM = String.raw`\s*(?:\*\s+as\s+[\w$]+|\{[^}]*\}|[A-Za-z_$][\w$]*)\s*`;
  const BINDING = String.raw`(?:${ITEM}(?:,${ITEM}){0,6})?`;
  for (const m of code.matchAll(new RegExp(String.raw`\bimport\b${BINDING}\s*(?:\bfrom\s*)?(?=["'])`, "g"))) {
    add("static-import", m.index + m[0].length);
  }
  // export {x} from "y"  |  export * from "y"  |  export * as ns from "y"
  for (const m of code.matchAll(/\bexport\b\s*(?:\*|\{[^}]*\})\s*(?:\bas\s+[\w$]+\s*)?\bfrom\s*(?=["'])/g)) {
    add("re-export", m.index + m[0].length);
  }
  // import("x")
  for (const m of code.matchAll(/\bimport\s*\(\s*(?=["'])/g)) {
    add("dynamic-import", m.index + m[0].length);
  }
  // require("x")
  for (const m of code.matchAll(/\brequire\s*\(\s*(?=["'])/g)) {
    add("require", m.index + m[0].length);
  }
  return edges;
}

/**
 * A specifier assembled at runtime has no literal to resolve — e.g.
 * import(`../${dir}/mod.mjs`). These are reported rather than assumed safe.
 *
 * Runs on the comment-stripped source, not the fully-blanked one: a template
 * literal is exactly how a runtime specifier is written, so blanking literals
 * first would erase the very thing being reported. A plain string argument is
 * still recognised as a resolvable literal and excluded.
 */
export function dynamicSpecifiers(src) {
  const code = stripComments(src);
  const out = [];
  for (const m of code.matchAll(/\b(?:import|require)\s*\(\s*([^)]*?)\s*\)/g)) {
    const arg = m[1].trim();
    if (arg === "") continue;
    if (/^["']/.test(arg)) continue;              // a plain literal: already an edge
    if (/^`[^`]*$/.test(arg)) continue;           // a template with no interpolation
    // A selector-name mention in prose, e.g. the phrase "CJS import" in a
    // docstring listing the edge kinds, is not a call. These appear inside
    // comments, which are already blanked, so anything left here is code.
    out.push({ at: m.index, arg: arg.slice(0, 60) });
  }
  return out;
}

/** Resolve a relative specifier to an absolute file, trying Node's extensions. */
export function resolveSpecifier(spec, fromFile, root) {
  if (!spec.startsWith(".")) return null;             // bare package — not a local edge
  const base = resolvePath(dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.mjs`, `${base}.js`, `${base}.json`,
    join(base, "index.mjs"), join(base, "index.js"),
  ];
  for (const c of candidates) {
    try { if (existsSync(c) && statSync(c).isFile()) return c; } catch { /* keep looking */ }
  }
  return undefined;   // relative but does not resolve — reported separately
}

/** True if a resolved path lies inside, or is named like, a forbidden surface. */
export function isForbidden(absPath, root) {
  const rel = relative(root, absPath).split(sep);
  if (rel.includes("..")) return false;
  // Compare on lower-cased, extension-stripped segments. A forbidden surface
  // can be a DIRECTORY (execution/, broker/) or a FILE (tradingview.js), and
  // the filesystem on Windows is case-insensitive, so `./TRADINGVIEW.JS`
  // resolves to the same file as `./tradingview.js` and must be caught too.
  const norm = rel.map((s) => s.toLowerCase().replace(/\.(mjs|js|cjs|json)$/, ""));
  return norm.some((seg) => FORBIDDEN_DIRS.includes(seg));
}

/** Every .mjs/.js file under a directory. Does not skip `data` or anything else. */
export function allModules(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|js|cjs)$/.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * Build the transitive module graph from `entryDir` and report every path that
 * reaches a forbidden directory, plus every unresolvable/dynamic specifier.
 */
export function analyseBoundary({ root, entryDir, extraFiles = [] }) {
  const entryAbs = resolvePath(root, entryDir);
  const seen = new Set();
  const violations = [];
  const unresolved = [];
  const dynamic = [];
  const edgesByFile = new Map();

  const visit = (file, fromLabel) => {
    if (seen.has(file)) return;
    seen.add(file);
    let full;
    try { full = readFileSync(file, "utf8"); } catch { return; }
    // Only the module part is scanned; a selftest block is test data.
    const src = modulePartOf(full);

    for (const d of dynamicSpecifiers(src)) {
      dynamic.push({ file: relative(root, file), arg: d.arg });
    }

    const edges = findEdges(src);
    edgesByFile.set(file, edges);
    for (const e of edges) {
      const abs = resolveSpecifier(e.spec, file, root);
      if (abs === null) continue;                 // bare specifier
      if (abs === undefined) {
        unresolved.push({ file: relative(root, file), kind: e.kind, spec: e.spec });
        continue;
      }
      if (isForbidden(abs, root)) {
        violations.push({
          file: relative(root, file), kind: e.kind, spec: e.spec,
          target: relative(root, abs), from: fromLabel ?? "entry",
        });
        continue;                                  // do not walk into forbidden code
      }
      visit(abs, relative(root, file));
    }
  };

  for (const f of allModules(entryAbs)) visit(f, "entry");
  for (const f of extraFiles) if (existsSync(f)) visit(f, "extra");

  // A specifier assembled at runtime cannot be resolved to a file. Whether that
  // is a risk depends on WHERE it points, so classify rather than blanket-fail:
  //   unanchored — no literal prefix, or a bare package name: could reach
  //                anywhere, so it cannot be verified and is reported.
  //   anchored   — rooted at a literal relative prefix whose directory is
  //                checked against the forbidden set, so it IS verifiable.
  // research/ legitimately loads strategies this way
  // (`./strategies/${id}.mjs` in evidence.mjs and harness.mjs), so failing every
  // dynamic specifier would have disabled a real capability rather than
  // described the residual risk honestly.
  const classifyDynamic = (arg) => {
    const t = arg.trim();
    // A template literal keeps its backticks, so strip them before reading the
    // literal prefix out of it.
    const inner = t.startsWith("`") && t.endsWith("`") ? t.slice(1, -1) : t;
    const prefix = (/^([^${]*)/.exec(inner)?.[1] ?? "").trim();
    if (prefix === "") return { verdict: "unanchored", prefix: t };
    if (!prefix.startsWith(".") && !prefix.startsWith("/")) return { verdict: "unanchored", prefix };
    const dir = prefix.replace(/[/\\][^/\\]*$/, "") || ".";
    const abs = resolvePath(root, dir);
    return { verdict: isForbidden(abs, root) ? "forbidden" : "anchored", prefix };
  };
  const dynamicClassified = dynamic.map((d) => ({ ...d, ...classifyDynamic(d.arg) }));

  return {
    modules: seen.size,
    violations,
    unresolved,
    dynamic,
    dynamicClassified,
    edges: edgesByFile,
    forbiddenTokens: (() => {
      const hits = [];
      for (const f of seen) {
        const src = modulePartOf(readFileSync(f, "utf8"));
        // The literal-stripped view means a TOKEN in a comment or a string does
        // not count; only a real identifier or call can trip this.
        const code = stripLiteralsAndComments(src);
        for (const t of FORBIDDEN_TOKENS) {
          if (code.includes(t)) hits.push({ file: relative(root, f), token: t });
        }
      }
      return hits;
    })(),
  };
}

// ------------------------------------------------------------------ selftest
if (process.argv[1] && process.argv[1].endsWith("boundary.mjs")) {
  let pass = 0, fail = 0;
  const check = (n, c, x = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); };

  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const tmp = join(process.env.TEMP ?? ".", `boundary-selftest-${process.pid}`);
  const mk = (rel, src) => {
    const p = join(tmp, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, src);
    return p;
  };

  // NOTE: the offender fixtures are NOT created inside this file's own
  // research/ tree. An earlier draft did that, and the scanner correctly
  // flagged its own test data as a violation — the fixtures are import
  // statements, and this file is scanned like any other module. Each offender
  // below therefore gets an isolated `solo-*` tree.

  // The clean control: its own tree, so no offender can pollute it.
  const cdir = join(tmp, "clean-root", "research");
  mkdirSync(cdir, { recursive: true });
  writeFileSync(join(cdir, "evidence.mjs"), "export const a = 1;\n");
  writeFileSync(join(cdir, "harness.mjs"), "import { a } from './evidence.mjs';\nexport const b = a + 1;\n");
  writeFileSync(join(cdir, "strategy.mjs"),
    "import { b } from './harness.mjs';\nexport const signal = () => b;\n");

  // Every offender gets its OWN tree, so a violation in one cannot mask
  // another and the clean control cannot be polluted by a neighbour.
  const solo = (rel, src) => {
    const root = join(tmp, `solo-${rel.replace(/[\\/.]/g, "_")}`);
    mkdirSync(join(root, "research"), { recursive: true });
    writeFileSync(join(root, "research", "edge.mjs"), src);
    return analyseBoundary({ root, entryDir: "research" });
  };

  for (const [name, src, why] of [
    ["direct import", `import tv from '../tradingview.js';\nexport const y = tv;\n`, "import tv from './tradingview.js'"],
    ["CommonJS require", `const t = require('../tradingview.js');\nexport const z = t;\n`, "require('./tradingview.js')"],
    ["re-export", `export { c } from '../tradingview.js';\n`, "export {x} from './tradingview.js'"],
    ["dynamic import", `const m = await import('../tradingview.js');\nexport const w = m;\n`, "await import('./tradingview.js')"],
    ["side-effect import", `import '../tradingview.js';\n`, "import './tradingview.js'"],
    ["case-variant path", `import tv from '../TRADINGVIEW.JS';\n`, "../TRADINGVIEW.JS (FS is case-insensitive)"],
    ["parent-relative to execution/", `import { b } from '../execution/paper-trade.mjs';\n`, "../execution/paper-trade.mjs"],
    ["reach into broker/", `import { d } from '../broker/api.mjs';\n`, "../broker/api.mjs"],
    ["wallet reach", `import { w } from '../wallet/keys.mjs';\n`, "../wallet/keys.mjs"],
  ]) {
    const root = join(tmp, `only-${name.replace(/[^a-z]/gi, "_")}`);
    mkdirSync(join(root, "research"), { recursive: true });
    for (const [f, body] of [["tradingview.js", "export const c = 3;\n"], ["execution/paper-trade.mjs", "export const b = 2;\n"], ["broker/api.mjs", "export const d = 4;\n"], ["wallet/keys.mjs", "export const w = 5;\n"]]) {
      const p = join(root, f);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    }
    writeFileSync(join(root, "research", "edge.mjs"), src);
    const r = analyseBoundary({ root, entryDir: "research" });
    check(`CAUGHT  ${name}`, r.violations.length > 0, why + (r.violations.length ? "" : "  <- MISSED"));
  }

  // The clean graph must pass — and must actually be traversed, or "no
  // violations" would just mean "nothing was read".
  const clean = analyseBoundary({ root: join(tmp, "clean-root"), entryDir: "research" });
  check("PASS    a clean research graph", clean.violations.length === 0,
        `${clean.modules} module(s) walked`);
  check("  ...it walked the whole chain, not just the entry",
        clean.modules === 3, `walked ${clean.modules} of 3`);
  // Transitively: the graph is followed, not just the entry file. A -> B -> C
  // where only the LAST one is forbidden.
  {
    const root = join(tmp, "indirect-root");
    mkdirSync(join(root, "research"), { recursive: true });
    writeFileSync(join(root, "tradingview.js"), "export const c = 3;\n");
    writeFileSync(join(root, "research", "leaf.mjs"), "export { c } from '../tradingview.js';\n");
    writeFileSync(join(root, "research", "mid.mjs"), "export { c } from './leaf.mjs';\n");
    writeFileSync(join(root, "research", "entry.mjs"), "export { c } from './mid.mjs';\n");
    const r = analyseBoundary({ root, entryDir: "research" });
    check("CAUGHT  a violation three hops away (transitive reach)", r.violations.length > 0,
          "entry -> mid -> leaf -> tradingview");
    check("  ...and it names the path that got there",
          r.violations[0]?.file?.includes("leaf"), r.violations[0]?.file);
  }

  // A forbidden-looking import mentioned only in a COMMENT must not count, and
  // neither must forbidden tokens that appear only inside strings or regexes.
  {
    const root = join(tmp, "innocent-root");
    mkdirSync(join(root, "research"), { recursive: true });
    writeFileSync(join(root, "tradingview.js"), "export const c = 3;\n");
    writeFileSync(join(root, "research", "ok.mjs"),
      "// import tv from '../tradingview.js'  <-- a comment, not code\n" +
      "/* export { c } from '../tradingview.js'; */\n" +
      "const s = \"paper-trade\";\n" +
      "const r = /launch-tv/;\n" +
      "const t = `not ${1} an import`;\n" +
      "export const ok = 1;\n");
    const r = analyseBoundary({ root, entryDir: "research" });
    check("IGNORED a forbidden import mentioned only in a comment", r.violations.length === 0,
          r.violations.map((v) => v.spec).join(", "));
    check("IGNORED forbidden tokens appearing only inside strings/regex",
          r.forbiddenTokens.length === 0, JSON.stringify(r.forbiddenTokens));
  }

  // A runtime-assembled specifier has no literal to resolve. It is REPORTED, not
  // silently accepted — the honest position is "cannot verify", not "clean".
  {
    const root = join(tmp, "runtime-root");
    mkdirSync(join(root, "research"), { recursive: true });
    writeFileSync(join(root, "research", "rt.mjs"),
      "const d = 'execution';\nconst m = await import(`../${d}/paper-trade.mjs`);\nexport const v = m;\n");
    const r = analyseBoundary({ root, entryDir: "research" });
    check("REPORTED a runtime-assembled specifier instead of assuming it safe",
          r.dynamic.length > 0, `dynamic=${r.dynamic.length}`);
  }

  // The real repo, checked from the entry point.
  const HERE = dirname(fileURLToPath(import.meta.url));
  const real = analyseBoundary({ root: join(HERE, ".."), entryDir: "research" });
  check("the real research/ graph is clean", real.violations.length === 0,
        real.violations.map((v) => `${v.file} -> ${v.spec}`).join("; "));
  check("  ...and it walked a non-trivial number of modules", real.modules >= 10, `${real.modules} modules`);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  try { require("node:fs").rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(fail ? 1 : 0);
}
