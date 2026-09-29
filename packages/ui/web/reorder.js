// Drag to reorder within a column (B11), and Alt+Up / Alt+Down on the
// focused tile for keyboards. Each move is one POST /api/cards/:id/reorder
// with the card's new neighbours; the server writes one fractional key.
import { postJSON } from "./dom.js";
import { noteFor } from "./level_gate.js";
import { dropIndex, neighboursFor } from "./reorder_logic.js";
import { store } from "./store.js";
import { toast } from "./toast.js";

function columnOf(tile) {
  return tile?.parentElement ?? null;
}

function idsIn(list) {
  return [...list.children].filter((n) => n.classList?.contains("tile")).map((n) => n.dataset.id);
}

/** DB-N9-17: why this person cannot move the tile's issue, or undefined when they can. */
function moveNote(tile) {
  const card = store.card(tile?.dataset.id);
  return noteFor("priority.change", card?.projectId, card?.projectName);
}

async function send(id, pos) {
  if (!pos) return;
  const r = await postJSON(`/api/cards/${encodeURIComponent(id)}/reorder`, pos);
  if (r.ok) window.dispatchEvent(new CustomEvent("sekhemet:refresh-view"));
}

/** Wire drag-and-drop and the keyboard move onto a board container. */
export function bindReorder(container) {
  let dragged = null;
  container.addEventListener("pointerdown", (e) => {
    const tile = e.target instanceof Element ? e.target.closest(".tile") : null;
    // Below Member the tile does not drag; the board says why once, above it.
    if (tile && !moveNote(tile)) tile.draggable = true;
  });
  container.addEventListener("dragstart", (e) => {
    const tile = e.target instanceof Element ? e.target.closest(".tile") : null;
    if (!tile) return;
    dragged = tile;
    tile.classList.add("dragging");
    e.dataTransfer?.setData("text/plain", tile.dataset.id);
  });
  container.addEventListener("dragover", (e) => {
    if (!dragged) return;
    const list = e.target instanceof Element ? e.target.closest(".tile")?.parentElement : null;
    if (list && list === columnOf(dragged)) e.preventDefault();
  });
  container.addEventListener("drop", (e) => {
    if (!dragged) return;
    const list = columnOf(dragged);
    e.preventDefault();
    const tiles = [...list.children].filter((n) => n.classList?.contains("tile"));
    const mids = tiles.map((t) => {
      const r = t.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    void send(
      dragged.dataset.id,
      neighboursFor(idsIn(list), dragged.dataset.id, dropIndex(mids, e.clientY)),
    );
  });
  container.addEventListener("dragend", () => {
    dragged?.classList.remove("dragging");
    if (dragged) dragged.draggable = false;
    dragged = null;
  });
  container.addEventListener("keydown", (e) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    const tile = e.target instanceof Element ? e.target.closest(".tile") : null;
    const list = columnOf(tile);
    if (!tile || !list) return;
    e.preventDefault();
    const note = moveNote(tile);
    if (note) {
      toast({ tone: "parked", text: note });
      return;
    }
    const ids = idsIn(list);
    const from = ids.indexOf(tile.dataset.id);
    const to = e.key === "ArrowUp" ? from - 1 : from + 2;
    void send(tile.dataset.id, neighboursFor(ids, tile.dataset.id, to));
  });
}
