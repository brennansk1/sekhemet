import { describe, expect, it } from "vitest";
import {
  ACCOUNT_COPY,
  UI_LIB_MODULES,
  accountHeader,
  accountMenu,
  authDecision,
  initials,
  levelLabel,
  refusalMessage,
  safeNext,
  signInMethods,
  themeChoice,
  themeFor,
  tokenExpiryOptions,
} from "../src/index.js";

/**
 * The Team setup's pages, their pure half (dashboard §2.2.6, §2.17 item 1;
 * teams §2.3; DB-N9-11, DB-N9-12, DB-N9-13): where a request lands, which
 * sign-in methods show, what a refusal says, and the account menu's items.
 */

const solo = { mode: "solo" as const, signedIn: true, principal: "p_local", level: "admin" };
const out = { mode: "team" as const, signedIn: false, setupNeeded: false, sources: ["accounts"] };
const inTeam = {
  mode: "team" as const,
  signedIn: true,
  principal: "p_ada",
  level: "member",
  via: "session",
  csrf: "c",
};

describe("where a page lands (DB-N9-12, teams item 10)", () => {
  it("Solo shows no sign-in page: #/signin and #/setup go to the app", () => {
    expect(authDecision(solo, "#/signin")).toEqual({ kind: "redirect", to: "#/" });
    expect(authDecision(solo, "#/setup")).toEqual({ kind: "redirect", to: "#/" });
    expect(authDecision(solo, "#/board")).toEqual({ kind: "app" });
    expect(authDecision(solo, "")).toEqual({ kind: "app" });
  });

  it("Team, signed out: every app route shows Sign in and remembers where it was going", () => {
    expect(authDecision(out, "#/board")).toEqual({
      kind: "page",
      page: { name: "signin" },
      next: "#/board",
    });
    expect(authDecision(out, "")).toEqual({ kind: "page", page: { name: "signin" } });
    expect(authDecision(out, "#/signin")).toEqual({ kind: "page", page: { name: "signin" } });
  });

  it("Team with no Admin yet: the page is Set up Sekhemet", () => {
    const first = { ...out, setupNeeded: true };
    expect(authDecision(first, "#/board")).toMatchObject({ kind: "page", page: { name: "setup" } });
    expect(authDecision(first, "#/signin")).toMatchObject({ page: { name: "setup" } });
  });

  it("an invite link shows the invite whether or not someone is signed in", () => {
    expect(authDecision(out, "#/invite/abc_DEF-1")).toEqual({
      kind: "page",
      page: { name: "invite", id: "abc_DEF-1" },
    });
    expect(authDecision(inTeam, "#/invite/abc")).toEqual({
      kind: "page",
      page: { name: "invite", id: "abc" },
    });
    expect(authDecision({ ...out, setupNeeded: true }, "#/invite/abc")).toMatchObject({
      page: { name: "invite" },
    });
  });

  it("Team, signed in: Sign in goes on to the app", () => {
    expect(authDecision(inTeam, "#/signin")).toEqual({ kind: "redirect", to: "#/" });
    expect(authDecision(inTeam, "#/review")).toEqual({ kind: "app" });
  });

  it("only an app route is a place to return to", () => {
    expect(safeNext("#/review/card_1")).toBe("#/review/card_1");
    expect(safeNext("#/signin")).toBe("#/");
    expect(safeNext("#/invite/x")).toBe("#/");
    expect(safeNext("https://evil.test/")).toBe("#/");
    expect(safeNext("//evil.test")).toBe("#/");
    expect(safeNext(undefined)).toBe("#/");
  });
});

describe("Sign in shows the methods an Admin turned on (DB-N9-13)", () => {
  it("email and password only, by default", () => {
    expect(signInMethods(out)).toEqual({
      password: true,
      passkey: false,
      sso: false,
      ssoLabel: ACCOUNT_COPY.ssoDefault,
    });
  });

  it("the passkey and company SSO buttons appear only when each is on", () => {
    const m = signInMethods({ ...out, sources: ["accounts", "passkeys", "oidc"] });
    expect(m).toMatchObject({ password: true, passkey: true, sso: true });
    expect(m.ssoLabel).toBe("Continue with company SSO");
    expect(signInMethods({ ...out, sources: ["oidc"], company: "Northwind" }).ssoLabel).toBe(
      "Sign in with Northwind",
    );
    expect(signInMethods({ ...out, sources: ["oidc"] }).password).toBe(false);
  });

  it("the page's fixed words are the spec's", () => {
    expect(ACCOUNT_COPY.askForInvite).toBe("Ask an admin for an invite link");
    expect(ACCOUNT_COPY.footer).toBe("Self-hosted · your code and data stay on this server");
    expect(ACCOUNT_COPY.setupTitle).toBe("Set up Sekhemet");
    expect(ACCOUNT_COPY.acceptInvite).toBe("Accept invite");
  });
});

describe("a refusal says what the server said (teams TEAM-4)", () => {
  it("a 403 shows the missing permission and who can grant it, in the server's words", () => {
    const body = {
      error: "You're a Stakeholder on Chronicle. A Member can start the Agent on this issue.",
      refused: "permission",
      permission: "start_agent",
      level: "stakeholder",
      needs: "member",
      grantedBy: "A Member",
    };
    expect(refusalMessage(403, body)).toBe(body.error);
  });

  it("a 403 without a sentence is written from its parts", () => {
    expect(
      refusalMessage(403, { refused: "permission", needs: "admin", grantedBy: "An Admin" }),
    ).toBe("This needs the Admin level. An Admin can grant it.");
  });

  it("a failed CSRF check and a pending account say what to do", () => {
    expect(refusalMessage(403, { error: "csrf" })).toBe(ACCOUNT_COPY.csrf);
    // Solo has no sign-in: its page is only out of date (the dashboard restarted).
    expect(refusalMessage(403, { error: "csrf", refused: "token" }, "solo")).toBe(
      ACCOUNT_COPY.csrfSolo,
    );
    expect(ACCOUNT_COPY.csrfSolo).toMatch(/reload the page/i);
    expect(ACCOUNT_COPY.csrfSolo).not.toMatch(/sign in|session|token|csrf/i);
    expect(refusalMessage(403, { error: "csrf", refused: "origin" }, "solo")).toBe(
      ACCOUNT_COPY.csrfSoloOrigin,
    );
    expect(ACCOUNT_COPY.csrfSoloOrigin).not.toMatch(/sign in|session|token|csrf/i);
    expect(refusalMessage(403, { error: "Waiting for approval.", pending: true })).toBe(
      ACCOUNT_COPY.pending,
    );
  });

  it("anything else is the server's error, or the status", () => {
    expect(refusalMessage(401, { error: "That email and password don't match." })).toBe(
      "That email and password don't match.",
    );
    expect(refusalMessage(401, null)).toBe(ACCOUNT_COPY.signInToContinue);
    expect(refusalMessage(500, null)).toBe("The server answered 500.");
    expect(refusalMessage(0, { error: "Failed to fetch" })).toBe(ACCOUNT_COPY.unreachable);
  });
});

describe("the account menu (§2.2.6, DB-N9-11)", () => {
  it("Solo: the name and This computer; Switch workspace, and no Sign out or Members (DEC-57)", () => {
    // SHL-02: a person's name or *You*, never the principal.
    expect(accountHeader(solo)).toEqual({ name: "You", detail: "This computer" });
    const ids = accountMenu(solo, new Set(["members", "audit", "notifications", "switch"])).map(
      (i) => i.id,
    );
    expect(ids).toEqual(["profile", "notifications", "shortcuts", "theme", "switch"]);
    // The routes are §3's: the account's pages live under #/account/.
    expect(accountMenu(solo, new Set(["notifications"])).map((i) => i.route ?? "")).toEqual([
      "#/account/profile",
      "#/account/notifications",
      "",
      "",
    ]);
  });

  it("Team: name, email and level, and Sign out", () => {
    expect(accountHeader({ ...inTeam, name: "Ada Lovelace", email: "ada@northwind.test" })).toEqual(
      { name: "Ada Lovelace", detail: "ada@northwind.test", level: "Member" },
    );
    expect(accountHeader(inTeam)).toEqual({ name: "You", detail: "Member", level: "Member" });
    expect(accountMenu(inTeam, new Set()).map((i) => i.id)).toEqual([
      "profile",
      "shortcuts",
      "theme",
      "signout",
    ]);
  });

  it("a page not built is never linked; Audit only for an Admin", () => {
    const pages = new Set(["members", "audit", "notifications", "switch"]);
    expect(accountMenu(inTeam, pages).map((i) => i.id)).toEqual([
      "profile",
      "notifications",
      "shortcuts",
      "theme",
      "members",
      "switch",
      "signout",
    ]);
    expect(accountMenu({ ...inTeam, level: "admin" }, pages).map((i) => i.id)).toContain("audit");
  });

  it("levels read as words, and initials come from the name", () => {
    expect(levelLabel("admin")).toBe("Admin");
    expect(levelLabel("stakeholder")).toBe("Stakeholder");
    expect(levelLabel("nonsense")).toBe("");
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("ada")).toBe("A");
    expect(initials("  Mary Ann Evans ")).toBe("ME");
    expect(initials("")).toBe("?");
  });
});

describe("Theme: System, Light, Dark (§2.1.3)", () => {
  it("a saved theme is a choice; nothing saved follows the system", () => {
    expect(themeChoice("sand")).toBe("light");
    expect(themeChoice("basalt")).toBe("dark");
    expect(themeChoice(null)).toBe("system");
    expect(themeFor("system", true)).toBe("sand");
    expect(themeFor("system", false)).toBe("basalt");
    expect(themeFor("light", false)).toBe("sand");
    expect(themeFor("dark", true)).toBe("basalt");
  });
});

describe("personal access tokens expire (teams item 15)", () => {
  it("offers expiries up to the maximum, the default chosen", () => {
    expect(tokenExpiryOptions()).toEqual([
      { days: 7, label: "7 days", selected: false },
      { days: 30, label: "30 days", selected: false },
      { days: 90, label: "90 days", selected: true },
      { days: 365, label: "1 year", selected: false },
    ]);
    expect(tokenExpiryOptions(30, 30).map((o) => o.days)).toEqual([7, 30]);
    expect(tokenExpiryOptions(30, 30).find((o) => o.selected)?.days).toBe(30);
  });
});

describe("the browser can load it", () => {
  it("is one of the compiled modules the server serves under /app/lib/", () => {
    expect(UI_LIB_MODULES).toContain("account.js");
  });
});
