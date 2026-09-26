// The account menu and Profile (dashboard §2.2.6; teams items 14, 15;
// DB-N9-11, DB-N9-12): who you are and your level, Theme, Keyboard shortcuts
// and, in the Team setup, Sign out; Profile holds the personal access tokens
// (created with an expiry, shown once, revocable) and this browser's session.
import { openCheatsheet } from "./cheatsheet.js";
import { announce, copyText, esc, getJSON, icon, sendJSON } from "./dom.js";
import {
  ACCOUNT_COPY as T,
  accountHeader,
  accountMenu,
  initials,
  levelLabel,
  levelsUpTo,
  refusalMessage,
  tokenExpiryOptions,
} from "./lib/account.js";
import { openMenu } from "./overlay.js";
import { getSession, signOutAndLeave } from "./session.js";
import { currentThemeChoice, setTheme, setTopbar } from "./shell.js";
import { toast } from "./toast.js";

/** Account pages this build has beyond Profile; a page not built is never linked. */
const PAGES = new Set();

const THEMES = [
  ["system", T.themeSystem],
  ["light", T.themeLight],
  ["dark", T.themeDark],
];

export function openAccountMenu(anchor) {
  const s = getSession();
  const head = accountHeader(s);
  const choice = currentThemeChoice();
  const items = [];
  for (const item of accountMenu(s, PAGES)) {
    if (item.id === "theme") {
      items.push("-");
      for (const [c, label] of THEMES)
        items.push({
          label: `${T.theme}: ${label}`,
          checked: choice === c,
          run: () => setTheme(c),
        });
      items.push("-");
    } else if (item.id === "shortcuts") {
      items.push({ label: item.label, run: () => setTimeout(openCheatsheet, 0) });
    } else if (item.id === "signout") {
      items.push({ label: item.label, run: () => signOutAndLeave() });
    } else if (item.route) {
      const route = item.route;
      items.push({
        label: item.label,
        run: () => {
          location.hash = route;
        },
      });
    }
  }
  while (items.at(-1) === "-") items.pop();
  const note =
    head.level && head.detail !== head.level ? `${head.detail} · ${head.level}` : head.detail;
  openMenu(anchor, items, { heading: head.name, note });
}

export function initAccount() {
  document.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target.closest("[data-account]") : null;
    if (t) openAccountMenu(t);
  });
}

/* ---------- Profile (#/account/profile) ---------- */

const ui = {
  host: null,
  /** GET /api/tokens's list, or null when this server does not list tokens. */
  listed: null,
  /** Tokens created in this visit, for a server that does not list them. */
  created: [],
  /** The one token value shown, once, right after it was created. */
  shown: null,
  error: "",
  busy: false,
};

const VIA = {
  session: T.signedInWithSession,
  token: T.signedInWithToken,
  proxy: T.signedInWithProxy,
};

function day(iso) {
  return iso ? new Date(iso).toLocaleDateString() : "";
}

async function loadTokens() {
  const r = await getJSON("/api/tokens").catch(() => ({ ok: false }));
  ui.listed = r.ok && Array.isArray(r.data?.tokens) ? r.data.tokens : null;
  render();
}

function tokensSection(s) {
  const levels = levelsUpTo(s.level);
  const rows = (ui.listed ?? ui.created)
    .map((t) => {
      const name = t.name || t.id;
      return `<li><span class="name">${esc(name)}</span><span class="sec">${esc(levelLabel(t.level))}${t.expires ? ` · ${esc(`${T.expires} ${day(t.expires)}`)}` : ""}</span><button class="btn sm" type="button" data-revoke="${esc(t.id)}" aria-label="${esc(`${T.revoke} ${name}`)}">${esc(T.revoke)}</button></li>`;
    })
    .join("");
  const shown = ui.shown
    ? `<div class="token-once" role="status"><p>${esc(T.tokenShownOnce)}</p><div class="token-row"><code class="mono" data-token-value>${esc(ui.shown.token)}</code><button class="btn sm" type="button" data-copy-token>${icon("copy", 14, "ic s14")}${esc(T.copy)}</button></div></div>`
    : "";
  const list = rows
    ? `<ul class="token-list">${rows}</ul>`
    : `<p class="sec">${esc(T.noTokens)}</p>`;
  return `<section class="profile-sec" aria-labelledby="tokens-h"><h2 id="tokens-h">${esc(T.tokensTitle)}</h2><p class="sec">${esc(T.tokensLead)}</p><form class="token-form" data-token-form><div class="auth-field"><label for="token-name">${esc(T.tokenName)}</label><input id="token-name" name="name" type="text" autocomplete="off" required maxlength="80"></div><div class="auth-field"><label for="token-level">${esc(T.tokenLevel)}</label><select id="token-level" name="level">${levels
    .map(
      (l) =>
        `<option value="${esc(l)}"${l === s.level ? " selected" : ""}>${esc(levelLabel(l))}</option>`,
    )
    .join(
      "",
    )}</select></div><div class="auth-field"><label for="token-days">${esc(T.tokenExpires)}</label><select id="token-days" name="days">${tokenExpiryOptions()
    .map(
      (o) => `<option value="${o.days}"${o.selected ? " selected" : ""}>${esc(o.label)}</option>`,
    )
    .join(
      "",
    )}</select></div><button class="btn primary" type="submit"${ui.busy ? " disabled" : ""}>${esc(T.createToken)}</button></form>${ui.error ? `<p class="auth-error" role="alert">${esc(ui.error)}</p>` : ""}${shown}${ui.listed ? "" : `<p class="sec note">${esc(T.tokensNotListed)}</p>`}${list}</section>`;
}

function sessionsSection(s) {
  return `<section class="profile-sec" aria-labelledby="sessions-h"><h2 id="sessions-h">${esc(T.sessionsTitle)}</h2><p class="sec">${esc(T.sessionsLead)}</p><ul class="token-list"><li><span class="name">${esc(T.thisSession)}</span><span class="sec">${esc(VIA[s.via] ?? "")}</span>${s.via === "session" ? `<button class="btn sm" type="button" data-signout>${esc(T.signOut)}</button>` : ""}</li></ul><p class="sec note">${esc(T.sessionsNotListed)}</p></section>`;
}

function render() {
  if (!ui.host) return;
  const s = getSession();
  const head = accountHeader(s);
  const who = `<section class="profile-sec profile-who"><span class="avatar lg" aria-hidden="true">${esc(initials(head.name))}</span><div><p class="name">${esc(head.name)}</p><p class="sec">${esc(head.detail)}</p></div></section>`;
  if (s.mode !== "team") {
    ui.host.innerHTML = `${who}<p class="sec profile-note">${esc(T.soloProfile)}</p>`;
    return;
  }
  const facts = `<dl class="auth-facts"><dt>${esc(T.level)}</dt><dd>${esc(levelLabel(s.level))}</dd><dt>${esc(T.signedInWith)}</dt><dd>${esc(VIA[s.via] ?? "")}</dd></dl>`;
  ui.host.innerHTML = `${who}${facts}${tokensSection(s)}${sessionsSection(s)}`;
}

async function createToken(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  ui.busy = true;
  ui.error = "";
  render();
  const r = await sendJSON("POST", "/api/tokens", {
    name: String(data.name ?? "").trim(),
    level: data.level,
    days: Number(data.days),
  });
  ui.busy = false;
  if (!r.ok) {
    ui.error = refusalMessage(r.status, r.data);
    render();
    return;
  }
  const t = r.data;
  ui.shown = { id: t.id, token: t.token };
  ui.created.push({
    id: t.id,
    name: String(data.name ?? "").trim(),
    level: t.level,
    expires: t.expires,
  });
  announce(T.tokenShownOnce);
  if (ui.listed) await loadTokens();
  else render();
  ui.host?.querySelector("[data-token-value]")?.scrollIntoView({ block: "nearest" });
}

async function revokeToken(id) {
  const r = await sendJSON("DELETE", `/api/tokens/${encodeURIComponent(id)}`);
  if (!r.ok) {
    toast({ tone: "fail", text: refusalMessage(r.status, r.data) });
    return;
  }
  ui.created = ui.created.filter((t) => t.id !== id);
  if (ui.shown?.id === id) ui.shown = null;
  toast({ tone: "pass", text: T.revoked });
  if (ui.listed) await loadTokens();
  else render();
}

export function mount(root) {
  setTopbar({ title: T.profileTitle });
  const host = document.createElement("div");
  host.className = "profile";
  root.append(host);
  ui.host = host;
  ui.shown = null;
  ui.error = "";
  render();
  const s = getSession();
  if (s.mode === "team" && s.signedIn) loadTokens();
  host.addEventListener("submit", (e) => {
    const form = e.target instanceof Element ? e.target.closest("[data-token-form]") : null;
    if (!form) return;
    e.preventDefault();
    createToken(form);
  });
  host.addEventListener("click", async (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const revoke = t.closest("[data-revoke]");
    if (revoke) revokeToken(revoke.getAttribute("data-revoke"));
    else if (t.closest("[data-copy-token]") && ui.shown) {
      const ok = await copyText(ui.shown.token);
      if (ok) toast({ tone: "pass", text: T.copied });
    } else if (t.closest("[data-signout]")) signOutAndLeave();
  });
  return {
    unmount() {
      ui.host = null;
      // A token is shown once: leaving the page forgets it.
      ui.shown = null;
    },
  };
}
