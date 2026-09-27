#!/usr/bin/env node
/**
 * frontend/server.mjs — the command centre.
 *
 * A third layer. It sits above research/ and execution/ and is the only thing
 * that can see both, which is exactly the separation the repo already insists
 * on: research can never reach an order, execution can never reach a hypothesis,
 * and the console does not merge them. It reads the evidence files, spawns the
 * CLIs, and streams state over SSE.
 *
 * Zero dependencies. node:http only. Runs with: node frontend/server.mjs
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ROOT, PUBLIC, P, CACHE, ensureCache, safeJoin, readJson } from "./lib/repo.mjs";
import { sseHandler, publish, clientCount } from "./lib/sse.mjs";
import * as A from "./lib/analytics.mjs";
import { execution, repo, firstJson } from "./lib/proc.mjs";
import { submit, getJob, cancel, activeJob, snapshot } from "./lib/jobs.mjs";

const PORT = Number(process.env.PORT ?? 7878);
const HOST = process.env.HOST ?? "127.0.0.1";

ensureCache();

// ---------------------------------------------------------------- file watching

/** Realtime without polling the disk on a timer. The registry, the audit log
 *  and the risk config are the three things that change under the console. */
const watchers = [];
function watch(file, label) {
  try {
    const w = fs.watch(file, { persistent: false }, () => {
      publish("invalidate", { label, at: Date.now() });
    });
    w.on("error", () => {});
    watchers.push(w);
  } catch {
    /* file may not exist yet; the poll endpoint still covers it */
  }
}
watch(P.state, "state");
watch(P.audit, "audit");
watch(P.risk, "risk");
try {
  const w = fs.watch(P.registryDir, { recursive: true, persistent: false }, () => publish("invalidate", { label: "registry", at: Date.now() }));
  w.on("error", () => {});
  watchers.push(w);
} catch {
  /* recursive watch unsupported on this platform; polling still works */
}

// ------------------------------------------------------------------ tiny router

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const rx = new RegExp(
    "^" +
      pattern
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/:(\w+)/g, (_, k) => {
          keys.push(k);
          return "([^/]+)";
        }) +
      "$"
  );
  routes.push({ method, rx, keys, handler });
};

const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload), "Cache-Control": "no-store" });
  res.end(payload);
};

const fail = (res, code, message, extra = {}) => json(res, code, { error: message, ...extra });

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("body must be JSON");
  }
}

// ------------------------------------------------------------------ card index

function cardIndex() {
  const buckets = ["tested", "proposed", "queued", "blocked", "controls", "falsified", "champion"];
  const out = [];
  for (const bucket of buckets) {
    const dir = path.join(P.cards, bucket);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const f of files) {
      const full = path.join(dir, f);
      let head = [];
      try {
        head = fs
          .readFileSync(full, "utf8")
          .split("\n")
          .slice(0, 24)
          .filter((l) => l.trim());
      } catch {
        /* unreadable card still lists */
      }
      out.push({
        bucket,
        id: f.replace(/\.md$/, ""),
        rel: path.relative(ROOT, full).split(path.sep).join("/"),
        title: (head.find((l) => l.startsWith("# ")) ?? `# ${f}`).slice(2).trim(),
        status: (head.find((l) => /^\*?\*?(status|verdict)/i.test(l)) ?? "").replace(/^[*_#\s]+/, "").slice(0, 120),
        lines: head.length,
      });
    }
  }
  // Any bucket not in the known list, so a new one is never invisible.
  try {
    for (const d of fs.readdirSync(P.cards, { withFileTypes: true })) {
      if (!d.isDirectory() || buckets.includes(d.name)) continue;
      for (const f of fs.readdirSync(path.join(P.cards, d.name)).filter((x) => x.endsWith(".md"))) {
        const rel = path.relative(ROOT, path.join(P.cards, d.name, f)).split(path.sep).join("/");
        out.push({ bucket: d.name, id: f.replace(/\.md$/, ""), rel, title: f, status: "", lines: 0 });
      }
    }
  } catch {
    /* no cards dir */
  }
  return out;
}

const DOCS = {
  playbook: P.playbook,
  backlog: P.backlog,
  schema: P.schema,
  template: P.template,
  agent: P.agent,
  readme: P.readme,
};

// ---------------------------------------------------------------------- routes

route("GET", "/api/bootstrap", (req, res) => {
  const proto = A.protocol();
  json(res, 200, {
    root: ROOT,
    protocol: proto,
    state: A.registryState(),
    risk: A.riskConfig(),
    catalog: A.strategyCatalog(),
    heatmap: A.buildHeatmap(),
    coverage: A.datasetCoverage(),
    backtest: snapshot(),
    client: { sse: clientCount() },
    cards: cardIndex(),
  });
});

route("GET", "/api/leaderboard", (req, res) => {
  const runs = A.latestRuns();
  const proto = A.protocol();
  const minPf = proto?.criteria?.MIN_PF ?? 1.3;
  json(res, 200, {
    rows: runs.map((r) => ({
      strategyId: r.strategyId,
      isControl: r.isControl,
      runCount: r.runCount,
      trades: r.latest.trades,
      winRate: null,
      profitFactor: r.latest.profit_factor,
      sharpe: r.latest.sharpe,
      tstat: r.latest.tstat,
      sharpeLcb: r.latest.sharpe_lcb,
      maxDrawdownPct: r.latest.max_drawdown_pct,
      totalReturnPct: r.latest.total_return_pct,
      passed: r.latest.passed,
      unmet: (r.latest.failed ?? []).length,
      ts: r.latest.ts,
      datasetHash: r.latest.dataset_hash,
      protocolHash: r.latest.protocol_hash,
    })),
    thresholds: proto?.criteria ?? {},
    minPf,
  });
});

route("GET", "/api/strategy/:id", (req, res, params) => {
  const id = params.id;
  const safe = safeJoin(P.registryDir, id);
  if (!safe) return fail(res, 400, "bad strategy id");
  const file = path.join(safe, "runs.jsonl");
  if (!fs.existsSync(file)) return fail(res, 404, `no run records for "${id}" — it has never been run`);
  const history = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const heat = A.buildHeatmap();
  const detail = heat.detail[id] ?? [];
  // Newest cached artifact for this strategy carries the full diagnostics.
  let artifact = null;
  try {
    const files = fs
      .readdirSync(CACHE)
      .filter((f) => f.includes(`-${id}-`) && f.endsWith(".json"))
      .sort();
    if (files.length) artifact = readJson(path.join(CACHE, files[files.length - 1]));
  } catch {
    /* none */
  }
  json(res, 200, { id, history, latest: history[history.length - 1], checks: detail, artifact, extraColumns: heat.extraColumns });
});

route("GET", "/api/equity/:id", (req, res, params, url) => {
  const id = params.id;
  if (!/^[\w.-]+$/.test(id)) return fail(res, 400, "bad strategy id");
  if (!fs.existsSync(path.join(P.strategyDir, `${id}.mjs`))) return fail(res, 404, `no strategy code for "${id}"`);
  const q = url.searchParams;
  const req1 = {
    strategy: id,
    tf: q.get("tf") ?? "15m",
    days: Math.min(400, Math.max(1, Number(q.get("days") ?? 400))),
    equity: Number(q.get("equity") ?? 1000),
    riskPct: Number(q.get("risk") ?? 0.01),
    maxHoldBars: Number(q.get("hold") ?? 96),
    force: q.get("force") === "1",
  };
  try {
    const r = submit({ job: "equity", ...req1 });
    json(res, 202, { jobId: r.id, queued: Boolean(r.queued), cached: Boolean(r.cached) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route("GET", "/api/job/:id", (req, res, params) => {
  const j = getJob(params.id);
  if (!j) return fail(res, 404, "unknown job");
  json(res, 200, {
    id: j.id,
    job: j.job,
    strategy: j.strategy,
    tf: j.tf,
    days: j.days,
    status: j.status,
    phase: j.phase,
    phaseDetail: j.phaseDetail ?? null,
    elapsedMs: j.elapsedMs,
    logs: j.logs.slice(-200),
    result: j.result,
    error: j.error,
    artifact: j.artifact ?? null,
  });
});

route("GET", "/api/backtests", (req, res) => json(res, 200, snapshot()));

route("POST", "/api/backtest", async (req, res) => {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return fail(res, 400, err.message);
  }
  try {
    const r = submit({
      job: "run",
      strategy: String(body.strategy ?? ""),
      tf: String(body.tf ?? "15m"),
      days: Math.min(400, Math.max(1, Number(body.days ?? 400))),
      equity: Math.max(1, Number(body.equity ?? 1000)),
      riskPct: Math.min(0.5, Math.max(0.0001, Number(body.risk ?? 0.01))),
      maxHoldBars: Math.max(1, Math.min(100000, Number(body.hold ?? 96))),
      to: body.to || undefined,
    });
    json(res, 202, { id: r.id, queued: Boolean(r.queued) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

/** The spawn fallback. Same arguments as the worker path, but goes through the
 *  run.mjs CLI and reads the JSON report it prints. */
route("POST", "/api/backtest/spawn", async (req, res) => {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return fail(res, 400, err.message);
  }
  const args = [
    "--strategy",
    String(body.strategy ?? "sweep-reversal"),
    "--tf",
    String(body.tf ?? "15m"),
    "--days",
    String(body.days ?? 400),
    "--equity",
    String(body.equity ?? 1000),
    "--risk",
    String(body.risk ?? 0.01),
    "--hold",
    String(body.hold ?? 96),
  ];
  publish("backtest", { id: "spawn", event: "phase", phase: "spawning", detail: `node research/run.mjs ${args.join(" ")}` });
  const r = await repo.backtest(args, {
    onLine: (line) => publish("backtest", { id: "spawn", event: "log", line }),
  });
  const data = firstJson(r.stdout);
  publish("backtest", { id: "spawn", event: r.ok ? "done" : "failed", elapsedMs: 0, error: r.ok ? null : r.stderr });
  json(res, r.ok ? 200 : 500, { ok: r.ok, exit: r.code, result: data, stderr: r.stderr?.slice(-4000) ?? "" });
});

route("POST", "/api/backtest/:id/cancel", (req, res, params) => {
  const ok = cancel(params.id);
  json(res, ok ? 200 : 404, { cancelled: ok });
});

// ------------------------------------------------------------------- execution

route("GET", "/api/tv", async (req, res) => {
  const r = await execution.status();
  json(res, 200, r);
});
route("GET", "/api/account", async (req, res) => {
  const r = await execution.account();
  json(res, 200, r);
});
route("GET", "/api/positions", async (req, res) => {
  const r = await execution.positions();
  json(res, 200, r);
});

/** Sizing only. The risk engine decides and nothing is clicked. */
route("POST", "/api/propose", async (req, res) => {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return fail(res, 400, err.message);
  }
  const side = body.side === "sell" ? "sell" : "buy";
  const symbol = String(body.symbol ?? "").trim();
  if (!/^[\w.:-]{1,24}$/.test(symbol)) return fail(res, 400, "bad symbol");
  const r = await execution.propose(side, symbol, String(body.thesis ?? ""));
  json(res, 200, r);
});

/** Places a real paper order on the TradingView canvas. The risk gate runs
 *  first inside paper-trade.mjs and can still block it, so the response carries
 *  the gate's own verdict rather than a bare ok. */
route("POST", "/api/order", async (req, res) => {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return fail(res, 400, err.message);
  }
  if (body.confirm !== true) return fail(res, 400, "order requires confirm:true — the UI must show the gate verdict first");
  const side = body.side === "sell" ? "sell" : "buy";
  const qty = Number(body.qty);
  const symbol = String(body.symbol ?? "").trim();
  if (!/^[\w.:-]{1,24}$/.test(symbol)) return fail(res, 400, "bad symbol");
  if (!Number.isFinite(qty) || qty <= 0) return fail(res, 400, "qty must be a positive number");
  const extra = [];
  if (body.limit) extra.push("--limit", String(body.limit));
  if (body.reduceOnly) extra.push("--close");
  if (body.reduceOnly) extra.push("--rth");
  const r = await execution.order(side, qty, symbol, extra);
  publish("invalidate", { label: "audit", at: Date.now() });
  json(res, 200, r);
});

route("GET", "/api/risk", (req, res) => json(res, 200, A.riskConfig()));

/** Flips kill_switch in place, preserving every other key including the _comment
 *  documentation block, then republishes so every open tab sees it at once. */
route("POST", "/api/risk/kill-switch", async (req, res) => {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return fail(res, 400, err.message);
  }
  const on = body.on === true;
  const current = readJson(P.risk, null);
  if (!current) return fail(res, 500, "config/risk.json is missing or unparseable — refusing to guess");
  const next = { ...current, kill_switch: on };
  try {
    fs.writeFileSync(P.risk, JSON.stringify(next, null, 2) + "\n");
  } catch (err) {
    return fail(res, 500, `could not write risk.json: ${err.message}`);
  }
  publish("invalidate", { label: "risk", at: Date.now() });
  publish("killswitch", { on, at: Date.now() });
  json(res, 200, next);
});

route("GET", "/api/audit", (req, res, params, url) => {
  const limit = Math.min(1000, Number(url.searchParams.get("limit") ?? 200));
  json(res, 200, { rows: A.auditTrail(limit), open: A.openOrdersFromAudit() });
});

route("GET", "/api/price", (req, res, params, url) => {
  const q = url.searchParams;
  const symbol = String(q.get("symbol") ?? "BTCUSDT");
  if (!/^[\w.-]{1,20}$/.test(symbol)) return fail(res, 400, "bad symbol");
  const s = A.priceSeries({ symbol, tf: q.get("tf") ?? "15m", points: Math.min(1500, Number(q.get("points") ?? 400)) });
  if (!s) return fail(res, 404, `no cached ${symbol} data — run a backtest to fetch it`);
  json(res, 200, s);
});

// ------------------------------------------------------------------- knowledge

route("GET", "/api/cards", (req, res) => json(res, 200, { cards: cardIndex() }));

route("GET", "/api/card", (req, res, params, url) => {
  const rel = String(url.searchParams.get("rel") ?? "");
  const full = safeJoin(ROOT, rel);
  if (!full) return fail(res, 400, "path escapes the repo");
  if (!full.endsWith(".md") || !fs.existsSync(full)) return fail(res, 404, "not found");
  json(res, 200, { rel, markdown: fs.readFileSync(full, "utf8"), bytes: fs.statSync(full).size });
});

route("GET", "/api/doc", (req, res, params, url) => {
  const name = String(url.searchParams.get("name") ?? "playbook");
  const file = DOCS[name];
  if (!file || !fs.existsSync(file)) return fail(res, 404, "not found");
  json(res, 200, { name, markdown: fs.readFileSync(file, "utf8") });
});

route("POST", "/api/validate-cards", async (req, res) => {
  const r = await repo.validateCards();
  json(res, 200, { ok: r.ok, exit: r.code, output: `${r.stdout}${r.stderr}`.slice(-8000) });
});

route("POST", "/api/verify", async (req, res) => {
  const lines = [];
  const r = await repo.verify({ onLine: (line) => lines.push(line) });
  publish("verify", { done: true, ok: r.ok });
  json(res, 200, { ok: r.ok, exit: r.code, lines: lines.slice(-200) });
});

// ---------------------------------------------------------------- static files

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = safeJoin(PUBLIC, rel);
  if (!file) return fail(res, 400, "bad path");
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // Single-page app: unknown paths fall back to the shell.
    const shell = path.join(PUBLIC, "index.html");
    if (!fs.existsSync(shell)) return fail(res, 404, "not found");
    res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" });
    return res.end(fs.readFileSync(shell));
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  res.end(fs.readFileSync(file));
}

// ------------------------------------------------------------------- the server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === "/events") return sseHandler(req, res);

  if (pathname.startsWith("/api/")) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.rx.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = m[i + 1]));
      try {
        return await r.handler(req, res, params, url);
      } catch (err) {
        if (!res.headersSent) fail(res, 500, err.message);
        return;
      }
    }
    return fail(res, 404, `no route for ${req.method} ${pathname}`);
  }

  if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "method not allowed");
  serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  const heat = A.buildHeatmap();
  const state = A.registryState();
  console.log("");
  console.log("  COMMAND CENTRE");
  console.log(`  http://${HOST}:${PORT}`);
  console.log("");
  console.log(`  repo          ${ROOT}`);
  console.log(`  protocol      ${A.protocol()?.protocol ?? "?"} (${state.protocol_hash ?? "?"})`);
  console.log(`  runs          ${state.total_runs ?? 0} across ${heat.rows.length} strategies`);
  console.log(`  champion      ${state.champion ? state.champion.strategy_id : "none — no strategy has passed the gate"}`);
  console.log(`  run cache     ${CACHE}`);
  console.log("");
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log("\n  closing");
    for (const w of watchers) w.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
