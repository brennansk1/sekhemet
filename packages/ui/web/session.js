// Who is signed in (teams §2.3; dashboard §2.2.6): `GET /api/session`, read
// once when the page boots. Solo is one person with no sign-in; in the Team
// setup the session's CSRF token rides on every write (dom.js).
import { getJSON, sendJSON, setCsrf } from "./dom.js";

/** Before the first answer, and from a server with no sessions, the page is Solo. */
let session = { mode: "solo", signedIn: true };

export function getSession() {
  return session;
}

export async function loadSession() {
  try {
    const r = await getJSON("/api/session");
    if (r.ok && r.data && (r.data.mode === "team" || r.data.mode === "solo")) session = r.data;
  } catch {
    // Unreachable: the app boots and says Offline.
  }
  setCsrf(session.csrf);
  // The account menu's header names the person (§2.2.6); an Admin also sees emails.
  if (session.mode === "team" && session.signedIn && !session.name) {
    try {
      const m = await getJSON("/api/members");
      const me = m.ok
        ? (m.data?.members ?? []).find((x) => x.principal === session.principal)
        : null;
      if (me) {
        session = {
          ...session,
          ...(me.name ? { name: me.name } : {}),
          ...(me.email ? { email: me.email } : {}),
        };
      }
    } catch {
      // The header falls back to the principal.
    }
  }
  return session;
}

/** Go on with a new session (or none): the whole page boots again at `hash`. */
export function continueTo(hash) {
  history.replaceState(null, "", `${location.pathname}${hash}`);
  location.reload();
}

/** Sign out (`DELETE /api/session`), then show Sign in. */
export async function signOutAndLeave() {
  await sendJSON("DELETE", "/api/session");
  continueTo("#/signin");
}
