import { type MachineProfile, TIER_PROFILES, hostFingerprintHash } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { activeHardwareTier } from "../src/dashboard_api.js";

// Dashboard DB-N2-9: Machine shows the active hardware tier — the one this
// machine's calibration decided, else the one its installed memory gives —
// and what that tier decides (models M14, MD-N1-1).

const GB = 1024 ** 3;

function profile(settings: Partial<NonNullable<MachineProfile["settings"]>>): MachineProfile {
  return {
    version: 1,
    date: "2026-09-26T00:00:00.000Z",
    fingerprint: {
      platform: "darwin",
      arch: "arm64",
      cpuModel: "Apple M4",
      cpuCount: 10,
      totalBytes: 24 * GB,
    },
    fingerprintHash: hostFingerprintHash(),
    usableBytes: 16 * GB,
    tier: "M",
    settings: {
      tier: "M",
      workingContextTokens: 16_384,
      parallelCards: 1,
      coLoadRoles: false,
      reason: "tier M",
      installedBytes: 24 * GB,
      ...settings,
    },
    models: {},
  } as MachineProfile;
}

describe("activeHardwareTier", () => {
  it("reads the calibrated tier and what it decides", () => {
    expect(activeHardwareTier(24 * GB, profile({}))).toEqual({
      tier: "M",
      source: "calibrated",
      budgetGb: [24, 48],
      installedBytes: 24 * GB,
      workingContextTokens: 16_384,
      parallelCards: 1,
      coLoadRoles: false,
    });
  });

  it("falls back to the installed memory's tier on a machine not calibrated yet", () => {
    expect(activeHardwareTier(24 * GB, undefined)).toEqual({
      tier: "M",
      source: "installed",
      budgetGb: [24, 48],
      installedBytes: 24 * GB,
    });
    expect(activeHardwareTier(128 * GB, undefined)).toMatchObject({
      tier: "XL",
      budgetGb: [96, null],
    });
    expect(TIER_PROFILES.S.budgetGb).toEqual([16, 24]);
  });

  it("says a machine below 16 GB is unsupported, never a tier", () => {
    const t = activeHardwareTier(8 * GB, undefined);
    expect(t.tier).toBeUndefined();
    expect(t.unsupported).toMatch(/below the 16 GB minimum/);
  });
});
