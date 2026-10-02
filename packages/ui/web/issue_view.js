// The issue page's own block (dashboard §2.6, NEW-dashboard-8, DEC-34): the
// description, the acceptance criteria with each one's check state, and the
// agent — its state in words and the controls it offers. Every word and every
// rule comes from `/app/lib/issue.js`; this module only renders and posts.
import { aiBadge, esc, icon, postJSON, teammateName } from "./dom.js";
import { ISSUE_COPY, agentPanel, criteriaChecks } from "./lib/issue.js";
import { aiStateLine } from "./lib/teammates.js";
import { toast } from "./toast.js";
import { blockedToast } from "./triage.js";

const MARK = {
  pass: () => icon("check", 14, "ic s14 i-pass"),
  fail: () => icon("x", 14, "ic s14 i-fail"),
  none: () => '<span class="cc-none" aria-hidden="true"></span>',
};

/** The AI badge beside an AI teammate's name (DEC-36, DB-N9-18): `icons.ts`'s one badge. */
export { aiBadge };

function criteriaHtml(card, evidence) {
  const c = criteriaChecks(card, evidence);
  const items = c.items
    .map(
      (i) =>
        `<li class="cc ${i.state}"><span class="cc-mark">${MARK[i.state]()}</span><span class="cc-t">${i.id ? `<span class="mono sec">${esc(i.id)}</span> ` : ""}${esc(i.text)}</span><span class="cc-s">${esc(i.stateText)}</span></li>`,
    )
    .join("");
  return `<section aria-labelledby="iss-crit-h"><h3 class="sh" id="iss-crit-h">${esc(ISSUE_COPY.criteria)} <span class="sec tnum">${esc(c.summary)}</span></h3>${items ? `<ul class="crit-checks">${items}</ul>` : ""}${c.note ? `<p class="sec">${esc(c.note)}</p>` : ""}</section>`;
}

/**
 * The AI teammates' state as the server set it (teams item 19, TEAM-15): the
 * Agent's words replace the panel's when the harness knows more (queued with
 * its place, a start request waiting on a person); Seshat's is its own line.
 */
function withAiState(panel, ai) {
  const agent = (ai ?? []).find((a) => a.who === "agent");
  // ISS-02, ISS-03: the page's own Stopped line names the person from the ledger.
  if (!agent || panel.state === "stopped") return panel;
  const line = aiStateLine(agent);
  return { ...panel, label: line.label, sentence: line.sentence };
}

function seshatHtml(ai) {
  const seshat = (ai ?? []).find((a) => a.who === "seshat");
  if (!seshat) return "";
  const line = aiStateLine(seshat);
  return `<div class="ag-line"><span class="ag-who">${teammateName(line.name, "seshat")}</span><span class="ag-state">${esc(line.label)}</span><span class="ag-sentence">${esc(line.sentence)}</span></div>`;
}

/** DB-N9-17: the permission each of the Agent's controls needs (teams item 6). */
const AGENT_NEEDS = {
  pause: "agent.pause",
  take_over: "agent.take_over",
  hand_back: "agent.guide",
  resume: "agent.guide",
};

const AGENT_ICON = {
  pause: "pause",
  take_over: "user",
  submit: "check-circle",
  resume: "refresh",
};

function agentHtml(panel, handBackOpen, seshat = "", project = "") {
  const buttons = panel.controls
    .map(
      (id) =>
        `<button class="btn" type="button" data-agent="${esc(id)}"${AGENT_NEEDS[id] ? ` data-needs="${AGENT_NEEDS[id]}"${project ? ` data-needs-project="${esc(project)}"` : ""}` : ""}${id === "hand_back" && handBackOpen ? ' aria-expanded="true"' : id === "hand_back" ? ' aria-expanded="false"' : ""}>${icon(AGENT_ICON[id] ?? "send", 14, "ic s14")}${esc(ISSUE_COPY.controls[id])}</button>`,
    )
    .join("");
  const form =
    handBackOpen && panel.controls.includes("hand_back")
      ? `<form class="hb-form" data-handback><label for="hb-note">${esc(ISSUE_COPY.handBackNote)}</label><textarea id="hb-note" name="note" rows="2"></textarea><div class="acts"><button type="button" class="btn ghost" data-handback-cancel>${esc(ISSUE_COPY.cancel)}</button><button type="submit" class="btn">${icon("send", 14, "ic s14")}${esc(ISSUE_COPY.handBackConfirm)}</button></div></form>`
      : "";
  return `<div class="agent-bar" role="group" aria-label="${esc(ISSUE_COPY.agent)}"><div class="ag-line"><span class="ag-who">${teammateName(ISSUE_COPY.agent, "agent")}</span>${panel.label ? `<span class="ag-state ${esc(panel.state)}">${esc(panel.label)}</span>` : ""}<span class="ag-sentence">${esc(panel.sentence)}</span>${buttons ? `<span class="acts">${buttons}</span>` : ""}</div>${form}${seshat}</div>`;
}

/**
 * Mount the issue block into `host`. `ctx` gives the card, its detail and its
 * events; `refresh()` redraws after a change the page made itself.
 */
export function mountIssue(host, ctx) {
  const state = { about: true, handBack: false, last: "", id: null };

  const draw = () => {
    const card = ctx.card();
    // Another issue: its hand-back note starts closed.
    if (state.id !== ctx.id) {
      state.id = ctx.id;
      state.handBack = false;
    }
    if (!card) {
      host.innerHTML = "";
      state.last = "";
      return;
    }
    const detail = ctx.detail();
    const full = detail?.card ?? card;
    const panel = withAiState(agentPanel(card, ctx.events() ?? []), detail?.ai);
    if (!panel.controls.includes("hand_back")) state.handBack = false;
    const crit = criteriaChecks(full, detail?.evidence ?? null);
    const spec = String(full.spec ?? "").trim();
    const next = `<details class="iss-about" data-about${state.about ? " open" : ""}><summary>${esc(ISSUE_COPY.description)} · ${esc(ISSUE_COPY.criteria)} <span class="sec tnum">${esc(crit.summary)}</span></summary><div class="iss-grid"><section aria-labelledby="iss-desc-h"><h3 class="sh" id="iss-desc-h">${esc(ISSUE_COPY.description)}</h3>${spec ? `<p class="prose">${esc(spec)}</p>` : `<p class="sec">${esc(ISSUE_COPY.noDescription)}</p>`}</section>${criteriaHtml(full, detail?.evidence ?? null)}</div></details>${agentHtml(panel, state.handBack, seshatHtml(detail?.ai), full.projectId ?? "")}`;
    if (next === state.last) return;
    // Keep a half-written hand-back note across a redraw.
    const note = host.querySelector("#hb-note")?.value ?? "";
    const focused = document.activeElement;
    const which = focused?.dataset?.agent;
    const inNote = focused?.id === "hb-note";
    host.innerHTML = next;
    state.last = next;
    const area = host.querySelector("#hb-note");
    if (area) area.value = note;
    if (inNote) area?.focus();
    else if (which) host.querySelector(`[data-agent="${which}"]`)?.focus();
  };

  const act = async (path, body, done) => {
    if (blockedToast()) return;
    const res = await postJSON(`/api/cards/${encodeURIComponent(ctx.id)}/${path}`, body ?? {});
    if (!res.ok) {
      toast({
        text: `Couldn't ${path.replace(/-/g, " ")}.`,
        detail: res.data?.error ?? `The server returned ${res.status}.`,
        tone: "fail",
      });
      return;
    }
    done(res.data ?? {});
    ctx.refresh();
  };

  host.addEventListener(
    "toggle",
    (e) => {
      if (e.target instanceof Element && e.target.matches("[data-about]")) {
        state.about = e.target.open;
      }
    },
    true,
  );

  host.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest("[data-handback-cancel]")) {
      state.handBack = false;
      draw();
      host.querySelector('[data-agent="hand_back"]')?.focus();
      return;
    }
    const b = t.closest("[data-agent]");
    if (!b) return;
    const card = ctx.card();
    if (!card) return;
    const panel = agentPanel(card, ctx.events() ?? []);
    const id = b.dataset.agent;
    if (id === "pause") {
      void act("pause", {}, () => toast({ text: ISSUE_COPY.pauseAsked, iconName: "pause" }));
    } else if (id === "take_over") {
      // The server takes over only a stopped agent: while it runs, pause first.
      if (panel.state === "working" || panel.state === "pausing") {
        void act("pause", {}, () =>
          toast({ text: ISSUE_COPY.takeOverWhileRunning, iconName: "pause" }),
        );
      } else {
        void act("take-over", {}, (data) =>
          toast({
            text: ISSUE_COPY.tookOver(data.worktreePath ?? `.sekhemet/worktrees/${ctx.id}`),
            duration: 8000,
          }),
        );
      }
    } else if (id === "submit") {
      void act("submit-take-over", {}, (data) =>
        toast(
          data.passed
            ? { text: ISSUE_COPY.checksPassed, tone: "info" }
            : {
                text: ISSUE_COPY.checksFailed(data.failures?.length ?? 0),
                detail: (data.failures ?? []).slice(0, 3).join("\n"),
                tone: "fail",
              },
        ),
      );
    } else if (id === "resume") {
      // ISS-02: a stopped run resumes from its last checkpoint (the server's hand-back).
      void act("hand-back", { note: "" }, () => toast({ text: ISSUE_COPY.resumed }));
    } else if (id === "hand_back") {
      state.handBack = !state.handBack;
      draw();
      if (state.handBack) host.querySelector("#hb-note")?.focus();
    }
  });

  host.addEventListener("submit", (e) => {
    const form = e.target instanceof Element ? e.target.closest("[data-handback]") : null;
    if (!form) return;
    e.preventDefault();
    const note = form.querySelector("#hb-note")?.value ?? "";
    void act("hand-back", { note }, () => {
      state.handBack = false;
      toast({ text: ISSUE_COPY.handedBack, iconName: "send" });
    });
  });

  host.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && e.target instanceof Element && e.target.closest("[data-handback]")) {
      e.preventDefault();
      e.stopPropagation();
      state.handBack = false;
      draw();
      host.querySelector('[data-agent="hand_back"]')?.focus();
    }
  });

  draw();
  return { draw };
}
