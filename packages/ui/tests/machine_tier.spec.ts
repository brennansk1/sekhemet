import { describe, expect, it } from "vitest";
import { hardwareTierView } from "../src/machine_tier.js";

// Dashboard DB-N2-9, the page: Machine names the active hardware tier and
// what it decides for this machine, in words (models M14).

const GB = 1024 ** 3;

describe("hardwareTierView", () => {
  it("a calibrated machine: the tier, its range and what it decides", () => {
    expect(
      hardwareTierView({
        tier: "M",
        source: "calibrated",
        budgetGb: [24, 48],
        installedBytes: 24 * GB,
        workingContextTokens: 16_384,
        parallelCards: 1,
        coLoadRoles: false,
      }),
    ).toEqual({
      heading: "Tier M",
      range: "24 to 48 GB of memory",
      lines: [
        "Measured on this machine.",
        "Up to 16,384 tokens of working context, and 1 issue at a time.",
        "The models take turns in memory: one is loaded at a time.",
      ],
    });
  });

  it("a machine not calibrated yet: the tier its installed memory gives", () => {
    expect(
      hardwareTierView({
        tier: "XL",
        source: "installed",
        budgetGb: [96, null],
        installedBytes: 128 * GB,
      }),
    ).toEqual({
      heading: "Tier XL",
      range: "96 GB of memory or more",
      lines: ["From this machine's 128 GB of installed memory; not measured on it yet."],
    });
  });

  it("two issues at once, and co-loaded models, read as such", () => {
    const v = hardwareTierView({
      tier: "L",
      source: "calibrated",
      budgetGb: [48, 96],
      installedBytes: 64 * GB,
      workingContextTokens: 32_768,
      parallelCards: 2,
      coLoadRoles: true,
    });
    expect(v.lines.slice(1)).toEqual([
      "Up to 32,768 tokens of working context, and 2 issues at a time.",
      "The models can stay loaded together.",
    ]);
  });

  it("an unsupported machine, and an absent answer (a server from before the tier)", () => {
    expect(
      hardwareTierView({
        source: "installed",
        installedBytes: 8 * GB,
        unsupported:
          "8.0 GB of installed memory is below the 16 GB minimum; Sekhemet does not run cards here.",
      }),
    ).toEqual({
      heading: "Below the minimum",
      range: "",
      lines: [
        "8.0 GB of installed memory is below the 16 GB minimum; Sekhemet does not run issues here.",
      ],
    });
    expect(hardwareTierView(undefined)).toBeUndefined();
  });
});
