// Seshat's suggestions on an issue (planner-pm §2.18.2, PM-N9-1; teams item
// 20): "Suggested: …", "Why: …", Apply and Dismiss, each one action. Nothing
// changes until a person applies one; a dismissed one is not raised again.
import { esc, getJSON, postJSON } from "./dom.js";
import { toast } from "./toast.js";

/** The open suggestions of one card, rendered into `host`; hidden when there are none. */
export async function renderSuggestions(host, cardId, { onChange } = {}) {
  if (!host || !cardId) return;
  const r = await getJSON(`/api/cards/${encodeURIComponent(cardId)}/suggestions`);
  if (host.dataset.card !== cardId && host.dataset.card) return;
  host.dataset.card = cardId;
  const list = r.ok ? (r.data?.suggestions ?? []) : [];
  host.hidden = list.length === 0;
  host.innerHTML = list.length
    ? `<ul class="sug-list" aria-label="Suggestions">${list
        .map(
          (s) =>
            `<li class="sug" data-sug="${esc(s.id)}"><div class="sug-t"><b>${esc(s.suggested)}</b>${
              s.why ? `<span class="sug-why">Why: ${esc(s.why)}</span>` : ""
            }</div><div class="sug-acts"><button type="button" class="btn sm" data-sug-apply="${esc(
              s.id,
            )}">Apply</button><button type="button" class="btn sm ghost" data-sug-dismiss="${esc(
              s.id,
            )}">Dismiss</button></div></li>`,
        )
        .join("")}</ul>`
    : "";
  host.onclick = async (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const apply = t?.closest("[data-sug-apply]");
    const dismiss = t?.closest("[data-sug-dismiss]");
    const id = apply?.dataset.sugApply ?? dismiss?.dataset.sugDismiss;
    if (!id) return;
    const verb = apply ? "apply" : "dismiss";
    for (const b of host.querySelectorAll(`[data-sug="${CSS.escape(id)}"] button`))
      b.disabled = true;
    const res = await postJSON(`/api/suggestions/${encodeURIComponent(id)}/${verb}`);
    if (!res.ok) {
      toast({
        tone: "fail",
        text: verb === "apply" ? "Couldn't apply the suggestion." : "Couldn't dismiss it.",
        detail: res.data?.error ?? `The server returned ${res.status || "no response"}.`,
      });
    }
    await renderSuggestions(host, cardId, { onChange });
    onChange?.();
  };
}
