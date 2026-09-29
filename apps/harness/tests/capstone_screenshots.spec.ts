import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodePng, encodePng } from "@sekhemet/gates";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error: plain ESM scripts, run by hand and checked here.
import * as shots from "../../../scripts/capstone/screenshots.mjs";
// @ts-expect-error: plain ESM scripts, run by hand and checked here.
import * as seed from "../../../scripts/capstone/seed.mjs";

/**
 * The capstone's showcase screenshots (W2 G5; owner, 2026-09-29): every
 * finished app started from its repository, given the same data through the
 * interface contract, and captured at the same views at 1440 and 400 pixels.
 * The capture itself is the visual gate's Chromium; here a stand-in capturer
 * loads each view over HTTP instead, so the app, the seeding and the views are
 * real and no browser starts. The Chromium run is the last block, and runs
 * only with SEKHEMET_CAPSTONE_CHROMIUM=1.
 */

const HIDDEN = resolve(
  process.env.SEKHEMET_CAPSTONE_HIDDEN || join(homedir(), ".sekhemet", "capstone-hidden"),
);
/**
 * The sealed reference runs only when asked (`SEKHEMET_CAPSTONE_SEALED_TESTS=1`),
 * never in every gate, and every copy of it (the tree, and the app's own
 * scratch copy) is made in the sealed scratch root beside it (`<hidden>-scratch`).
 */
const HAVE_REFERENCE =
  process.env.SEKHEMET_CAPSTONE_SEALED_TESTS === "1" &&
  existsSync(join(HIDDEN, "reference", "src"));
const SEALED_SCRATCH = `${HIDDEN}-scratch`;

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function temp(prefix = "capstone-shots-spec-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

/** A fresh seed repository (real git), at the seed commit. */
function seedTree(): string {
  const repo = join(temp(), "repo");
  seed.materialise(repo);
  expect(spawnSync("git", ["-C", repo, "rev-parse", "seed"], { encoding: "utf8" }).status).toBe(0);
  return repo;
}

/**
 * The sealed reference solution after the change, as a finished tree (no
 * history needed here): the seed is made in the temp directory (seed.mjs
 * refuses the sealed one) and moved into the sealed scratch before any of the
 * reference is copied in.
 */
function referenceTree(): string {
  mkdirSync(SEALED_SCRATCH, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(SEALED_SCRATCH, "shots-spec-"));
  temps.push(dir);
  const repo = join(dir, "repo");
  renameSync(seedTree(), repo);
  const ref = join(HIDDEN, "reference");
  cpSync(ref, repo, {
    recursive: true,
    filter: (src) => !/[/\\](node_modules|dist|data)([/\\]|$)/.test(src.slice(ref.length)),
  });
  return repo;
}

const PNG = encodePng({ width: 2, height: 2, data: Buffer.alloc(16, 255) });

/** A capturer that loads each view over HTTP and records what it saw; its image is a placeholder. */
function httpCapturer(seen: { url?: string; html?: string; width: number; status?: number }[]) {
  return async () => ({
    name: "the spec's HTTP stand-in",
    capture: async ({ url, html, width }: { url?: string; html?: string; width: number }) => {
      let status: number | undefined;
      if (url) status = (await fetch(url)).status;
      seen.push({ url, html, width, status });
      return { png: PNG, a11y: [] };
    },
    close: async () => undefined,
  });
}

const VIEW_IDS = [
  "manager-grid",
  "employee-view",
  "federal-overtime",
  "california",
  "csv-export",
  "error-state",
];

describe.skipIf(!HAVE_REFERENCE)("against the reference solution", () => {
  it(
    "starts the app, loads the same data through the contract and captures every view at both widths",
    async () => {
      const out = temp();
      const seen: { url?: string; html?: string; width: number; status?: number }[] = [];
      const r = await shots.captureRun({
        tree: referenceTree(),
        out,
        arm: "claude-code-opus",
        run: 1,
        makeCapturer: httpCapturer(seen),
        scratchRoot: SEALED_SCRATCH,
      });
      expect(r.started).toBe(true);
      const refused = r.seeding.filter(
        (s: { status: number }) => s.status < 200 || s.status >= 300,
      );
      expect(refused).toEqual([]);
      expect(r.views.map((v: { view: string; width: number }) => `${v.view}-${v.width}`)).toEqual(
        VIEW_IDS.flatMap((id) => [`${id}-1440`, `${id}-400`]),
      );
      for (const v of r.views) {
        expect(v.file, v.view).toBe(`${v.view}-${v.width}.png`);
        expect(existsSync(join(out, v.file))).toBe(true);
      }
      const pages = seen.filter((s) => s.url);
      expect(pages).toHaveLength(10);
      for (const p of pages) {
        if (p.url?.includes("2026-10-05")) expect(p.status, p.url).toBeGreaterThanOrEqual(400);
        else expect(p.status, p.url).toBe(200);
      }
      const csv = seen.find((s) => s.html?.includes("/api/export.csv"));
      expect(csv?.html).toContain("HTTP 200");
      expect(csv?.html).toContain("Ana Reyes");
      expect(csv?.html).toContain("Chlo");
      expect(JSON.parse(readFileSync(join(out, "views.json"), "utf8")).started).toBe(true);
    },
    15 * 60_000,
  );
});

describe("against the empty seed", () => {
  it(
    "captures the failure as the error state, with the log excerpt, and records every other view as not captured",
    async () => {
      const out = temp();
      const seen: { url?: string; html?: string; width: number }[] = [];
      const r = await shots.captureRun({
        tree: seedTree(),
        out,
        arm: "one-shot-haiku",
        run: 1,
        makeCapturer: httpCapturer(seen),
      });
      expect(r.started).toBe(false);
      expect(r.failure.stage).toBe("build");
      expect(existsSync(join(out, "error-state-1440.png"))).toBe(true);
      expect(existsSync(join(out, "error-state-400.png"))).toBe(true);
      expect(seen).toHaveLength(2);
      expect(seen[0]?.html).toContain("The app did not build");
      expect(seen[0]?.html).toContain("npm run build");
      const missing = r.views.filter((v: { file: string | null }) => !v.file);
      expect(missing).toHaveLength(10);
      for (const v of missing) expect(v.notCaptured).toBe("the app did not build");
    },
    10 * 60_000,
  );
});

describe("the comparison page", () => {
  it("has one row per captured arm with its scores, time, tokens and screenshots side by side", () => {
    const showcase = temp();
    const dir = join(showcase, "one-shot-opus", "1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "views.json"),
      JSON.stringify({
        started: true,
        views: [
          {
            view: "manager-grid",
            title: "The manager's timesheet grid",
            width: 1440,
            file: "manager-grid-1440.png",
          },
          {
            view: "manager-grid",
            title: "The manager's timesheet grid",
            width: 400,
            file: "manager-grid-400.png",
          },
        ],
      }),
    );
    writeFileSync(
      join(dir, "score.json"),
      JSON.stringify({
        afterChange: { passed: 90, total: 111, passRate: 0.81 },
        releaseOne: { passed: 80, total: 84, passRate: 0.95 },
        regressions: { count: 2 },
        effort: { wallClockMinutes: 3.5, inputTokens: 6000, outputTokens: 30000 },
      }),
    );
    const md = shots.readme(showcase);
    const rows = md.split("\n").filter((l: string) => l.startsWith("| One shot"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("90/111");
    expect(rows[0]).toContain("80/84");
    expect(rows[0]).toContain("6000 / 30000");
    expect(rows[0]).toContain('src="one-shot-opus/1/manager-grid-1440.png"');
    expect(md).toContain('src="one-shot-opus/1/manager-grid-400.png"');
    expect(md).toContain("no clear difference");
  });
});

describe.skipIf(!process.env.SEKHEMET_CAPSTONE_CHROMIUM || !HAVE_REFERENCE)(
  "with the visual gate's Chromium",
  () => {
    it(
      "captures every view of the reference at 1440 and 400 pixels, and the seed's failure",
      async () => {
        const out = temp();
        const r = await shots.captureRun({
          tree: referenceTree(),
          out,
          arm: "claude-code-opus",
          run: 1,
          scratchRoot: SEALED_SCRATCH,
        });
        expect(r.views.filter((v: { file: string | null }) => v.file)).toHaveLength(12);
        for (const v of r.views) {
          const img = decodePng(readFileSync(join(out, v.file)));
          expect(img.width).toBe(v.width);
          expect(img.height).toBeLessThanOrEqual(shots.MAX_HEIGHT);
        }
        const failed = await shots.captureRun({
          tree: seedTree(),
          out: temp(),
          arm: "one-shot-haiku",
          run: 1,
        });
        expect(failed.views.filter((v: { file: string | null }) => v.file)).toHaveLength(2);
      },
      20 * 60_000,
    );
  },
);
