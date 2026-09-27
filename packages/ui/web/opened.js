// The files a person was shown in Review (review-git RG-S6-6, RG-N5-5): Accept
// is refused on every surface until each Implementation file has been shown,
// so the page records what it showed, once per evidence bundle, and again
// only when the person opens more. `post` is dom.js's postJSON on the page.

/** cardId|evidenceId → the files already recorded as shown. */
const reported = new Map();

/**
 * POST `/api/cards/<id>/opened { filesShown }` when `files` holds a file not
 * yet recorded for this evidence. Resolves true when a record was made.
 */
export async function reportOpened(cardId, evidenceId, files, post) {
  const key = `${cardId}|${evidenceId ?? ""}`;
  const had = reported.get(key) ?? new Set();
  const fresh = [...new Set(files)].filter((f) => !had.has(f));
  if (fresh.length === 0) return false;
  for (const f of fresh) had.add(f);
  reported.set(key, had);
  const res = await post(`/api/cards/${encodeURIComponent(cardId)}/opened`, {
    filesShown: [...had],
  });
  if (!res?.ok) for (const f of fresh) had.delete(f);
  return Boolean(res?.ok);
}

/** The files this page has recorded as shown for one evidence bundle (DB-N5-3). */
export function reportedFiles(cardId, evidenceId) {
  return [...(reported.get(`${cardId}|${evidenceId ?? ""}`) ?? [])];
}
