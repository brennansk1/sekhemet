// Small DOM and network helpers shared by every view.
export { aiBadge, brandLockup, brandMark, icon, teammateName } from "./lib/icons.js";

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

// In the Team setup a signed-in session's writes carry its CSRF token
// (teams item 13, `X-Sekhemet-CSRF`); Solo has none and sends only the
// action header every write needs.
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

export async function getJSON(path) {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  const data = await readBody(res);
  noticeAuth(res.status, data);
  return { ok: res.ok, status: res.status, data };
}

/** A write with a JSON body: the action header and, signed in, the CSRF token. */
export async function sendJSON(method, path, body) {
  try {
    const res = await fetch(path, {
      method,
      headers: actionHeaders({ "Content-Type": "application/json" }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await readBody(res);
    noticeAuth(res.status, data);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: String(err?.message ?? err) } };
  }
}

/** Triage mutations carry the header the server requires (CSRF guard). */
export function postJSON(path, body) {
  return sendJSON("POST", path, body ?? {});
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
