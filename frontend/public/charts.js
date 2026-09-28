// Canvas charts, no dependencies. Every function is idempotent: it sizes the
// backing store to the element's box at device-pixel resolution, scales the
// context, and paints. Data shapes are parsed defensively because some series
// come from a re-simulation (objects) and some from an evidence record (scalars).

const MONO = '10px ui-monospace, "Cascadia Code", Menlo, Consolas, monospace';
const GRID = "#ffffff12";
const AXIS = "#5d6780";
const TXT = "#8b95ad";
const PASS = "#3fb950";
const FAIL = "#f85149";
const INFO = "#58a6ff";
const ACCENT = "#a371f7";

/** Size the backing store to the CSS box and return a ready-to-paint context. */
function surface(canvas) {
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(r.width));
  const h = Math.max(1, Math.floor(r.height));
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

const nice = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—");
const cls = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "muted");

/** Accept [{equity}|{e}|{t,equity}|number] and return a plain number series. */
function numSeries(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((p) => (typeof p === "number" ? p : p?.equity ?? p?.e ?? p?.value ?? p?.close ?? null))
    .filter((v) => typeof v === "number" && Number.isFinite(v));
}

// ────────────────────────────────────────────────────────────────── heatmap
/** rows: [{strategyId, isControl, unmet, cells:[{name, ok, known}]}] */
export function heatmap(canvas, data) {
  const { ctx, w, h } = surface(canvas);
  const rows = data?.rows ?? [];
  const cols = data?.columns ?? [];
  if (!rows.length || !cols.length) return empty(ctx, w, h, "no runs to plot");

  const padL = 168;
  const padT = 74;
  const padB = 8;
  const gap = 2;
  const cw = Math.max(8, (w - padL - 6) / cols.length);
  const rh = Math.max(9, Math.min(24, (h - padT - padB) / rows.length));

  ctx.font = MONO;
  ctx.textBaseline = "middle";

  // rotated column headers
  ctx.save();
  ctx.fillStyle = TXT;
  ctx.font = `9.5px ${MONO.split("px ")[1]}`;
  for (let c = 0; c < cols.length; c++) {
    ctx.save();
    ctx.translate(padL + c * cw + cw / 2, padT - 6);
    ctx.rotate(-Math.PI / 2.6);
    ctx.textAlign = "left";
    ctx.fillText(cols[c], 0, 0, 96);
    ctx.restore();
  }
  ctx.restore();

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const y = padT + r * rh;
    if (y + rh > h) break;

    // row label + unmet count
    ctx.textAlign = "left";
    ctx.fillStyle = row.isControl ? ACCENT : TXT;
    ctx.font = `${row.isControl ? "italic " : ""}10.5px ${MONO.split("px ")[1]}`;
    const label = row.strategyId.length > 21 ? row.strategyId.slice(0, 20) + "…" : row.strategyId;
    ctx.fillText(label, 0, y + rh / 2);
    ctx.fillStyle = FAIL;
    ctx.font = `9.5px ${MONO.split("px ")[1]}`;
    ctx.fillText(`${row.unmet}`, padL - 26, y + rh / 2);

    for (let c = 0; c < cols.length; c++) {
      const cell = row.cells[c] ?? {};
      const x = padL + c * cw;
      if (x + cw > w) break;
      if (cell.known === false) ctx.fillStyle = "#ffffff08";
      else ctx.fillStyle = cell.ok ? PASS : FAIL;
      ctx.globalAlpha = cell.known === false ? 1 : 0.72;
      ctx.fillRect(x, y, Math.max(2, cw - gap), Math.max(2, rh - gap));
    }
    ctx.globalAlpha = 1;
  }

  // legend
  ctx.textAlign = "left";
  ctx.font = `9.5px ${MONO.split("px ")[1]}`;
  let lx = 0;
  const ly = h - 6;
  for (const [lbl, col] of [["passed", PASS], ["failed", FAIL], ["not observable", "#ffffff14"]]) {
    ctx.fillStyle = col;
    ctx.fillRect(lx, ly - 6, 9, 9);
    ctx.fillStyle = AXIS;
    ctx.fillText(lbl, lx + 13, ly - 1);
    lx += 24 + ctx.measureText(lbl).width;
  }
  ctx.fillStyle = AXIS;
  ctx.textAlign = "right";
  ctx.fillText(`${rows.length} strategies × ${cols.length} criteria`, w, ly - 1);
}

// ────────────────────────────────────────────────────────────────── scatter
/** rows: [{strategyId, isControl, profitFactor, maxDrawdownPct}] */
export function scatter(canvas, rows, thresholds = {}) {
  const { ctx, w, h } = surface(canvas);
  const pts = (rows ?? []).filter((r) => Number.isFinite(r.profitFactor) && Number.isFinite(r.maxDrawdownPct));
  if (!pts.length) return empty(ctx, w, h, "no runs to plot");

  const padL = 42, padR = 14, padT = 12, padB = 30;
  const xs = pts.map((p) => p.maxDrawdownPct);
  const ys = pts.map((p) => p.profitFactor);
  const x0 = 0, x1 = Math.max(...xs) * 1.1 || 1;
  const y0 = Math.min(0.9, Math.min(...ys) - 0.05);
  const y1 = Math.max(1.15, Math.max(...ys) + 0.05);
  const X = (v) => padL + ((v - x0) / (x1 - x0)) * (w - padL - padR);
  const Y = (v) => padT + (1 - (v - y0) / (y1 - y0)) * (h - padT - padB);

  // grid
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.font = MONO;
  ctx.fillStyle = AXIS;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) {
    const v = y0 + ((y1 - y0) * i) / 4;
    const y = Math.round(Y(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillText(v.toFixed(2), padL - 5, y);
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let i = 0; i <= 4; i++) {
    const v = x0 + ((x1 - x0) * i) / 4;
    ctx.fillText(v.toFixed(0) + "%", X(v), h - padB + 6);
  }
  ctx.textAlign = "left";
  ctx.fillText("max drawdown →", padL, h - 12);

  // PF = 1 reference: the line a coin flip sits on
  if (1 >= y0 && 1 <= y1) {
    ctx.strokeStyle = "#f8514988";
    ctx.setLineDash([4, 3]);
    const y = Math.round(Y(1)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#f85149aa";
    ctx.textAlign = "right"; ctx.textBaseline = "bottom";
    ctx.fillText("PF 1.00", w - padR - 2, Y(1) - 2);
  }
  // gate minimum
  const minPf = thresholds.MIN_PF;
  if (Number.isFinite(minPf) && minPf >= y0 && minPf <= y1) {
    ctx.strokeStyle = "#d8a03a66";
    const y = Math.round(Y(minPf)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillStyle = "#d8a03aaa";
    ctx.textAlign = "left"; ctx.textBaseline = "bottom";
    ctx.fillText(`gate PF ${minPf}`, padL + 3, Y(minPf) - 2);
  }

  // points
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = `9.5px ${MONO.split("px ")[1]}`;
  for (const p of pts) {
    const x = X(p.maxDrawdownPct), y = Y(p.profitFactor);
    ctx.fillStyle = p.isControl ? ACCENT : INFO;
    ctx.globalAlpha = p.isControl ? 0.85 : 0.7;
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    if (w > 620) {
      ctx.fillStyle = TXT;
      const lbl = p.strategyId.length > 17 ? p.strategyId.slice(0, 16) + "…" : p.strategyId;
      ctx.fillText(lbl, x, y + 7, 92);
    }
  }
}

// ───────────────────────────────────────────────────────────────────── bars
/** items: [{label, value, isControl, sub}] — signed, zero-centred. */
export function bars(canvas, items, opts = {}) {
  const { ctx, w, h } = surface(canvas);
  const data = (items ?? []).filter((d) => Number.isFinite(d.value));
  if (!data.length) return empty(ctx, w, h, "nothing to plot");

  const padL = 44, padR = 10, padT = 6, padB = opts.rotateLabels ? Math.min(96, w / data.length / 1.5) : 20;
  const vals = data.map((d) => d.value);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const Y = (v) => padT + (1 - (v - lo) / span) * (h - padT - padB);
  const zero = Y(0);
  const slot = (w - padL - padR) / data.length;
  const bw = Math.max(4, Math.min(30, slot - 8));

  ctx.font = MONO;
  ctx.strokeStyle = GRID;
  ctx.beginPath(); ctx.moveTo(padL, Math.round(zero) + 0.5); ctx.lineTo(w - padR, Math.round(zero) + 0.5); ctx.stroke();

  for (const v of [lo, 0, hi]) {
    ctx.fillStyle = AXIS;
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(nice(v, 2), padL - 5, Y(v));
  }

  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    const x = padL + i * slot + (slot - bw) / 2;
    const y = d.value >= 0 ? Y(d.value) : zero;
    const bh = Math.max(1.5, Math.abs(Y(d.value) - zero));
    ctx.fillStyle = d.isControl ? ACCENT : d.value >= 0 ? PASS : FAIL;
    ctx.globalAlpha = 0.8;
    ctx.fillRect(x, y, bw, bh);
    ctx.globalAlpha = 1;

    ctx.fillStyle = d.isControl ? ACCENT : TXT;
    ctx.textAlign = "center";
    if (opts.rotateLabels) {
      ctx.save();
      ctx.translate(x + bw / 2, h - padB + 4);
      ctx.rotate(-Math.PI / 5);
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.font = `9.5px ${MONO.split("px ")[1]}`;
      ctx.fillText(d.label, 0, 0, 78);
      ctx.restore();
    } else {
      ctx.textBaseline = "top";
      ctx.font = `9.5px ${MONO.split("px ")[1]}`;
      ctx.fillText(d.label, x + bw / 2, h - padB + 4, slot - 2);
    }
  }
}

// ─────────────────────────────────────────────────────────────────── equity
export function equity(canvas, input, opts = {}) {
  const { ctx, w, h } = surface(canvas);
  const vals = numSeries(input);
  if (vals.length < 2) return empty(ctx, w, h, opts.empty ?? "no curve yet");

  const padL = 50, padR = 10, padT = 10, padB = 20;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const X = (i) => padL + (i / (vals.length - 1)) * (w - padL - padR);
  const Y = (v) => padT + (1 - (v - lo) / span) * (h - padT - padB);

  ctx.font = MONO;
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 3; i++) {
    const v = lo + (span * i) / 3;
    const y = Math.round(Y(v)) + 0.5;
    ctx.strokeStyle = GRID;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillStyle = AXIS; ctx.textAlign = "right";
    ctx.fillText(v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(2), padL - 5, y);
  }

  // underwater shading: where the curve sits below its running peak
  if (opts.drawdown !== false) {
    let peak = -Infinity;
    ctx.beginPath();
    ctx.moveTo(X(0), Y(vals[0]));
    const base = new Path2D();
    for (let i = 0; i < vals.length; i++) {
      peak = Math.max(peak, vals[i]);
      ctx.lineTo(X(i), Y(vals[i]));
    }
    ctx.strokeStyle = INFO;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.save();
    ctx.lineTo(X(vals.length - 1), Y(lo));
    ctx.lineTo(X(0), Y(lo));
    ctx.closePath();
    ctx.fillStyle = "#58a6ff12";
    ctx.fill();
    ctx.restore();

    void base;
  } else {
    ctx.beginPath();
    ctx.moveTo(X(0), Y(vals[0]));
    for (let i = 1; i < vals.length; i++) ctx.lineTo(X(i), Y(vals[i]));
    ctx.strokeStyle = INFO;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // start/end markers
  ctx.fillStyle = "#58a6ff22";
  ctx.fillRect(X(0) - 1.5, padT, 3, h - padT - padB);
  const endV = vals[vals.length - 1];
  ctx.fillStyle = endV >= vals[0] ? PASS : FAIL;
  ctx.beginPath();
  ctx.arc(X(vals.length - 1), Y(endV), 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = AXIS;
  ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillText(opts.xLabel ?? "", padL, h - padB + 5);
  ctx.textAlign = "right";
  ctx.fillText(opts.xRight ?? "", w - padR, h - padB + 5);
}

// ────────────────────────────────────────────────────────────────── candles
export function candles(canvas, barsIn) {
  const { ctx, w, h } = surface(canvas);
  const bars = (barsIn ?? []).filter((b) => Number.isFinite(b?.c));
  if (bars.length < 2) return empty(ctx, w, h, "no cached bars");

  const padL = 8, padR = 52, padT = 8, padB = 16;
  const lo = Math.min(...bars.map((b) => b.l));
  const hi = Math.max(...bars.map((b) => b.h));
  const span = hi - lo || 1;
  const Y = (v) => padT + (1 - (v - lo) / span) * (h - padT - padB);
  const slot = (w - padL - padR) / bars.length;
  const bw = Math.max(1, Math.min(9, slot * 0.7));

  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const v = lo + (span * i) / 3;
    const y = Math.round(Y(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
  }

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const x = padL + i * slot + (slot - bw) / 2;
    const up = b.c >= b.o;
    ctx.strokeStyle = ctx.fillStyle = up ? "#3fb950cc" : "#f85149cc";
    ctx.beginPath();
    ctx.moveTo(Math.round(x + bw / 2) + 0.5, Y(b.h));
    ctx.lineTo(Math.round(x + bw / 2) + 0.5, Y(b.l));
    ctx.stroke();
    const y0 = Y(Math.max(b.o, b.c));
    const bh = Math.max(1, Math.abs(Y(b.o) - Y(b.c)));
    ctx.fillRect(x, y0, bw, bh);
  }

  // last price tag
  const last = bars[bars.length - 1];
  const y = Y(last.c);
  ctx.fillStyle = last.c >= last.o ? PASS : FAIL;
  ctx.fillRect(w - padR + 2, y - 8, padR - 4, 16);
  ctx.fillStyle = "#08121a";
  ctx.font = MONO;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(last.c >= 1000 ? Math.round(last.c).toLocaleString() : last.c.toFixed(2), w - padR / 2 + 2, y);

  ctx.fillStyle = AXIS;
  ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillText(`${bars.length} bars`, padL, h - padB + 3);
  ctx.textAlign = "right";
  ctx.fillText(opts?.timeLabel ?? "", w - padR, h - padB + 3);
}

// ──────────────────────────────────────────────────────────────────── misc
function empty(ctx, w, h, msg) {
  ctx.fillStyle = AXIS;
  ctx.font = MONO;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(msg, w / 2, h / 2);
}

export function clear(canvas) {
  const { ctx, w, h } = surface(canvas);
  empty(ctx, w, h, "");
}

/** Re-paint every chart on resize / DPR change. */
export function bindResize(fn) {
  let t = null;
  const run = () => {
    clearTimeout(t);
    t = setTimeout(fn, 90);
  };
  window.addEventListener("resize", run);
  if (window.ResizeObserver) new ResizeObserver(run).observe(document.body);
}
