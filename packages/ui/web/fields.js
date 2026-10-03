// Inline and bulk field edits (PM_DESIGN §3.3–3.4): one menu per field, an
// optimistic change, then PATCH /api/cards/:id per card. On failure the value
// reverts and the toast says why, verbatim. One toast reports the outcome and
// offers Undo (`z`) for what was applied (§2.4.23, NEW-dashboard-16).
import { aiBadge, esc, icon, sendJSON } from "./dom.js";
import { noteFor } from "./level_gate.js";
import {
  ESTIMATES,
  PRIORITY_LABELS,
  PRIORITY_ORDER,
  assigneeLabel,
  formatFieldValue,
  formatPoints,
  showsPoints,
} from "./lib/pm.js";
import { fieldPermission } from "./lib/team_admin.js";
import { teammatePicker } from "./lib/teammates.js";
import { prioMark } from "./marks.js";
import { openMenu } from "./overlay.js";
import { openPicker } from "./picker.js";
import { offerNoSprint } from "./sprints.js";
import { store } from "./store.js";
import { toast } from "./toast.js";
import { mutationsBlocked } from "./triage.js";
import { toastWithUndo } from "./undo.js";

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
  { field: "cycleId", label: "Sprint", key: "⇧C" },
  { field: "assignee", label: "Assignee", key: "⇧A" },
  { field: "epicId", label: "Epic" },
  { field: "dueDate", label: "Due date" },
];

function patchJSON(path, body) {
  return sendJSON("PATCH", path, body);
}

function why(r) {
  if (r.status === 404 || r.status === 405)
    return `The server returned ${r.status}: this server can't edit issues yet.`;
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
export function setField(ids, field, value) {
  return setFieldEach(new Map(ids.map((id) => [id, value])), field, { value });
}

/** "TS-9's priority was changed by Priya since, so it was left." (DB-N16-2) */
function leftSentence(id, label, r) {
  const by = r.data?.changed?.[0]?.by;
  return `${shortName(id)}'s ${label} was changed${by ? ` by ${by}` : ""} since, so it was left.`;
}

/**
 * Undo an applied edit (DB-N16-2): each card gets its previous value back as a
 * new edit, only while it still holds the value this edit set.
 */
async function undoEdits(field, applied, label) {
  const results = await Promise.all(
    applied.map(async ({ id, was, set }) => [
      id,
      await patchJSON(`/api/cards/${encodeURIComponent(id)}`, {
        [field]: was ?? null,
        ifUnchanged: { [field]: set ?? null },
      }),
      was,
    ]),
  );
  const restored = results.filter(([, r]) => r.ok);
  for (const [id, , was] of restored) {
    const c = store.card(id);
    if (!c) continue;
    if (was === undefined || was === null) delete c[field];
    else c[field] = was;
  }
  if (restored.length) store.set({ cards: [...store.state.cards] });
  const left = results.filter(([, r]) => r.status === 409);
  const failed = results.filter(([, r]) => !r.ok && r.status !== 409);
  const Label = label.charAt(0).toUpperCase() + label.slice(1);
  const text = restored.length
    ? `${Label} restored on ${restored.length === 1 ? shortName(restored[0][0]) : `${restored.length} issues`}.`
    : `${Label} not restored.`;
  const detail = [
    ...left.map(([id, r]) => leftSentence(id, label, r)),
    ...failed.slice(0, 1).map(([id, r]) => `${shortName(id)}: ${why(r)}`),
  ].join(" ");
  return { text, detail, tone: failed.length ? "fail" : "info" };
}

/**
 * Set `field` on each card in `values` (id → its new value): one request per
 * issue, each its own recorded edit, and one toast for them all (BRD-12).
 * `opts.value` is the one value every card gets, when there is one.
 */
export async function setFieldEach(values, field, opts = {}) {
  const ids = [...values.keys()];
  const blocked = mutationsBlocked();
  if (blocked) {
    toast({
      tone: "parked",
      text: blocked === "readonly" ? "Read-only." : "Offline.",
      detail:
        blocked === "readonly"
          ? "This server was started without triage. Restart with sekhemet serve to edit issues."
          : "Edits are disabled until Sekhemet is reachable.",
    });
    return;
  }
  const before = new Map();
  for (const id of ids) {
    const c = store.card(id);
    if (!c) continue;
    const value = values.get(id);
    before.set(id, c[field]);
    if (value === null || value === undefined) delete c[field];
    else c[field] = value;
  }
  store.set({ cards: [...store.state.cards] });
  const results = await Promise.all(
    [...before.keys()].map(async (id) => [
      id,
      await patchJSON(`/api/cards/${encodeURIComponent(id)}`, {
        [field]: values.get(id) ?? null,
      }),
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
  const shown =
    "value" in opts
      ? formatFieldValue(field, opts.value, {
          cycles: store.state.cycles,
          epics: store.state.epics,
          cards: store.state.cards,
        })
      : "";
  const n = before.size;
  // What was applied, so Undo can give each card its previous value back.
  const failedIds = new Set(failed.map(([id]) => id));
  const applied = [...before.entries()]
    .filter(([id]) => !failedIds.has(id))
    .map(([id, was]) => ({ id, was, set: values.get(id) }));
  const undo = () => undoEdits(field, applied, label);
  if (failed.length === 0) {
    const on = n === 1 ? shortName(ids[0]) : `${n} issues`;
    toastWithUndo(
      {
        tone: "pass",
        text: shown ? `Set ${label} to ${shown} on ${on}` : `Changed ${label} on ${on}`,
      },
      undo,
    );
  } else if (failed.length === n) {
    toast({
      tone: "fail",
      text:
        n === 1
          ? `Couldn't set ${label} on ${shortName(failed[0][0])}.`
          : `Couldn't set ${label} on ${n} issues.`,
      detail: why(failed[0][1]),
    });
  } else {
    toastWithUndo(
      {
        tone: "fail",
        text: `Set on ${n - failed.length} of ${n}. ${shortName(failed[0][0])}: ${why(failed[0][1])}`,
      },
      undo,
    );
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
  // DB-N9-17: where the person's level cannot change this field on an issue's
  // project, say who can instead of opening the menu (the server refuses too).
  for (const id of ids) {
    const c = store.card(id);
    const note = noteFor(fieldPermission(field), c?.projectId, c?.projectName);
    if (note) {
      toast({ tone: "parked", text: note });
      return;
    }
  }
  const cur = common(ids, field);
  const heading = `${EDITABLE.find((f) => f.field === field)?.label ?? field}${ids.length > 1 ? ` · ${ids.length} issues` : ""}`;
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
        // DB-N11-5: New sprint and Plan a sprint with Seshat, never a dead end.
        offerNoSprint(anchor);
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
          { value: "", label: "No sprint", checked: !cur },
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
      // TEAM-17: the people under Members, the Agent and Seshat under AI
      // teammates with the AI badge — never mixed in with the people.
      const people = new Set(["human"]);
      for (const c of s.cards) if (c.assignee && c.assignee !== "worker") people.add(c.assignee);
      const groups = teammatePicker({
        people: [...people].map((a) => ({
          value: a,
          label: assigneeLabel(a),
          ...(a === "human" && s.meta?.gitUser ? { detail: s.meta.gitUser } : {}),
        })),
        purpose: "assign",
      });
      openPicker(anchor, {
        heading,
        options: [
          { value: "", label: "Unassigned", checked: !cur },
          ...groups.flatMap((g) =>
            g.options.map((o) => ({
              ...o,
              group: g.heading,
              plain: true,
              ...(o.ai ? { badge: aiBadge() } : {}),
              checked: cur === o.value,
            })),
          ),
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
          // Bulk: add or remove only the toggled label, keep each card's
          // others; one toast for the selection (BRD-12).
          const next = new Map();
          for (const id of ids) {
            const labels = new Set(store.card(id)?.labels ?? []);
            for (const l of all) if (!chosen.has(l) && has(l)) labels.delete(l);
            for (const l of chosen) labels.add(l);
            next.set(id, [...labels].sort());
          }
          void setFieldEach(next, "labels");
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
          { value: "cycle", label: "End of the current sprint" },
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
    EDITABLE.filter((f) => f.field !== "estimate" || showsPoints(store.state.estimation)).map(
      (f) => ({
        label: f.key ? `${f.label}  ${f.key}` : f.label,
        run: () => setTimeout(() => editField(f.field, ids, anchor), 0),
      }),
    ),
    { heading: ids.length > 1 ? `Edit ${ids.length} issues` : "Edit field" },
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
