// Configuration › Models › Inference engine (models rules 6a and 6b,
// NEW-models-16, NEW-models-19; DEC-53 c7): which llama-server Sekhemet uses,
// where it came from and its build against the floor; and *Get the inference
// engine* — the pinned llama.cpp release, file, size and licence shown first,
// downloaded only when the person presses the button. Served by
// `GET /api/config/engine` and `POST /api/config/engine/get`
// (PM_CONTRACT §3). Nothing here downloads on its own.
import { esc, getJSON, postJSON } from "./dom.js";

const ORIGIN = {
  setting: "named by SEKHEMET_LLAMA_SERVER",
  downloaded: "downloaded by Sekhemet",
  path: "found on PATH",
};

const mb = (b) => `${(b / 1e6).toFixed(1)} MB`;

/** The download's line while it runs or after it ended. */
export function downloadLine(d) {
  if (!d) return "";
  if (d.state === "done") return `llama.cpp ${d.release} is installed.`;
  if (d.state === "failed") return `Not installed: ${d.error || "the download stopped"}`;
  if (d.state === "verifying") return "Checking the file against its published hash…";
  return `Downloading llama.cpp ${d.release}: ${mb(d.bytes || 0)} of ${mb(d.total || 0)}`;
}

/**
 * The card's markup from `GET /api/config/engine`: the engine line, the
 * floor, and — when the engine is missing or below the floor and a build is
 * pinned for this machine — the offer and its button; where none is pinned,
 * why, and the guide to build one (MD-N19-3).
 */
export function engineCardHtml(v, opts = {}) {
  if (!v)
    return `<section class="cfg-card" aria-labelledby="cfg-h-engine"><h2 id="cfg-h-engine">Inference engine</h2><p class="sec">Reading the engine…</p></section>`;
  const e = v.engine;
  const status = !e
    ? "Not found"
    : v.meetsFloor
      ? `llama.cpp b${e.build}`
      : e.build
        ? `llama.cpp b${e.build}, too old`
        : "Build unknown";
  const where = e ? `<p class="sec">${esc(e.path)} · ${esc(ORIGIN[e.origin] || e.origin)}</p>` : "";
  const parts = [
    `<p><strong>${esc(status)}</strong> · b${esc(v.floor)} or later needed</p>`,
    where,
  ];
  const running =
    v.download && (v.download.state === "running" || v.download.state === "verifying");
  if (v.download) parts.push(`<p class="sec" role="status">${esc(downloadLine(v.download))}</p>`);
  if (v.offer && !v.installed && !running) {
    parts.push(`<p class="sec">${esc(v.offerText || "")}</p>`);
    if (opts.readOnly) parts.push(`<p class="sec">${esc(opts.readOnly)}</p>`);
    else
      parts.push(
        `<div class="row"><button class="btn${v.meetsFloor ? "" : " primary"}" data-engine-get>Get the inference engine</button></div>`,
      );
  } else if (!v.offer && !v.meetsFloor) {
    parts.push(`<p class="sec">${esc(v.noAsset || "")}</p>`);
  }
  if (!v.meetsFloor && !(v.offer && !v.installed))
    for (const f of v.fixes || []) parts.push(`<p class="sec">${esc(f)}</p>`);
  return `<section class="cfg-card" aria-labelledby="cfg-h-engine"><h2 id="cfg-h-engine">Inference engine</h2>${parts.join("")}</section>`;
}

/** Mount the card into `host`; `readOnly` is the reason a person may not change it, if any. */
export function mount(host, opts = {}) {
  let timer;
  let gone = false;
  const render = (v) => {
    if (gone) return;
    host.innerHTML = engineCardHtml(v, opts);
    const btn = host.querySelector("[data-engine-get]");
    btn?.addEventListener("click", async () => {
      btn.disabled = true;
      // The offer is on screen above the button: the press is the yes (MD-N19-1).
      const r = await postJSON("/api/config/engine/get", { confirm: true });
      if (r.ok) poll();
      else {
        await load();
        const why = r.data?.error;
        if (why)
          host
            .querySelector(".cfg-card")
            ?.insertAdjacentHTML("beforeend", `<p class="sec" role="alert">${esc(why)}</p>`);
      }
    });
  };
  const load = async () => {
    const r = await getJSON("/api/config/engine");
    const v = r.ok ? r.data : undefined;
    if (v) render(v);
    else if (!gone)
      host.innerHTML = `<section class="cfg-card" aria-labelledby="cfg-h-engine"><h2 id="cfg-h-engine">Inference engine</h2><p class="sec" role="alert">${esc(r.data?.error || "The engine's state could not be read.")}</p></section>`;
    return v;
  };
  const poll = async () => {
    const v = await load();
    const d = v?.download;
    if (!gone && d && (d.state === "running" || d.state === "verifying"))
      timer = setTimeout(poll, 1000);
  };
  void poll();
  return {
    unmount() {
      gone = true;
      clearTimeout(timer);
    },
  };
}
