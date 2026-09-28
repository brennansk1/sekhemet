// The pages before signing in (dashboard §2.17 item 1; teams items 2, 10–12;
// DB-N9-13): Sign in, Set up Sekhemet from the setup token, and an invite.
// They replace the whole shell: nothing of the app shows until someone is
// signed in, and each page has one primary action.
import { brandLockup, esc, getJSON, icon, sendJSON } from "./dom.js";
import {
  ACCOUNT_COPY as T,
  levelLabel,
  refusalMessage,
  safeNext,
  signInMethods,
} from "./lib/account.js";
import { continueTo, getSession } from "./session.js";

const TITLES = { signin: T.signInTitle, setup: T.setupTitle, invite: T.inviteTitle };

function frame(inner) {
  return `<div class="auth"><div class="auth-col"><div class="auth-brand">${brandLockup(32)}</div>${inner}<p class="auth-foot">${esc(T.footer)}</p></div></div>`;
}

function field(name, label, type, autocomplete, hint = "") {
  const id = `auth-${name}`;
  const described = hint ? ` aria-describedby="${id}-hint"` : "";
  const extra = name === "token" ? ' spellcheck="false" autocapitalize="off"' : "";
  return `<div class="auth-field"><label for="${id}">${esc(label)}</label><input id="${id}" name="${name}" type="${type}" autocomplete="${autocomplete}" required${described}${extra}>${hint ? `<small id="${id}-hint">${esc(hint)}</small>` : ""}</div>`;
}

const errorLine = '<p class="auth-error" role="alert" data-auth-error hidden></p>';

/** Mount one page into `view`; `decision` is `authDecision`'s. */
export function mountAuthPage(view, decision) {
  const page = decision.page;
  document.documentElement.dataset.auth = page.name;
  document.title = `${TITLES[page.name] ?? T.signInTitle} · Sekhemet`;
  const next = safeNext(decision.next);
  const root = document.createElement("div");
  root.className = "auth-host";
  view.textContent = "";
  view.append(root);
  if (page.name === "setup") renderSetup(root, next);
  else if (page.name === "invite") renderInvite(root, page.id);
  else renderSignIn(root, next);
}

/** Submit a form's fields as JSON; on success go on to `next`, signed in. */
function wire(root, path, next, extra = {}) {
  const form = root.querySelector("form");
  const error = root.querySelector("[data-auth-error]");
  const button = form.querySelector('button[type="submit"]');
  const label = button.textContent;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = { ...extra, ...Object.fromEntries(new FormData(form).entries()) };
    button.disabled = true;
    button.textContent = T.signingIn;
    error.hidden = true;
    const r = await sendJSON("POST", path, body);
    if (r.ok) {
      continueTo(next);
      return;
    }
    button.disabled = false;
    button.textContent = label;
    error.textContent = refusalMessage(r.status, r.data);
    error.hidden = false;
    // The password is the field to retype; the rest stays as typed.
    const pw = form.querySelector('input[name="password"]');
    if (pw) {
      pw.value = "";
      pw.focus();
    }
  });
}

function renderSignIn(root, next) {
  const m = signInMethods(getSession());
  const others = [
    m.sso ? `<a class="btn wide" href="/api/oidc/start">${esc(m.ssoLabel)}</a>` : "",
    m.passkey
      ? `<button class="btn wide" type="button" data-passkey>${icon("lock", 14, "ic s14")}${esc(T.passkey)}</button>`
      : "",
  ].join("");
  const form = m.password
    ? `<form data-auth-form="signin" novalidate>${field("email", T.email, "email", "username")}${field("password", T.password, "password", "current-password")}<button class="btn primary wide" type="submit">${esc(T.signIn)}</button></form>`
    : "";
  root.innerHTML = frame(
    `<h1>${esc(T.signInTitle)}</h1>${others}${others && form ? `<p class="auth-or">${esc(T.or)}</p>` : ""}${form}${errorLine}<p class="auth-note">${esc(T.askForInvite)}</p>`,
  );
  if (form) wire(root, "/api/session", next);
  root.querySelector("[data-passkey]")?.addEventListener("click", () => passkeySignIn(root, next));
  root.querySelector("input")?.focus();
}

function renderSetup(root, next) {
  root.innerHTML = frame(
    `<h1>${esc(T.setupTitle)}</h1><p class="auth-lead">${esc(T.setupLead)}</p><form data-auth-form="setup" novalidate>${field("token", T.setupToken, "text", "off")}${field("name", T.name, "text", "name")}${field("email", T.email, "email", "email")}${field("password", T.password, "password", "new-password", T.passwordHint)}<button class="btn primary wide" type="submit">${esc(T.createAdmin)}</button></form>${errorLine}`,
  );
  wire(root, "/api/setup", next);
  root.querySelector("input")?.focus();
}

async function renderInvite(root, id) {
  root.innerHTML = frame(`<h1>${esc(T.inviteTitle)}</h1><p class="auth-lead">…</p>`);
  const r = await getJSON(`/api/invites/${encodeURIComponent(id)}`).catch(() => ({
    ok: false,
    status: 0,
    data: null,
  }));
  if (!r.ok) {
    root.innerHTML = frame(
      `<h1>${esc(T.inviteTitle)}</h1><p class="auth-error" role="alert">${esc(T.inviteGone)}</p><p class="auth-lead">${esc(refusalMessage(r.status, r.data))}</p>`,
    );
    return;
  }
  const inv = r.data ?? {};
  const facts = [
    [T.inviteWorkspace, inv.workspace],
    [T.inviteLevel, levelLabel(inv.level) || inv.level],
    [T.inviteProject, inv.project],
    [T.inviteFrom, inv.invitedBy],
    [T.inviteExpires, inv.expires ? new Date(inv.expires).toLocaleDateString() : ""],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
    .join("");
  root.innerHTML = frame(
    `<h1>${esc(T.inviteTitle)}</h1><dl class="auth-facts">${facts}</dl><p class="auth-lead">${esc(T.inviteLead)}</p><form data-auth-form="invite" novalidate>${field("name", T.name, "text", "name")}${field("email", T.email, "email", "email")}${field("password", T.password, "password", "new-password", T.passwordHint)}<button class="btn primary wide" type="submit">${esc(T.acceptInvite)}</button></form>${errorLine}`,
  );
  // Only this button accepts: opening the link consumed nothing (teams item 10).
  wire(root, `/api/invites/${encodeURIComponent(id)}/accept`, "#/");
  root.querySelector("input")?.focus();
}

/* ---------- Passkeys (WebAuthn) ---------- */

const fromB64url = (s) => {
  const b = atob(
    s
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(s.length / 4) * 4, "="),
  );
  return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer;
};
const toB64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** The server's JSON options as the browser's, where the browser cannot parse them itself. */
function requestOptions(json) {
  if (PublicKeyCredential.parseRequestOptionsFromJSON)
    return PublicKeyCredential.parseRequestOptionsFromJSON(json);
  return {
    ...json,
    challenge: fromB64url(json.challenge),
    allowCredentials: (json.allowCredentials ?? []).map((c) => ({ ...c, id: fromB64url(c.id) })),
  };
}

function credentialJSON(cred) {
  if (cred.toJSON) return cred.toJSON();
  const r = cred.response;
  return {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: toB64url(r.clientDataJSON),
      authenticatorData: toB64url(r.authenticatorData),
      signature: toB64url(r.signature),
      ...(r.userHandle ? { userHandle: toB64url(r.userHandle) } : {}),
    },
  };
}

async function passkeySignIn(root, next) {
  const error = root.querySelector("[data-auth-error]");
  const say = (text) => {
    error.textContent = text;
    error.hidden = false;
  };
  error.hidden = true;
  if (!window.PublicKeyCredential || !navigator.credentials) {
    say(T.passkeyUnsupported);
    return;
  }
  const o = await sendJSON("POST", "/api/passkeys/signin/options", {});
  if (!o.ok) {
    say(refusalMessage(o.status, o.data));
    return;
  }
  let cred;
  try {
    cred = await navigator.credentials.get({ publicKey: requestOptions(o.data) });
  } catch {
    say(T.passkeyCancelled);
    return;
  }
  if (!cred) {
    say(T.passkeyCancelled);
    return;
  }
  const r = await sendJSON("POST", "/api/passkeys/signin", credentialJSON(cred));
  if (r.ok) continueTo(next);
  else say(refusalMessage(r.status, r.data));
}
