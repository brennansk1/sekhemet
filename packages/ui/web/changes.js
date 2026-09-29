// Changes tab (dashboard §2.6, DB-N8-1, DB-N8-4): the files relevant to the
// card, then the diff grouped by role, with comments on diff lines. Selecting
// a line in the diff fills in its file and line; the form alone reaches every
// line from the keyboard. Send back carries the comments (`triage.js`), each
// an instruction to the agent's next attempt (worker-loop WL-N10-4).
import { parseUnifiedDiff } from "./diff_parse.js";
import { esc, icon } from "./dom.js";
import { filesTableHtml } from "./files.js";
import { ISSUE_COPY, addLineComment, lineCommentLabel, removeLineComment } from "./lib/issue.js";
import { recordShown } from "./review_desk.js";
import { replyInThread, threadAction, threadsHtml } from "./threads.js";

const C = ISSUE_COPY.lineComment;

function commentsHtml(comments, files, draft, problem, canSend) {
  const list = comments.length
    ? `<ul class="lc-list">${comments
        .map(
          (c, i) =>
            `<li><span class="mono">${esc(lineCommentLabel(c))}</span><span class="lc-t">${esc(c.text)}</span><button class="btn ghost" type="button" data-lc-remove="${i}" aria-label="${esc(C.remove(lineCommentLabel(c)))}">${icon("x", 14, "ic s14")}</button></li>`,
        )
        .join("")}</ul>`
    : `<p class="sec">${esc(C.none)}</p>`;
  const options = files
    .map(
      (f) => `<option value="${esc(f)}"${f === draft.file ? " selected" : ""}>${esc(f)}</option>`,
    )
    .join("");
  const send =
    comments.length && canSend
      ? `<button class="btn" type="button" data-back>${icon("send-back", 14, "ic s14")}${esc(C.sendBack(comments.length))}</button>`
      : comments.length
        ? `<p class="sec">${esc(C.carried(comments.length))}</p>`
        : "";
  return `<section class="lc" aria-labelledby="lc-h"><h3 class="sh" id="lc-h">${esc(C.heading)} <span class="sec tnum">${comments.length}</span></h3><p class="sec">${esc(C.hint)}</p>${list}<form class="lc-form" data-lc-form><label>${esc(C.file)}<select name="file">${options}</select></label><label class="lc-line">${esc(C.line)}<input name="line" type="number" min="1" step="1" inputmode="numeric" value="${esc(draft.line ?? "")}"></label><label class="lc-text">${esc(C.text)}<textarea name="text" rows="2">${esc(draft.text ?? "")}</textarea></label><div class="err" role="alert"${problem ? "" : " hidden"}>${esc(problem ?? "")}</div><div class="acts"><button class="btn" type="submit">${icon("plus", 14, "ic s14")}${esc(C.add)}</button>${send}</div></form></section>`;
}

/**
 * Mount the Changes tab. `ctx.pane` is the card's EvidencePane (diff mode,
 * open files); `ctx.comments()` / `ctx.setComments()` hold this card's line
 * comments where Send back can read them.
 */
export function renderChanges(host, ctx) {
  const state = { draft: { file: "", line: "", text: "" }, problem: undefined, replies: {} };

  const files = () => {
    const ev = ctx.detail()?.evidence;
    return ev ? parseUnifiedDiff(ev.diff).map((f) => f.path) : [];
  };

  const draw = ({ keepScroll = true } = {}) => {
    const card = ctx.card();
    const detail = ctx.detail();
    if (!card) return;
    if (!detail) {
      host.innerHTML = ctx.pane.loadingHtml();
      return;
    }
    const top = host.scrollTop;
    const paths = files();
    // A line picked in a file outside the diff (a protected test) is offered too.
    if (state.draft.file && !paths.includes(state.draft.file)) paths.push(state.draft.file);
    if (!state.draft.file) state.draft.file = paths[0] ?? "";
    const comments = paths.length
      ? commentsHtml(
          ctx.comments(),
          paths,
          state.draft,
          state.problem,
          card.status === "review" || card.status === "parked",
        )
      : "";
    // Teams item 25: the review threads a Comment opened, with Reply and Resolve.
    const threads = threadsHtml(detail.desk, state.replies);
    host.innerHTML = `${filesTableHtml(card, detail)}${threads}${comments}${ctx.pane.changesOnlyHtml(card, detail)}`;
    if (keepScroll) host.scrollTop = top;
    shown();
  };

  // RG-S6-6, DB-N5-3: the diffs on screen here count as shown for Accept, too.
  const shown = () => {
    recordShown(ctx.card(), ctx.detail(), ctx.pane, host, () => ctx.shown?.());
    ctx.shown?.();
  };

  const readDraft = (form) => {
    state.draft = {
      file: form.elements.file?.value ?? "",
      line: form.elements.line?.value ?? "",
      text: form.elements.text?.value ?? "",
    };
  };

  const scrollToFile = (path) => {
    const group = host.querySelector(`.group[data-file="${CSS.escape(path)}"]`);
    if (!group) return;
    if (group.classList.contains("collapsed")) group.querySelector("[data-toggle]")?.click();
    group.scrollIntoView({ block: "start" });
    group.querySelector("[data-toggle]")?.focus({ preventScroll: true });
  };

  host.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    // The pane toggles the file on the page root, after this listener.
    if (t.closest("[data-toggle]")) setTimeout(shown, 0);
    const act = t.closest("[data-rt-act]");
    if (act && !act.disabled) {
      void threadAction(ctx.id, act.dataset.thread, act.dataset.rtAct).then(
        (done) => done && ctx.reloadDetail?.(),
      );
      return;
    }
    const rm = t.closest("[data-lc-remove]");
    if (rm) {
      ctx.setComments(removeLineComment(ctx.comments(), Number(rm.dataset.lcRemove)));
      draw();
      host.querySelector("[data-lc-form] textarea")?.focus();
      return;
    }
    const row = t.closest("tr[data-file]");
    if (row) {
      scrollToFile(row.dataset.file);
      return;
    }
    // A line of the diff: its file and its line (the new side, else the old).
    const ln = t.closest(".ln");
    const group = ln?.closest(".group[data-file]");
    if (ln && group && !ln.classList.contains("hunk")) {
      const no = (
        ln.querySelector(".n")?.textContent ||
        ln.querySelector(".o")?.textContent ||
        ""
      ).trim();
      if (!/^\d+$/.test(no)) return;
      const form = host.querySelector("[data-lc-form]");
      if (form) readDraft(form);
      state.draft = { ...state.draft, file: group.dataset.file, line: no };
      state.problem = undefined;
      draw();
      const area = host.querySelector("[data-lc-form] textarea");
      area?.scrollIntoView({ block: "center" });
      area?.focus({ preventScroll: true });
    }
  });

  host.addEventListener("keydown", (e) => {
    const row = e.target instanceof Element ? e.target.closest("tr[data-file]") : null;
    if (row && e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      scrollToFile(row.dataset.file);
    }
  });

  host.addEventListener("submit", (e) => {
    const reply = e.target instanceof Element ? e.target.closest("[data-rt-reply]") : null;
    if (reply) {
      e.preventDefault();
      const thread = reply.dataset.rtReply;
      const text = reply.elements.text?.value.trim() ?? "";
      if (!text) return;
      void replyInThread(ctx.id, thread, text).then((done) => {
        if (!done) return;
        delete state.replies[thread];
        ctx.reloadDetail?.();
      });
      return;
    }
    const form = e.target instanceof Element ? e.target.closest("[data-lc-form]") : null;
    if (!form) return;
    e.preventDefault();
    readDraft(form);
    const r = addLineComment(ctx.comments(), {
      file: state.draft.file,
      line: Number(state.draft.line),
      text: state.draft.text,
    });
    state.problem = r.problem;
    if (!r.problem) {
      ctx.setComments(r.comments);
      state.draft = { ...state.draft, text: "" };
    }
    draw();
    host.querySelector("[data-lc-form] textarea")?.focus();
  });

  // Typing in the form is kept across the redraws a stream frame causes.
  host.addEventListener("input", (e) => {
    const reply = e.target instanceof Element ? e.target.closest("[data-rt-reply]") : null;
    if (reply) state.replies[reply.dataset.rtReply] = reply.elements.text?.value ?? "";
    const form = e.target instanceof Element ? e.target.closest("[data-lc-form]") : null;
    if (form) readDraft(form);
  });

  draw({ keepScroll: false });
  return {
    onDetail: () => draw(),
    rerender: () => draw(),
  };
}
