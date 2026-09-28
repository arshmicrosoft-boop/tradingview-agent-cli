// Command Centre client. Plain ES modules, no build step, no framework.
//
// Rules this file follows:
//  * The repo's evidence files are the only source of truth. Nothing is invented
//    client-side; if the server cannot tell us a value we render "—".
//  * Nothing touches TradingView unless the operator presses the button that says
//    it will. Loading the console never spawns a child process against the desktop
//    app, because reading positions is not free and the challenge account is real.
//  * An order can only be submitted after its proposal has been shown, and the
//    server independently refuses any order without confirm:true.

import * as C from "./charts.js";
import { renderMarkdown } from "./markdown.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const MONO = 'ui-monospace, "Cascadia Code", Menlo, Consolas, monospace';

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "DOGEUSDT", "SOLUSDT", "ZECUSDT"];

const S = {
  view: "dashboard",
  boot: null,
  leaderboard: null,
  selected: null,      // strategy id shown in the strategy + equity panes
  strategyData: null,
  equity: new Map(),   // strategyId -> {series, perSymbol, initialEquity}
  equityPending: new Set(),
  job: null,           // active backtest job
  jobLogs: [],
  propose: null,       // last dry-run proposal
  tv: { touched: false, data: null },
  priceSymbol: "BTCUSDT",
  card: null,
  doc: "playbook",
  integrity: [],
};

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : "—");
const n3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : "—");
const pct = (v) => (Number.isFinite(v) ? v.toFixed(2) + "%" : "—");
const int = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString() : "—");
const sign = (v) => (Number.isFinite(v) ? (v > 0 ? "pos" : v < 0 ? "neg" : "muted") : "muted");
const tcol = (v, d = 0) => (Number.isFinite(v) ? `color:${v > d ? "#3fb950" : v < -d ? "#f85149" : "#8b95ad"}` : "");

// ───────────────────────────────────────────────────────────────────── api
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 400) }; }
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
  return data;
}

const log = (line, cls = "") => {
  S.jobLogs.push({ line, cls });
  if (S.jobLogs.length > 400) S.jobLogs.splice(0, S.jobLogs.length - 400);
  const el = $("#bt-log");
  if (!el) return;
  el.innerHTML = S.jobLogs.map((l) => `<div class="${l.cls}">${esc(l.line)}</div>`).join("");
};

// ───────────────────────────────────────────────────────────────── routing
function show(view) {
  S.view = view;
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  $$(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === view));
  paint();
}

function paint() {
  if (!S.boot) return;
  ({
    dashboard: paintDashboard,
    strategy: paintStrategy,
    backtest: paintBacktest,
    execution: paintExecution,
    knowledge: paintKnowledge,
  })[S.view]();
}

// ────────────────────────────────────────────────────────────── dashboard
function paintDashboard() {
  const b = S.boot;
  const heat = b.heatmap ?? { rows: [] };
  const lb = S.leaderboard?.rows ?? [];
  const thr = S.leaderboard?.thresholds ?? {};

  $("#tb-runs").textContent = int(b.state?.total_runs);
  $("#tb-strategies").textContent = int(heat.rows.length);
  $("#tb-protocol").textContent = b.protocol?.protocol ?? "—";
  $("#tb-champion").textContent = b.state?.champion?.strategy_id ?? "none";
  const kill = b.risk?.kill_switch === true;
  const killEl = $("#tb-kill");
  killEl.textContent = kill ? "ON" : "OFF";
  killEl.className = kill ? "kill-on" : "kill-off";

  $("#k-runs").textContent = int(b.state?.total_runs);
  const bestUnmet = heat.rows.length ? Math.min(...heat.rows.map((r) => r.unmet)) : null;
  $("#k-unmet").textContent = bestUnmet ?? "—";
  $("#k-pass").textContent = heat.rows.filter((r) => r.passed).length;
  $("#k-cards").textContent = (b.cards ?? []).length;
  $("#k-verdict").innerHTML = b.state?.champion
    ? `Champion: <b>${esc(b.state.champion.strategy_id)}</b>`
    : `No strategy has passed the gate. Best is <b>${bestUnmet ?? "—"} unmet criteria</b> of ~28. Every hypothesis tested so far is falsified.`;

  // leaderboard with a signed sharpe bar
  const maxAbs = Math.max(0.1, ...lb.map((r) => Math.abs(r.sharpe ?? 0)));
  $("#leaderboard").innerHTML = `
    <table><thead><tr>
      <th>strategy</th><th>PF</th><th>sharpe</th><th>t</th><th>maxDD</th><th>return</th><th>trades</th><th>unmet</th>
    </tr></thead><tbody>${lb
      .map(
        (r) => `<tr data-id="${esc(r.strategyId)}">
        <td>${r.isControl ? '<span class="pill ctl">ctl</span> ' : ""}${esc(r.strategyId)}</td>
        <td class="num ${r.profitFactor >= 1 ? "pos" : "neg"}">${n3(r.profitFactor)}</td>
        <td class="num" style="${tcol(r.sharpe, 0.01)}">${n3(r.sharpe)}</td>
        <td class="num" style="${tcol(r.tstat, 1)}">${n2(r.tstat)}</td>
        <td class="num neg">${pct(r.maxDrawdownPct)}</td>
        <td class="num" style="${tcol(r.totalReturnPct, 0)}">${pct(r.totalReturnPct)}</td>
        <td class="num muted">${int(r.trades)}</td>
        <td class="num">${r.passed ? '<span class="pill pass">pass</span>' : `<span class="pill fail">${r.unmet}</span>`}</td>
      </tr>`,
      )
      .join("")}</tbody></table>`;
  $$("#leaderboard tr[data-id]").forEach((tr) =>
    tr.addEventListener("click", () => {
      S.selected = tr.dataset.id;
      show("strategy");
    }),
  );
  void maxAbs;

  C.heatmap($("#c-heatmap"), heat);
  C.scatter($("#c-scatter"), lb, thr);
  C.bars($("#c-sharpe"), lb.map((r) => ({ label: r.strategyId, value: r.sharpe, isControl: r.isControl })), {
    rotateLabels: true,
  });

  // coverage
  $("#coverage").innerHTML = `<table><thead><tr><th>symbol</th><th>tf</th><th>bars</th><th>days</th><th>gaps</th></tr></thead><tbody>${(
    b.coverage ?? []
  )
    .map(
      (c) =>
        `<tr><td>${esc(c.symbol)}</td><td>${esc(c.tf)}</td><td class="num">${int(c.bars)}</td><td class="num">${c.days}</td><td class="num ${c.gaps ? "warnc" : "muted"}">${c.gaps}</td></tr>`,
    )
    .join("")}</tbody></table>`;

  paintEquity($("#c-equity"), $("#eq-stats"), $("#eq-label"), S.selected);
}

// ────────────────────────────────────────────────────────────── strategy
async function paintStrategy() {
  const cat = S.boot.catalog ?? [];
  const sel = S.selected ?? (S.boot.heatmap?.rows?.[0]?.strategyId ?? cat[0]?.id);
  S.selected = sel;

  $("#str-picker").innerHTML = cat
    .map(
      (c) => `<button class="pick ${c.id === sel ? "sel" : ""} ${c.everRun ? "" : "never"}" data-id="${esc(c.id)}">
        <span class="nm">${c.isControl ? "◇ " : ""}${esc(c.id)}</span>
        <span class="mt">${c.everRun ? n3(c.sharpe) : "never run"}</span>
      </button>`,
    )
    .join("");
  $$("#str-picker .pick").forEach((b) =>
    b.addEventListener("click", () => {
      S.selected = b.dataset.id;
      S.strategyData = null;
      paintStrategy();
    }),
  );

  $("#str-title").textContent = sel ?? "—";
  renderMetricTiles($("#str-metrics"), []);

  if (!sel) return;

  if (!S.strategyData || S.strategyData.id !== sel) {
    try {
      S.strategyData = await api(`/api/strategy/${encodeURIComponent(sel)}`);
    } catch (err) {
      S.strategyData = { id: sel, error: err.message, history: [], checks: [] };
    }
  }
  const d = S.strategyData;
  const l = d.latest ?? {};

  renderMetricTiles($("#str-metrics"), [
    ["profit factor", n3(l.profit_factor), (l.profit_factor ?? 0) >= 1 ? "pass" : "fail"],
    ["sharpe", n3(l.sharpe), (l.sharpe ?? 0) > 0 ? "pass" : "fail"],
    ["t-stat", n2(l.tstat), Math.abs(l.tstat ?? 0) > 2 ? "pass" : "fail"],
    ["sharpe LCB", n3(l.sharpe_lcb), "warn"],
    ["max drawdown", pct(l.max_drawdown_pct), "fail"],
    ["total return", pct(l.total_return_pct), "fail"],
    ["trades", int(l.trades), ""],
    ["criteria unmet", int((l.failed ?? []).length), "fail"],
  ]);

  const checks = d.checks ?? [];
  $("#str-check-count").textContent = `${checks.filter((c) => c.ok).length}/${checks.length} passed`;
  $("#str-checks").innerHTML = checks.length
    ? checks
        .map((c) => {
          const known = c.known !== false;
          const k = known ? (c.ok ? "ok" : "bad") : "unk";
          const mark = known ? (c.ok ? "✓" : "✗") : "?";
          const val = known && c.expected && c.expected !== "-" ? `${c.actual} / ${c.expected}` : c.actual ?? "";
          return `<div class="chk ${k}"><span class="m">${mark}</span><span class="nm" title="${esc(c.name)}">${esc(c.name)}</span><span class="vl">${esc(val)}</span></div>`;
        })
        .join("")
    : `<p class="result-empty">No checks available — this strategy has never been run.</p>`;

  const hist = d.history ?? [];
  $("#str-history").innerHTML = `<table><thead><tr><th>ts</th><th>PF</th><th>sharpe</th><th>maxDD</th><th>passed</th></tr></thead><tbody>${hist
    .slice()
    .reverse()
    .map(
      (r) => `<tr><td class="muted">${esc((r.ts ?? "").slice(0, 19).replace("T", " "))}</td>
      <td class="num ${r.profit_factor >= 1 ? "pos" : "neg"}">${n3(r.profit_factor)}</td>
      <td class="num" style="${tcol(r.sharpe, 0.01)}">${n3(r.sharpe)}</td>
      <td class="num neg">${pct(r.max_drawdown_pct)}</td>
      <td>${r.passed ? '<span class="pill pass">pass</span>' : `<span class="pill fail">${(r.failed ?? []).length}</span>`}</td></tr>`,
    )
    .join("")}</tbody></table>`;

  paintEquity($("#c-str-equity"), null, null, sel);
}

function renderMetricTiles(el, tiles) {
  el.innerHTML = tiles
    .map(([label, value, cls]) => `<div class="m ${cls ?? ""}"><b>${esc(value)}</b><i>${esc(label)}</i></div>`)
    .join("");
}

// ────────────────────────────────────────────────────── equity (on demand)
async function paintEquity(canvas, statsEl, labelEl, id) {
  if (!canvas) return;
  if (!id) {
    C.equity(canvas, [], { empty: "select a strategy" });
    if (statsEl) statsEl.innerHTML = "";
    if (labelEl) labelEl.textContent = "";
    return;
  }
  if (labelEl) labelEl.textContent = id;

  const key = id;
  if (S.equity.has(key)) {
    drawEquity(canvas, statsEl, key);
    return;
  }
  if (S.equityPending.has(key)) return;
  S.equityPending.add(key);
  C.equity(canvas, [], { empty: "re-simulating…" });

  try {
    const r = await api(`/api/equity/${encodeURIComponent(id)}`);
    if (r.cached && S.equity.has(key)) return;
    const job = await pollJob(r.jobId);
    if (job?.result) {
      S.equity.set(key, job.result);
      drawEquity(canvas, statsEl, key);
    } else {
      C.equity(canvas, [], { empty: job?.error ?? "simulation failed" });
    }
  } catch (err) {
    C.equity(canvas, [], { empty: err.message });
  } finally {
    S.equityPending.delete(key);
  }
}

function drawEquity(canvas, statsEl, key) {
  const r = S.equity.get(key);
  if (!r) return;
  const series = r.series ?? [];
  // The pooled view is not a real curve — the harness never pools equity across
  // symbols, by design. So show the largest single symbol and say which.
  const best = series.slice().sort((a, b) => (b.curve?.length ?? 0) - (a.curve?.length ?? 0))[0];
  if (!best) {
    C.equity(canvas, [], { empty: "no curve returned" });
    return;
  }
  const points = best.curve.map((p) => p.e ?? p.equity);
  const first = points[0] ?? 0;
  const last = points[points.length - 1] ?? 0;
  C.equity(canvas, points, { xLabel: best.symbol, xRight: `${points.length} pts`, empty: "no curve" });
  if (statsEl) {
    const totalTrades = series.reduce((a, s) => a + (s.trades ?? 0), 0);
    const ruined = series.filter((s) => s.ruined).length;
    statsEl.innerHTML =
      `<span>symbol <b>${esc(best.symbol)}</b></span>` +
      `<span>equity <b>${int(Math.round(first))} → ${int(Math.round(last))}</b></span>` +
      `<span>return <b class="${last >= first ? "pos" : "neg"}">${(((last - first) / (first || 1)) * 100).toFixed(1)}%</b></span>` +
      `<span>trades <b>${int(totalTrades)}</b></span>` +
      `<span>${series.length} symbols, ${ruined} ruined</span>`;
  }
}

async function pollJob(jobId, onTick) {
  if (!jobId) return null;
  for (let i = 0; i < 900; i++) {
    const j = await api(`/api/job/${jobId}`);
    onTick?.(j);
    if (j.status === "done" || j.status === "error" || j.status === "cancelled") return j;
    await new Promise((r) => setTimeout(r, 350));
  }
  return null;
}

// ────────────────────────────────────────────────────────────── backtest
const PHASES = ["starting", "loading-data", "simulating", "gating", "recording", "done"];

function paintBacktest() {
  const sel = $("#bt-strategy");
  if (sel && !sel.options.length) {
    sel.innerHTML = (S.boot.catalog ?? [])
      .map((c) => `<option value="${esc(c.id)}">${esc(c.id)}${c.everRun ? "" : " (never run)"}</option>`)
      .join("");
  }

  const snap = S.boot.backtest ?? { active: null, queued: 0, recent: [] };
  const active = snap.active;
  const phaseIdx = PHASES.indexOf(active?.phase ?? "idle");

  $("#bt-phases").innerHTML = PHASES.map(
    (p, i) =>
      `<span class="ph ${i < phaseIdx ? "done" : i === phaseIdx && active ? "now" : ""}">${p}</span>`,
  ).join("");
  $("#bt-meter").style.width = active ? `${Math.max(4, ((phaseIdx + 1) / PHASES.length) * 100)}%` : "0%";
  $("#bt-phase").textContent = active ? `${active.job} · ${active.phase}` : "idle";
  $("#bt-elapsed").textContent = active?.detail ?? (snap.queued ? `${snap.queued} queued` : "");
  $("#bt-cancel").disabled = !active;

  $("#bt-recent").innerHTML = `<table><thead><tr><th>id</th><th>job</th><th>strategy</th><th>status</th><th>time</th></tr></thead><tbody>${(
    snap.recent ?? []
  )
    .map(
      (j) => `<tr><td class="muted">${esc(j.id)}</td><td>${esc(j.job)}</td><td>${esc(j.strategy)}</td>
      <td class="${j.status === "done" ? "pos" : j.status === "error" ? "neg" : "warnc"}">${esc(j.status)}</td>
      <td class="muted">${new Date(j.ts).toLocaleTimeString()}</td></tr>`,
    )
    .join("")}</tbody></table>`;
}

function renderRunResult(j) {
  const el = $("#bt-result");
  const r = j?.result;
  if (!r) {
    el.innerHTML = j?.error
      ? `<div class="verdict-box fail"><b>Run failed.</b><br>${esc(j.error)}</div>`
      : '<p class="result-empty">No result yet.</p>';
    return;
  }
  const a = r.aggregate ?? {};
  const v = r.verdict ?? {};
  const checks = (v.checks ?? []).map((c) =>
    Array.isArray(c) ? { name: c[0], actual: c[1], expected: c[2], ok: c[3] } : c,
  );
  const pass = v.pass === true || a.passed === true;

  const metric = (l, val, cls = "") => `<div class="m ${cls}"><b>${esc(val)}</b><i>${esc(l)}</i></div>`;
  el.innerHTML = `
    <div class="result-head">
      <b>${esc(r.strategy ?? r.run?.strategy ?? "")}</b>
      <span class="pill ${pass ? "pass" : "fail"}">${pass ? "GATE PASSED" : `${(v.failed ?? []).length} UNMET`}</span>
      <span class="muted" style="font:400 10px ${MONO}">${Math.round((j.elapsedMs ?? 0) / 100) / 10}s</span>
    </div>
    <div class="metric-grid">
      ${metric("profit factor", n3(a.profitFactor ?? a.profit_factor), (a.profitFactor ?? 0) >= 1 ? "pass" : "fail")}
      ${metric("sharpe", n3(a.sharpe), (a.sharpe ?? 0) > 0 ? "pass" : "fail")}
      ${metric("t-stat", n2(a.tstat ?? a.tstat))}
      ${metric("max drawdown", pct(a.maxDrawdownPct ?? a.max_drawdown_pct), "fail")}
      ${metric("trades", int(a.trades))}
      ${metric("total return", pct(a.totalReturnPct ?? a.total_return_pct), "fail")}
    </div>
    <div class="checks" style="margin-top:9px;max-height:280px">
      ${checks
        .map(
          (c) => `<div class="chk ${c.ok ? "ok" : "bad"}"><span class="m">${c.ok ? "✓" : "✗"}</span>
            <span class="nm" title="${esc(c.name)}">${esc(c.name)}</span>
            <span class="vl">${esc(c.actual ?? "")} / ${esc(c.expected ?? "")}</span></div>`,
        )
        .join("")}
    </div>`;
}

async function startBacktest(mode) {
  const f = $("#bt-form");
  const body = {
    strategy: f.strategy.value,
    tf: f.tf.value,
    days: Number(f.days.value),
    equity: Number(f.equity.value),
    risk: Number(f.risk.value),
    hold: Number(f.hold.value),
  };
  S.jobLogs = [];
  $("#bt-log").innerHTML = "";
  log(`▸ ${mode === "spawn" ? "spawn" : "worker"} run: ${JSON.stringify(body)}`, "hl");

  if (mode === "spawn") {
    try {
      const r = await api("/api/backtest/spawn", { method: "POST", body });
      log(`exit ${r.exit}`, r.ok ? "ok" : "err");
      renderRunResult({ result: r.result, error: r.ok ? null : r.stderr, elapsedMs: 0 });
      await refresh();
    } catch (err) {
      log(err.message, "err");
    }
    return;
  }

  try {
    const r = await api("/api/backtest", { method: "POST", body });
    S.job = r.id;
    log(`job ${r.id}${r.queued ? " (queued)" : " (started)"}`, "hl");
    const done = await pollJob(r.id, (j) => {
      if (j.phaseDetail && j.phase !== $("#bt-phase").textContent.split("· ")[1]) log(j.phaseDetail);
    });
    log(done?.status === "done" ? "✔ run complete" : `✖ ${done?.status}: ${done?.error ?? ""}`, done?.status === "done" ? "ok" : "err");
    renderRunResult(done);
    S.job = null;
    await refresh();
  } catch (err) {
    log(err.message, "err");
    S.job = null;
  }
}

// ───────────────────────────────────────────────────────────── execution
function paintExecution() {
  const risk = S.boot.risk ?? {};
  const keys = ["kill_switch", "max_risk_pct", "max_notional", "max_open_positions", "min_free_margin_pct", "daily_loss_limit_pct", "max_qty_per_symbol", "allowed_symbols", "require_thesis"];
  $("#ex-risk").innerHTML = keys
    .filter((k) => k in risk)
    .map(
      (k) => `<div class="risk-row"><span>${esc(k)}</span><b class="${k === "kill_switch" ? (risk[k] ? "neg" : "pos") : ""}">${
        typeof risk[k] === "boolean" ? (risk[k] ? "true" : "false") : Array.isArray(risk[k]) ? risk[k].length + " symbols" : esc(risk[k])
      }</b></div>`,
    )
    .join("");

  if (!S.tv.touched) {
    $("#ex-account").innerHTML = `<div class="m"><b>—</b><i>not read</i></div>`;
    $("#ex-positions").innerHTML = `<p class="result-empty">Reading positions spawns a child process against the TradingView desktop app. Press <b>Read from TradingView</b> to do it.</p>`;
    renderAudit(S.boot.auditRows ?? []);
    return;
  }
  if (S.tv.data) {
    const d = S.tv.data;
    $("#ex-account").innerHTML =
      `<div class="m"><b>${esc(d.ok === false ? "error" : (d.equity ?? d.account ?? "—"))}</b><i>equity</i></div>` +
      `<div class="m"><b>${esc(d.balance ?? d.available ?? "—")}</b><i>balance</i></div>` +
      `<div class="m"><b>${esc(d.margin ?? d.used ?? "—")}</b><i>margin</i></div>` +
      `<div class="m"><b>${esc(d.leverage ?? d.leverage ?? "—")}</b><i>leverage</i></div>`;
    $("#ex-positions").innerHTML = Array.isArray(d.positions) && d.positions.length
      ? `<table><thead><tr><th>symbol</th><th>side</th><th>qty</th><th>entry</th><th>pnl</th></tr></thead><tbody>${d.positions
          .map(
            (p) => `<tr><td>${esc(p.symbol)}</td><td>${esc(p.side)}</td><td class="num">${esc(p.qty)}</td><td class="num">${esc(p.entry ?? p.avg)}</td><td class="num ${(p.pnl ?? 0) >= 0 ? "pos" : "neg"}">${esc(p.pnl ?? "—")}</td></tr>`,
          )
          .join("")}</tbody></table>`
      : `<p class="result-empty">No open positions.</p>`;
  }
  renderAudit(S.boot.auditRows ?? []);
}

function renderAudit(rows) {
  $("#ex-audit").innerHTML = rows.length
    ? `<table><thead><tr><th>time</th><th>action</th><th>symbol</th><th>qty</th><th>gate</th><th>result</th></tr></thead><tbody>${rows
        .slice(0, 120)
        .map(
          (r) => `<tr><td class="muted">${esc((r.time ?? "").slice(5, 19).replace("T", " "))}</td>
        <td>${esc(r.action)}</td><td>${esc(r.symbol ?? "—")}</td><td class="num">${esc(r.qty ?? "—")}</td>
        <td class="${r.gate === "PASS" || r.approved === true ? "pos" : r.gate ? "neg" : "muted"}">${esc(r.gate ?? r.gateCode ?? "—")}</td>
        <td class="muted">${esc(r.result ?? r.reason ?? "—")}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="result-empty">No audit records.</p>`;
}

async function readTradingView() {
  const btn = $("#ex-propose");
  void btn;
  log("reading TradingView…", "hl");
  try {
    const [status, account, positions] = await Promise.all([
      api("/api/tv").catch((e) => ({ error: e.message })),
      api("/api/account").catch((e) => ({ error: e.message })),
      api("/api/positions").catch((e) => ({ error: e.message })),
    ]);
    S.tv.touched = true;
    S.tv.data = { status, ...pickAccount(account), positions: pickPositions(positions) };
    $("#tv-note")?.remove();
    const note = document.createElement("p");
    note.id = "tv-note";
    note.className = "note";
    note.textContent = `read at ${new Date().toLocaleTimeString()}`;
    $("#ex-risk")?.after(note);
    paintExecution();
  } catch (err) {
    log(err.message, "err");
  }
}

const pickAccount = (r) => (Array.isArray(r) ? r[0] ?? {} : r?.account ?? r?.result ?? r ?? {});
const pickPositions = (r) => (Array.isArray(r) ? r[0]?.positions ?? r[0] ?? [] : r?.positions ?? r?.result ?? []);

async function doPropose() {
  const side = $("#ex-form").side.value;
  const symbol = $("#ex-symbol").value.trim();
  const thesis = $("#ex-thesis").value.trim();
  if (!symbol) {
    setVerdict("fail", "A symbol is required.");
    return;
  }
  setVerdict("", "Running dry run…");
  try {
    const r = await api("/api/propose", { method: "POST", body: { side, symbol, thesis } });
    S.propose = r;
    const qty = r?.qty ?? r?.engine_qty ?? r?.result?.qty;
    if (qty != null) $("#ex-qty").value = qty;
    setVerdict(r?.ok === false ? "fail" : "pass", pre(r));
    $("#ex-order").disabled = r?.ok === false || qty == null;
  } catch (err) {
    S.propose = null;
    $("#ex-order").disabled = true;
    setVerdict("fail", esc(err.message));
  }
}

function pre(v) {
  return esc(typeof v === "string" ? v : JSON.stringify(v, null, 2));
}
function setVerdict(cls, html) {
  const el = $("#ex-verdict");
  el.className = "verdict-box " + cls;
  el.innerHTML = html;
}

async function doOrder(ev) {
  ev.preventDefault();
  if (!S.propose) return setVerdict("fail", "Run a proposal first.");
  const side = $("#ex-form").side.value;
  const symbol = $("#ex-symbol").value.trim();
  const qty = Number($("#ex-qty").value);
  if (!Number.isFinite(qty) || qty <= 0) return setVerdict("fail", "Qty must be positive.");

  if (!confirm(`Place a real ${side.toUpperCase()} of ${qty} ${symbol} on the TradingView paper account?\n\nThe risk gate runs again server-side and can still refuse.`)) {
    setVerdict("", "Cancelled by operator.");
    return;
  }
  setVerdict("", "Submitting…");
  try {
    const r = await api("/api/order", { method: "POST", body: { side, symbol, qty, confirm: true } });
    const ok = r?.ok !== false && !r?.error;
    setVerdict(ok ? "pass" : "fail", `<b>${ok ? "Order accepted" : "Order refused"}</b><br>${pre(r)}`);
    S.propose = null;
    $("#ex-order").disabled = true;
    await refresh();
  } catch (err) {
    setVerdict("fail", `<b>Order failed.</b><br>${esc(err.message)}`);
  }
}

// ───────────────────────────────────────────────────────────── knowledge
function paintKnowledge() {
  const cards = S.boot.cards ?? [];
  const buckets = [...new Set(cards.map((c) => c.bucket))];
  $("#k-cards").innerHTML = buckets
    .map((b) => {
      const inB = cards.filter((c) => c.bucket === b);
      return (
        `<div class="ph" style="margin:5px 0 2px">${esc(b)} · ${inB.length}</div>` +
        inB
          .map(
            (c) => `<button class="pick ${S.card?.rel === c.rel ? "sel" : ""}" data-rel="${esc(c.rel)}">
          <span class="nm">${esc(c.title ?? c.id)}</span>
          <span class="mt">${esc((c.status ?? "").replace("status: ", ""))}</span>
        </button>`,
          )
          .join("")
      );
    })
    .join("");
  $$("#k-cards .pick").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        const r = await api(`/api/card?rel=${encodeURIComponent(b.dataset.rel)}`);
        S.card = r;
        $("#k-card-title").textContent = r.rel.split("/").pop();
        $("#k-card-body").innerHTML = renderMarkdown(r.markdown);
      } catch (err) {
        $("#k-card-body").innerHTML = `<p class="result-empty">${esc(err.message)}</p>`;
      }
    }),
  );

  const docs = ["playbook", "backlog", "schema", "template", "agent", "readme"];
  $("#k-docs").innerHTML = docs
    .map((d) => `<button class="${d === S.doc ? "on" : ""}" data-doc="${d}">${d}</button>`)
    .join("");
  $$("#k-docs button").forEach((b) =>
    b.addEventListener("click", async () => {
      S.doc = b.dataset.doc;
      paintKnowledge();
      try {
        const r = await api(`/api/doc?name=${S.doc}`);
        $("#k-doc-title").textContent = `${S.doc}.md`;
        $("#k-doc-body").innerHTML = renderMarkdown(r.markdown);
      } catch (err) {
        $("#k-doc-body").innerHTML = `<p class="result-empty">${esc(err.message)}</p>`;
      }
    }),
  );

  $("#k-integrity").innerHTML = S.integrity
    .map((l) => `<div class="${l.startsWith("PASS") || l.includes("passed") ? "ok" : ""}">${esc(l)}</div>`)
    .join("");
}

// ────────────────────────────────────────────────────────────── plumbing
async function refresh() {
  const [boot, leaderboard, audit] = await Promise.all([
    api("/api/bootstrap"),
    api("/api/leaderboard"),
    api("/api/audit?limit=120"),
  ]);
  boot.auditRows = audit.rows;
  S.boot = boot;
  S.leaderboard = leaderboard;
  if (!S.selected) S.selected = leaderboard.rows[0]?.strategyId ?? null;
  paint();
  paintTopbarTv();
}

let tvTimer = null;
function paintTopbarTv() {
  const el = $("#tb-tv");
  if (!S.tv.touched) {
    el.textContent = "not read";
    el.className = "dim";
    return;
  }
  const d = S.tv.data ?? {};
  el.textContent = d.status?.connected ? "connected" : d.status?.ok === false ? "unreachable" : "read";
  el.className = d.status?.connected ? "" : "warnc";
}

function connect() {
  const dot = $("#live-dot");
  const es = new EventSource("/events");
  es.addEventListener("open", () => { dot.className = "dot on"; dot.title = "SSE connected"; });
  es.addEventListener("error", () => { dot.className = "dot off"; dot.title = "SSE disconnected — retrying"; });
  es.addEventListener("hello", () => { dot.className = "dot on"; });

  es.addEventListener("invalidate", () => { refresh().catch(() => {}); });
  es.addEventListener("killswitch", (e) => {
    const d = JSON.parse(e.data);
    if (S.boot) S.boot.risk = { ...S.boot.risk, kill_switch: d.on };
    paint();
  });
  es.addEventListener("backtest", () => {
    api("/api/backtests").then((s) => { if (S.boot) S.boot.backtest = s; paint(); }).catch(() => {});
  });
  es.addEventListener("backtest:idle", () => {
    api("/api/backtests").then((s) => { if (S.boot) S.boot.backtest = s; paint(); }).catch(() => {});
  });
  es.addEventListener("verify", () => {
    api("/api/verify", { method: "POST" }).then((r) => {
      S.integrity = r.lines ?? [];
      paint();
    }).catch(() => {});
  });
}

function wire() {
  $("#tabs").addEventListener("click", (e) => {
    const t = e.target.closest(".tab[data-view]");
    if (t) show(t.dataset.view);
  });
  $("#btn-refresh").addEventListener("click", () => refresh().then(() => log("refreshed", "ok")).catch((e) => log(e.message, "err")));

  $("#bt-form").addEventListener("submit", (e) => { e.preventDefault(); startBacktest("worker"); });
  $("#bt-spawn").addEventListener("click", () => startBacktest("spawn"));
  $("#bt-cancel").addEventListener("click", async () => {
    if (!S.job) return;
    try {
      await api(`/api/backtest/${S.job}/cancel`, { method: "POST" });
      log(`cancelled ${S.job}`, "hl");
      S.job = null;
    } catch (err) { log(err.message, "err"); }
  });

  $("#ex-kill").addEventListener("click", async () => {
    const on = S.boot?.risk?.kill_switch !== true;
    if (!confirm(`${on ? "ENGAGE" : "RELEASE"} the kill switch?\n\nWhile engaged, paper-trade.mjs refuses every order before it touches the UI.`)) return;
    try {
      const r = await api("/api/risk/kill-switch", { method: "POST", body: { on } });
      S.boot.risk = r;
      paint();
    } catch (err) { setVerdict("fail", esc(err.message)); }
  });

  // A read button, because reading is not free and must be deliberate.
  const readBtn = document.createElement("button");
  readBtn.className = "btn wide";
  readBtn.id = "ex-read";
  readBtn.textContent = "Read from TradingView";
  readBtn.addEventListener("click", readTradingView);
  $("#ex-kill").after(readBtn);

  $("#ex-propose").addEventListener("click", doPropose);
  $("#ex-form").addEventListener("submit", doOrder);
  $("#ex-symbol").addEventListener("input", () => { S.propose = null; $("#ex-order").disabled = true; });
  $("#ex-qty").addEventListener("input", () => { S.propose = null; $("#ex-order").disabled = true; });

  $("#px-seg").innerHTML = SYMBOLS.map(
    (s) => `<button class="${s === S.priceSymbol ? "on" : ""}" data-sym="${s}">${s.replace("USDT", "")}</button>`,
  ).join("");
  $$("#px-seg button").forEach((b) =>
    b.addEventListener("click", async () => {
      S.priceSymbol = b.dataset.sym;
      paintExecution();
      await loadPrice();
    }),
  );

  $("#k-validate").addEventListener("click", async () => {
    S.integrity = ["running card validation…"];
    paintKnowledge();
    try {
      const r = await api("/api/validate-cards", { method: "POST" });
      S.integrity = (r.output ?? "").split("\n").filter(Boolean);
    } catch (err) { S.integrity = [err.message]; }
    paintKnowledge();
  });
  $("#k-verify").addEventListener("click", async () => {
    S.integrity = ["running verify…"];
    paintKnowledge();
    try {
      const r = await api("/api/verify", { method: "POST" });
      S.integrity = r.lines ?? [];
    } catch (err) { S.integrity = [err.message]; }
    paintKnowledge();
  });

  C.bindResize(() => paint());
  setInterval(() => {
    $("#tb-clock").textContent = new Date().toLocaleTimeString();
  }, 1000);
}

async function loadPrice() {
  try {
    const r = await api(`/api/price?symbol=${S.priceSymbol}&tf=15m&points=320`);
    $("#px-label").textContent = `${r.symbol} ${r.tf} · ${r.totalBars} bars cached`;
    C.candles($("#c-price"), r.bars, {
      timeLabel: new Date((r.bars.at(-1)?.t ?? 0) * 1000).toLocaleDateString(),
    });
  } catch (err) {
    C.candles($("#c-price"), [], {});
    $("#px-label").textContent = err.message;
  }
}

// ───────────────────────────────────────────────────────────────── start
(async function start() {
  wire();
  connect();
  try {
    await refresh();
    await loadPrice();
  } catch (err) {
    document.body.insertAdjacentHTML(
      "afterbegin",
      `<p style="padding:14px;color:#f85149;font:12px ${MONO}">Could not reach the server: ${esc(err.message)}</p>`,
    );
  }
  void tvTimer;
})();
