// A plan's criteria, approved in the card view (planner-pm §2.17, PM-N7-5):
// a card waiting in Planning on a person's approval shows its criteria, its
// example rows and, by the depth profile, the example tables or test files to
// approve, and one Approve button. The button sends back the SHA-256 of what
// it showed, so a plan that changed meanwhile is refused (409) and shown again.
import { approvalHtml, approveShown } from "./approval_view.js";
import { getJSON, postJSON } from "./dom.js";
import { toast } from "./toast.js";

/** Render the approval for one card into `host`; hidden when nothing waits. */
export async function renderApproval(host, cardId, { onChange, get = getJSON } = {}) {
  if (!host || !cardId) return;
  const r = await get(`/api/cards/${encodeURIComponent(cardId)}/approval`);
  if (host.dataset.card !== cardId && host.dataset.card) return;
  show(host, cardId, r.ok ? r.data : undefined, onChange);
}

function show(host, cardId, view, onChange) {
  host.dataset.card = cardId;
  const html = approvalHtml(view);
  host.hidden = html === "";
  host.innerHTML = html;
  host.onclick = async (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const btn = t?.closest("[data-approve]");
    if (!btn || !view) return;
    btn.disabled = true;
    const res = await approveShown(cardId, view, postJSON);
    if (res.status === 409 && res.data?.current) {
      toast({
        tone: "fail",
        text: "The criteria changed since they were shown.",
        detail: "Here is what there is now; approve again if it is right.",
      });
      show(host, cardId, res.data.current, onChange);
      return;
    }
    if (!res.ok) {
      btn.disabled = false;
      toast({
        tone: "fail",
        text: "Couldn't record the approval.",
        detail: res.data?.error ?? `The server returned ${res.status || "no response"}.`,
      });
      return;
    }
    const released = res.data?.released?.length ?? 0;
    toast({
      tone: "pass",
      text: `Approved. ${released} issue${released === 1 ? "" : "s"} left Planning.`,
      ...(res.data?.held?.length
        ? { detail: res.data.held.map((h) => `${h.id}: ${h.reason}`).join(" ") }
        : {}),
    });
    await renderApproval(host, cardId, { onChange });
    onChange?.();
  };
}
