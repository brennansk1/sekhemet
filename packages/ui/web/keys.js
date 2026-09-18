// Keyboard core (FRONTEND_DESIGN §2.5.12): overlays first, then global keys and
// `g` chords, then the current view. Single keys never fire while typing.
import { openCheatsheet } from "./cheatsheet.js";
import { isTyping } from "./dom.js";
import { closeTop, topOverlay } from "./overlay.js";
import { openPalette } from "./palette.js";
import { peekAct } from "./peek.js";
import { toggleTheme } from "./shell.js";
import { undoAccept } from "./triage.js";

const CHORDS = {
  r: "#/review",
  b: "#/board",
  q: "#/runs",
  l: "#/ledger",
  m: "#/machine",
  p: "#/playbook",
};
let chordUntil = 0;

function view() {
  return window.sekhemetView?.();
}

/** Card actions from the palette: the view handles them if it can, else the peek drawer. */
function cardAction(key, card) {
  const v = view();
  if (v?.cardAction?.(key, card)) return;
  peekAct(card.id, key);
}

export function initKeys() {
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openPalette("", cardAction);
      return;
    }
    const top = topOverlay();
    if (top?.onKey?.(e)) return;
    if (e.key === "Escape") {
      if (top) {
        e.preventDefault();
        closeTop();
      } else if (isTyping(e)) {
        e.target.blur();
      }
      return;
    }
    if (top?.modal) return;
    if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;

    if (Date.now() < chordUntil) {
      chordUntil = 0;
      const hash = CHORDS[e.key];
      if (hash) {
        e.preventDefault();
        location.hash = hash;
      }
      return;
    }
    if (e.key === "g") {
      chordUntil = Date.now() + 1200;
      return;
    }
    if (e.key === "?") {
      e.preventDefault();
      openCheatsheet();
      return;
    }
    if (e.key === "t") {
      toggleTheme();
      return;
    }
    if (e.key === "/") {
      e.preventDefault();
      openPalette("#", cardAction);
      return;
    }
    if (e.key === "z" && undoAccept()) {
      e.preventDefault();
      return;
    }
    if (view()?.onKey?.(e)) e.preventDefault();
  });

  document.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest("[data-palette]")) openPalette("", cardAction);
    else if (t.closest("[data-cheats]")) openCheatsheet();
  });
}
