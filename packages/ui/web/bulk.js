// Bulk bar (PM_DESIGN §3.4): with cards selected, one toolbar docks at the
// bottom of the board or list with the same field actions and Ask Seshat.
import { esc, icon, kbd, postJSON } from "./dom.js";
import { editField } from "./fields.js";
import { showsPoints, sumPoints } from "./lib/pm.js";
import { openPrompt } from "./picker.js";
import { askMerit } from "./pm_panel.js";
import { store } from "./store.js";
import { toast } from "./toast.js";
import { mutationsBlocked } from "./triage.js";

let node = null;
let last = "";

function ids() {
  return [...store.state.selected].filter((id) => store.card(id));
}

function html(list) {
  // Points only with Preferences → Estimation on story points (DB-N7-2).
  const on = showsPoints(store.state.estimation);
  const pts = on ? sumPoints(list.map((id) => store.card(id))) : 0;
  const btn = (field, label, key) =>
    `<button class="btn ghost sm" type="button" data-bulk="${field}">${esc(label)}${key ? ` ${kbd(key)}` : ""}</button>`;
  return `<span class="n tnum"><b>${list.length} selected</b>${pts ? ` · ${pts} pts` : ""}</span><span class="sep"></span>${btn("priority", "Priority", "⇧P")}${on ? btn("estimate", "Points", "⇧E") : ""}${btn("cycleId", "Sprint", "⇧C")}${btn("labels", "Labels", "⇧L")}${btn("assignee", "Assignee", "⇧A")}<span class="sep"></span><button class="btn ghost sm" type="button" data-bulk-park>${icon("park", 12, "ic s12")}Park</button><button class="btn ghost sm" type="button" data-bulk-ask>${icon("chat", 12, "ic s12")}Ask Seshat</button><button class="icon-btn" type="button" data-bulk-clear aria-label="Clear selection (Esc)" title="Clear selection (Esc)">${icon("x", 14, "ic s14")}</button>`;
}

function render() {
  const onBoard = store.state.route?.name === "board";
  const list = onBoard ? ids() : [];
  if (!list.length) {
    node?.remove();
    node = null;
    last = "";
    return;
  }
  if (!node) {
    node = document.createElement("div");
    node.className = "bulk";
    node.setAttribute("role", "toolbar");
    node.setAttribute("aria-label", "Selected cards");
    document.getElementById("main").append(node);
    node.addEventListener("click", onClick);
  }
  const h = html(list);
  if (h !== last) {
    node.innerHTML = h;
    last = h;
  }
}

function parkAll(list, anchor) {
  if (mutationsBlocked()) {
    toast({
      tone: "parked",
      text: "Parking is disabled.",
      detail: "The server is read-only or offline.",
    });
    return;
  }
  openPrompt(anchor, {
    heading: `Park ${list.length} cards: why?`,
    placeholder: "Not now",
    value: "Not now",
    submit: "Park",
    onSubmit: async (reason) => {
      // One park per card, each its own ledger event.
      const failed = [];
      for (const id of list) {
        const r = await postJSON(`/api/cards/${encodeURIComponent(id)}/park`, { reason });
        if (!r.ok) failed.push([id, r]);
      }
      if (failed.length === 0) {
        toast({
          tone: "parked",
          iconName: "park",
          text: `Parked ${list.length} cards. Nothing runs until you unpark them.`,
        });
      } else {
        const [id, r] = failed[0];
        toast({
          tone: "fail",
          text: `Parked ${list.length - failed.length} of ${list.length}.`,
          detail: `${store.card(id)?.display?.shortId ?? id}: ${r.data?.error ?? `the server returned ${r.status}`}`,
        });
      }
      store.set({ selected: new Set() });
      window.dispatchEvent(new CustomEvent("sekhemet:refresh"));
    },
  });
}

function onClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const list = ids();
  const f = t.closest("[data-bulk]");
  if (f) return editField(f.dataset.bulk, list, f);
  if (t.closest("[data-bulk-clear]")) return store.set({ selected: new Set() });
  if (t.closest("[data-bulk-ask]")) {
    const refs = list.map((id) => `@${id}`).join(" ");
    return askMerit(`About ${refs}: `);
  }
  const park = t.closest("[data-bulk-park]");
  if (park) parkAll(list, park);
}

export function initBulk() {
  store.on(render);
  window.addEventListener("hashchange", () => setTimeout(render, 0));
}
