// Peek drawer (FRONTEND_DESIGN §2.4.2): Space on a tile. Gates, failures, Done
// when and files, with triage keys that work inside the drawer.
import { loadDetail } from "./data.js";
import { aiBadge, esc, icon, kbd } from "./dom.js";
import { failuresHeadline, failuresHtml } from "./failures.js";
import { gatesStripHtml } from "./gates.js";
import { issueMoreHtml, openIssueMenu } from "./issue_actions.js";
import { checksTip } from "./learn.js";
import { peekFacts } from "./lib/issue.js";
import { EMPTY_SHA256, gateSummary, outcomeSentence, stopReasonLabel } from "./lib/vocabulary.js";
import { pushOverlay } from "./overlay.js";
import { store } from "./store.js";
import { typeTag } from "./tile.js";
import {
  accept,
  composerHtml,
  openPark,
  quickNotes,
  triageBarHtml,
  wireComposer,
} from "./triage.js";

let current = null;

export function peekOpenFor() {
  return current?.id ?? null;
}

export function closePeek() {
  if (!current) return;
  const { node, remove, returnFocus, id } = current;
  current = null;
  remove();
  node.remove();
  const target = document.getElementById(`tile-${id}`) ?? returnFocus;
  target?.focus?.({ preventScroll: true });
}

function outcomeHtml(card, evidence, gates) {
  if (!evidence) {
    return `${typeTag(card.display?.type)}<span>No attempts yet. Budget: ${esc(card.stepBudget)} steps.</span>`;
  }
  const tone = evidence.passed
    ? "i-pass"
    : stopReasonLabel(evidence.stopReason).tone === "parked"
      ? "i-park"
      : "i-fail";
  const glyph = evidence.passed ? "check" : tone === "i-park" ? "pause" : "x";
  return `${typeTag(card.display?.type)}${icon(glyph, 14, `ic s14 ${tone}`)}<span>${esc(outcomeSentence(evidence, gates))}</span>`;
}

function filesHtml(evidence) {
  const files = evidence?.filesTouched ?? [];
  if (!files.length) return "";
  const rows = files
    .map((f) => `<div>${icon("file", 14, "ic s14")}<span class="mono">${esc(f)}</span></div>`)
    .join("");
  return `<section><h4>Files <span class="sec">· +${esc(evidence.linesAdded)} −${esc(evidence.linesRemoved)}</span></h4><div class="files">${rows}</div></section>`;
}

async function fill(id) {
  if (!current || current.id !== id) return;
  const { node } = current;
  const card = store.card(id);
  if (!card) return closePeek();
  const project = store.state.meta?.project ?? "";
  node.setAttribute("aria-label", `Peek: ${card.display?.title ?? card.title}`);
  node.querySelector("header > div").innerHTML =
    `<div class="crumb">${esc(project)} ${icon("chevron-right", 12, "ic s12")}<span class="mono">${esc(card.id)}</span></div><h3>${esc(card.display?.title ?? card.title)}</h3><div class="out">Loading…</div>`;

  const detail = await loadDetail(id);
  if (!current || current.id !== id) return;
  const ev = detail.evidence;
  const config = store.state.gates;
  const gates = ev
    ? gateSummary(ev, config?.gates ?? [], {
        maxFiles: config?.maxFiles,
        maxDiffLines: config?.maxDiffLines,
      })
    : [];
  const attempt = detail.attempts.length ? ` · attempt ${detail.attempts.length}` : "";
  node.querySelector(".crumb").insertAdjacentHTML("beforeend", esc(attempt));
  node.querySelector(".out").innerHTML = outcomeHtml(card, ev, gates);

  const criteria = card.acceptanceCriteria ?? detail.card?.acceptanceCriteria ?? [];
  const body = [];
  if (detail.error) {
    body.push(
      `<div class="ev-error">${icon("alert")}<span>Couldn't load evidence for ${esc(card.display?.shortId)}. The server returned ${esc(detail.error.status || "no response")}.</span></div>`,
    );
  }
  if (ev) {
    body.push(
      `<section><h4>Checks ${checksTip(gates)}</h4>${gatesStripHtml(gates, { failures: ev.failures, config, emptyContract: ev.gatesConfigSha256 === EMPTY_SHA256, sha: ev.gatesConfigSha256 })}</section>`,
    );
    if (ev.failures?.length) {
      body.push(
        `<section><h4>Failures <span class="sec">· ${esc(failuresHeadline(ev.failures))}</span></h4>${failuresHtml(ev.failures, { card: detail.card ?? card, gatesConfig: config, limit: 2 })}</section>`,
      );
    }
  }
  // ISS-05: who has it, who builds it, how hard it is and who may accept it.
  const s = detail.desk?.suggestedAccepters;
  const accepters = [
    ...(s?.unmapped ?? []),
    ...(s?.principals?.length
      ? [`${s.principals.length} ${s.principals.length === 1 ? "member" : "members"}`]
      : []),
  ];
  const facts = peekFacts(detail.card ?? card, { accepters })
    .map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(f.text)}${f.ai ? ` ${aiBadge()}` : ""}</dd>`)
    .join("");
  body.push(`<section><dl class="kv peek-kv">${facts}</dl></section>`);
  if (criteria.length) {
    body.push(
      `<section><h4>Acceptance criteria</h4><div class="crit-line">${criteria.map(esc).join(" · ")}</div></section>`,
    );
  }
  body.push(filesHtml(ev));
  node.querySelector(".body").innerHTML = body.join("");
  node.querySelector("footer").innerHTML =
    `${triageBarHtml(card, ev, { hint: false }).replace(/^<div class="triage[^"]*"[^>]*>|<\/div>$/g, "")}${issueMoreHtml(card)}<span class="hint">${kbd("↵")} open issue</span>`;
  current.evidence = ev;
  current.detail = detail;
  current.sig = signature(card) + store.state.connection;
}

function act(key) {
  if (!current) return false;
  const card = store.card(current.id);
  if (!card || !"arp".includes(key) || key.length !== 1) return false;
  if (!current.detail) {
    // Evidence still loading: act once it lands, on the same card.
    const id = current.id;
    loadDetail(id).then((d) => {
      if (current?.id === id) {
        current.detail = d;
        current.evidence = d.evidence;
        act(key);
      }
    });
    return true;
  }
  const ev = current.evidence;
  if (key === "a") {
    accept(card, ev, { onChange: () => fill(card.id) });
    return true;
  }
  if (key === "r" && ev) {
    const foot = current.node.querySelector("footer");
    if (current.node.querySelector("[data-composer]")) return true;
    foot.insertAdjacentHTML("beforebegin", composerHtml(quickNotes(card, ev, store.state.gates)));
    wireComposer(current.node.querySelector("[data-composer]"), card, {
      onSent: () => closePeek(),
    });
    return true;
  }
  if (key === "p") {
    openPark(
      current.node.querySelector("[data-park]") ?? current.node.querySelector("footer"),
      card,
      { onDone: () => closePeek() },
    );
    return true;
  }
  return false;
}

/** Run a triage key on a card through the drawer (used by the palette on the board). */
export function peekAct(id, key) {
  openPeek(id);
  return act(key);
}

/** Open (or retarget) the drawer. */
export function openPeek(id, { returnFocus } = {}) {
  if (current && current.id === id) return;
  if (!current) {
    const node = document.createElement("aside");
    node.className = "peek";
    node.setAttribute("aria-label", "Peek");
    node.innerHTML = `<header><div></div><button class="icon-btn" type="button" data-close aria-label="Close peek (Esc)">${icon("x")}</button></header><div class="body"></div><footer></footer>`;
    document.getElementById("overlay-root").append(node);
    const remove = pushOverlay({
      kind: "peek",
      modal: false,
      close: () => closePeek(),
      onKey: (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return false;
        if (e.key === "Enter" && current) {
          location.hash = `#/card/${encodeURIComponent(current.id)}`;
          closePeek();
          return true;
        }
        if (e.key === " ") {
          closePeek();
          return true;
        }
        return act(e.key.toLowerCase());
      },
    });
    node.addEventListener("click", (e) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t) return;
      if (t.closest("[data-close]")) closePeek();
      else if (t.closest("[data-accept]")) act("a");
      else if (t.closest("[data-back]")) act("r");
      else if (t.closest("[data-park]")) act("p");
      // NEW-dashboard-21: Won't do, Reopen and Revert from the peek's `⋯`.
      else if (t.closest("[data-issue-more]") && current) {
        const card = store.card(current.id);
        if (card)
          void openIssueMenu(t.closest("[data-issue-more]"), card, {
            detail: current.detail,
            onDone: () => closePeek(),
          });
      }
    });
    current = { id, node, remove, returnFocus };
  } else {
    current.id = id;
    current.detail = null;
    current.evidence = null;
    current.node.querySelector("[data-composer]")?.remove();
  }
  fill(id);
}

// Keep an open drawer current as the board changes underneath it.
function signature(card) {
  return `${card?.status}|${card?.display?.evidence?.id ?? ""}`;
}

store.on((_s, patch) => {
  if (!current || !("cards" in patch || "connection" in patch)) return;
  const card = store.card(current.id);
  if (!card) return closePeek();
  const sig = signature(card) + store.state.connection;
  if (
    current.sig !== undefined &&
    current.sig !== sig &&
    !current.node.querySelector("[data-composer]")
  ) {
    current.detail = null;
    fill(current.id);
  }
  current.sig = sig;
});
