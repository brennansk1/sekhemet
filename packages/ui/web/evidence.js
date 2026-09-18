// The evidence composition shared by Review and the card view: header, gates,
// failures, changes, facts. Keeps its own scroll, diff mode and file toggles.
import { changesHtml } from "./diff.js";
import { $, $$, copyText, esc, icon } from "./dom.js";
import { factsInlineHtml, factsRailHtml } from "./facts.js";
import { failuresHeadline, failuresHtml } from "./failures.js";
import { gatesHeadline, gatesSkeletonHtml, gatesStripHtml } from "./gates.js";
import {
  EMPTY_SHA256,
  columnLabel,
  formatWait,
  gateSummary,
  outcomeSentence,
  stopReasonLabel,
} from "./lib/vocabulary.js";
import { store } from "./store.js";
import { kindTags } from "./tile.js";
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
 * Merit's review (ledger `card/review`): the diff checked against what Merit
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
  return `<section aria-label="Merit's review" class="mreview"><h3 class="sh">Merit's review <span class="sec">${esc(head)}</span></h3><p class="mr-why">Merit checked this diff against what it has learned about you (<a href="#/playbook/profile">Playbook</a>). It's advice, not a gate: Accept is still yours.</p><ul>${items}</ul></section>`;
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
    return `<div><div class="crumbs">${esc(project)} ${icon("chevron-right", 12, "ic s12")}<span class="mono">${esc(card.id)}</span>${att}</div>${withTitle ? `<h2 class="ttl">${esc(card.display?.title ?? card.title)}</h2>` : ""}<div class="outcome">${kindTags(card.display?.kinds)}${outcome}</div><div data-notice></div></div>`;
  }

  bodyHtml(card, detail) {
    const ev = detail.evidence;
    if (detail.error) {
      return `<div class="ev-error" role="alert">${icon("alert")}<span><b>Couldn't load evidence for ${esc(card.display?.shortId ?? card.id)}.</b> <span class="sec">${detail.error.status ? `The server returned ${esc(detail.error.status)}.` : "Sekhemet did not respond."} ${esc(detail.error.message ?? "")}</span></span><button class="btn sm" type="button" data-retry-ev>${icon("refresh", 14, "ic s14")}Retry</button></div>`;
    }
    if (!ev) {
      return `<div class="ev-empty">${icon("glyph", 24, "ic s24")}<b>No attempts yet.</b><span>Evidence appears after the Worker's first run. Budget: ${esc(card.stepBudget)} steps.</span></div>`;
    }
    const config = store.state.gates;
    const gates = gatesFor(ev);
    const parts = [];
    parts.push(factsInlineHtml(detail.card ?? card, ev));
    parts.push(
      `<section aria-label="Gates"><h3 class="sh">Gates <span class="sec">${esc(gatesHeadline(gates))}</span></h3>${gatesStripHtml(gates, { failures: ev.failures, config, emptyContract: ev.gatesConfigSha256 === EMPTY_SHA256, sha: ev.gatesConfigSha256 })}</section>`,
    );
    if (detail.review) parts.push(reviewHtml(detail.review));
    if (ev.failures?.length) {
      parts.push(
        `<section aria-label="Failures" data-failures><h3 class="sh">Failures <span class="sec">${esc(failuresHeadline(ev.failures))}</span></h3>${failuresHtml(ev.failures, { card: detail.card ?? card, gatesConfig: config })}</section>`,
      );
    }
    parts.push(
      changesHtml(ev, {
        card: detail.card ?? card,
        gatesConfig: config,
        acceptance: detail.acceptance,
        mode: this.mode,
        open: this.open,
        full: this.full,
      }),
    );
    return parts.join("");
  }

  loadingHtml() {
    return `${gatesSkeletonHtml()}<div style="display:flex;flex-direction:column;gap:8px"><div class="sk sk-line" style="width:70%"></div><div class="sk sk-line" style="width:55%"></div><div class="sk sk-line" style="width:62%"></div></div>`;
  }

  factsHtml(card, detail) {
    return factsRailHtml(detail?.card ?? card, detail?.evidence, { hidden: this.factsHidden });
  }

  /** "This card moved to Working 3s ago. Evidence may be out of date." */
  noticeHtml(card, sinceStatus) {
    if (!sinceStatus || sinceStatus === card.status) return "";
    const at = card.display?.enteredColumnAt
      ? Date.parse(card.display.enteredColumnAt)
      : Date.now();
    return `<div class="notice" role="status">${icon("alert", 14, "ic s14")}<span>This card moved to ${esc(columnLabel(card.status))} ${esc(formatWait(Date.now() - at))} ago. Evidence may be out of date.</span><button type="button" data-reload-ev>Reload</button></div>`;
  }

  /** Wire the delegated handlers once on a stable root. */
  bind(root, { rerender, reload }) {
    root.addEventListener("click", async (e) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t) return;
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
          toast({ text: "No output recorded for passed gates.", duration: 2500 });
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
