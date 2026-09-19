import { mkdtempSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { findChrome } from "@sekhemet/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBuiltinGates } from "../src/builtin.js";
import { decodePng, parseVisualConfig, pixelDiffRatio, runVisualGates } from "../src/visual.js";

/** A tiny RGB PNG encoder for the decoder test. */
function png(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = (crcTable[(c ^ x) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows: number[] = [];
  for (let y = 0; y < height; y++) {
    rows.push(y % 2); // alternate filters 0 (none) and 1 (sub)
    let prev = [0, 0, 0];
    for (let x = 0; x < width; x++) {
      const p = pixel(x, y);
      if (y % 2 === 1) rows.push(...p.map((v, i) => (v - (prev[i] as number)) & 0xff));
      else rows.push(...p);
      prev = p;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("visual gates over CDP (G17, G18, G19, G20)", () => {
  it("decodes PNG filters and measures pixel differences", () => {
    const a = decodePng(png(10, 10, (x) => [x * 20, 100, 50]));
    expect(a.width).toBe(10);
    expect([...a.data.subarray(4 * 13, 4 * 13 + 4)]).toEqual([60, 100, 50, 255]);
    const b = decodePng(
      png(10, 10, (x, y) => (x === 0 && y === 0 ? [255, 0, 0] : [x * 20, 100, 50])),
    );
    expect(pixelDiffRatio(a, b)).toBeCloseTo(0.01);
    expect(pixelDiffRatio(a, decodePng(png(5, 5, () => [0, 0, 0])))).toBe(1);
  });

  it("parses [visual] from gates.toml terms", () => {
    const c = parseVisualConfig({
      url: "http://localhost:{port}/",
      start: ["pnpm", "dev"],
      check: [{ selector: "#app", visible: true, no_overflow: true }],
      snapshot: [{ name: "header", selector: "header" }],
      baseline_approval: "human",
    });
    expect(c).toMatchObject({
      viewports: [1280, 375],
      threshold: 0.01,
      baselineApproval: "human",
      checks: [{ selector: "#app", visible: true, noOverflow: true }],
    });
  });

  describe.runIf(findChrome() !== undefined)("against a real page in headless Chromium", () => {
    let server: Server;
    let port: number;
    let state: string;
    let html = "";
    beforeEach(async () => {
      state = mkdtempSync(join(tmpdir(), "visual-"));
      server = createServer((req, res) => {
        if (req.url === "/missing.js") {
          res.statusCode = 404;
          return res.end("nope");
        }
        res.setHeader("content-type", "text/html");
        res.end(html);
      });
      port = await new Promise((r) =>
        server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port)),
      );
    });
    afterEach(async () => {
      await new Promise((r) => server.close(() => r(undefined)));
      rmSync(state, { recursive: true, force: true });
    });

    const config = (over: Record<string, unknown> = {}) =>
      parseVisualConfig({
        url: `http://127.0.0.1:${port}/`,
        viewports: [1280, 375],
        check: [{ selector: "#box", visible: true, no_overflow: true }],
        snapshot: [{ name: "box", selector: "#box" }],
        ...over,
      }) as NonNullable<ReturnType<typeof parseVisualConfig>>;

    it("passes a clean page and records baselines, then catches every kind of regression", async () => {
      html = `<!doctype html><html lang="en"><head><title>ok</title></head><body style="margin:0;background:#fff">
        <div id="box" style="width:200px;height:50px;background:#123456;color:#fff">Hello</div></body></html>`;
      const clean = await runVisualGates({ root: state, config: config(), stateDir: state });
      expect(clean.failures).toEqual([]);
      expect(clean.advisories.filter((a) => a.includes("baseline recorded"))).toHaveLength(2);

      html = `<!doctype html><html><head></head><body style="margin:0">
        <script>console.error("boom")</script><script src="/missing.js"></script>
        <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
        <button></button>
        <div id="box" style="width:2000px;height:50px;background:#654321;color:#fff">Hello</div>
        <p style="color:#ccc;background:#fff">faint</p></body></html>`;
      const broken = await runVisualGates({ root: state, config: config(), stateDir: state });
      const gates = new Set(broken.failures.map((f) => f.gate));
      expect([...gates].sort()).toEqual([
        "visual-a11y",
        "visual-console",
        "visual-layout",
        "visual-snapshot",
      ]);
      const text = broken.failures.map((f) => f.errorExcerpt).join("\n");
      expect(text).toContain("console.error: boom");
      expect(text).toContain("404");
      expect(text).toContain("#box @375px: content overflows horizontally");
      for (const rule of [
        "html-has-lang",
        "document-title",
        "image-alt",
        "button-name",
        "color-contrast",
      ]) {
        expect(text).toContain(rule);
      }
      expect(text).toMatch(/box @1280px differs from its baseline/);
    }, 60_000);

    it("runs as part of the built-in layers when gates.toml declares [visual] and the gates passed", async () => {
      html = `<!doctype html><html lang="en"><head><title>t</title></head><body><script>console.error("x")</script><div id="box">b</div></body></html>`;
      const project = {
        protected: [],
        maxFiles: 3,
        maxDiffLines: 200,
        visual: config({ viewports: [1280] }),
      };
      const off = await runBuiltinGates({
        root: state,
        base: "main",
        diff: "",
        project,
        which: () => false,
        gates: [],
      });
      expect(off.outcomes).toEqual([]);
      const on = await runBuiltinGates({
        root: state,
        base: "main",
        diff: "",
        project,
        which: () => false,
        gates: [],
        visual: true,
        stateDir: state,
      });
      expect(on.outcomes.map((o) => o.gate)).toEqual([
        "visual-console",
        "visual-layout",
        "visual-snapshot",
        "visual-a11y",
      ]);
      expect(on.failures.some((f) => f.gate === "visual-console")).toBe(true);
    }, 60_000);

    it("requires a person to approve a first baseline when the project says so", async () => {
      html = `<!doctype html><html lang="en"><head><title>t</title></head><body><div id="box" style="width:10px;height:10px;background:#000"></div></body></html>`;
      const r = await runVisualGates({
        root: state,
        config: config({ baseline_approval: "human", viewports: [1280] }),
        stateDir: state,
      });
      expect(r.failures.map((f) => f.errorExcerpt)).toEqual([
        expect.stringContaining("no approved baseline"),
      ]);
    }, 60_000);
  });
});
