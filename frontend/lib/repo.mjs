// Resolve the repo root from this file's location so nothing is ever
// hardcoded to a machine. frontend/lib/repo.mjs -> frontend/lib -> frontend -> <root>
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, "..", "..");
export const RESEARCH = path.join(ROOT, "research");
export const EXECUTION = path.join(ROOT, "execution");
export const CONFIG = path.join(ROOT, "config");
export const STRATEGIES = path.join(ROOT, "strategies");
export const FRONTEND = path.join(ROOT, "frontend");
export const PUBLIC = path.join(FRONTEND, "public");
/** Run artifacts cached by the console. Not evidence, so not tracked by git. */
export const CACHE = path.join(FRONTEND, "data", "runs");

export const P = {
  protocol: path.join(RESEARCH, "protocol.v1.json"),
  state: path.join(RESEARCH, "registry", "state.json"),
  registryDir: path.join(RESEARCH, "registry"),
  dataDir: path.join(RESEARCH, "data"),
  strategyDir: path.join(RESEARCH, "strategies"),
  risk: path.join(CONFIG, "risk.json"),
  audit: path.join(CONFIG, "audit.jsonl"),
  cards: path.join(STRATEGIES, "cards"),
  playbook: path.join(STRATEGIES, "PLAYBOOK.md"),
  backlog: path.join(STRATEGIES, "BACKLOG.md"),
  schema: path.join(STRATEGIES, "SCHEMA.md"),
  template: path.join(STRATEGIES, "TEMPLATE.md"),
  agent: path.join(ROOT, "AGENT.md"),
  readme: path.join(ROOT, "README.md"),
  validate: path.join(STRATEGIES, "validate.mjs"),
  verify: path.join(ROOT, "verify.mjs"),
  paperTrade: path.join(EXECUTION, "paper-trade.mjs"),
};

export function ensureCache() {
  fs.mkdirSync(CACHE, { recursive: true });
  return CACHE;
}

/** Reject any path that escapes `root`. The card/doc endpoints take names from
 *  the query string, so this is the boundary that keeps `..` out of the disk. */
export function safeJoin(root, ...segments) {
  const target = path.resolve(root, ...segments);
  const normRoot = path.resolve(root);
  if (target !== normRoot && !target.startsWith(normRoot + path.sep)) return null;
  return target;
}

export const readJson = (file, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

/** Read a JSONL file, dropping unparseable lines rather than failing the page. */
export function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* a torn line from an interrupted append is not worth failing over */
    }
  }
  return out;
}
