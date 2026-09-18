// Inline and bulk field edits (PM_DESIGN §3.3–3.4): one menu per field, an
// optimistic change, then PATCH /api/cards/:id per card. On failure the value
// reverts and the toast says why, verbatim.
import { esc, icon } from "./dom.js";
import {
  ESTIMATES,
  PRIORITY_LABELS,
  PRIORITY_ORDER,
  assigneeLabel,
  formatFieldValue,
  formatPoints,
} from "./lib/pm.js";
import { prioMark } from "./marks.js";
import { openMenu } from "./overlay.js";
import { openPicker } from "./picker.js";
import { store } from "./store.js";
import { toast } from "./toast.js";
import { mutationsBlocked } from "./triage.js";

/** Uppercase keys, so they never collide with the triage verbs a / r / p. */
export const FIELD_KEYS = {
  P: "priority",
  E: "estimate",
  L: "labels",
  C: "cycleId",
  A: "assignee",
};

export const EDITABLE = [
  { field: "priority", label: "Priority", key: "⇧P" },
  { field: "estimate", label: "Points", key: "⇧E" },
  { field: "labels", label: "Labels", key: "⇧L" },
  { field: "cycleId", label: "Cycle", key: "⇧C" },
  { field: "assignee", label: "Assignee", key: "⇧A" },
  { field: "epicId", label: "Epic" },
  { field: "dueDate", label: "Due date" },
];

async function patchJSON(path, body) {
  try {
    const res = await fetch(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Sekhemet-Action": "1" },
      body: JSON.stringify(body),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: String(err?.message ?? err) } };
  }
}

function why(r) {
  if (r.status === 404 || r.status === 405)
    return `The server returned ${r.status}: this server can't edit cards yet.`;
  if (r.status === 403) return "This action must come from the dashboard. Reload the page.";
  if (r.status === 0) return "Sekhemet is not reachable.";
  return r.data?.error ?? `The server returned ${r.status}.`;
}

function shortName(id) {
  const c = store.card(id);
  return c?.display?.shortId ?? id;
}

/**
 * Set `field` to `value` on every card in `ids`. Optimistic: the store changes
 * first; each failed card reverts. One toast reports the outcome.
 */
export async function setField(ids, field, value) {
  const blocked = mutationsBlocked();
  if (blocked) {
    toast({
      tone: "parked",
      text: blocked === "readonly" ? "Read-only." : "Offline.",
      detail:
        blocked === "readonly"
          ? "This server was started without triage. Restart with sekhemet serve to edit cards."
          : "Edits are disabled until Sekhemet is reachable.",
    });
    return;
  }
  const before = new Map();
  for (const id of ids) {
    const c = store.card(id);
    if (!c) continue;
    before.set(id, c[field]);
    if (value === null || value === undefined) delete c[field];
    else c[field] = value;
  }
  store.set({ cards: [...store.state.cards] });
  const results = await Promise.all(
    [...before.keys()].map(async (id) => [
      id,
      await patchJSON(`/api/cards/${encodeURIComponent(id)}`, { [field]: value ?? null }),
    ]),
  );
  const failed = results.filter(([, r]) => !r.ok);
  for (const [id] of failed) {
    const c = store.card(id);
    if (!c) continue;
    const old = before.get(id);
    if (old === undefined) delete c[field];
    else c[field] = old;
  }
  if (failed.length) store.set({ cards: [...store.state.cards] });
  const label = EDITABLE.find((f) => f.field === field)?.label.toLowerCase() ?? field;
  const shown = formatFieldValue(field, value, {
    cycles: store.state.cycles,
    epics: store.state.epics,
    cards: store.state.cards,
  });
  const n = before.size;
  if (failed.length === 0) {
    toast({
      tone: "pass",
      text:
        n === 1
          ? `Set ${label} to ${shown} on ${shortName(ids[0])}`
          : `Set ${label} to ${shown} on ${n} cards`,
    });
  } else if (failed.length === n) {
    toast({
      tone: "fail",
      text:
        n === 1
          ? `Couldn't set ${label} on ${shortName(failed[0][0])}.`
          : `Couldn't set ${label} on ${n} cards.`,
      detail: why(failed[0][1]),
    });
  } else {
    toast({
      tone: "fail",
      text: `Set on ${n - failed.length} of ${n}. ${shortName(failed[0][0])}: ${why(failed[0][1])}`,
    });
  }
}

function common(ids, field) {
  const vals = ids.map((id) => JSON.stringify(store.card(id)?.[field] ?? null));
  return new Set(vals).size === 1 ? store.card(ids[0])?.[field] : undefined;
}

/** Open the edit menu for `field` on `ids`, anchored to `anchor`. */
export function editField(field, cardIds, anchor) {
  const ids = cardIds.filter((id) => store.card(id));
  if (!ids.length || !anchor) return;
  const cur = common(ids, field);
  const heading = `${EDITABLE.find((f) => f.field === field)?.label ?? field}${ids.length > 1 ? ` · ${ids.length} cards` : ""}`;
  const s = store.state;
  switch (field) {
    case "priority":
      openPicker(anchor, {
        heading,
        options: PRIORITY_ORDER.map((p) => ({
          value: p,
          label: PRIORITY_LABELS[p],
          html: prioMark(p),
          checked: (cur ?? 0) === p,
        })),
        onPick: (v) => setField(ids, field, v),
      });
      return;
    case "estimate":
      openPicker(anchor, {
        heading,
        options: [
          ...ESTIMATES.map((n) => ({ value: n, label: formatPoints(n), checked: cur === n })),
          { value: 0, label: "No estimate", checked: !cur },
        ],
        onPick: (v) => setField(ids, field, v || null),
      });
      return;
    case "cycleId": {
      const cycles = [...s.cycles].filter((c) => c.state !== "closed");
      if (!cycles.length) {
        toast({
          text: "No cycles yet.",
          detail: "Ask Seshat to plan one, or create one with POST /api/cycles.",
        });
        return;
      }
      openPicker(anchor, {
        heading,
        options: [
          ...cycles.map((c) => ({
            value: c.id,
            label: c.name,
            detail: c.state === "active" ? "Current" : "Next",
            checked: cur === c.id,
          })),
          { value: "", label: "No cycle", checked: !cur },
        ],
        onPick: (v) => setField(ids, field, v || null),
      });
      return;
    }
    case "epicId": {
      const epics = s.epics ?? [];
      openPicker(anchor, {
        heading,
        options: [
          ...epics.map((e) => ({ value: e.id, label: e.title, checked: cur === e.id })),
          { value: "", label: "No epic", checked: !cur },
        ],
        onPick: (v) => setField(ids, field, v || null),
      });
      return;
    }
    case "assignee": {
      const people = new Set(["worker", "human"]);
      for (const c of s.cards) if (c.assignee) people.add(c.assignee);
      openPicker(anchor, {
        heading,
        options: [
          ...[...people].map((a) => ({
            value: a,
            label: assigneeLabel(a),
            detail:
              a === "worker" ? "The local model" : a === "human" ? (s.meta?.gitUser ?? "") : "",
            checked: cur === a,
          })),
          { value: "", label: "Unassigned", checked: !cur },
        ],
        onPick: (v) => setField(ids, field, v || null),
      });
      return;
    }
    case "labels": {
      const all = new Set();
      for (const c of s.cards) for (const l of c.labels ?? []) all.add(l);
      // For a selection, a label is checked when every card has it.
      const has = (l) => ids.every((id) => (store.card(id)?.labels ?? []).includes(l));
      let chosen = new Set([...all].filter(has));
      const apply = () => {
        if (ids.length === 1) setField(ids, "labels", [...chosen].sort());
        else {
          // Bulk: add or remove only the toggled label, keep each card's others.
          for (const id of ids) {
            const c = store.card(id);
            const next = new Set(c?.labels ?? []);
            for (const l of all) if (!chosen.has(l) && has(l)) next.delete(l);
            for (const l of chosen) next.add(l);
            if (c) c._nextLabels = [...next].sort();
          }
          Promise.all(
            ids.map((id) => setField([id], "labels", store.card(id)?._nextLabels ?? [])),
          ).catch(() => {});
        }
      };
      let timer = 0;
      openPicker(anchor, {
        heading,
        multi: true,
        search: true,
        options: [...all].sort().map((l) => ({
          value: l,
          label: l,
          html: icon("tag", 12, "ic s12"),
          checked: chosen.has(l),
        })),
        onChange: (vals) => {
          chosen = new Set(vals);
          clearTimeout(timer);
          // One PATCH after the toggling settles, not one per click.
          timer = setTimeout(apply, 700);
        },
        create: (text) => {
          chosen.add(text.toLowerCase());
          apply();
        },
        footer: "Space toggles · ⌘↵ closes",
      });
      return;
    }
    case "dueDate": {
      const node = document.createElement("div");
      openPicker(anchor, {
        heading,
        search: false,
        options: [
          { value: "today", label: "Today" },
          { value: "week", label: "End of this week" },
          { value: "cycle", label: "End of the current cycle" },
          { value: "", label: "No due date", checked: !cur },
        ],
        onPick: (v) => {
          const d = new Date();
          let out = null;
          if (v === "today") out = d.toISOString().slice(0, 10);
          else if (v === "week") {
            d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7));
            out = d.toISOString().slice(0, 10);
          } else if (v === "cycle")
            out = s.cycles.find((c) => c.state === "active")?.endsOn ?? null;
          setField(ids, field, out);
        },
      });
      node.remove();
      return;
    }
  }
}

/** `.`: choose which field to edit. */
export function fieldMenu(ids, anchor) {
  openMenu(
    anchor,
    EDITABLE.map((f) => ({
      label: f.key ? `${f.label}  ${f.key}` : f.label,
      run: () => setTimeout(() => editField(f.field, ids, anchor), 0),
    })),
    { heading: ids.length > 1 ? `Edit ${ids.length} cards` : "Edit field" },
  );
}

/** Handle ⇧P ⇧E ⇧L ⇧C ⇧A and `.` for `ids`; returns true when handled. */
export function fieldKey(e, ids, anchor) {
  if (e.metaKey || e.ctrlKey || e.altKey || !ids.length) return false;
  const field = FIELD_KEYS[e.key];
  if (field && e.shiftKey) {
    editField(field, ids, anchor);
    return true;
  }
  if (e.key === ".") {
    fieldMenu(ids, anchor);
    return true;
  }
  return false;
}

export function selectionOrFocused() {
  const sel = [...store.state.selected].filter((id) => store.card(id));
  if (sel.length) return sel;
  return store.state.focusedId && store.card(store.state.focusedId) ? [store.state.focusedId] : [];
}

export { esc };
