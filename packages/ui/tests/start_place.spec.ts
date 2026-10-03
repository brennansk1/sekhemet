import { describe, expect, it } from "vitest";
import { START_COPY, startPlaceView } from "../src/start.js";

/**
 * design-stage §2.11 item 6, NEW-design-stage-8 (DS-N8-1..3) and dashboard
 * DB-N26-1 (DEC-57): the start page's place bar, as a pure model. In a
 * workspace that already holds projects it names the folder approval creates
 * and lets the person change it; a folder that cannot take the project is
 * said before any approval, with *Open it* for one of this workspace's
 * projects; *Add an existing repository* is always offered; and a person who
 * may not create a project is told the plan goes for approval.
 */
describe("the start page's place (DS-N8-1, DS-N8-3, DB-N26-1)", () => {
  it("names the folder the approval creates, with Change folder, and Add an existing repository", () => {
    const v = startPlaceView({
      newFolder: true,
      folder: "/Users/ada/Sekhemet/projects/chronicle",
      shown: "~/Sekhemet/projects/chronicle",
      mayCreate: true,
    });
    expect(v.folderLine).toBe("Will be created in ~/Sekhemet/projects/chronicle");
    expect(v.changeFolder).toBe(START_COPY.changeFolder);
    expect(v.addRepository).toBe("Add an existing repository");
    expect(v.refusal).toBeNull();
    expect(v.blocksApproval).toBe(false);
    expect(v.approvalNote).toBeNull();
  });

  it("in a workspace with no project, names no folder: the server's folder takes it", () => {
    const v = startPlaceView({ newFolder: false, mayCreate: true });
    expect(v.folderLine).toBeNull();
    expect(v.changeFolder).toBeNull();
    expect(v.addRepository).toBe("Add an existing repository");
  });

  it("says a refused folder before approval, offering Open it for this workspace's project only", () => {
    const here = startPlaceView({
      newFolder: true,
      folder: "/w/alpha",
      shown: "/w/alpha",
      mayCreate: true,
      refusal: {
        kind: "has_project",
        reason: "This folder already holds the project Alpha, in the workspace Northwind.",
        project: { id: "proj_a", name: "Alpha", workspace: "Northwind", here: true },
      },
    });
    expect(here.refusal).toEqual({
      text: "This folder already holds the project Alpha, in the workspace Northwind.",
      openIt: { label: "Open it", project: "proj_a" },
      addInstead: false,
    });
    expect(here.blocksApproval).toBe(true);
    const other = startPlaceView({
      newFolder: true,
      folder: "/w/payroll",
      mayCreate: true,
      refusal: {
        kind: "has_project",
        reason: "This folder already holds the project Payroll, in the workspace Ledger.",
        project: { name: "Payroll", workspace: "Ledger", here: false },
      },
    });
    expect(other.refusal?.openIt).toBeNull();
    // A folder with code is offered the take-over instead.
    const code = startPlaceView({
      newFolder: true,
      folder: "/w/legacy",
      mayCreate: true,
      refusal: { kind: "has_code", reason: "/w/legacy already holds code…" },
    });
    expect(code.refusal?.addInstead).toBe(true);
  });

  it("TEAM-57: tells a person who may not create a project that the plan goes for approval", () => {
    const v = startPlaceView({ newFolder: true, folder: "/w/x", mayCreate: false });
    expect(v.approvalNote).toBe(
      "An Admin or a project lead approves a new project: Review plan ends in Send for approval.",
    );
  });
});
