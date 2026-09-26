import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type MachineProfile,
  ManagedLlamaServerAdapter,
  ModelRoster,
  type UnloadableAdapter,
  calibrateHardware,
  hardwareFingerprint,
  hostFingerprintHash,
  loadHostMachineProfile,
  p99Tokens,
  saveMachineProfile,
  tierForInstalled,
  tierSettingsFor,
} from "../src/index.js";

const GB = 1024 ** 3;
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sek-n1-"));
  dirs.push(d);
  return d;
}

const fast: UnloadableAdapter = {
  modelId: "m",
  supportedArms: ["arm_a_flat"],
  generate: async () => ({
    text: "ok",
    toolCalls: [],
    usage: {
      promptTokens: 2048,
      completionTokens: 64,
      durationMs: 1000,
      prefillTokensPerSecond: 400,
      decodeTokensPerSecond: 30,
    },
  }),
};

describe("NEW-models-1: the reference host's tier and window", () => {
  it("MD-N1-1: a machine with 24 GB installed is tier M, whatever its usable share", () => {
    expect(tierForInstalled(24 * GB).tier).toBe("M");
    expect(tierForInstalled(16 * GB).tier).toBe("S");
    expect(tierForInstalled(64 * GB).tier).toBe("L");
    expect(tierForInstalled(128 * GB).tier).toBe("XL");
    // The 24 GB M4: two thirds usable (16 GB) no longer drops it to tier S.
    const reference = tierSettingsFor(16 * GB, { installedBytes: 24 * GB });
    expect(reference).toMatchObject({ tier: "M", workingContextTokens: 16_384, parallelCards: 1 });
    expect(reference.coLoadRoles).toBe(false);
    expect(reference.installedBytes).toBe(24 * GB);
  });

  it("MD-N1-1: calibration classifies by the installed memory it is given", async () => {
    const profile = await calibrateHardware({
      candidates: [{ label: "m", adapter: fast }],
      usableBytes: 16 * GB,
      installedBytes: 24 * GB,
      buckets: [2048],
      memoryBandwidthGbPerSecond: 120,
      path: join(tmp(), "machine.json"),
    });
    expect(profile.tier).toBe("M");
    expect(profile.settings?.workingContextTokens).toBe(16_384);
  });

  it("MD-N1-1: a profile saved under the old usable-memory tier is reclassified on read", () => {
    const fp = { ...hardwareFingerprint(), totalBytes: 24 * GB };
    const old: MachineProfile = {
      version: 1,
      date: "2026-09-19T00:00:00Z",
      fingerprint: fp,
      fingerprintHash: hostFingerprintHash(),
      usableBytes: 16 * GB,
      tier: "S",
      // What the old classification saved: tier S, 12k.
      settings: {
        tier: "S",
        workingContextTokens: 12_288,
        parallelCards: 1,
        coLoadRoles: false,
        reason: "old",
      },
      models: {},
    };
    const roster = new ModelRoster({
      machineProfile: old,
      managed: {
        "cyber-tiel": () =>
          new ManagedLlamaServerAdapter({
            modelId: "w",
            modelPath: "/w.gguf",
            contextTokens: 16_384,
          }),
      },
    });
    expect(roster.tierSettings()?.tier).toBe("M");
    const args = (roster.resolve("cyber-tiel", "worker") as ManagedLlamaServerAdapter).launchArgs();
    expect(args[args.indexOf("-c") + 1]).toBe("16384");
  });

  it("MD-N1-2: never sets the working context below the p99 prompt plus the answer and thinking caps", () => {
    const sizes = [...Array.from({ length: 99 }, () => 9_000), 15_000];
    expect(p99Tokens(sizes)).toBe(9_000);
    expect(p99Tokens([...sizes, 15_000])).toBe(15_000);
    expect(p99Tokens([])).toBeUndefined();
    // Tier S on a 16 GB machine would give 12,288; the prompts need 14,000.
    const kept = tierSettingsFor(11 * GB, {
      installedBytes: 16 * GB,
      promptNeed: { p99PromptTokens: 10_928, answerTokens: 2_048, thinkingTokens: 1_024 },
    });
    expect(kept.workingContextTokens).toBe(14_000);
    expect(kept.reason).toMatch(/kept 14000 tokens/);
    expect(kept.reason).toMatch(/p99 of the Worker's recorded prompts \(10928\)/);
    expect(kept.promptNeedTokens).toBe(14_000);
    // A need the tier already covers changes nothing.
    const covered = tierSettingsFor(11 * GB, {
      installedBytes: 16 * GB,
      promptNeed: { p99PromptTokens: 6_000, answerTokens: 2_048, thinkingTokens: 1_024 },
    });
    expect(covered.workingContextTokens).toBe(12_288);
    expect(covered.reason).not.toMatch(/kept/);
  });

  it("MD-N1-3: the profile is read on the host whose fingerprint it carries, and not elsewhere", () => {
    const path = join(tmp(), "machine.json");
    const base: MachineProfile = {
      version: 1,
      date: "2026-09-19T00:00:00Z",
      fingerprint: hardwareFingerprint(),
      fingerprintHash: hostFingerprintHash(),
      usableBytes: 16 * GB,
      tier: "M",
      models: {},
    };
    saveMachineProfile(base, path);
    expect(loadHostMachineProfile(path)?.fingerprintHash).toBe(hostFingerprintHash());
    saveMachineProfile({ ...base, fingerprintHash: "another-host" }, path);
    expect(loadHostMachineProfile(path)).toBeUndefined();
  });
});
