// Views that arrive in a later phase (Runs, Ledger, Machine, Playbook). Each
// says what it will hold and where the same information is available today.
import { esc, icon } from "./dom.js";
import { setTopbar } from "./shell.js";
import { store } from "./store.js";

const COPY = {
  runs: {
    title: "Runs",
    icon: "runs",
    lead: "Scorecards for unattended runs arrive in a later release.",
    cli: "sekhemet queue --auto-accept",
    hint: "The latest run's report is in .sekhemet/queue_report.json.",
  },
  ledger: {
    title: "Ledger",
    icon: "ledger",
    lead: "The ledger as sentences, with filters, arrives in a later release.",
    cli: "sekhemet log",
    hint: "Integrity is checked live: see the status at the bottom of the sidebar.",
  },
  machine: {
    title: "Machine",
    icon: "machine",
    lead: "Memory, model and health checks in one view arrive in a later release.",
    cli: "sekhemet doctor",
    hint: "Memory and model status already show at the bottom of the sidebar.",
  },
  playbook: {
    title: "Playbook",
    icon: "playbook",
    lead: "Learned rules and your send-back notes arrive in a later release.",
    cli: "cat .sekhemet/playbook.toml",
    hint: "Every note you write when sending a card back is kept in .sekhemet/playbook_candidates.jsonl.",
  },
};

export function mount(view, route) {
  const c = COPY[route.name];
  const host = document.createElement("div");
  host.className = "view-host";
  const v = store.state.verification;
  const extra =
    route.name === "ledger" && v
      ? `<span>${v.valid ? `Ledger intact · ${esc(v.totalEvents)} entries.` : `Ledger altered at entry #${esc(v.corruptedSeq)}.`}</span>`
      : "";
  host.innerHTML = `<div class="later">${icon(c.icon, 24, "ic s24")}<b>${esc(c.title)}</b><span>${esc(c.lead)}</span>${extra}<span>Today: <code>${esc(c.cli)}</code></span><span>${esc(c.hint)}</span></div>`;
  view.append(host);
  setTopbar({ title: c.title, crumb: store.state.meta?.project ?? "" });
  return {
    setParams() {},
    unmount() {
      host.remove();
    },
  };
}
