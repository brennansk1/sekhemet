// The issue page's Watch toggle (teams item 22; dashboard §2.6's header, in
// the Team setup): *Watch*, or *Watching* with who else watches — Jira's
// watchers and Linear's subscribe. A watcher gets every change on the issue
// in their Inbox. The toggle is each person's own; every level may use it.
import { esc, getJSON, postJSON } from "./dom.js";
import { WATCH_COPY, watchLine } from "./lib/inbox.js";
import { getSession } from "./session.js";
import { toast } from "./toast.js";

/** Mount the toggle in `host` for the issue `id()` names; Solo shows nothing. */
export function mountWatch(host, ctx) {
  let state = null;
  let seq = 0;
  const draw = () => {
    if (!state || getSession().mode !== "team") {
      host.hidden = true;
      host.innerHTML = "";
      return;
    }
    const l = watchLine({
      watching: state.watching,
      watchers: (state.watchers ?? []).map((w) => w.name),
    });
    host.hidden = false;
    host.innerHTML = `<span class="watch"><button class="btn sm" type="button" data-watch aria-pressed="${l.pressed}" title="${esc(WATCH_COPY.hint)}">${esc(l.label)}</button><span class="sec">${esc(l.detail)}</span></span>`;
  };
  const load = async () => {
    const id = ctx.id();
    const mine = ++seq;
    if (!id || getSession().mode !== "team") {
      state = null;
      draw();
      return;
    }
    const r = await getJSON(`/api/issues/${encodeURIComponent(id)}/watch`);
    if (mine !== seq) return;
    state = r.ok ? r.data : null;
    draw();
  };
  host.addEventListener("click", async (e) => {
    const t = e.target instanceof Element ? e.target.closest("[data-watch]") : null;
    if (!t || !state) return;
    const id = ctx.id();
    const r = await postJSON(`/api/issues/${encodeURIComponent(id)}/watch`, {
      watch: !state.watching,
    });
    if (!r.ok) {
      toast({
        text: "Couldn't change Watch.",
        detail: r.data?.error ?? `The server returned ${r.status}.`,
        tone: "fail",
      });
      return;
    }
    state = r.data;
    draw();
  });
  return { load };
}
