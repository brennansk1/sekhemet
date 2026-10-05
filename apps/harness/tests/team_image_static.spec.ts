import { closeSync, ftruncateSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SHIPPED_MODELS } from "@sekhemet/models";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { LLAMA_CPP_TEAM_IMAGES, TEAM_MODELS_DIR, teamEngines } from "../src/team_engines.js";

// The Team image (models rule 26a, NEW-models-15; FINDINGS INS-01; DESIGN_GAPS_C1
// b1): static tests over the shipped Dockerfile, compose file and INSTALL,
// each with two negatives showing the check would catch the defect (DoD §2B).

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DOCKERFILE = readFileSync(join(ROOT, "packaging/server/Dockerfile"), "utf8");
const COMPOSE = readFileSync(join(ROOT, "packaging/server/compose.yaml"), "utf8");
const INSTALL = readFileSync(join(ROOT, "docs/reference/INSTALL.md"), "utf8");

// --------------------------------------------------------------- the checks

/** Every program the harness spawns on Linux (DEC-50): git, bubblewrap, socat. */
const SPAWNED_ON_LINUX = ["git", "bubblewrap", "socat"];

/** The programs the runtime (last) stage's apt-get installs leave missing. */
function missingPrograms(dockerfile: string): string[] {
  const stages = dockerfile.split(/^FROM\s/m);
  const runtime = (stages.at(-1) ?? "").replace(/\\\n/g, " ");
  const installed = new Set(
    [...runtime.matchAll(/apt-get install([^&\n]*)/g)].flatMap((m) =>
      (m[1] ?? "").split(/\s+/).filter((w) => w && !w.startsWith("-")),
    ),
  );
  return SPAWNED_ON_LINUX.filter((p) => !installed.has(p));
}

/** Third-party images not pinned by digest: compose `image:` values and Dockerfile `FROM`s. */
function unpinnedImages(compose: string, dockerfile: string): string[] {
  const services = (parse(compose) as { services: Record<string, { image?: string }> }).services;
  const images = Object.values(services)
    .map((s) => s.image)
    .filter((i): i is string => typeof i === "string");
  const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1] as string);
  return [...images, ...froms].filter((i) => !/@sha256:[0-9a-f]{64}$/.test(i));
}

type Service = {
  image?: string;
  command?: unknown;
  network_mode?: string;
  volumes?: string[];
  healthcheck?: { test?: string[] };
};

/** How the compose file's engine services differ from the shipped profiles' launches. */
function engineMismatches(compose: string): string[] {
  const services = (parse(compose) as { services: Record<string, Service> }).services;
  const out: string[] = [];
  for (const e of teamEngines()) {
    const s = services[e.service];
    if (!s) {
      out.push(`${e.service}: missing`);
      continue;
    }
    if (JSON.stringify(s.command) !== JSON.stringify(e.args))
      out.push(`${e.service}: command differs from launchArgs()`);
    if (s.network_mode !== "service:sekhemet")
      out.push(`${e.service}: not in the harness's network namespace`);
    if (!s.volumes?.some((v) => v.endsWith(`:${TEAM_MODELS_DIR}:ro`)))
      out.push(`${e.service}: no models volume at ${TEAM_MODELS_DIR}`);
    if (!s.healthcheck?.test?.join(" ").includes(`127.0.0.1:${e.port}/health`))
      out.push(`${e.service}: its health check is not its own port's /health`);
  }
  // No engine service for a role that is not filled, and none left over.
  const named = new Set(teamEngines().map((e) => e.service));
  for (const name of Object.keys(services))
    if (name.startsWith("engine-") && !named.has(name)) out.push(`${name}: not a filled role`);
  return out;
}

// --------------------------------------------------------------- the tests

describe("MD-N15-1: the image contains every program the harness spawns on Linux", () => {
  it("installs git, bubblewrap and socat in the runtime stage", () => {
    expect(missingPrograms(DOCKERFILE)).toEqual([]);
  });

  it("negative: a Dockerfile without socat fails", () => {
    expect(missingPrograms(DOCKERFILE.replace(/\bsocat\b/g, ""))).toEqual(["socat"]);
  });

  it("negative: socat installed only in the build stage fails", () => {
    const moved = DOCKERFILE.replace(/\bsocat\b/g, "").replace(
      "RUN corepack enable",
      "RUN apt-get install -y socat && corepack enable",
    );
    expect(moved).toMatch(/install -y socat/);
    expect(missingPrograms(moved)).toEqual(["socat"]);
  });
});

describe("MD-N15-2: one engine service per filled role, started with its profile's launchArgs()", () => {
  it("has a service for each filled shipped role and none for the unfilled Review role", () => {
    const filled = SHIPPED_MODELS.filter((m) => m.id).map((m) => m.role);
    expect(teamEngines().map((e) => e.roles)).toEqual(filled.map((r) => [r]));
    expect(teamEngines().map((e) => e.service)).toEqual([
      "engine-coding",
      "engine-planning",
      "engine-research",
    ]);
    expect(engineMismatches(COMPOSE)).toEqual([]);
    // The weights at the shared path, so /props reports the path the profile expects (MD-M4-1).
    for (const e of teamEngines())
      expect(e.args.slice(0, 2)).toEqual(["-m", `${TEAM_MODELS_DIR}/${e.model.source?.file}`]);
  });

  it("negative: one argument different from launchArgs() fails", () => {
    const changed = COMPOSE.replace(/"16384"/, '"8192"');
    expect(changed).not.toBe(COMPOSE);
    expect(engineMismatches(changed)).toContain("engine-coding: command differs from launchArgs()");
  });

  it("negative: a filled role's service missing fails", () => {
    const doc = parse(COMPOSE) as { services: Record<string, unknown> };
    const services = Object.fromEntries(
      Object.entries(doc.services).filter(([name]) => name !== "engine-planning"),
    );
    expect(engineMismatches(stringify({ ...doc, services }))).toEqual(["engine-planning: missing"]);
  });
});

describe("MD-N15-4: third-party images pinned by digest; INSTALL names the GPU variant and each service's memory", () => {
  it("pins every image in the compose file and the Dockerfile by digest", () => {
    expect(unpinnedImages(COMPOSE, DOCKERFILE)).toEqual([]);
    const services = (parse(COMPOSE) as { services: Record<string, Service> }).services;
    for (const e of teamEngines())
      expect(services[e.service]?.image).toBe(LLAMA_CPP_TEAM_IMAGES.cuda);
  });

  it("negative: a floating tag fails", () => {
    const floating = COMPOSE.replace(
      /oauth2-proxy:v7\.15\.5@sha256:[0-9a-f]{64}/,
      "oauth2-proxy:latest",
    );
    expect(unpinnedImages(floating, DOCKERFILE)).toEqual([
      "quay.io/oauth2-proxy/oauth2-proxy:latest",
    ]);
  });

  it("negative: an unpinned base image fails", () => {
    const base = DOCKERFILE.replace(
      /node:24-bookworm-slim@sha256:[0-9a-f]{64}/,
      "node:24-bookworm-slim",
    );
    expect(unpinnedImages(COMPOSE, base)).toContain("node:24-bookworm-slim");
  });

  const dir = mkdtempSync(join(tmpdir(), "sek-team-mem-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("names the GPU variants and, for each engine service, the memory its footprint needs", async () => {
    for (const v of Object.values(LLAMA_CPP_TEAM_IMAGES))
      expect(INSTALL).toContain(v.split("@")[0]);
    // Sparse files of each shipped size: the footprint the harness itself computes (footprintBytes).
    for (const e of teamEngines({ modelsDir: dir })) {
      const fd = openSync(join(dir, e.model.source?.file as string), "w");
      ftruncateSync(fd, e.model.source?.sizeBytes as number);
      closeSync(fd);
      const gb = (((await e.adapter.footprintBytes()) as number) / 1e9).toFixed(1);
      expect(INSTALL).toMatch(new RegExp(`${e.service}[^\\n]*${gb.replace(".", "\\.")} GB`));
    }
  });
});
