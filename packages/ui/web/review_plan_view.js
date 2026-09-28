// Review plan (design-stage §2.9 items 5-7, DS-P2-6, -7; planner-pm §2.9):
// a new project's proposal group, before anything exists, as pure functions
// the tests import as-is. `review_plan.js` renders it and wires the buttons.
// The on-screen words name candidates, never a "requirements" heading
// (design-stage §2.2.6).

/** Escape text for markup: the brief and the candidates are a person's or a model's words. */
function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PRIORITIES = [
  ["must", "Must have"],
  ["should", "Should have"],
  ["could", "Could have"],
];

const TYPES = ["prototype", "internal tool", "production", "regulated"];

const BRIEF = [
  ["problem", "Problem"],
  ["outcome", "Outcome"],
  ["users", "Users"],
  ["notInScope", "Not in scope"],
  ["constraints", "Constraints"],
  ["priorArt", "Prior art"],
  ["riskiest", "Riskiest assumption"],
  ["doneMeans", "Done means"],
];

/** A proposal Review plan can show: a `start_project` carrying its group. */
export function hasReviewPlan(proposal) {
  return proposal?.kind === "start_project" && proposal?.patch?.group?.version === 1;
}

/**
 * The button a project proposal has in place of Apply: applying is where the
 * person's choices go, so it opens Review plan first (DS-P2-6).
 */
export function reviewPlanButtonHtml(busy) {
  return `<button class="btn primary sm" type="button" data-review-plan${busy ? " disabled" : ""}>${busy ? "Creating…" : "Review plan"}</button>`;
}

/** The person's choices, starting from what the group proposes. */
export function reviewState(group) {
  return {
    accept: [],
    remove: [],
    line: group.releaseLine,
    type: group.type.profile,
    answers: {},
  };
}

/** The candidates still in the plan, in order: proposed-and-kept, or accepted. */
export function keptCandidates(group, state) {
  return group.candidates.filter(
    (c) => !state.remove.includes(c.key) && (c.accepted || state.accept.includes(c.key)),
  );
}

/** Accept or Remove one candidate; each undoes the other. */
export function toggleCandidate(state, key, verb) {
  const accept = state.accept.filter((k) => k !== key);
  const remove = state.remove.filter((k) => k !== key);
  if (verb === "accept") accept.push(key);
  else remove.push(key);
  return { ...state, accept, remove };
}

/** Move the release line by `delta` candidates, within the kept ones (at least one above it). */
export function moveLine(group, state, delta) {
  const n = keptCandidates(group, state).length;
  const line = Math.max(1, Math.min(n, state.line + delta));
  return { ...state, line };
}

export function setType(state, type) {
  return TYPES.includes(type) ? { ...state, type } : state;
}

export function setAnswer(state, question, answer) {
  return { ...state, answers: { ...state.answers, [String(question)]: answer } };
}

/** The body Create project sends with the apply (`choices`, PM_CONTRACT §3). */
export function choicesOf(state) {
  return {
    ...(state.accept.length ? { accept: [...state.accept] } : {}),
    ...(state.remove.length ? { remove: [...state.remove] } : {}),
    releaseLine: state.line,
    type: state.type,
    ...(Object.keys(state.answers).length ? { answers: { ...state.answers } } : {}),
  };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function briefHtml(group) {
  return BRIEF.map(([field, label]) => {
    const lines = group.brief[field] ?? [];
    return `<div class="rp-sec"><h4 class="rp-h">${esc(label)}</h4>${
      lines.length
        ? `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`
        : '<p class="sec">Not stated.</p>'
    }</div>`;
  }).join("");
}

function candidateHtml(c, state) {
  const kept = !state.remove.includes(c.key) && (c.accepted || state.accept.includes(c.key));
  const status = kept ? "In the plan" : state.remove.includes(c.key) ? "Removed" : "Proposed";
  return `<li class="rp-cand${kept ? " kept" : ""}" data-cand="${esc(c.key)}" draggable="true"><span class="t">${esc(c.title)}</span><span class="sec">${esc(status)}</span><span class="rp-acts"><button type="button" class="btn ghost sm" data-accept="${esc(c.key)}" aria-pressed="${kept}">Accept</button><button type="button" class="btn ghost sm" data-remove="${esc(c.key)}" aria-pressed="${state.remove.includes(c.key)}">Remove</button></span></li>`;
}

const LINE = `<li class="rp-line" data-release-line role="separator" aria-label="Release line: above it is the first release"><button type="button" class="btn ghost sm" data-line-up aria-label="Move the release line up">↑</button><span>First release ends here</span><button type="button" class="btn ghost sm" data-line-down aria-label="Move the release line down">↓</button></li>`;

function candidatesHtml(group, state) {
  const kept = keptCandidates(group, state);
  const lineAfter = kept[state.line - 1]?.key;
  return PRIORITIES.map(([priority, label]) => {
    const items = group.candidates.filter((c) => c.priority === priority);
    if (!items.length)
      return `<div class="rp-pri"><h4 class="rp-h">${label}</h4><p class="sec">None.</p></div>`;
    return `<div class="rp-pri"><h4 class="rp-h">${label}</h4><ul class="rp-cands">${items
      .map((c) => `${candidateHtml(c, state)}${c.key === lineAfter ? LINE : ""}`)
      .join("")}</ul></div>`;
  }).join("");
}

function releasesHtml(group, state) {
  const kept = keptCandidates(group, state);
  const holds = [kept.slice(0, state.line), kept.slice(state.line)];
  return `<ul class="rp-rel">${group.releases
    .map((r, i) => {
      const n = (holds[i] ?? []).length;
      const when = r.forecast
        ? `50%: within ${plural(r.forecast.p50Days, "day")} · 85%: within ${plural(r.forecast.p85Days, "day")}`
        : "Not enough history yet";
      return `<li><b>${esc(r.name)}</b> <span class="sec">${plural(n, "candidate")}, about ${plural(r.cards, "issue")}</span> <span class="tnum">${esc(when)}</span></li>`;
    })
    .join("")}</ul>`;
}

function typeHtml(group, state) {
  const options = TYPES.map(
    (t) =>
      `<option value="${esc(t)}"${t === state.type ? " selected" : ""}>${esc(t.charAt(0).toUpperCase() + t.slice(1))}</option>`,
  ).join("");
  return `<div class="rp-type"><label>Type <select data-type>${options}</select></label><p class="sec">Proposed: ${esc(group.type.profile)}. ${esc(group.type.reason)}</p></div>`;
}

function questionsHtml(group, state) {
  if (!group.questions.length) return "";
  return `<div class="rp-qs">${group.questions
    .slice(0, 2)
    .map((q, i) => {
      const picked = state.answers[String(i)];
      const opts = q.answers
        .map(
          (a, j) =>
            `<label><input type="radio" name="rp-q${i}" data-answer="${i}" value="${j}"${picked === j ? " checked" : ""}> ${esc(a)}</label>`,
        )
        .join("");
      return `<fieldset><legend>${esc(q.question)}</legend>${opts}<p class="sec">Unanswered, it is assumed: ${esc(q.default)}.</p></fieldset>`;
    })
    .join("")}</div>`;
}

/** Review plan for one group and the person's choices so far. */
export function reviewPlanHtml(group, state, { setup = "solo" } = {}) {
  const c = group.creates;
  const counted = `${plural(c.project, "project")}, ${plural(c.epics, "epic")}, ${plural(c.issues, "issue")}, the brief and its setup issue`;
  // TEAM-20's Send for approval is not built: in the Team setup the button
  // says what pressing it does — it creates the project and accepts its
  // brief — and who may press it is said beforehand.
  const who =
    setup === "team"
      ? '<p class="sec" id="rp-who">In the Team setup an Admin creates the project, since creating it accepts its brief.</p>'
      : "";
  const label = setup === "team" ? "Create project and accept its brief" : "Create project";
  return `<section class="rp" aria-labelledby="rp-h"><h3 id="rp-h">Review plan</h3><p class="sec">“${esc(group.sentence)}”</p><h4 class="rp-h2">The brief</h4>${briefHtml(group)}<h4 class="rp-h2">What it does</h4>${typeHtml(group, state)}${candidatesHtml(group, state)}<h4 class="rp-h2">Releases</h4>${releasesHtml(group, state)}${questionsHtml(group, state)}<h4 class="rp-h2">Assumed</h4><ul class="rp-asm">${group.assumptions
    .map((a) => `<li>${esc(a)}</li>`)
    .join(
      "",
    )}</ul><p class="rp-count" id="rp-count">Creating it makes ${counted}, set up first by ${esc(group.stack.name)}'s own generator. Nothing exists until you create it.</p>${who}<div class="rp-foot"><button type="button" class="btn primary" data-create aria-describedby="rp-count${who ? " rp-who" : ""}">${label}</button></div></section>`;
}

/**
 * The two issues a project started by conversation begins with (design-stage
 * §2.4, DS-P2-1..3; internally card zero and card one): what each one's check
 * is, since neither is the usual one. DEC-31: *issue* and *checks* on screen.
 */
export function startCardNote(card) {
  const labels = card?.labels ?? [];
  if (labels.includes("card-zero")) {
    return "This setup issue runs the ecosystem's own generator, one step per command in its description. Its check looks at the files the generator leaves; once it is done, the project's checks are derived from them and the generator's version is written into the brief.";
  }
  if (labels.includes("card-one")) {
    return "This issue is the project's first failing test. Its check passes only when the test runs and fails at an assertion, for the reason its criterion states; failing at an import, at collection or at setup does not count. Every issue after it has a functional check.";
  }
  return "";
}
