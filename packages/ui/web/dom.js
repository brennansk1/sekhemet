// Small DOM and network helpers shared by every view.
export { aiBadge, brandLockup, brandMark, icon, teammateName } from "./lib/icons.js";
import { refusedWriteBody } from "./lib/account.js";

// Card titles, notes, file paths and error text are written by a model or a
// person, so every interpolation into markup goes through esc(). Never assign
// innerHTML from raw data.
export function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A hover title that is never the only way to its words (DB-P12-6): the same
 * text is the element's accessible description, so a screen reader reaches it
 * and the title stays a pointer-only duplicate. `text` is raw; it is escaped here.
 */
export function tip(text) {
  const t = esc(text);
  return `title="${t}" aria-description="${t}"`;
}

/** Parse one HTML string into a single element. The string must be pre-escaped. */
export function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function $$(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

/** True while focus is in a text field: single-key shortcuts must not fire. */
export function isTyping(e) {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
}

/* ---------- Requests: the action header, the session's CSRF token, refusals ---------- */

// Every write carries the action header and a token the page reads from
// `GET /api/session` as `csrf`, sent as `X-Sekhemet-CSRF`: in the Team setup
// the signed-in session's (teams item 13), in Solo this server start's
// (security SEC-25), so a page from before a restart must be reloaded.
let csrfToken = "";

export function setCsrf(token) {
  csrfToken = typeof token === "string" ? token : "";
}

/** The headers every write carries; `extra` adds to them. */
export function actionHeaders(extra = {}) {
  return {
    "X-Sekhemet-Action": "1",
    ...(csrfToken ? { "X-Sekhemet-CSRF": csrfToken } : {}),
    ...extra,
  };
}

/**
 * A 401 or 403 is announced once, page-wide (`sekhemet:auth`): the app sends
 * a signed-out Team page to Sign in and shows an access refusal's sentence,
 * which names the missing permission and who can grant it (teams TEAM-4).
 */
export function noticeAuth(status, data) {
  if (status !== 401 && status !== 403) return;
  window.dispatchEvent(new CustomEvent("sekhemet:auth", { detail: { status, data } }));
}

async function readBody(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** How long a read waits for an answer before it says so (FINDINGS ERR-01). */
const READ_TIMEOUT_MS = 20_000;

/**
 * No answer at all, in words (FINDINGS ERR-01, ERR-04; §A *Nothing raw*):
 * never the browser's *Failed to fetch*. Status 0 marks it.
 */
function noAnswer(err) {
  const slow = err?.name === "TimeoutError" || err?.name === "AbortError";
  return {
    ok: false,
    status: 0,
    data: {
      error: slow
        ? "Sekhemet took too long to answer. Try again."
        : "Sekhemet can't be reached. Check that it is running, then try again.",
    },
  };
}

/**
 * A read: never throws. No answer, or none within the timeout, comes back
 * as status 0 with a sentence (ERR-01), so a view shows its error state
 * with Retry instead of a skeleton that never ends.
 */
export async function getJSON(path, { timeout = READ_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: { Accept: "application/json" },
      ...(typeof AbortSignal?.timeout === "function"
        ? { signal: AbortSignal.timeout(timeout) }
        : {}),
    });
  } catch (err) {
    return noAnswer(err);
  }
  const data = await readBody(res);
  noticeAuth(res.status, data);
  return { ok: res.ok, status: res.status, data: refusedWriteBody(res.status, data) };
}

/**
 * A write with a JSON body: the action header and, signed in, the CSRF
 * token. `background`: a write the page makes on its own (focus, files
 * shown), never one the person asked for — a refusal of it is never
 * announced page-wide, so no toast blames them for it (FINDINGS SEC-01).
 */
export async function sendJSON(method, path, body, { background = false, headers = {} } = {}) {
  try {
    const res = await fetch(path, {
      method,
      headers: actionHeaders({ "Content-Type": "application/json", ...headers }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await readBody(res);
    if (!(background && res.status === 403)) noticeAuth(res.status, data);
    return { ok: res.ok, status: res.status, data: refusedWriteBody(res.status, data) };
  } catch (err) {
    return noAnswer(err);
  }
}

/** Triage mutations carry the header the server requires (CSRF guard). */
export function postJSON(path, body, opts) {
  return sendJSON("POST", path, body ?? {}, opts);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(String(text));
    return true;
  } catch {
    return false;
  }
}

/** Announce to screen readers through the single polite live region. */
export function announce(text) {
  const live = document.getElementById("live");
  if (!live) return;
  live.textContent = "";
  setTimeout(() => {
    live.textContent = text;
  }, 30);
}

export function kbd(...keys) {
  return keys.map((k) => `<kbd>${esc(k)}</kbd>`).join("");
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? "⌘" : "Ctrl";
