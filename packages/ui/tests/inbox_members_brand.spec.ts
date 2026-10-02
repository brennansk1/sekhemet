import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appIconSvg, brandMark } from "../src/icons.js";
import {
  INBOX_PANE_COPY,
  INBOX_SPLIT_PX,
  causeComment,
  paneOpenHref,
  readingFacts,
} from "../src/inbox.js";
import { machineLine } from "../src/machine_tier.js";
import {
  MEMBERS_PARTS_COPY,
  accessLevelLines,
  aiTeammateLines,
  inviteRows,
  memberRows,
  membersTab,
  membersTabs,
  signInLines,
} from "../src/team_admin.js";
import { DERIVED, THEMES, contrastRatio, generateTokenCss } from "../src/tokens.js";

// C2a, the team-visual builder: the visual system as the approved mockups draw
// it (DEC-51). NEW-dashboard-20 — primary buttons in dark ink, gold only in its
// three places, the warning hue apart from gold — and NEW-dashboard-19's brand
// mark as `Logo.dc.html` draws it (FINDINGS SPEC-07, VIS-02).
const WEB = join(import.meta.dirname, "..", "web");

interface Rule {
  file: string;
  selector: string;
  decls: Map<string, string>;
}

/** The served stylesheets' rules, @media blocks flattened (the files are flat CSS). */
function readRules(): Rule[] {
  const out: Rule[] = [];
  for (const file of readdirSync(WEB).filter((f) => f.endsWith(".css"))) {
    const css = readFileSync(join(WEB, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const re = /([^{}]+)\{([^{}]*)\}/g;
    for (let m = re.exec(css); m; m = re.exec(css)) {
      const head = (m[1] ?? "").trim().replace(/^@[^{]*\{\s*/, "");
      if (head.startsWith("@") || /^(from|to|\d+%)$/.test(head)) continue;
      const decls = new Map<string, string>();
      for (const d of (m[2] ?? "").split(";")) {
        const k = d.indexOf(":");
        if (k > 0) decls.set(d.slice(0, k).trim(), d.slice(k + 1).trim());
      }
      out.push({ file, selector: head.replace(/\s+/g, " "), decls });
    }
  }
  return out;
}
const RULES = readRules();
const where = (r: Rule) => `${r.file} ${r.selector}`;

describe("NEW-dashboard-20: primary buttons in dark ink, gold as the brand accent", () => {
  it("DB-N20-1: --on-ink on --text-primary is at least 4.5:1 in both themes, and emitted in both", () => {
    for (const [name, t] of Object.entries(THEMES)) {
      const d = DERIVED[name as keyof typeof DERIVED];
      const r = contrastRatio(d.onInk, t.textPrimary);
      expect(r, `${name} on-ink on text-primary = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(generateTokenCss().split("--on-ink:").length - 1).toBe(2);
  });

  it("DB-N20-1: the primary button is filled with --text-primary and set in --on-ink", () => {
    const primary = RULES.find((r) => r.file === "base.css" && r.selector === ".btn.primary");
    expect(primary?.decls.get("background")).toBe("var(--text-primary)");
    expect(primary?.decls.get("border-color")).toBe("var(--text-primary)");
    expect(primary?.decls.get("color")).toBe("var(--on-ink)");
    const kbd = RULES.find((r) => r.file === "base.css" && r.selector === ".btn.primary kbd");
    expect(kbd?.decls.get("color")).toBe("var(--on-ink)");
  });

  it("DB-N20-1: no button and no other fill uses --accent or --on-accent", () => {
    for (const r of RULES) {
      // The active-nav indicator is a 2 px bar, not a fill (DB-N20-2).
      const indicator = r.selector === '.nav a[aria-current="page"]::before';
      for (const [k, v] of r.decls) {
        if (/^(background|background-color|fill)$/.test(k) && !indicator)
          expect(v, `${where(r)} ${k}`).not.toContain("--accent");
        expect(v, `${where(r)} ${k}`).not.toContain("--on-accent");
      }
    }
  });

  it("DB-N20-2: --accent is used only by the active-nav indicator, the focus ring and the brand mark's disc", () => {
    const allowed = (s: string) =>
      // The focus ring, wherever focus is drawn.
      /:focus|\.focus\b|focus-within/.test(s) ||
      // The active-nav indicator: the sidebar's bar and the phone tab bar's.
      /^\.nav a\[aria-current="page"\]::before$/.test(s) ||
      /^\.tabbar a\[aria-current="page"\]$/.test(s);
    const users = RULES.filter((r) => [...r.decls.values()].some((v) => v.includes("--accent")));
    expect(users.length).toBeGreaterThan(0);
    for (const r of users) {
      for (const s of r.selector.split(",").map((x) => x.trim()))
        expect(allowed(s), `${where(r)} uses --accent`).toBe(true);
    }
    // The one place outside the stylesheets: the brand mark's disc.
    expect(brandMark(18)).toContain('style="fill:var(--accent)"');
    for (const f of readdirSync(WEB).filter((x) => x.endsWith(".js"))) {
      expect(readFileSync(join(WEB, f), "utf8"), f).not.toContain("var(--accent)");
    }
  });

  it("DB-N20-3: every warning treatment is drawn in --state-parked", () => {
    const value = (file: string, selector: string, prop: string) =>
      RULES.find((r) => r.file === file && r.selector === selector)?.decls.get(prop);
    // A capacity bar at its limit, a column count at its limit, a wait past its limit.
    expect(value("board.css", ".cap.full i", "background")).toBe("var(--state-parked)");
    expect(value("board.css", ".col-h .c.full", "color")).toBe("var(--state-parked)");
    expect(value("wave2.css", ".ib-wait.long", "color")).toBe("var(--state-parked)");
  });
});

describe("NEW-dashboard-19: the brand mark as Logo.dc.html draws it (VIS-02)", () => {
  const LOGO = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "docs",
      "design",
      "mockups",
      "dashboard-v3",
      "boards",
      "Logo.dc.html",
    ),
    "utf8",
  );

  /** The disc and the pylons' tops, read from a 24-unit mark. */
  function geometry(svg: string) {
    const c = /<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/.exec(svg);
    const paths = [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1] ?? "");
    const ys = paths.flatMap((d) => [...d.matchAll(/[\d.]+ ([\d.]+)/g)].map((m) => Number(m[1])));
    return {
      disc: { cx: Number(c?.[1]), cy: Number(c?.[2]), r: Number(c?.[3]) },
      paths,
      top: Math.min(...ys),
    };
  }

  it("DB-N19-6: the disc is centred at (12, 6.5), radius 2.4, on the horizon the pylons' tops make", () => {
    for (const svg of [brandMark(18), appIconSvg()]) {
      const g = geometry(svg);
      expect(g.disc).toEqual({ cx: 12, cy: 6.5, r: 2.4 });
      // A disc lower in the gate fails: its centre sits on the pylons' tops.
      expect(g.disc.cy).toBe(g.top);
      expect(g.paths).toEqual(["M2.2 21 4.4 6.5H9.3V21z", "M21.8 21 19.6 6.5H14.7V21z"]);
    }
  });

  it("DB-N19-6: the geometry is the approved board's", () => {
    // The Logo board's mark: pylons from the horizon at 6.5 to the base at 21,
    // outer edges 4.4→2.2 and 19.6→21.8, inner edges at 9.3 and 14.7.
    expect(LOGO).toContain("M2.2 21L4.4 6.5H9.3V21zM21.8 21L19.6 6.5h-4.9V21z");
    expect(LOGO).toContain('<circle cx="12" cy="6.5" r="2.4"');
  });
});

describe("NEW-dashboard-19: Members' parts (DB-N19-3, DB-N19-4; FINDINGS TEAM-04)", () => {
  it("DB-N19-3: tabs Members, Invites (an Admin only) and Sign-in", () => {
    expect(membersTabs(true).map((t) => t.label)).toEqual(["Members", "Invites", "Sign-in"]);
    expect(membersTabs(false).map((t) => t.label)).toEqual(["Members", "Sign-in"]);
    expect(membersTab("invites", false)).toBe("members");
    expect(membersTab("signin", false)).toBe("signin");
    expect(membersTab("nonsense", true)).toBe("members");
  });

  it("DB-N19-3: the table's columns, and Can accept in by project name", () => {
    expect(MEMBERS_PARTS_COPY.columns).toEqual({
      name: "Name",
      access: "Access",
      labels: "Labels",
      projects: "Projects",
      acceptIn: "Can accept in",
      lastActive: "Last active",
    });
    const [row] = memberRows(
      [{ principal: "p_1", level: "member", name: "Mo Member", acceptIn: ["proj_a", "proj_b"] }],
      { admin: false, now: 0, projectNames: { proj_a: "Chronicle", proj_b: "Billing" } },
    );
    expect(row?.acceptIn).toEqual(["Billing", "Chronicle"]);
  });

  it("DB-N19-3: the AI teammates are not members, and say what they may do", () => {
    const lines = aiTeammateLines({ agentIssuesPerPerson: 1, autoApply: [] });
    expect(MEMBERS_PARTS_COPY.aiNote).toBe("not members · no access level · no seat");
    expect(lines).toEqual([
      {
        who: "seshat",
        name: "Seshat",
        role: "Project manager · Planning model",
        does: "Suggests; people apply. Auto-apply: off for every property.",
      },
      {
        who: "agent",
        name: "Agent",
        role: "Coding model",
        does: "Acts with the access of the person who starts it · 1 issue per person at a time.",
      },
    ]);
    const on = aiTeammateLines({
      agentIssuesPerPerson: 2,
      autoApply: [{ project: "proj_a", name: "Chronicle", properties: ["priority", "label"] }],
    });
    expect(on[0]?.does).toBe(
      "Suggests; people apply. Auto-apply: on for priority and label in Chronicle.",
    );
    expect(on[1]?.does).toContain("2 issues per person at a time");
  });

  it("DB-N19-3: each access level and what it allows, from the server's table", () => {
    const lines = accessLevelLines([
      {
        level: "admin",
        allows: ["manage members, invites and levels", "change the server's configuration"],
      },
      { level: "viewer", allows: ["read this project", "comment"] },
    ]);
    expect(lines).toEqual([
      {
        level: "admin",
        word: "Admin",
        allows: "Manage members, invites and levels; change the server's configuration.",
      },
      { level: "viewer", word: "Viewer", allows: "Read this project; comment." },
    ]);
    expect(MEMBERS_PARTS_COPY.levelsNote).toBe(
      "Accepting work is set per project. Labels such as Developer or Product owner set a person's home page, not what they can do.",
    );
  });

  it("DB-N19-4: an outstanding invite's row: email, level, project, sender, expiry", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    const rows = inviteRows(
      [
        {
          ref: "inv_1",
          level: "stakeholder",
          email: "sam@northwind.test",
          project: "proj_a",
          projectName: "Chronicle",
          invitedBy: "Ada Admin",
          expires: "2026-10-08T12:00:00Z",
        },
        { ref: "inv_2", level: "viewer", expires: "2026-10-01T15:00:00Z" },
      ],
      now,
    );
    expect(rows).toEqual([
      {
        ref: "inv_1",
        email: "sam@northwind.test",
        levelWord: "Stakeholder",
        project: "Chronicle",
        by: "Ada Admin",
        expires: "in 7 days",
      },
      {
        ref: "inv_2",
        email: "Anyone with the link",
        levelWord: "Viewer",
        project: "Whole workspace",
        by: "An Admin",
        expires: "in 3 hours",
      },
    ]);
  });

  it("DB-N19-3: the sign-in settings in force, each with where it is changed", () => {
    const lines = signInLines({
      sso: false,
      passkeys: true,
      passwords: true,
      minPasswordLength: 15,
      openSignup: [],
      idleMinutes: 60,
      absoluteHours: 24,
    });
    expect(lines.map((l) => [l.label, l.value])).toEqual([
      ["Company SSO", "Off"],
      ["Passkeys", "On"],
      ["Passwords", "On · 15 characters minimum"],
      ["Open sign-up", "Off · invite links only"],
      ["Sessions", "1 h idle · 24 h total"],
    ]);
    for (const l of lines) expect(l.where).toMatch(/config\.toml/);
  });
});

describe("NEW-dashboard-19: the Inbox's reading pane (DB-N19-7..9; FINDINGS TEAM-03)", () => {
  it("DB-N19-7: two panes from 1100 px, one list below", () => {
    expect(INBOX_SPLIT_PX).toBe(1100);
    expect(INBOX_PANE_COPY).toMatchObject({
      backToInbox: "Back to Inbox",
      reply: "Reply",
      replyPlaceholder: "Type @ to mention a person or the Agent",
      openIssue: "Open issue",
      reviewIt: "Review it",
    });
  });

  it("DB-N19-7: the issue's column, assignee, delegate and release in board words", () => {
    // The shape `GET /api/cards/:id` sends: the stored owner and delegate, and
    // their names in `display` (DEC-52: the owner is the Assignee).
    expect(
      readingFacts({
        status: "review",
        owner: "p_1ea759a97c8be9dd6cf8f7b8",
        delegate: { kind: "worker" },
        display: { ownerName: "Priya Nair" },
      }),
    ).toBe("In review · assignee Priya Nair · delegate Agent");
    expect(
      readingFacts({
        status: "ready",
        owner: "p_1",
        delegate: { kind: "person", id: "p_2" },
        display: { ownerName: "Priya Nair", delegateName: "Lee Park" },
      }),
    ).toBe("To do · assignee Priya Nair · delegate Lee Park");
    expect(readingFacts({ status: "ready", release: "Release 1" })).toBe(
      "To do · no assignee · release Release 1",
    );
  });

  it("DB-N17-1: the pane's Review it opens the criteria view for a person who manages the work", () => {
    const review = {
      reason: "review_requested" as const,
      kind: "issue" as const,
      cardId: "card_x",
      link: "#/review/card_x",
    };
    expect(paneOpenHref(review, true)).toBe("#/card/card_x/criteria");
    expect(paneOpenHref(review, false)).toBe("#/review/card_x");
    const mention = { ...review, reason: "mentioned" as const, link: "#/card/card_x/activity" };
    expect(paneOpenHref(mention, true)).toBe("#/card/card_x/activity");
    const plan = { ...review, kind: "plan_approval" as const, link: "#/card/card_x/plan" };
    expect(paneOpenHref(plan, true)).toBe("#/card/card_x/plan");
  });

  it("DB-N19-7, SHL-02: never a principal, and the Agent is only ever the delegate (DEC-52)", () => {
    // The legacy executor field names the delegate or the owner's principal.
    const card = {
      status: "ready",
      assignee: "p_1ea759a97c8be9dd6cf8f7b8",
      owner: "p_1ea759a97c8be9dd6cf8f7b8",
    };
    expect(readingFacts(card)).toBe("To do · assignee an unnamed person");
    const delegated = {
      status: "review",
      assignee: "worker",
      delegate: { kind: "worker" },
    };
    expect(readingFacts(delegated)).toBe("In review · no assignee · delegate Agent");
  });

  it("DB-N19-7: what caused the item, in context: the comment that mentioned or replied", () => {
    const comments = [
      { id: "c1", by: "person", name: "Lee Park", text: "First", postedAt: "2026-10-01T09:00:00Z" },
      { id: "c2", by: "person", name: "You", text: "Mine", postedAt: "2026-10-01T09:30:00Z" },
      {
        id: "c3",
        by: "person",
        name: "Lee Park",
        text: "@Nora can you look?",
        postedAt: "2026-10-01T10:00:00Z",
      },
    ];
    const item = {
      id: "i1",
      reason: "mentioned" as const,
      kind: "issue" as const,
      cardId: "c",
      title: "T",
      change: { type: "mentioned" as const, by: "Lee Park" },
      count: 1,
      at: "2026-10-01T10:00:00Z",
      seq: 3,
      unread: true,
      saved: false,
      done: false,
      link: "#/card/c",
    };
    expect(causeComment(item, comments)?.id).toBe("c3");
    expect(
      causeComment(
        { ...item, change: { type: "status", by: "Lee Park", status: "review" } },
        comments,
      ),
    ).toBeUndefined();
  });
});

describe("NEW-dashboard-19: Configuration's machine line (DB-N19-5; FINDINGS CFG-07)", () => {
  it("names the machine, its chip and memory in plain words, and the bandwidth only when measured", () => {
    const GB = 1024 ** 3;
    expect(
      machineLine({ name: "This Mac", chip: "Apple M4", memoryBytes: 24 * GB, unified: true }),
    ).toBe("This Mac · Apple M4 · 24 GB unified memory · memory bandwidth not measured yet");
    expect(
      machineLine({
        name: "This machine",
        chip: "AMD Ryzen 9 7950X",
        memoryBytes: 64 * GB,
        unified: false,
        bandwidthGBs: 81.6,
      }),
    ).toBe("This machine · AMD Ryzen 9 7950X · 64 GB memory · about 82 GB/s memory bandwidth");
    expect(machineLine(undefined)).toBe("");
  });
});

describe("VIS-03, VIS-05: pages fill the main area; one tab treatment; a link drawn as a button", () => {
  it("VIS-03: Inbox, My issues, Members, Audit and Configuration set no column width", () => {
    for (const sel of [".ib-view", ".mi", ".mb", ".au", ".cfg"]) {
      const rules = RULES.filter((r) => r.selector.split(",").some((s) => s.trim() === sel));
      expect(rules.length, sel).toBeGreaterThan(0);
      for (const r of rules) expect(r.decls.has("max-width"), where(r)).toBe(false);
    }
  });

  it("VIS-05: a link drawn as a button has no underline", () => {
    const rule = RULES.find((r) => r.file === "base.css" && r.selector === "a.btn");
    expect(rule?.decls.get("text-decoration")).toBe("none");
  });

  it("VIS-05: Inbox, Members and Configuration use the issue page's one tab treatment", () => {
    expect(RULES.some((r) => /\.ib-tabs button|\.cfg-tabs a\.btn/.test(r.selector))).toBe(false);
    const src = (f: string) => readFileSync(join(WEB, f), "utf8");
    expect(src("inbox.js")).toContain('class="tab" type="button" role="tab"');
    expect(src("members.js")).toContain('<a class="tab" href="#/members');
    expect(src("configuration.js")).toContain('<a class="tab" href="#/configuration/');
    expect(src("configuration.js")).not.toContain('<a class="btn sm" href="#/configuration/');
    const current = RULES.find((r) => r.selector.includes('.tab[aria-current="page"]::after'));
    expect(current?.decls.get("background")).toBe("var(--text-primary)");
  });
});

describe("VIS-01 (in part): type sizes and radii from the tokens", () => {
  it("sets no literal font size and no 5 px radius in the served stylesheets", () => {
    for (const r of RULES) {
      const size = r.decls.get("font-size");
      if (size) expect(size, where(r)).toMatch(/^(var\(--text-[a-z]+\)|inherit|100%|1em)$/);
      expect(r.decls.get("border-radius") ?? "", where(r)).not.toMatch(/\b5px\b/);
    }
  });
});
