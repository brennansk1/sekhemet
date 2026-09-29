import { describe, expect, it } from "vitest";
import {
  AUDIT_CATEGORIES,
  AUDIT_TYPES,
  UI_LIB_MODULES,
  agentStatusLine,
  auditActorText,
  auditCsv,
  auditEntry,
  lastActiveText,
  levelNote,
  memberRows,
} from "../src/index.js";

/**
 * B4.11 T5, the pure half of Members, Audit and the level notes (teams
 * NEW-teams-10, items 6–10, 27; dashboard §2.2.3, §2.2.7, §2.17 items 4–5;
 * DB-N9-10, DB-N9-16, DB-N9-17; TEAM-27).
 */

const NOW = Date.parse("2026-09-28T12:00:00Z");

describe("DB-N9-17: a control the viewer's level does not allow says why", () => {
  const stakeholder = { mode: "team" as const, level: "stakeholder" };

  it("names the level held and a level that can, in the server's own sentence", () => {
    expect(levelNote(stakeholder, "agent.start", { projectName: "Chronicle" })).toBe(
      "You're a Stakeholder on Chronicle. A Member can start the Agent on this issue.",
    );
    expect(levelNote({ mode: "team", level: "member" }, "members.manage")).toBe(
      "You're a Member in this workspace. An Admin can manage members, invites and levels.",
    );
    expect(levelNote({ mode: "team", level: "viewer" }, "project.settings")).toBe(
      "You're a Viewer in this workspace. An Admin or the project lead can change this project's Accept rule and settings.",
    );
  });

  it("allows what the level allows, a project's own level, and a lead's rows", () => {
    expect(levelNote(stakeholder, "comment")).toBeUndefined();
    expect(levelNote(stakeholder, "issue.file")).toBeUndefined();
    const override = {
      mode: "team" as const,
      level: "stakeholder",
      projects: { proj_a: { level: "member" }, proj_b: { lead: true } },
    };
    expect(levelNote(override, "agent.start", { project: "proj_a" })).toBeUndefined();
    expect(levelNote(override, "agent.start", { project: "proj_c" })).toBe(
      "You're a Stakeholder on this project. A Member can start the Agent on this issue.",
    );
    const lead = { mode: "team" as const, level: "member", projects: { proj_b: { lead: true } } };
    expect(levelNote(lead, "project.settings", { project: "proj_b" })).toBeUndefined();
    expect(levelNote(lead, "project.settings", { project: "proj_x" })).toMatch(/project lead/);
  });

  it("leaves the Accept rule's permissions to the review desk above Member, and says nothing in Solo", () => {
    expect(levelNote({ mode: "team", level: "member" }, "accept")).toBeUndefined();
    expect(levelNote(stakeholder, "accept")).toBe(
      "You're a Stakeholder in this workspace. A Member this project's Accept rule names can accept this issue.",
    );
    expect(levelNote({ mode: "solo", level: "admin" }, "members.manage")).toBeUndefined();
    expect(levelNote({ mode: "team" }, "comment")).toMatch(/not a member/);
  });
});

describe("DB-N9-16: the Members table", () => {
  const members = [
    { principal: "p_vic", level: "viewer", name: "Vic Viewer", lastActive: "2026-09-28T09:00:00Z" },
    {
      principal: "p_ada",
      level: "admin",
      name: "Ada Admin",
      email: "ada@northwind.test",
      active: true,
    },
    { principal: "p_new", level: "viewer", name: "Nia New", pending: true },
    {
      principal: "p_mo",
      level: "member",
      name: "Mo Member",
      label: "Developer",
      projects: { proj_a: "admin" },
      locked: true,
      lastActive: "2026-09-28T11:55:00Z",
    },
  ];

  it("pending first, then Admins, Members and the rest; the Admin's actions per row", () => {
    const rows = memberRows(members, {
      admin: true,
      me: "p_ada",
      projectNames: { proj_a: "Chronicle" },
      now: NOW,
    });
    expect(rows.map((r) => r.name)).toEqual(["Nia New", "Ada Admin", "Mo Member", "Vic Viewer"]);
    expect(rows[0]?.actions).toEqual(["approve", "decline"]);
    // Your own row: no level change, reset or removal — the last Admin stays.
    expect(rows[1]?.actions).toEqual(["override", "label"]);
    expect(rows[2]).toMatchObject({
      levelWord: "Member",
      label: "Developer",
      overrides: [
        { project: "proj_a", projectName: "Chronicle", level: "admin", levelWord: "Admin" },
      ],
      lastActive: "5 minutes ago",
      locked: true,
      actions: ["level", "override", "label", "reset", "unlock", "remove"],
    });
    expect(rows[1]).toMatchObject({ active: true, lastActive: "Active now", initials: "AA" });
    expect(rows[3]?.lastActive).toBe("3 hours ago");
  });

  it("read-only for everyone else", () => {
    const rows = memberRows(members, { admin: false, me: "p_vic", now: NOW });
    for (const r of rows) expect(r.actions).toEqual([]);
    expect(rows.find((r) => r.you)?.name).toBe("Vic Viewer");
  });

  it("says when someone was last active", () => {
    expect(lastActiveText(undefined, NOW)).toBe("Not yet");
    expect(lastActiveText("2026-09-28T11:59:40Z", NOW)).toBe("Just now");
    expect(lastActiveText("2026-09-26T12:00:00Z", NOW)).toBe("2 days ago");
    expect(lastActiveText("2026-07-01T12:00:00Z", NOW)).toBe("2026-07-01");
  });
});

describe("TEAM-27: the audit log's entries and export", () => {
  const names = {
    person: (p: string) => ({ p_ada: "Ada Admin", p_mo: "Mo Member" })[p],
    project: (id: string) => ({ proj_a: "Chronicle" })[id],
  };
  const row = (over: Partial<Parameters<typeof auditEntry>[0]>) => ({
    seq: 1,
    at: "2026-09-28T10:00:00.000Z",
    type: "member/level_changed",
    actor: "human",
    principal: "p_ada",
    payload: {},
    ...over,
  });

  it("covers every kind teams item 27 names", () => {
    expect(AUDIT_CATEGORIES.map((c) => c.id)).toEqual([
      "sign_in",
      "refusal",
      "lock",
      "level",
      "invite",
      "token",
      "password",
      "model",
      "configuration",
    ]);
    for (const t of [
      "session/started",
      "session/refused",
      "account/locked",
      "member/level_changed",
      "member/invited",
      "token/created",
      "password/reset_issued",
      "models/assigned",
      "config/changed_outside",
    ])
      expect(AUDIT_TYPES).toContain(t);
    expect(AUDIT_TYPES).not.toContain("session/active");
  });

  it("reads actor, action and target in words, from the public part only", () => {
    expect(
      auditEntry(row({ payload: { principal: "p_mo", level: "admin", project: "proj_a" } }), names),
    ).toEqual({
      seq: 1,
      at: "2026-09-28T10:00:00.000Z",
      type: "member/level_changed",
      category: "level",
      action: "Level changed to Admin",
      actor: { principal: "p_ada", name: "Ada Admin" },
      target: "Mo Member on Chronicle",
      targetPrincipal: "p_mo",
      project: "proj_a",
    });
    expect(
      auditEntry(
        row({
          type: "config/changed_outside",
          actor: "harness",
          principal: null,
          payload: { keys: ["sessions.idle_minutes", "team.mode"], state: {} },
        }),
        names,
      ),
    ).toMatchObject({
      action: "Configuration changed outside Sekhemet",
      actor: { name: "Sekhemet" },
      target: "sessions.idle_minutes, team.mode",
    });
    expect(
      auditEntry(
        row({
          type: "session/refused",
          principal: "p_mo",
          payload: { reason: "bad_credentials", count: 3 },
        }),
        names,
      )?.action,
    ).toBe("Sign-in refused 3 times: wrong password");
    expect(
      auditEntry(
        row({ type: "models/assigned", payload: { role: "worker", model: "tiel" } }),
        names,
      )?.action,
    ).toBe("Coding model set to tiel");
    expect(auditEntry(row({ type: "card/accepted" }), names)).toBeUndefined();
  });

  it("names an AI teammate with its badge and the person it works for", () => {
    const e = auditEntry(
      row({ actor: "worker", principal: null, onBehalfOf: "p_mo", type: "models/assigned" }),
      names,
    );
    expect(e?.actor).toEqual({
      name: "Agent",
      ai: true,
      onBehalfOf: { principal: "p_mo", name: "Mo Member" },
    });
    expect(auditActorText(e?.actor ?? { name: "" })).toBe("Agent (AI) on behalf of Mo Member");
  });

  it("exports CSV that a spreadsheet opens safely", () => {
    const e = auditEntry(
      row({ type: "member/label_changed", payload: { principal: "p_mo", label: '=cmd, "x"' } }),
      names,
    );
    const csv = auditCsv(e ? [e] : []);
    const [head, line] = csv.split("\r\n");
    expect(head).toBe("time,actor,on_behalf_of,action,target,project,event,seq");
    expect(line).toBe(
      '2026-09-28T10:00:00.000Z,Ada Admin,,"Profile label set to =cmd, ""x""",Mo Member,,member/label_changed,1',
    );
    // A cell that starts like a formula is quoted so a spreadsheet reads it as text.
    const f = auditEntry(
      row({ type: "member/label_changed", payload: { label: "=HYPERLINK()" } }),
      {
        person: () => "=HYPERLINK(evil)",
        project: () => undefined,
      },
    );
    expect(auditCsv(f ? [f] : [])).toContain("'=HYPERLINK(evil)");
  });

  it("is a module the page imports", () => {
    expect(UI_LIB_MODULES).toContain("team_admin.js");
  });
});

describe("DB-N9-10: the Agent status line at the foot of the sidebar", () => {
  it("says what the Agent is doing in one line", () => {
    expect(agentStatusLine({ running: [] })).toEqual({ text: "Agent idle", state: "idle" });
    expect(agentStatusLine({ running: [{ key: "CHR-12", step: 14, budget: 40 }] })).toEqual({
      text: "Agent working on CHR-12 · step 14 of 40",
      state: "working",
    });
    expect(agentStatusLine({ running: [{ key: "CHR-12" }, { key: "CHR-13" }] }).text).toBe(
      "Agent working on 2 issues",
    );
    expect(
      agentStatusLine({ running: [{ key: "CHR-12", step: 5 }], pausedForSeshat: { step: 5 } }),
    ).toEqual({ text: "Agent paused after step 5 while Seshat replies", state: "paused" });
  });
});

describe("B4.11 T6: health is the project lead's alone (TEAM-28, DB-N9-2)", () => {
  it("disables Set health for anyone but the lead, an Admin included, and names who can", () => {
    const where = { project: "proj_c", projectName: "Chronicle" };
    expect(levelNote({ mode: "team", level: "admin" }, "project.health", where)).toBe(
      "You're an Admin on Chronicle. The project lead or a Member who leads a release can set this project's health.",
    );
    expect(
      levelNote(
        { mode: "team", level: "member", projects: { proj_c: { lead: true } } },
        "project.health",
        where,
      ),
    ).toBeUndefined();
    // The target date is the lead's or an Admin's, as the project's settings are.
    expect(levelNote({ mode: "team", level: "admin" }, "release.target", where)).toBeUndefined();
    expect(levelNote({ mode: "team", level: "member" }, "release.target", where)).toBe(
      "You're a Member on Chronicle. An Admin or the project lead can set a release's target date.",
    );
    expect(levelNote({ mode: "solo" }, "project.health", where)).toBeUndefined();
  });
});

describe("close-out C3: a Member who leads a release may set health (teams item 28, DB-N9-2)", () => {
  const where = { project: "proj_c", projectName: "Chronicle" };
  it("leaves Set health enabled for a release's lead at Member, and names them in the note", () => {
    expect(
      levelNote(
        { mode: "team", level: "member", projects: { proj_c: { releaseLead: true } } },
        "project.health",
        where,
      ),
    ).toBeUndefined();
    expect(levelNote({ mode: "team", level: "member" }, "project.health", where)).toBe(
      "You're a Member on Chronicle. The project lead or a Member who leads a release can set this project's health.",
    );
    // Below Member, leading a release is not enough.
    expect(
      levelNote(
        {
          mode: "team",
          level: "member",
          projects: { proj_c: { level: "viewer", releaseLead: true } },
        },
        "project.health",
        where,
      ),
    ).toBe(
      "You're a Viewer on Chronicle. The project lead or a Member who leads a release can set this project's health.",
    );
  });

  it("names a release's lead: the project lead or an Admin", () => {
    expect(levelNote({ mode: "team", level: "member" }, "release.lead", where)).toBe(
      "You're a Member on Chronicle. An Admin or the project lead can name a release's lead.",
    );
    expect(
      levelNote(
        { mode: "team", level: "member", projects: { proj_c: { lead: true } } },
        "release.lead",
        where,
      ),
    ).toBeUndefined();
  });
});

describe("close-out C3: a release's lead is on the audit log (teams items 27, 28)", () => {
  const names = {
    person: (p: string) => ({ p_ada: "Ada Admin", p_mo: "Mo Member" })[p],
    project: (id: string) => ({ proj_a: "Chronicle" })[id],
    release: (project: string, id: string) =>
      project === "proj_a" && id === "SLICE-1" ? "Release 1" : undefined,
  };
  it("lists who named whom to lead which release, on which project", () => {
    expect(AUDIT_TYPES).toContain("release/lead_set");
    const base = {
      seq: 2,
      at: "2026-09-28T10:00:00.000Z",
      type: "release/lead_set",
      actor: "human",
      principal: "p_ada",
    };
    expect(
      auditEntry(
        { ...base, payload: { sliceId: "SLICE-1", projectId: "proj_a", lead: "p_mo" } },
        names,
      ),
    ).toMatchObject({
      category: "level",
      action: "Release lead named",
      actor: { principal: "p_ada", name: "Ada Admin" },
      target: "Mo Member for Release 1 on Chronicle",
      targetPrincipal: "p_mo",
      project: "proj_a",
    });
    expect(
      auditEntry({ ...base, payload: { sliceId: "SLICE-1", projectId: "proj_a" } }, names),
    ).toMatchObject({ action: "Release lead cleared", target: "Release 1 on Chronicle" });
  });

  it("names the release by its name, never its internal id (DEC-31)", () => {
    const row = {
      seq: 3,
      at: "2026-09-28T10:00:00.000Z",
      type: "release/lead_set",
      actor: "human",
      principal: "p_ada",
      payload: { sliceId: "SLICE-9", projectId: "proj_a", lead: "p_mo" },
    };
    // A release the names do not know (since removed): a release, not SLICE-9.
    const entry = auditEntry(row, names);
    expect(entry?.target).toBe("Mo Member for a release on Chronicle");
    expect(JSON.stringify(entry)).not.toContain("SLICE-9");
  });
});
