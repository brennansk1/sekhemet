import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CO_RESIDENT_MIN_BYTES,
  type MachineProfile,
  ManagedLlamaServerAdapter,
  ModelRoster,
  ModelRouter,
  type SweepPoint,
  type UnloadableAdapter,
  calibrateHardware,
  hardwareFingerprint,
  hostFingerprintHash,
  measureMemoryBandwidth,
  measureUsableMemory,
  oneStepBackFromCliff,
  sweepLaunchSettings,
  tierSettingsFor,
} from "../src/index.js";

const GB = 1024 ** 3;
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sek-tier-"));
  dirs.push(d);
  return d;
}

const speed = (prefill: number | undefined) => ({
  prefillTokensPerSecond: prefill,
  decodeTokensPerSecond: 30,
});

describe("M13: the machine is measured, not assumed", () => {
  it("reads what the GPU may actually wire down on Apple Silicon", () => {
    // An explicit iogpu limit is the user's own answer.
    expect(
      measureUsableMemory({ platform: "darwin", totalBytes: 24 * GB, sysctl: () => "20480" }),
    ).toMatchObject({ usableBytes: 20 * 1024 * 1024 * 1024 });
    // The default on the 24 GB reference machine is about 16 GB, not 20.
    const auto = measureUsableMemory({
      platform: "darwin",
      totalBytes: 24 * GB,
      sysctl: () => "0",
    });
    expect(auto.usableBytes / GB).toBeCloseTo(16, 0);
    expect(auto.source).toMatch(/wired limit/);
    // A big machine gets the larger share.
    expect(
      measureUsableMemory({ platform: "darwin", totalBytes: 128 * GB, sysctl: () => "0" })
        .usableBytes / GB,
    ).toBeCloseTo(96, 0);
  });

  it("uses what the kernel reports available on Linux, and falls back elsewhere", () => {
    expect(
      measureUsableMemory({
        platform: "linux",
        totalBytes: 64 * GB,
        readMeminfo: () => "MemTotal: 67108864 kB\nMemAvailable: 41943040 kB\n",
      }),
    ).toMatchObject({ usableBytes: 41943040 * 1024, source: "/proc/meminfo MemAvailable" });
    expect(
      measureUsableMemory({ platform: "win32", totalBytes: 16 * GB }).usableBytes / GB,
    ).toBeCloseTo(12, 0);
  });

  it("measures a memory bandwidth in a plausible range for a real machine", () => {
    const gbps = measureMemoryBandwidth({ bytes: 8 * 1024 * 1024, passes: 2 });
    expect(gbps).toBeGreaterThan(0);
    expect(gbps).toBeLessThan(10_000);
  });
});

describe("M13: the prefill batch and offload sweep", () => {
  it("keeps the setting one step back from the cliff", async () => {
    const points: SweepPoint[] = [];
    const choice = await sweepLaunchSettings({
      candidates: [512, 1024, 2048, 4096].map((batchTokens) => ({ batchTokens, gpuLayers: 99 })),
      probe: async (c) => {
        // 4096 is where this host starts paging.
        const result =
          c.batchTokens >= 4096
            ? { speed: speed(undefined), hitCliff: true }
            : { speed: speed(100 + c.batchTokens / 10) };
        points.push({ ...c, ...result });
        return result;
      },
    });
    expect(choice).toMatchObject({ batchTokens: 2048, gpuLayers: 99 });
    expect(choice.reason).toMatch(/one step back/);
    // Nothing past the cliff is measured.
    expect(points.map((p) => p.batchTokens)).toEqual([512, 1024, 2048, 4096]);
  });

  it("treats a throughput collapse as the cliff, and takes the largest when there is none", () => {
    const at = (batchTokens: number, prefill: number | undefined, hitCliff?: boolean) => ({
      batchTokens,
      gpuLayers: 99,
      speed: speed(prefill),
      ...(hitCliff ? { hitCliff } : {}),
    });
    // 4096 runs, but at half the speed: the host is paging to pretend it fits.
    expect(oneStepBackFromCliff([at(1024, 200), at(2048, 260), at(4096, 120)])).toMatchObject({
      batchTokens: 2048,
    });
    expect(oneStepBackFromCliff([at(1024, 200), at(2048, 260)])).toMatchObject({
      batchTokens: 2048,
      reason: expect.stringMatching(/no cliff/),
    });
  });
});

describe("M14: the tier's numbers are derived and then applied", () => {
  it("places a machine inside its tier's range and never co-loads below 32 GB", () => {
    // The 24 GB M4: 16 GB usable is the bottom of tier S.
    const reference = tierSettingsFor(16 * GB);
    expect(reference).toMatchObject({ tier: "S", workingContextTokens: 12_288, parallelCards: 1 });
    expect(reference.coLoadRoles).toBe(false);
    // High in the band buys the top of the range.
    expect(tierSettingsFor(23 * GB).workingContextTokens).toBe(16_384);
    // Tier L co-loads, and only above the co-residency floor.
    expect(tierSettingsFor(64 * GB).coLoadRoles).toBe(true);
    expect(CO_RESIDENT_MIN_BYTES).toBe(32 * GB);
    // A slow bus keeps the second card away even on a big machine.
    expect(tierSettingsFor(90 * GB, { memoryBandwidthGbPerSecond: 20 }).parallelCards).toBeLessThan(
      tierSettingsFor(90 * GB, { memoryBandwidthGbPerSecond: 400 }).parallelCards,
    );
  });

  it("calibration records the tier's settings alongside the measurements", async () => {
    const adapter: UnloadableAdapter = {
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
    const profile = await calibrateHardware({
      candidates: [{ label: "m", adapter }],
      usableBytes: 16 * GB,
      buckets: [2048],
      memoryBandwidthGbPerSecond: 120,
      path: join(tmp(), "machine.json"),
    });
    expect(profile.settings).toMatchObject({
      tier: "S",
      workingContextTokens: 12_288,
      parallelCards: 1,
      coLoadRoles: false,
    });
    expect(profile.memoryBandwidthGbPerSecond).toBe(120);
  });

  it("holds a managed server to the tier's working context and the swept batch", () => {
    const calibrated = (over: Partial<MachineProfile> = {}): MachineProfile => ({
      version: 1,
      date: "2026-09-19T00:00:00Z",
      fingerprint: hardwareFingerprint(),
      fingerprintHash: hostFingerprintHash(),
      usableBytes: 16 * GB,
      tier: "S",
      settings: tierSettingsFor(16 * GB),
      models: {},
      ...over,
    });
    const args = (profile: MachineProfile | null) =>
      (
        new ModelRoster({
          machineProfile: profile,
          managed: {
            "cyber-tiel": () =>
              new ManagedLlamaServerAdapter({
                modelId: "w",
                modelPath: "/w.gguf",
                contextTokens: 16_384,
              }),
          },
        }).resolve("cyber-tiel", "worker") as ManagedLlamaServerAdapter
      ).launchArgs();
    const flag = (a: string[], name: string) => a[a.indexOf(name) + 1];

    // Tier S at 16 GB: 12k of working context, not the profile's 16k.
    expect(flag(args(calibrated()), "-c")).toBe("12288");
    expect(
      flag(
        args(calibrated({ launch: { batchTokens: 1024, gpuLayers: 40, reason: "r", points: [] } })),
        "-b",
      ),
    ).toBe("1024");
    expect(
      flag(
        args(calibrated({ launch: { batchTokens: 1024, gpuLayers: 40, reason: "r", points: [] } })),
        "-ngl",
      ),
    ).toBe("40");
    // An uncalibrated machine keeps the model profile's own numbers.
    expect(flag(args(null), "-c")).toBe("16384");
  });

  it("swaps roles instead of co-loading them below the co-residency floor", async () => {
    const fake = (id: string, bytes: number): UnloadableAdapter => ({
      modelId: id,
      supportedArms: [],
      generate: async () => ({
        text: "",
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, durationMs: 0 },
      }),
      unload: async () => undefined,
      confirmUnloaded: async () => true,
      footprintBytes: async () => bytes,
    });
    const build = (tier: ReturnType<typeof tierSettingsFor> | null) =>
      new ModelRouter(
        { worker: () => fake("w", 5 * GB), manager: () => fake("m", 5 * GB) },
        { tier, pressureLevel: () => 1, headroomWaitMs: 0, healthCheck: false },
      );
    // Two 5 GB models would both fit the raw budget; the tier says they swap.
    const swapping = build(tierSettingsFor(16 * GB));
    expect((await swapping.calibrate(24 * GB)).resident).toEqual(["worker"]);
    await swapping.use("worker");
    await swapping.use("manager");
    expect(swapping.swapCount).toBe(1);

    const roomy = build(tierSettingsFor(64 * GB));
    expect((await roomy.calibrate(80 * GB)).resident).toEqual(["worker", "manager"]);
    await roomy.use("worker");
    await roomy.use("manager");
    expect(roomy.swapCount).toBe(0);
  });
});
