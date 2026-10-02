// Undo for field and bulk edits, moves and holds (dashboard §2.4.23,
// NEW-dashboard-16). A result toast offers *Undo* (`z`) for 10 s; `z` acts on
// the newest toast that still offers it. Undo sends compensating requests —
// the log stays append-only — and says what it restored. Accept keeps its own
// grace window (triage.js) and never comes here.
import { toast } from "./toast.js";

/** How long a result toast offers Undo. */
export const UNDO_MS = 10_000;

/** The toasts that still offer Undo, oldest first. */
const offers = [];

/**
 * Show a result toast that offers Undo. `undo` runs the compensating
 * requests and returns the toast to show after: `{ text, detail?, tone? }`.
 */
export function toastWithUndo({ text, detail = "", tone = "pass", iconName }, undo) {
  const offer = { used: false, handle: null, timer: 0 };
  const run = async () => {
    if (offer.used) return;
    offer.used = true;
    clearTimeout(offer.timer);
    forget(offer);
    offer.handle.update({ text: "Undoing…", tone: "info", iconName: "undo", sticky: true });
    const after = await undo();
    offer.handle.update({ iconName: "undo", duration: 6000, ...after, tone: after.tone ?? "info" });
  };
  offer.handle = toast({
    text,
    detail,
    tone,
    ...(iconName ? { iconName } : {}),
    duration: UNDO_MS,
    action: { label: "Undo", kbd: "Z", run },
  });
  offer.run = run;
  offer.timer = setTimeout(() => forget(offer), UNDO_MS);
  offers.push(offer);
  return offer.handle;
}

function forget(offer) {
  const i = offers.indexOf(offer);
  if (i >= 0) offers.splice(i, 1);
}

/** `z`: undo the newest toast that offers it. True when there was one. */
export function undoLatest() {
  const offer = offers.at(-1);
  if (!offer) return false;
  void offer.run();
  return true;
}
