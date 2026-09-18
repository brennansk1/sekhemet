// Per-card detail: the card record with attempts, and its evidence bundle.
// Cached by the evidence id the board reports, so an SSE frame that does not
// change a card's evidence never refetches it.
import { getJSON } from "./dom.js";
import { store } from "./store.js";

const cache = new Map();

function key(id, attempt) {
  const ev = store.card(id)?.display?.evidence?.id ?? "none";
  return `${id}|${ev}|${attempt ?? "latest"}`;
}

/**
 * @returns {Promise<{ card, attempts, acceptance, evidence, error? }>}
 * `evidence` is null when the card has not run; `error` is set on 5xx/network.
 */
export function loadDetail(id, attempt) {
  const k = key(id, attempt);
  if (cache.has(k)) return cache.get(k);
  const q = attempt ? `?attempt=${encodeURIComponent(attempt)}` : "";
  // Ask for evidence only when the board says there is some: a 404 for a card
  // that never ran is expected, and should not surface as a console error.
  const hasEvidence = attempt || store.card(id)?.display?.evidence;
  const p = Promise.all([
    getJSON(`/api/cards/${encodeURIComponent(id)}`),
    hasEvidence
      ? getJSON(`/api/evidence/${encodeURIComponent(id)}${q}`)
      : Promise.resolve({ ok: false, status: 404, data: null }),
  ])
    .then(([c, e]) => {
      const out = {
        card: c.ok ? c.data.card : store.card(id),
        attempts: c.ok ? c.data.attempts : [],
        acceptance: c.ok ? (c.data.acceptance ?? []) : [],
        evidence: e.ok ? e.data : null,
      };
      if (!e.ok && e.status !== 404) out.error = { status: e.status, message: e.data?.error ?? "" };
      if (!c.ok && c.status !== 404) out.error = { status: c.status, message: c.data?.error ?? "" };
      if (out.error) cache.delete(k);
      return out;
    })
    .catch((err) => {
      cache.delete(k);
      return {
        card: store.card(id),
        attempts: [],
        acceptance: [],
        evidence: null,
        error: { status: 0, message: String(err?.message ?? err) },
      };
    });
  cache.set(k, p);
  return p;
}

/** Synchronous peek at a settled cache entry, to render without a flash. */
export function cachedKey(id, attempt) {
  return key(id, attempt);
}

export function forget(id) {
  for (const k of cache.keys()) if (k.startsWith(`${id}|`)) cache.delete(k);
}
