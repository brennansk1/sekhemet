// Playbook (FRONTEND_DESIGN §2.4.7): the learned rules the Worker is given, and
// the suggestions that came from your send-back notes.
import { $, copyText, esc, getJSON, icon } from "./dom.js";
import { gateLabel, parseTitle, shortId } from "./lib/vocabulary.js";
import { setTopbar } from "./shell.js";
import { store } from "./store.js";
import { toast } from "./toast.js";

const ui = { root: null, open: new Set(), last: "" };

function titleOf(id) {
  const c = store.card(id);
  return c ? (c.display?.title ?? parseTitle(c.title).title) : shortId(id);
}

function day(iso) {
  if (!iso) return "—";
  // A bare date is a calendar day, not UTC midnight: parse it as local.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

/** A candidate as a TOML rule to paste into .sekhemet/playbook.toml. */
function asToml(c, i) {
  const id = `rule_${shortId(c.cardId)}_${i + 1}`;
  const q = (s) =>
    `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
  return `[[rule]]\nid = ${q(id)}\noriginCard = ${q(c.cardId)}\ntriggerGate = "typecheck"\npattern = "src/"\ninstruction = ${q(c.reason)}\neffectiveDate = ${q(new Date().toISOString().slice(0, 10))}\n`;
}

function render() {
  if (!ui.root) return;
  const p = store.state.playbook;
  setTopbar({
    title: "Playbook",
    crumb: `${store.state.meta?.project ?? ""}${p ? ` · ${p.rules.length} rules · ${p.candidates.length} suggested` : ""}`,
  });
  let html;
  if (!p) html = '<div class="sk" style="height:160px"></div>';
  else {
    const rules = p.rules.length
      ? `<div class="tbl-wrap"><table class="tbl pb"><thead><tr><th>Instruction</th><th>Responds to</th><th>Taught by</th><th>Since</th><th>Applies to</th></tr></thead><tbody>${p.rules
          .map((r) => {
            const open = ui.open.has(r.id);
            return `<tr><td class="instr"><button type="button" class="clamp${open ? " open" : ""}" data-rule="${esc(r.id)}" aria-expanded="${open}">${esc(r.instruction)}</button><span class="mono sec">${esc(r.id)}</span></td><td>${r.triggerGate ? esc(gateLabel(r.triggerGate)) : '<span class="sec">Any gate</span>'}</td><td>${r.originCard ? `<a href="#/card/${encodeURIComponent(r.originCard)}/thread">${esc(titleOf(r.originCard))}</a>` : '<span class="sec">—</span>'}</td><td class="tnum">${esc(day(r.effectiveDate))}</td><td class="mono">${esc(r.pattern)}</td></tr>`;
          })
          .join("")}</tbody></table></div>`
      : '<p class="sec">No rules yet. Rules live in <span class="mono">.sekhemet/playbook.toml</span>; each one is given to the Worker when its pattern matches the card.</p>';
    const cands = p.candidates.length
      ? `<ul class="cands">${p.candidates
          .map(
            (c, i) =>
              `<li><div class="cq"><blockquote>${esc(c.reason)}</blockquote><div class="sec">From <a href="#/card/${encodeURIComponent(c.cardId)}/thread">${esc(titleOf(c.cardId))}</a> · ${esc(day(c.at))}</div></div><button class="btn sm" type="button" data-copy-rule="${i}" title="Copy this note as a [[rule]] block for .sekhemet/playbook.toml">${icon("copy", 14, "ic s14")}Copy as rule</button></li>`,
          )
          .join("")}</ul>`
      : '<p class="sec">No suggestions. Every note you write when sending a card back shows up here.</p>';
    html = `<section><h3 class="sh">Rules <span class="sec">${p.rules.length} · given to the Worker when a card's files match</span></h3>${rules}</section><section><h3 class="sh">Suggested rules <span class="sec">${p.candidates.length} from your send-back notes</span></h3>${cands}</section>`;
  }
  if (html === ui.last) return;
  ui.last = html;
  const body = $(".sc", ui.root);
  const top = body.scrollTop;
  body.innerHTML = html;
  body.scrollTop = top;
}

export function mount(view) {
  const root = document.createElement("div");
  root.className = "view-host";
  root.innerHTML = '<section class="sc pb-view" aria-label="Playbook"></section>';
  view.append(root);
  ui.root = root;
  ui.last = "";
  root.addEventListener("click", async (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const rule = t?.closest("[data-rule]");
    if (rule) {
      const id = rule.dataset.rule;
      if (ui.open.has(id)) ui.open.delete(id);
      else ui.open.add(id);
      render();
      return;
    }
    const cp = t?.closest("[data-copy-rule]");
    if (cp) {
      const c = store.state.playbook?.candidates?.[Number(cp.dataset.copyRule)];
      if (!c) return;
      const ok = await copyText(asToml(c, Number(cp.dataset.copyRule)));
      toast({
        text: ok ? "Copied as a [[rule]] block" : "Couldn't copy to the clipboard.",
        detail: ok ? "Paste it into .sekhemet/playbook.toml and pick its trigger gate." : "",
        tone: ok ? "info" : "fail",
      });
    }
  });
  const unsub = store.on((_s, patch) => {
    if ("playbook" in patch || "cards" in patch) render();
  });
  render();
  getJSON("/api/playbook").then((r) => r.ok && store.set({ playbook: r.data }));
  return {
    setParams() {},
    unmount() {
      unsub();
      root.remove();
      ui.root = null;
    },
  };
}
