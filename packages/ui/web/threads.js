// Review threads on the Changes tab (teams item 25, NEW-teams-8): the
// threads a *Comment* review opened, each with its comments by name, a
// Reply box, and Resolve conversation / Unresolve conversation — GitHub's
// pull-request review, as the research names it. The rows and every word
// are the pure model's (`/app/lib/review_desk.js`, `threadRows`); this module
// writes the markup and posts the reply and the resolve.
import { esc, icon, postJSON } from "./dom.js";
import { THREAD_COPY, threadRows } from "./lib/review_desk.js";
import { getSession } from "./session.js";
import { toast } from "./toast.js";

/** Whether the reader may resolve: a Member or an Admin (Solo's person is an Admin). */
function mayResolve() {
  const s = getSession();
  return s.mode !== "team" || s.level === "member" || s.level === "admin";
}

/**
 * The threads section. `drafts` keeps a reply being typed across the
 * redraws a stream frame causes, by thread id.
 */
export function threadsHtml(desk, drafts = {}) {
  const s = getSession();
  const m = threadRows(desk, s.principal, mayResolve());
  if (m.rows.length === 0) {
    return s.mode === "team"
      ? `<section class="rt" aria-labelledby="rt-h"><h3 class="sh" id="rt-h">${esc(m.heading)}</h3><p class="sec">${esc(THREAD_COPY.none)}</p></section>`
      : "";
  }
  const rows = m.rows
    .map((r) => {
      const comments = r.comments
        .map((c) => `<li><b>${esc(c.who)}</b> <span class="rt-t">${esc(c.text)}</span></li>`)
        .join("");
      const why = r.action.disabled
        ? `<span class="sec" id="rt-why-${esc(r.id)}">${esc(r.action.disabled)}</span>`
        : "";
      const act = `<button class="btn ghost" type="button" data-rt-act="${esc(r.action.verb)}" data-thread="${esc(r.id)}"${r.action.disabled ? ` disabled aria-describedby="rt-why-${esc(r.id)}"` : ""}>${icon(r.resolved ? "undo" : "check", 14, "ic s14")}${esc(r.action.label)}</button>${why}`;
      const reply = r.resolved
        ? ""
        : `<form class="rt-reply" data-rt-reply="${esc(r.id)}"><label class="sr-only" for="rt-r-${esc(r.id)}">${esc(THREAD_COPY.replyLabel(r.place))}</label><textarea id="rt-r-${esc(r.id)}" name="text" rows="1" placeholder="${esc(THREAD_COPY.reply)}">${esc(drafts[r.id] ?? "")}</textarea><button class="btn" type="submit">${esc(THREAD_COPY.reply)}</button></form>`;
      return `<li class="rt-row${r.resolved ? " resolved" : ""}" data-thread-row="${esc(r.id)}"><div class="rt-top"><span class="mono">${esc(r.place)}</span><span class="rt-state">${esc(r.state)}</span><span class="rt-acts">${act}</span></div><ul class="plain rt-cs">${comments}</ul>${reply}</li>`;
    })
    .join("");
  return `<section class="rt" aria-labelledby="rt-h"><h3 class="sh" id="rt-h">${esc(m.heading)} <span class="sec tnum">${esc(m.count)}</span></h3><ul class="plain rt-list">${rows}</ul></section>`;
}

/** Post a thread's resolve or reopen; true when it was recorded. */
export async function threadAction(cardId, thread, verb) {
  const res = await postJSON(
    `/api/cards/${encodeURIComponent(cardId)}/threads/${encodeURIComponent(thread)}/${verb}`,
    {},
  );
  if (!res.ok)
    toast({ text: "Couldn't change the thread.", detail: res.data?.error ?? "", tone: "fail" });
  return res.ok;
}

/** Post a reply in a thread; true when it was recorded. */
export async function replyInThread(cardId, thread, text) {
  const res = await postJSON(
    `/api/cards/${encodeURIComponent(cardId)}/threads/${encodeURIComponent(thread)}/replies`,
    { text },
  );
  if (!res.ok) toast({ text: "Couldn't reply.", detail: res.data?.error ?? "", tone: "fail" });
  return res.ok;
}
