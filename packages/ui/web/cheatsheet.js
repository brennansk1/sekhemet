// Keyboard cheat sheet (dashboard §2.3.3): `?` from anywhere. Generated from
// the one keymap the palette also reads (lib/nav.js, DB-P11-6).
import { MOD, esc, icon, kbd } from "./dom.js";
import { cheatSheet } from "./lib/nav.js";
import { pushOverlay, trapFocus } from "./overlay.js";
import { currentNav } from "./shell.js";
import { store } from "./store.js";

/** `Mod+K` is ⌘K on a Mac and Ctrl+K elsewhere. */
export function keyLabel(k) {
  return k.startsWith("Mod+") ? `${MOD}${k.slice(4)}` : k;
}

let open = null;

export function closeCheatsheet() {
  if (!open) return;
  const { node, remove, invoker } = open;
  open = null;
  remove();
  node.remove();
  invoker?.focus?.({ preventScroll: true });
}

export function openCheatsheet() {
  if (open) return closeCheatsheet();
  const view = store.state.route?.name ?? "";
  const cols = cheatSheet(currentNav())
    .map((s) => {
      const off = s.views && !s.views.includes(view) ? " off" : "";
      const rows = s.rows
        .map((r) => `<div><dt>${esc(r.label)}</dt><dd>${kbd(...r.keys.map(keyLabel))}</dd></div>`)
        .join("");
      const note = s.note ? `<p class="note">${esc(s.note)}</p>` : "";
      return `<section class="${off.trim()}"><h3>${esc(s.name)}</h3><dl>${rows}</dl>${note}</section>`;
    })
    .join("");
  const node = document.createElement("div");
  node.className = "scrim";
  node.innerHTML = `<div class="dialog cheats" role="dialog" aria-modal="true" aria-labelledby="cheats-h"><header><h2 id="cheats-h">Keyboard shortcuts</h2><button class="icon-btn" type="button" data-close aria-label="Close (Esc)">${icon("x")}</button></header><div class="cheat-grid">${cols}</div></div>`;
  document.getElementById("overlay-root").append(node);
  const invoker = document.activeElement;
  const remove = pushOverlay({
    kind: "cheats",
    modal: true,
    close: () => closeCheatsheet(),
    onKey: (e) => {
      if (trapFocus(node, e)) return true;
      if (e.key === "?") {
        closeCheatsheet();
        return true;
      }
      return e.key !== "Escape";
    },
  });
  node.addEventListener("click", (e) => {
    if (e.target === node || (e.target instanceof Element && e.target.closest("[data-close]")))
      closeCheatsheet();
  });
  open = { node, remove, invoker };
  node.querySelector("[data-close]").focus();
}
