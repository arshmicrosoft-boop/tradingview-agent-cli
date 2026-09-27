// Child-process boundary for everything in execution/ and for the repo's CLI
// entry points.
//
// execution/paper-trade.mjs cannot be imported: it destructures process.argv at
// module top level and calls process.exit(0) inside its dispatcher, so importing
// it would terminate this server. Its stdout contract is, however, clean enough
// to wrap: status / account / positions / buy / sell each print exactly one JSON
// document, and stderr carries the audit line. That is the whole interface.

import { spawn } from "node:child_process";
import { ROOT, P } from "./repo.mjs";

const NODE = process.execPath;

/**
 * Run a node script and resolve with its result.
 * @param {string[]} args  argv after the script path
 * @param {object} opts
 * @param {(line:string, stream:'out'|'err')=>void} [opts.onLine]
 * @param {number} [opts.timeoutMs]
 */
export function runNode(args, { onLine, timeoutMs = 180000, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    const child = spawn(NODE, args, { cwd, windowsHide: true });
    let timedOut = false;

    const collect = (stream, which) => {
      let buf = "";
      let acc = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        acc += chunk;
        if (!onLine) return;
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) onLine(line, which);
      });
      stream.on("end", () => {
        if (buf.trim()) onLine?.(buf.trim(), which);
      });
      return () => acc;
    };

    const getOut = collect(child.stdout, "out");
    const getErr = collect(child.stderr, "err");

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout: getOut(), stderr: getErr() + "\nspawn error: " + err.message, error: err.message });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: getOut(), stderr: getErr(), timedOut });
    });
  });
}

/** Extract the first balanced JSON document from stdout.
 *  `propose` prints two documents back to back on success, so a whole-string
 *  parse is not an option; `report()` in run.mjs appends human text after its
 *  JSON for the same reason. */
export function firstJson(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function allJson(text) {
  const docs = [];
  let i = 0;
  let rest = text;
  while (i < 400) {
    const doc = firstJson(rest);
    if (!doc) break;
    docs.push(doc);
    const at = rest.indexOf("{");
    rest = rest.slice(at + 1);
    i++;
  }
  return docs;
}

/** Spawn an execution/ subcommand and parse its JSON stdout. */
export async function paperTrade(args, opts = {}) {
  const res = await runNode([P.paperTrade, ...args], { timeoutMs: opts.timeoutMs ?? 120000, onLine: opts.onLine });
  const json = firstJson(res.stdout);
  return {
    ok: res.ok && json != null,
    exit: res.code,
    data: json,
    stdout: res.stdout,
    stderr: res.stderr,
    error: res.ok ? (json == null ? "no JSON on stdout — is TradingView running? (npm run tv:launch)" : null) : tail(res.stderr || res.stdout),
  };
}

export const execution = {
  status: (o) => paperTrade(["status"], o),
  account: (o) => paperTrade(["account"], o),
  positions: (o) => paperTrade(["positions"], o),
  /** Sizing only. The risk engine decides; nothing is clicked. */
  propose: (side, symbol, thesis, o) =>
    paperTrade(["propose", side, symbol, "--thesis", thesis || "", "--dry-run"], o),
  order: (side, qty, symbol, extra, o) =>
    paperTrade([side, String(qty), symbol, ...(extra ?? [])], { timeoutMs: 180000, ...o }),
};

export const repo = {
  verify: (o) => runNode([P.verify], { timeoutMs: 600000, onLine: o?.onLine }),
  validateCards: (o) => runNode([P.validate], { timeoutMs: 120000, onLine: o?.onLine }),
  /** The spawn fallback for a backtest, used when the in-process worker path
   *  is unavailable. run.mjs prints its JSON report first, then human text. */
  backtest: (args, o) => runNode([path_("research", "run.mjs"), ...args], { timeoutMs: 3600000, onLine: o?.onLine }),
};

function path_(...parts) {
  return ROOT + "\\" + parts.join("\\");
}

function tail(text, n = 6) {
  return String(text ?? "")
    .split("\n")
    .filter((l) => l.trim())
    .slice(-n)
    .join("\n");
}
