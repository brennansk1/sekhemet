// Inbox (FRONTEND_DESIGN §2.4.8): decision requests, longest wait first. The
// planner's (options with consequence, effort, risk, preview and a deadline
// policy) and the kernel's plain asks (permission requests) in one queue.
import { byWait, duration, mergeDecisions, policyLine, waited } from "./decision.js";
import { $, $$, esc, getJSON, icon, postJSON } from "./dom.js";
import { parseTitle, shortId } from "./lib/vocabulary.js";
import { setTopbar } from "./shell.js";
import { store } from "./store.js";
import { toast } from "./toast.js";

const ui = { root: null, picked: new Map(), confirm: new Set(), focus: 0, last: "", timer: 0 };

/** Fetch both sources into the store (`decisions` slice, U21). */
export async function refreshDecisions() {
  const [planner, plain] = await Promise.all([
    getJSON("/api/planner/decisions").catch(() => ({ ok: false })),
    getJSON("/api/decisions?status=pending").catch(() => ({ ok: false })),
  ]);
  const available = planner.ok || plain.ok;
  const items = mergeDecisions(
    planner.ok ? planner.data?.decisions : [],
    plain.ok ? plain.data?.decisions : [],
  );
  store.set({ decisions: { available, items, at: Date.now() } });
  return items;
}

function cardLine(id) {
  if (!id) return "";
  const c = store.card(id);
  const title = c ? (c.display?.title ?? parseTitle(c.title).title) : shortId(id);
  return `For <a href="#/card/${encodeURIComponent(id)}/evidence">${esc(title)}</a>`;
}

function render() {
  if (!ui.root) return;
  const d = store.state.decisions;
  const items = byWait(d.items ?? [], store.state.now);
  setTopbar({
    title: "Inbox",
    crumb: `${store.state.meta?.project ?? ""}${items.length ? ` · ${items.length} waiting on you` : ""}`,
  });
  let html;
  if (!d.available && d.at === 0) html = '<div class="sk" style="height:160px"></div>';
  else if (items.length === 0)
    html = `<div class="ib-empty">${icon("inbox", 24, "ic s24")}<b>No decisions waiting.</b><span>When the planner meets a question it should not answer alone, or a command needs your permission, it lands here, longest wait first.</span></div>`;
  else {
    ui.focus = Math.min(ui.focus, items.length - 1);
    html = `<ol class="ib-list">${items
      .map(
        (it, i) =>
          `<li class="ib-item${i === ui.focus ? " focus" : ""}" data-i="${i}"><div class="ib-wait tnum${waited(it, store.state.now) > 2 * 3600_000 ? " long" : ""}">${icon("clock", 12, "ic s12")}waiting ${esc(duration(waited(it, store.state.now)))}</div>${decisionHtml(it, { picked: ui.picked.get(it.id), confirm: ui.confirm.has(it.id), now: store.state.now, title: cardLine(it.cardId) })}</li>`,
      )
      .join("")}</ol>`;
  }
  if (html === ui.last) return;
  ui.last = html;
  const body = $(".sc", ui.root);
  const top = body.scrollTop;
  body.innerHTML = html;
  body.scrollTop = top;
}

async function answer(id) {
  const d = (store.state.decisions.items ?? []).find((x) => x.id === id);
  const option = ui.picked.get(id);
  if (!d || option === undefined) return;
  if (d.options[option]?.destructive && !ui.confirm.has(id)) {
    ui.confirm.add(id);
    ui.last = "";
    render();
    return;
  }
  const path =
    d.source === "planner"
      ? `/api/planner/decisions/${encodeURIComponent(id)}`
      : `/api/decisions/${encodeURIComponent(id)}`;
  const res = await postJSON(path, { option });
  if (res.ok) {
    toast({ text: `Answered: ${d.options[option].label}`, tone: "info" });
    ui.picked.delete(id);
    ui.confirm.delete(id);
    await refreshDecisions();
  } else {
    toast({
      text: "Couldn't record the answer.",
      detail: res.data?.error ?? `The server returned ${res.status}.`,
      tone: "fail",
    });
  }
}

function pick(id, i) {
  ui.picked.set(id, i);
  ui.confirm.delete(id);
  ui.last = "";
  render();
}

export function onKey(e) {
  const items = byWait(store.state.decisions.items ?? [], store.state.now);
  const cur = items[ui.focus];
  if (/^[1-9]$/.test(e.key) && cur && Number(e.key) <= cur.options.length) {
    pick(cur.id, Number(e.key) - 1);
    return true;
  }
  if (e.key === "Enter" && cur) {
    answer(cur.id);
    return true;
  }
  if ((e.key === "j" || e.key === "ArrowDown") && ui.focus < items.length - 1) {
    ui.focus++;
    ui.last = "";
    render();
    $(".ib-item.focus", ui.root)?.scrollIntoView({ block: "nearest" });
    return true;
  }
  if ((e.key === "k" || e.key === "ArrowUp") && ui.focus > 0) {
    ui.focus--;
    ui.last = "";
    render();
    $(".ib-item.focus", ui.root)?.scrollIntoView({ block: "nearest" });
    return true;
  }
  return false;
}

export function mount(view) {
  const root = document.createElement("div");
  root.className = "view-host";
  root.innerHTML = '<section class="sc ib-view" aria-label="Inbox"></section>';
  view.append(root);
  ui.root = root;
  ui.last = "";
  root.addEventListener("change", (e) => {
    const input = e.target instanceof HTMLInputElement ? e.target : null;
    const art = input?.closest("[data-decision]");
    if (input?.dataset.opt !== undefined && art) pick(art.dataset.decision, Number(input.dataset.opt));
  });
  root.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const btn = t?.closest("[data-answer]");
    if (btn) answer(btn.dataset.answer);
    const item = t?.closest(".ib-item");
    if (item && Number(item.dataset.i) !== ui.focus) {
      ui.focus = Number(item.dataset.i);
      for (const n of $$(".ib-item", root)) n.classList.toggle("focus", n === item);
    }
  });
  const unsub = store.on((_s, patch) => {
    if ("decisions" in patch || "now" in patch || "cards" in patch) render();
    // A ledger frame about decisions: refetch.
    if ("feed" in patch && (patch.feed ?? []).some((e) => /^decision\//.test(e.type)))
      refreshDecisions();
  });
  refreshDecisions();
  // The countdown moves to the minute, never every second (§2.5.7).
  ui.timer = setInterval(() => store.set({ now: Date.now() }), 60_000);
  render();
  return {
    onKey,
    unmount() {
      clearInterval(ui.timer);
      unsub();
      root.remove();
      ui.root = null;
    },
  };
}

/** One decision request as a card-width panel. `picked` is the chosen index. */
function decisionHtml(d, { picked, confirm = false, now = Date.now(), title = "" } = {}) {
  const pol = policyLine(d, now);
  const opts = d.options
    .map((o, i) => {
      const rec = i === d.recommended;
      const meta = [o.effort ? `Effort ${esc(o.effort)}` : "", o.risk ? `Risk: ${esc(o.risk)}` : ""]
        .filter(Boolean)
        .join(" · ");
      const preview = o.preview
        ? `<details class="dq-prev"><summary>Preview</summary><pre class="mono">${esc(o.preview)}</pre></details>`
        : "";
      return `<li class="dq-opt${o.destructive ? " destructive" : ""}${picked === i ? " on" : ""}"><label><input type="radio" name="dq-${esc(d.id)}" value="${i}"${picked === i ? " checked" : ""} data-opt="${i}"><span class="dq-k kbd">${i + 1}</span><span class="dq-body"><span class="dq-l">${esc(o.label)}${rec ? '<span class="dq-rec">Recommended</span>' : ""}${o.destructive ? `<span class="dq-destr">${icon("alert", 12, "ic s12")}Destructive</span>` : ""}</span>${o.consequence ? `<span class="dq-c">${esc(o.consequence)}</span>` : ""}${meta ? `<span class="dq-m">${meta}</span>` : ""}${rec && d.rationale ? `<span class="dq-why">${esc(d.rationale)}</span>` : ""}</span></label>${preview}</li>`;
    })
    .join("");
  const chosen = picked !== undefined ? d.options[picked] : undefined;
  const needsConfirm = chosen?.destructive && !confirm;
  return `<article class="dq" data-decision="${esc(d.id)}" aria-labelledby="dq-q-${esc(d.id)}"><header class="dq-h"><h3 id="dq-q-${esc(d.id)}">${esc(d.question)}</h3>${d.category ? `<span class="dq-cat">${esc(String(d.category).replace(/_/g, " "))}</span>` : ""}</header>${title ? `<p class="dq-card sec">${title}</p>` : ""}${d.context ? `<p class="dq-ctx sec">${esc(d.context)}</p>` : ""}<ol class="dq-opts" role="radiogroup" aria-label="Options">${opts}</ol><footer class="dq-f"><span class="dq-pol${pol.urgent ? " urgent" : ""}">${pol.lock ? icon("lock", 12, "ic s12") : icon("clock", 12, "ic s12")}${esc(pol.text)}</span><button class="btn${needsConfirm ? "" : " primary"}" type="button" data-answer="${esc(d.id)}"${picked === undefined ? ' aria-disabled="true"' : ""}>${needsConfirm ? "Confirm destructive choice" : "Answer"}<kbd>↩</kbd></button></footer></article>`;
}
