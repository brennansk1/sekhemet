// What the card view shows for a plan's approval (planner-pm §2.17,
// PM-N7-5), as pure functions the tests import as-is: dom.js reads the
// served icon library, so this module escapes its own text. `approval.js`
// renders it and wires the button.

/** Escape text for markup: titles and criteria are a model's or a person's words. */
function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The cards of a view that still need a person's approval. */
export function waitingCards(view) {
  return (view?.cards ?? []).filter((c) => !c.approved);
}

function cardHtml(c) {
  const criteria = (c.criteria ?? [])
    .map((cr) => `<li><span class="mono">${esc(cr.id)}</span> ${esc(cr.text)}</li>`)
    .join("");
  const examples = (c.examples ?? []).length
    ? `<p class="apv-sub">Examples, given → expected</p><ul class="apv-ex">${c.examples
        .map((e) => `<li class="mono">${esc(e)}</li>`)
        .join("")}</ul>`
    : "";
  const tests = (c.tests ?? []).length
    ? `<ul class="apv-files">${c.tests
        .map(
          (t) =>
            `<li>${t.what === "file" ? "Test file" : "Example tables"}: <span class="mono">${esc(t.path)}</span>${t.approved ? " (approved)" : ""}</li>`,
        )
        .join("")}</ul>`
    : "";
  return `<li class="apv-card"><b>${esc(c.title)}</b> <span class="mono">${esc(c.id)}</span><ol class="apv-crit">${criteria}</ol>${examples}${tests}</li>`;
}

/** The approval block for a view from `GET /api/cards/:id/approval`, or "" when nothing waits. */
export function approvalHtml(view) {
  const waiting = waitingCards(view);
  if (waiting.length === 0) return "";
  const n = waiting.length;
  return `<section class="apv" aria-labelledby="apv-h"><h3 id="apv-h" class="apv-h">Waiting on your approval of its criteria</h3><p class="apv-note" id="apv-note">${
    n === 1 ? "This issue stays" : `These ${n} issues stay`
  } in Planning until a person approves what is shown here (the ${esc(view.profile)} profile). Approving records your name against exactly this content.</p><ul class="apv-list">${waiting
    .map(cardHtml)
    .join(
      "",
    )}</ul><div class="apv-acts"><button type="button" class="btn primary" data-approve aria-describedby="apv-note">Approve</button></div></section>`;
}

/** POST the person's approval of what `view` showed: `{ sha256 }` to the card's approve route. */
export function approveShown(cardId, view, post) {
  return post(`/api/cards/${encodeURIComponent(cardId)}/approve`, { sha256: view.sha256 });
}
