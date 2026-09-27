// Quick create (dashboard §2.4.7, DB-P3-12): `c` or a column's `+` opens this
// form. It posts a create proposal to Seshat's thread (`POST /api/pm/create-card`);
// applied there, the card goes through the planner pipeline. Every word is
// the pure module's (`lib/create.js`).
import { esc, icon, postJSON } from "./dom.js";
import { QUICK_CREATE_COPY as T, quickCreateRequest } from "./lib/create.js";
import { pushOverlay, trapFocus } from "./overlay.js";
import { loadThread } from "./pm_client.js";
import { togglePmPanel } from "./pm_panel.js";
import { store } from "./store.js";
import { toast } from "./toast.js";

let open = null;

export function closeCreate() {
  if (!open) return;
  const { node, remove, invoker } = open;
  open = null;
  remove();
  node.remove();
  invoker?.focus?.({ preventScroll: true });
}

/**
 * Open the form. `epicId` is the epic the board is filtered to, when there is
 * exactly one, so the card lands under it.
 */
export function openCreate({ epicId } = {}) {
  if (open) return;
  const node = document.createElement("div");
  node.className = "scrim";
  node.innerHTML = `<form class="dialog qc" role="dialog" aria-modal="true" aria-labelledby="qc-h" aria-describedby="qc-note" novalidate>
<header><h2 id="qc-h">${esc(T.heading)}</h2><button class="icon-btn" type="button" data-close aria-label="${esc(`${T.cancel} (Esc)`)}">${icon("x")}</button></header>
<label class="qc-f" for="qc-title">${esc(T.title)}</label>
<input id="qc-title" name="title" type="text" autocomplete="off" spellcheck="true" maxlength="300" required aria-describedby="qc-err">
<label class="qc-f" for="qc-desc">${esc(T.description)}</label>
<textarea id="qc-desc" name="description" rows="4" aria-describedby="qc-hint"></textarea>
<p class="qc-hint" id="qc-hint">${esc(T.descriptionHint)}</p>
<p class="qc-err" id="qc-err" role="alert"></p>
<p class="qc-note" id="qc-note">${icon("chat", 12, "ic s12")}<span>${esc(T.note)}</span></p>
<footer><button class="btn ghost" type="button" data-close>${esc(T.cancel)}</button><button class="btn primary" type="submit">${esc(T.submit)}</button></footer>
</form>`;
  document.getElementById("overlay-root").append(node);
  const form = node.querySelector("form");
  const title = node.querySelector("#qc-title");
  const err = node.querySelector("#qc-err");
  const submit = node.querySelector('button[type="submit"]');
  const invoker = document.activeElement;
  const remove = pushOverlay({
    kind: "create",
    modal: true,
    node,
    close: () => closeCreate(),
    onKey: (e) => trapFocus(node, e),
  });
  open = { node, remove, invoker };
  node.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (e.target === node || t?.closest("[data-close]")) closeCreate();
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const asked = quickCreateRequest({
      title: title.value,
      description: node.querySelector("#qc-desc").value,
      ...(epicId ? { epicId } : {}),
      // The project the board is scoped to: the card lands there, and a Team
      // checks the permission there (DB-P3-12).
      projectId: store.state.project?.id ?? null,
    });
    if (!asked.ok) {
      err.textContent = asked.error;
      title.setAttribute("aria-invalid", "true");
      title.focus();
      return;
    }
    submit.disabled = true;
    const r = await postJSON("/api/pm/create-card", asked.body);
    submit.disabled = false;
    if (!r.ok) {
      err.textContent = r.data?.error ?? `The server returned ${r.status || "no response"}.`;
      return;
    }
    closeCreate();
    // The proposal waits in Seshat's thread for Apply.
    await loadThread();
    togglePmPanel(true);
    toast({ tone: "info", text: T.sent });
  });
  title.focus();
}
