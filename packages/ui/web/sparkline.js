// Canvas sparklines (U18): memory, decode speed and prefix-cache hit rate.
// `sparkPoints` is pure (tested); `drawSparkline` paints it at device pixels.

/** Map values to canvas points inside `w`×`h` with `pad`; null gaps are skipped. */
export function sparkPoints(values, w, h, { min, max, pad = 2 } = {}) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return [];
  const lo = min ?? Math.min(...finite);
  const hi = max ?? Math.max(...finite);
  const span = hi - lo || 1;
  const n = values.length;
  const pts = [];
  values.forEach((v, i) => {
    if (!Number.isFinite(v)) return;
    const x = n === 1 ? w / 2 : pad + (i / (n - 1)) * (w - 2 * pad);
    const y = pad + (1 - (Math.min(hi, Math.max(lo, v)) - lo) / span) * (h - 2 * pad);
    pts.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
  });
  return pts;
}

/** Summary words for a series: last value, and min to max. */
export function sparkSummary(values, fmt = (v) => String(Math.round(v))) {
  const f = values.filter((v) => Number.isFinite(v));
  if (f.length === 0) return { last: "—", range: "no samples yet" };
  return {
    last: fmt(f[f.length - 1]),
    range: `${fmt(Math.min(...f))} to ${fmt(Math.max(...f))} over ${f.length} samples`,
  };
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Paint one series. `tone` is a state token name (running, pass, parked, fail). */
export function drawSparkline(canvas, values, { tone = "running", min, max, band } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 240;
  const h = canvas.clientHeight || 40;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const opts = { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
  if (band) {
    // A threshold line (memory's warning level), dashed and quiet.
    const [y] = sparkPoints([band], w, h, { min: min ?? 0, max: max ?? 1 }).map((p) => p[1]);
    ctx.strokeStyle = cssVar("--state-parked", "#c90");
    ctx.globalAlpha = 0.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
  const pts = sparkPoints(values, w, h, opts);
  if (pts.length === 0) return;
  const color = cssVar(`--state-${tone}`, "#58f");
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = color;
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
  // A soft fill under the line, and the latest point marked.
  ctx.lineTo(pts[pts.length - 1][0], h);
  ctx.lineTo(pts[0][0], h);
  ctx.closePath();
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1;
  const [lx, ly] = pts[pts.length - 1];
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
  ctx.fill();
}
