import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG_SOURCE_LABELS,
  DENSITY_CHOICES,
  QUEUE_CAP_REFUSED,
  REVIEW_MINUTES_REFUSED,
  configRows,
  queueCapInput,
  queueCapView,
  readDensity,
  reviewCapacityView,
  reviewMinutesInput,
} from "../src/settings.js";

/**
 * Dashboard NEW-dashboard-4, the page half: Configuration's Preferences
 * (theme, density, Tips and the first-run role), Review capacity and
 * Project configuration with each value's source (DB-N4-1..3).
 */

const web = (f: string) => readFileSync(join(import.meta.dirname, "..", "web", f), "utf8");

describe("Preferences (DB-N4-1)", () => {
  it("offers both densities, compact by default, from this browser's storage", () => {
    expect(DENSITY_CHOICES.map((c) => [c.value, c.label])).toEqual([
      ["compact", "Compact"],
      ["comfortable", "Comfortable"],
    ]);
    const store = (v: string | null) => ({ getItem: () => v });
    expect(readDensity(store("comfortable"))).toBe("comfortable");
    expect(readDensity(store(null))).toBe("compact");
    // Negative cases: an unknown value, and storage that throws.
    expect(readDensity(store("spacious"))).toBe("compact");
    expect(
      readDensity({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe("compact");
  });

  it("the Preferences section renders theme, density, Tips and the first-run role", () => {
    const src = web("configuration.js");
    for (const attr of [
      "data-theme-select",
      "data-density-select",
      "data-tips-select",
      "data-role-select",
    ])
      expect(src).toContain(attr);
    // Density is the same setting the palette toggles and boot.js reads.
    expect(src).toContain("setDensity(");
    expect(web("palette.js")).toContain("sekhemet-density");
  });
});

describe("Review capacity (DB-N4-2, DB-N4-3)", () => {
  it("shows the minutes and the In review limit they give", () => {
    expect(
      reviewCapacityView({ project: "p", minutesPerDay: 60, reviewWip: 4, allowed: true }),
    ).toEqual({
      value: "60",
      limitText: "In review holds at most 4 issues at 60 minutes a day.",
      disabled: false,
      reason: "",
    });
    expect(
      reviewCapacityView({ project: "p", minutesPerDay: 15, reviewWip: 1, allowed: true })
        .limitText,
    ).toBe("In review holds at most 1 issue at 15 minutes a day.");
  });

  it("disables the field for a person without the permission, with the reason beside it", () => {
    const reason =
      "You're a Member on Atlas. An Admin or a person this project's Accept rule names can change review capacity.";
    expect(
      reviewCapacityView({ project: "p", minutesPerDay: 60, reviewWip: 4, allowed: false, reason }),
    ).toMatchObject({ disabled: true, reason });
    // With no reason given, it still says why.
    expect(reviewCapacityView({ project: "p", minutesPerDay: 60, allowed: false }).reason).toBe(
      "You can't change this project's review capacity.",
    );
  });

  it("refuses 0 or less beside the field and keeps the previous value", () => {
    expect(reviewMinutesInput("90", 60)).toEqual({ ok: true, value: 90 });
    for (const bad of ["0", "-5", "", "abc", "   "]) {
      expect(reviewMinutesInput(bad, 60)).toEqual({
        ok: false,
        value: 60,
        error: REVIEW_MINUTES_REFUSED,
      });
    }
    expect(REVIEW_MINUTES_REFUSED).toBe("Review minutes per day must be more than 0.");
  });
});

describe("Project configuration: each value's source (DB-N4-1)", () => {
  const config = {
    machine: { tier: "auto", reservedHours: "09:00-17:00" },
    network: { mode: "offline" },
    team: { mode: "solo" },
    review: { reviewMinutesPerDay: 60 },
  };

  it("names every value and where it came from", () => {
    const rows = configRows(config, {
      "machine.reserved_hours": "project",
      "network.mode": "user",
    });
    expect(rows.map((r) => [r.label, r.value, r.source])).toEqual([
      ["Reserved hours", "09:00-17:00", "This project (.sekhemet/config.toml)"],
      ["Overnight hours", "The hours outside the reserved hours", "Default"],
      ["Network", "Offline", "Your configuration (~/.sekhemet/config.toml)"],
      ["Setup", "Solo", "Default"],
      ["Review minutes per day (new projects)", "60", "Default"],
    ]);
  });

  it("labels every layer in words, and an unknown one by its name", () => {
    expect(Object.keys(CONFIG_SOURCE_LABELS)).toEqual([
      "defaults",
      "user",
      "project",
      "card",
      "cli",
    ]);
    const rows = configRows(
      { ...config, machine: { tier: "M", reservedHours: "", overnightHours: "22:00-06:00" } },
      { "machine.tier": "cli", "machine.overnight_hours": "mystery" },
    );
    expect(rows[1]).toMatchObject({ value: "22:00-06:00", source: "Mystery" });
    expect(rows.map((r) => r.key)).not.toContain("machine.tier");
    const cli = configRows(config, { "network.mode": "cli" });
    expect(cli[2]).toMatchObject({ label: "Network", source: "The command line" });
  });
});

describe("TEAM-30, dashboard §2.16: the per-person Agent cap in Configuration", () => {
  it("shows the cap in force with its source, editable by an Admin", () => {
    const v = queueCapView(
      { queue: { agentIssuesPerPerson: 2 } },
      { "queue.agent_issues_per_person": "user" },
      "",
    );
    expect(v).toEqual({
      value: "2",
      source: "Your configuration (~/.sekhemet/config.toml)",
      disabled: false,
      note: "How many Agent issues one person may have running at once. At the limit, their next issue waits and other people's issues go first.",
    });
    expect(queueCapView({}, {}, "").value).toBe("1");
    expect(queueCapView({}, {}, "").source).toBe("Default");
  });

  it("is read-only below Admin, with the level note beside it", () => {
    const ro = "Read-only. You're a Member in this workspace. An Admin can set the queue's caps.";
    const v = queueCapView({ queue: { agentIssuesPerPerson: 1 } }, {}, ro);
    expect(v.disabled).toBe(true);
    expect(v.note).toContain(ro);
  });

  it("takes a whole number of 1 or more, and keeps the previous value otherwise", () => {
    expect(queueCapInput("3", 1)).toEqual({ ok: true, value: 3 });
    for (const raw of ["0", "-1", "1.5", "two", ""]) {
      expect(queueCapInput(raw, 2)).toEqual({ ok: false, value: 2, error: QUEUE_CAP_REFUSED });
    }
    expect(QUEUE_CAP_REFUSED).toBe("Agent issues per person is a whole number, 1 or more.");
  });

  it("the page renders it in Project configuration, marked with the permission it needs", () => {
    const js = web("configuration.js");
    expect(js).toContain("data-queue-form");
    expect(js).toContain('levelNote(getSession(), "queue.caps")');
    expect(js).toContain('sendJSON("PUT", "/api/config/queue"');
  });
});
