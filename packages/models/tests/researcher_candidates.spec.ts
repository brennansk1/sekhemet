import { describe, expect, it } from "vitest";
import {
  MANAGED_MODEL_FILES,
  MODEL_SOURCES,
  RESEARCHER_CANDIDATES,
  createApodexResearcher,
  createNeoHorseResearcher,
  createSparkResearcher,
  llamaBuildNumber,
  managedModelWeights,
} from "../src/index.js";

// Models NEW-models-11 (MD-N11-1, MD-N11-3): the Researcher bake-off's two
// candidates as managed llama-server profiles beside the incumbent. Building
// a profile starts no server; their download sources are unverified, so no
// source is recorded and nothing is fetched.

const arg = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("the Researcher candidates' profiles (MD-N11-1)", () => {
  it("Spark-X2.5-4B: its own port, thinking off at the server, two slots of 32k, and the llama.cpp build it needs", () => {
    const spark = createSparkResearcher("/m/spark.gguf", "/bin/llama-server");
    const args = spark.launchArgs();
    expect(spark.modelId).toBe("spark-x2.5-4b");
    expect(arg(args, "-m")).toBe("/m/spark.gguf");
    expect(arg(args, "--port")).toBe("8102");
    expect(arg(args, "-np")).toBe("2");
    expect(arg(args, "-c")).toBe(String(2 * 32768));
    expect(arg(args, "--reasoning")).toBe("off");
    expect(spark.contextWindow?.contextTokens).toBe(32768);
    const row = RESEARCHER_CANDIDATES.find((c) => c.modelId === "spark-x2.5-4b");
    expect(row?.minLlamaBuild).toBe(10828);
  });

  it("NeoHorse-1-4B: its own port, thinking off at the server, two slots of 32k", () => {
    const horse = createNeoHorseResearcher("/m/horse.gguf", "/bin/llama-server");
    const args = horse.launchArgs();
    expect(horse.modelId).toBe("neohorse-1-4b");
    expect(arg(args, "--port")).toBe("8103");
    expect(arg(args, "-c")).toBe(String(2 * 32768));
    expect(arg(args, "--reasoning")).toBe("off");
  });

  it("lists the incumbent and both candidates, each on a port of its own", () => {
    const ids = RESEARCHER_CANDIDATES.map((c) => c.modelId);
    expect(ids).toEqual(["apodex-1.1-mini", "spark-x2.5-4b", "neohorse-1-4b"]);
    const ports = RESEARCHER_CANDIDATES.map((c) => c.create("/m/x.gguf").launchProfile.port);
    expect(new Set(ports).size).toBe(3);
    for (const c of RESEARCHER_CANDIDATES) expect(c.file).toMatch(/\.gguf$/);
  });

  it("records no download source for either candidate: their sources are unverified, so nothing fetches them", () => {
    for (const id of ["spark-x2.5-4b", "neohorse-1-4b"]) expect(MODEL_SOURCES[id]).toBeUndefined();
    // Nor are they managed defaults the weights check expects on every host.
    expect(Object.values(MANAGED_MODEL_FILES).some((f) => /spark|neohorse/i.test(f))).toBe(false);
    expect(managedModelWeights({ modelsDir: "/m" }).map((w) => w.modelId)).not.toContain(
      "spark-x2.5-4b",
    );
  });

  it("MD-N11-3: keeps the Apodex profile, the incumbent, until an adoption is recorded", () => {
    expect(createApodexResearcher("/m/a.gguf").modelId).toBe("apodex-1.1-mini");
    expect(managedModelWeights({ modelsDir: "/m" }).map((w) => w.modelId)).toContain(
      "apodex-1.1-mini",
    );
  });

  it("reads llama.cpp's build number from its build_info or version line", () => {
    expect(llamaBuildNumber("b10828-abc1234")).toBe(10828);
    expect(llamaBuildNumber("llama.cpp b7000 (abc1234)")).toBe(7000);
    expect(llamaBuildNumber("version: 10901 (0f1e2d3c)")).toBe(10901);
    expect(llamaBuildNumber("unknown build")).toBeUndefined();
  });
});
