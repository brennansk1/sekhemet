import { describe, expect, it } from "vitest";
import { sliceReleaseVersion } from "../src/project_done.js";

// review-git RG-N4-1 and planner-pm PM-P13-13: a slice's release takes the
// version its squashes give, never at or below one already proposed in the
// project, and SemVer's rules hold on that path too — a breaking change
// bumps minor while the version is 0.y.z (1.0 is a person's decision), and
// a prerelease comes before its release (DEC-44: the semver library).

describe("RG-N4-1: a slice's release version", () => {
  it("takes the planned version when nothing at or above it was proposed", () => {
    expect(sliceReleaseVersion({ nextVersion: "v0.2.0", bump: "minor" }, [])).toBe("0.2.0");
    expect(sliceReleaseVersion({ nextVersion: "v0.2.0", bump: "minor" }, ["0.1.0"])).toBe("0.2.0");
  });

  it("bumps minor past a proposed 0.y.z for a breaking change, never to 1.0.0", () => {
    expect(sliceReleaseVersion({ nextVersion: "v0.3.0", bump: "major" }, ["0.3.0"])).toBe("0.4.0");
    expect(sliceReleaseVersion({ nextVersion: "v0.1.0", bump: "none" }, ["0.1.0"])).toBe("0.1.1");
  });

  it("orders proposals by SemVer precedence: 0.10.0 after 0.9.0, a prerelease before its release", () => {
    expect(sliceReleaseVersion({ nextVersion: "v0.2.0", bump: "minor" }, ["0.10.0", "0.9.0"])).toBe(
      "0.11.0",
    );
    expect(sliceReleaseVersion({ nextVersion: "v0.3.0", bump: "minor" }, ["0.3.0-rc.1"])).toBe(
      "0.3.0",
    );
  });
});
