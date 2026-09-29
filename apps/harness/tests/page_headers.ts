/**
 * The headers the dashboard page sends on a write (dom.js `actionHeaders`):
 * the action header, and the token the page read from `GET /api/session`
 * when it loaded. A Solo server hands out this start's token there
 * (security item 37, SEC-25); a signed-out Team request gets none, and a
 * Team session's own `X-Sekhemet-CSRF` is spread over these by the caller.
 */
export async function pageWriteHeaders(base: string): Promise<Record<string, string>> {
  const res = await fetch(`${base}/api/session`, { headers: { Accept: "application/json" } });
  const body = (await res.json().catch(() => ({}))) as { csrf?: unknown };
  return {
    "X-Sekhemet-Action": "1",
    ...(typeof body.csrf === "string" ? { "X-Sekhemet-CSRF": body.csrf } : {}),
  };
}
