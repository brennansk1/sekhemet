// The evidence composition shared by Review and the card view: header, gates,
// failures, changes, facts. Keeps its own scroll, diff mode and file toggles.
import { changesHtml } from "./diff.js";
import { $, $$, brandMark, copyText, esc, icon } from "./dom.js";
import { factsInlineHtml, factsRailHtml } from "./facts.js";
import { failuresHeadline, failuresHtml } from "./failures.js";
import { gatesHeadline, gatesSkeletonHtml, gatesStripHtml } from "./gates.js";
import { checksTip } from "./learn.js";
import {
  EMPTY_SHA256,
  columnLabel,
  formatWait,
  gateSummary,
  outcomeSentence,
  stopReasonLabel,
} from "./lib/vocabulary.js";
import {
  acknowledge,
  builtByOutcome,
  diffOptions,
  focusNextFinding,
  reviewerHtml,
} from "./review_desk.js";
import { paintShotDiffs, shotsHtml } from "./shots.js";
import { store } from "./store.js";
import { typeTag } from "./tile.js";
import { toast } from "./toast.js";

export function gatesFor(evidence) {
  const config = store.state.gates;
  return gateSummary(evidence, config?.gates ?? [], {
    maxFiles: config?.maxFiles,
    maxDiffLines: config?.maxDiffLines,
  });
}

export function outcomeIcon(evidence) {
  if (!evidence) return "";
  if (evidence.passed) return icon("check", 14, "ic s14 i-pass");
  return stopReasonLabel(evidence.stopReason).tone === "parked"
    ? icon("pause", 14, "ic s14 i-park")
    : icon("x", 14, "ic s14 i-fail");
}

/**
 * Seshat's review (ledger `card/review`): the diff checked against what Seshat
 * has learned about you. Advice, not a gate; likely send-backs read as warnings.
 */
export function reviewHtml(review) {
  const findings = [...(review.findings ?? [])].sort(
    (a, b) => Number(b.severity === "likely_send_back") - Number(a.severity === "likely_send_back"),
  );
  const likely = findings.filter((f) => f.severity === "likely_send_back").length;
  const head = likely
    ? `${likely} likely send-${likely === 1 ? "back" : "backs"}`
    : `${findings.length} ${findings.length === 1 ? "thing" : "things"} to consider`;
  const items = findings
    .map((f) => {
      const warn = f.severity === "likely_send_back";
      return `<li class="${warn ? "warn" : ""}">${icon(warn ? "alert" : "chat", 14, `ic s14${warn ? " i-park" : ""}`)}<div><b>${warn ? "Likely send-back" : "Consider"}</b><span>${esc(f.note)}</span></div></li>`;
    })
    .join("");
  return `<section aria-label="Seshat's review" class="mreview"><h3 class="sh">Seshat's review <span class="sec">${esc(head)}</span></h3><p class="mr-why">Seshat checked this diff against what it has learned about you (<a href="#/playbook/profile">Playbook</a>). It's advice, not a check: Accept is still yours.</p><ul>${items}</ul></section>`;
}

export class EvidencePane {
  constructor({ onAttempt } = {}) {
    this.mode = "unified";
    this.open = new Map();
    this.full = new Set();
    this.factsHidden = false;
    this.onAttempt = onAttempt;
    this.cardId = null;
    this.signature = null;
  }

  /** Reset per-card UI state when the card changes. */
  forCard(id) {
    if (this.cardId !== id) {
      this.cardId = id;
      this.open = new Map();
      this.full = new Set();
      this.signature = null;
    }
  }

  headHtml(card, detail, { attempt, withTitle = true } = {}) {
    const project = store.state.meta?.project ?? "";
    const attempts = detail?.attempts ?? [];
    const cur = attempt ?? attempts.length;
    let att = "";
    if (attempts.length > 1) {
      att = `<select class="att" data-attempt aria-label="Attempt">${attempts
        .map(
          (a) =>
            `<option value="${a.attempt}"${a.attempt === cur ? " selected" : ""}>attempt ${a.attempt} of ${attempts.length}</option>`,
        )
        .join("")}</select>`;
    } else if (attempts.length === 1) {
      att = '<span class="att" title="Only one attempt so far">attempt 1 of 1</span>';
    }
    const ev = detail?.evidence;
    const outcome = ev
      ? `${outcomeIcon(ev)}<span>${esc(outcomeSentence(ev, gatesFor(ev)))}</span>`
      : card.status === "in_progress"
        ? `<span class="dot run" aria-hidden="true"></span><span>${esc(card.display?.statusLine ?? "Working")}</span>`
        : `<span>No attempts yet · ${esc(card.stepBudget)}-step budget</span>`;
    // DB-N5-4: a card a person built says so in its outcome line.
    const built = builtByOutcome(detail);
    const builtHtml = built ? `<span class="sec built-by">· ${esc(built)}</span>` : "";
    return `<div><div class="crumbs">${esc(project)} ${icon("chevron-right", 12, "ic s12")}<span class="mono">${esc(card.id)}</span>${att}</div>${withTitle ? `<h2 class="ttl">${esc(card.display?.title ?? card.title)}</h2>` : ""}<div class="outcome">${typeTag(card.display?.type)}${outcome}${builtHtml}</div><div data-notice></div></div>`;
  }

  /** What stands in for the evidence when it failed to load or does not exist yet; else null. */
  missingHtml(card, detail) {
    if (detail.error) {
      return `<div class="ev-error" role="alert">${icon("alert")}<span><b>Couldn't load evidence for ${esc(card.display?.shortId ?? card.id)}.</b> <span class="sec">${detail.error.status ? `The server returned ${esc(detail.error.status)}.` : "Sekhemet did not respond."} ${esc(detail.error.message ?? "")}</span></span><button class="btn sm" type="button" data-retry-ev>${icon("refresh", 14, "ic s14")}Retry</button></div>`;
    }
    if (!detail.evidence) {
      return `<div class="ev-empty">${brandMark(24)}<b>No attempts yet.</b><span>Evidence appears after the agent's first run. Budget: ${esc(card.stepBudget)} steps.</span></div>`;
    }
    return null;
  }

  /** Each part of the composition, by name; Review shows them all, the issue page by tab. */
  sections(card, detail) {
    const ev = detail.evidence;
    const config = store.state.gates;
    const gates = gatesFor(ev);
    const out = {};
    out.facts = factsInlineHtml(detail.card ?? card, ev, detail);
    // §2.5.3 4a (NEW-dashboard-5): the Reviewer's findings and coverage, first.
    out.reviewer = reviewerHtml(card, detail);
    out.gates = `<section aria-label="Checks"><h3 class="sh">Checks ${checksTip(gates)}<span class="sec">${esc(gatesHeadline(gates))}</span></h3>${gatesStripHtml(gates, { failures: ev.failures, config, emptyContract: ev.gatesConfigSha256 === EMPTY_SHA256, sha: ev.gatesConfigSha256 })}</section>`;
    // SEC-32: files that run outside the sandbox on the next commit or in an editor.
    out.later = ev.executesLater?.length
      ? `<section aria-label="Runs outside the sandbox later"><h3 class="sh">${icon("alert", 14, "ic s14 i-park")} Runs outside the sandbox later <span class="sec">${esc(ev.executesLater.length)}</span></h3><ul class="plain">${ev.executesLater.map((f) => `<li class="mono">${esc(f)}</li>`).join("")}</ul></section>`
      : "";
    out.review = detail.review ? reviewHtml(detail.review) : "";
    out.failures = ev.failures?.length
      ? `<section aria-label="Failures" data-failures><h3 class="sh">Failures <span class="sec">${esc(failuresHeadline(ev.failures))}</span></h3>${failuresHtml(ev.failures, { card: detail.card ?? card, gatesConfig: config })}</section>`
      : "";
    // U8, X3: screenshot differences from the visual gates, and attached images.
    out.shots = shotsHtml(ev, detail.attachments ?? [], card.id);
    if (out.shots) setTimeout(() => paintShotDiffs(document), 0);
    out.changes = changesHtml(ev, {
      card: detail.card ?? card,
      gatesConfig: config,
      acceptance: detail.acceptance,
      mode: this.mode,
      open: this.open,
      full: this.full,
      ...diffOptions(card, detail),
    });
    return out;
  }

  bodyHtml(card, detail) {
    const missing = this.missingHtml(card, detail);
    if (missing) return missing;
    const s = this.sections(card, detail);
    return [s.facts, s.reviewer, s.gates, s.later, s.review, s.failures, s.shots, s.changes].join(
      "",
    );
  }

  /** The issue page's Checks tab (DB-N8-1): the gates and what they found. */
  checksHtml(card, detail) {
    const missing = this.missingHtml(card, detail);
    if (missing) return missing;
    const s = this.sections(card, detail);
    return [s.facts, s.reviewer, s.gates, s.later, s.failures, s.shots].join("");
  }

  /** The issue page's Changes tab (DB-N8-1, DB-N8-4): the diff, grouped by role. */
  changesOnlyHtml(card, detail) {
    return this.missingHtml(card, detail) ?? this.sections(card, detail).changes;
  }

  loadingHtml() {
    return `${gatesSkeletonHtml()}<div style="display:flex;flex-direction:column;gap:8px"><div class="sk sk-line" style="width:70%"></div><div class="sk sk-line" style="width:55%"></div><div class="sk sk-line" style="width:62%"></div></div>`;
  }

  factsHtml(card, detail) {
    return factsRailHtml(detail?.card ?? card, detail?.evidence, {
      hidden: this.factsHidden,
      detail,
    });
  }

  /** "This card moved to Working 3s ago. Evidence may be out of date." */
  noticeHtml(card, sinceStatus) {
    if (!sinceStatus || sinceStatus === card.status) return "";
    const at = card.display?.enteredColumnAt
      ? Date.parse(card.display.enteredColumnAt)
      : Date.now();
    return `<div class="notice" role="status">${icon("alert", 14, "ic s14")}<span>This card moved to ${esc(columnLabel(card.status))} ${esc(formatWait(Date.now() - at))} ago. Evidence may be out of date.</span><button type="button" data-reload-ev>Reload</button></div>`;
  }

  /**
   * Wire the delegated handlers once on a stable root. `current()` returns
   * the card and detail on screen, for acknowledging a finding (DB-N5-3).
   */
  bind(root, { rerender, reload, current }) {
    root.addEventListener("click", async (e) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t) return;
      const ack = t.closest("[data-ack]");
      if (ack && current) {
        const { card, detail } = current();
        if (card && acknowledge(card, detail, ack.dataset.ack)) {
          rerender();
          focusNextFinding(root, card, detail);
        }
        return;
      }
      const cite = t.closest("[data-cite]");
      if (cite) {
        e.preventDefault();
        const group = $(`.group[data-file="${CSS.escape(cite.dataset.cite)}"]`, root);
        if (group?.classList.contains("collapsed")) group.querySelector("[data-toggle]")?.click();
        group?.scrollIntoView({ block: "start" });
        group?.querySelector("[data-toggle]")?.focus({ preventScroll: true });
        return;
      }
      const tog = t.closest("[data-toggle]");
      if (tog) {
        const path = tog.dataset.toggle;
        const group = tog.closest(".group");
        const nowOpen = group.classList.contains("collapsed");
        this.open.set(path, nowOpen);
        group.classList.toggle("collapsed", !nowOpen);
        tog.setAttribute("aria-expanded", String(nowOpen));
        const chev = tog.querySelector(".ic");
        if (chev && !group.classList.contains("acceptance"))
          chev.outerHTML = icon(nowOpen ? "chevron-down" : "chevron-right", 14, "ic s14");
        return;
      }
      const copy = t.closest("[data-copy]");
      if (copy) {
        const ok = await copyText(copy.dataset.copy);
        toast({
          text: ok
            ? `Copied ${copy.dataset.copy.length > 40 ? `${copy.dataset.copy.slice(0, 40)}…` : copy.dataset.copy}`
            : "Couldn't copy to the clipboard.",
          tone: ok ? "info" : "fail",
          duration: 2000,
        });
        return;
      }
      const full = t.closest("[data-full]");
      if (full) {
        this.full.add(full.dataset.full);
        rerender();
        return;
      }
      const jump = t.closest("[data-jump]");
      if (jump) {
        e.preventDefault();
        this.jumpTo(root, jump.dataset.jump);
        return;
      }
      const seg = t.closest(".g-seg[data-gate]");
      if (seg) {
        const block = $(`[data-fgate="${CSS.escape(seg.dataset.gate)}"]`, root);
        if (block) {
          block.scrollIntoView({ block: "start" });
          block.querySelector("a")?.focus();
        } else if (seg.classList.contains("pass")) {
          toast({ text: "No output recorded for passed checks.", duration: 2500 });
        }
        return;
      }
      if (t.closest("[data-retry-ev], [data-reload-ev]")) reload();
    });
    root.addEventListener("change", (e) => {
      const sel = e.target instanceof Element ? e.target.closest("[data-attempt]") : null;
      if (sel) this.onAttempt?.(Number(sel.value));
    });
  }

  jumpTo(root, annId) {
    const ann = document.getElementById(annId);
    if (!ann) return;
    const group = ann.closest(".group");
    if (group?.classList.contains("collapsed")) group.querySelector("[data-toggle]")?.click();
    ann.scrollIntoView({ block: "center" });
    ann.focus({ preventScroll: true });
  }

  /** `n` / `N`: next or previous inline annotation. */
  nextAnnotation(root, dir) {
    const anns = $$("[data-ann]", root).filter((a) => a.offsetParent !== null);
    if (anns.length === 0) {
      toast({ text: "No annotations in this diff.", duration: 2000 });
      return;
    }
    const i = anns.indexOf(document.activeElement);
    const next = anns[(i + dir + anns.length) % anns.length] ?? anns[0];
    next.scrollIntoView({ block: "center" });
    next.focus({ preventScroll: true });
  }

  /** Space: expand or collapse the file under focus, else the first file. */
  toggleFile(root) {
    const group =
      document.activeElement?.closest?.(".group") ??
      $(".group [data-toggle]", root)?.closest(".group");
    group?.querySelector("[data-toggle]")?.click();
  }
}
