// Keyboard cheat sheet (FRONTEND_DESIGN §2.5.12): `?` from anywhere.
import { MOD, esc, icon, kbd } from "./dom.js";
import { pushOverlay, trapFocus } from "./overlay.js";
import { store } from "./store.js";

const SECTIONS = [
  {
    name: "Global",
    rows: [
      ["Command palette", [`${MOD}K`]],
      ["Search cards", ["/"]],
      ["Keyboard shortcuts", ["?"]],
      ["Switch theme", ["t"]],
      ["Close or cancel", ["Esc"]],
    ],
  },
  {
    name: "Navigate",
    rows: [
      ["Review", ["g", "r"]],
      ["Board", ["g", "b"]],
      ["Runs", ["g", "q"]],
      ["Ledger", ["g", "l"]],
      ["Playbook", ["g", "p"]],
      ["Machine", ["g", "m"]],
      ["Merit", ["g", "a"]],
      ["Insights", ["g", "f"]],
      ["Integrations", ["g", "s"]],
    ],
  },
  {
    name: "Merit",
    rows: [
      ["Open or close the panel", [`${MOD}J`]],
      ["Send", ["↵"]],
      ["New line", ["⇧", "↵"]],
      ["Mention a card", ["@"]],
      ["Apply or discard a proposal", ["y", "n"]],
      ["Apply all in a group", ["⇧", "Y"]],
    ],
  },
  {
    name: "Cards",
    views: ["board"],
    rows: [
      ["Move between columns", ["h", "l"]],
      ["Move within a column", ["j", "k"]],
      ["First or last in column", ["Home", "End"]],
      ["Peek", ["Space"]],
      ["Open card", ["↵"]],
      ["Select", ["x"]],
      ["Extend selection (list)", ["⇧", "J"]],
      ["Priority, points, labels", ["⇧", "P"]],
      ["Cycle, assignee", ["⇧", "C"]],
      ["Any field", ["."]],
      ["Board or list", ["v"]],
      ["Group into swimlanes", ["⇧", "S"]],
      ["Filter", ["/"]],
      ["New card", ["c"]],
    ],
  },
  {
    name: "Review",
    views: ["review", "card"],
    rows: [
      ["Accept", ["a"]],
      ["Send back", ["r"]],
      ["Park", ["p"]],
      ["Undo accept", ["z"]],
      ["Next or previous card", ["j", "k"]],
      ["Open card", ["o"]],
      ["Previous or next attempt", ["[", "]"]],
      ["Next or previous annotation", ["n", "N"]],
      ["Expand file", ["Space"]],
      ["Unified or split diff", ["u"]],
      ["Facts rail", ["f"]],
      ["Send the note", [`${MOD}↵`]],
    ],
  },
  {
    name: "Card and lists",
    views: ["card", "ledger", "runs", "machine"],
    rows: [
      ["Evidence, Plan, Steps, Thread, Files", ["1", "5"]],
      ["Next or previous tab", ["←", "→"]],
      ["Next or previous row", ["j", "k"]],
      ["Open ledger entry", ["↵"]],
      ["Re-run health checks", ["⇧", "R"]],
    ],
  },
];

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
  const cols = SECTIONS.map((s) => {
    const off = s.views && !s.views.includes(view) ? " off" : "";
    const rows = s.rows
      .map(([d, keys]) => `<div><dt>${esc(d)}</dt><dd>${kbd(...keys)}</dd></div>`)
      .join("");
    return `<section class="${off.trim()}"><h3>${esc(s.name)}</h3><dl>${rows}</dl></section>`;
  }).join("");
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
