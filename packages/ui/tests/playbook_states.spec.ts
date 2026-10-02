import { describe, expect, it } from "vitest";
import {
  PLAYBOOK_COPY,
  learningMissing,
  playbookCrumb,
  playbookSectionNotes,
  profileHeadingNote,
  retireSentence,
  ruleReach,
  ruleRoleLabel,
} from "../src/playbook.js";
import { groupRules, strengthLabel } from "../src/pm.js";

// DB-N2-8, dashboard §2.11: the Playbook's and the profile's states,
// rendered from fixtures, give their specified text — including the page's
// state when GET /api/learning answers 404. The page modules (`playbook.js`,
// `learning_view.js`) render exactly these words.

const rule = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  role: "worker" as const,
  text: `Rule ${id}`,
  scope: {},
  status: "active" as const,
  helpful: 0,
  harmful: 0,
  value: 0,
  source: "send_back" as const,
  evidence: [],
  createdAt: "2026-09-20T00:00:00.000Z",
  ...over,
});

describe("the Playbook (§2.11)", () => {
  it("opens with the lede, once", () => {
    expect(PLAYBOOK_COPY.lede).toBe(
      "Learned from check results and what you do, never from a model grading itself. Everything stays on this machine and is recorded in the Activity log. A rule takes effect only after you approve it, and you can edit or retire any of them.",
    );
  });

  it("names each section with its count, and each empty section in words", () => {
    const g = groupRules([
      rule("a", { status: "candidate" }),
      rule("b"),
      rule("c"),
      rule("d", { status: "retired" }),
    ]);
    expect(playbookSectionNotes(g)).toEqual({
      candidates: "1 candidate",
      active:
        "2 · given to the Agent or Seshat when their scope matches · value rises with each helpful use and decays over time",
      retired: "1 retired",
    });
    expect(playbookCrumb("chronicle", g)).toBe("chronicle · 2 active · 1 awaiting approval");
    expect(playbookCrumb("", groupRules([]))).toBe("0 active · 0 awaiting approval");
    expect(PLAYBOOK_COPY.headings).toEqual({
      candidates: "Needs your approval",
      active: "Active",
      retired: "Retired",
    });
    expect(PLAYBOOK_COPY.empty).toEqual({
      candidates:
        "Nothing awaiting approval. New rules come from fixes that took the Agent several tries, your notes when you request changes, and Seshat's notes at the end of a run.",
      active: "No active rules.",
      retired: "None retired.",
    });
  });

  it("says who each rule is for, its reach, and when it is proposed for retirement", () => {
    expect(ruleRoleLabel("worker")).toBe("For the Agent");
    expect(ruleRoleLabel("manager")).toBe("For Seshat");
    expect(ruleReach("global")).toEqual({
      label: "All projects",
      title: "Lives in ~/.config/sekhemet and applies to every repository on this machine",
    });
    expect(ruleReach("project")).toEqual({
      label: "This project",
      title: "Applies to this project only",
    });
    expect(retireSentence({ helpful: 1, harmful: 4 })).toBe(
      "Proposed for retirement: used 4 times on failing first attempts, 1 on passing ones.",
    );
    expect(PLAYBOOK_COPY.seededReadOnly).toBe("Edit in playbook.toml");
    expect(PLAYBOOK_COPY.approve).toEqual({
      heading: "Approve for",
      project: { label: "This project", detail: "Only this repository's issues" },
      global: { label: "All projects", detail: "Every repository on this machine" },
      footer:
        "All-projects rules live in ~/.config/sekhemet and apply to every repository on this machine.",
    });
  });

  it("keeps the seeded rules under a banner saying to update Sekhemet when the server has no learning", () => {
    expect(learningMissing(404)).toEqual({
      title: "Learning isn't on this server yet.",
      detail:
        "Update Sekhemet and restart it. Below are the seeded rules and the suggestions from your notes; approvals, counts and the project rules Seshat follows arrive with the update.",
    });
    expect(learningMissing(500)).toEqual({
      title: "Couldn't load what Sekhemet has learned.",
      detail: "The server returned 500. Showing the playbook file instead.",
    });
    expect(learningMissing(0).detail).toBe(
      "The server returned no response. Showing the playbook file instead.",
    );
  });
});

describe("Project rules Seshat follows (§2.11)", () => {
  it("has its heading, lock line and empty state", () => {
    expect(PLAYBOOK_COPY.profile.heading).toBe("Project rules Seshat follows");
    expect(profileHeadingNote(1)).toBe("1 statement Seshat reads when it answers you");
    expect(profileHeadingNote(3)).toBe("3 statements Seshat reads when it answers you");
    expect(PLAYBOOK_COPY.profile.lock).toBe(
      "These stay on this machine, in the project's Activity log. Edit a statement to correct it; dismiss it and Seshat stops using it.",
    );
    expect(PLAYBOOK_COPY.profile.empty).toBe(
      "Nothing yet. Seshat learns from your notes when you request changes, the proposals you apply or discard, and the fields you change after it sets them. Statements appear here after a run.",
    );
    expect(PLAYBOOK_COPY.profile.dismissed(2)).toBe("2 dismissed");
  });

  it("words each statement's strength: Strong from 0.7, Moderate from 0.4, else Weak", () => {
    expect([0.9, 0.7, 0.69, 0.4, 0.39, 0.1].map(strengthLabel)).toEqual([
      "Strong",
      "Strong",
      "Moderate",
      "Moderate",
      "Weak",
      "Weak",
    ]);
  });
});
