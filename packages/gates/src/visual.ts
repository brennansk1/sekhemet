import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import {
  findChrome,
  isHeadlessShell,
  selectedEngine,
  spawnConfined,
  stopProcessTree,
} from "@sekhemet/sandbox";
import { RERUN_GATES, gateCopy } from "./copy.js";
import type { CompleteGateFailure, GateFailure, RungOutcome } from "./types.js";

/**
 * The visual layer (G17-G20), driven over the Chrome DevTools Protocol with
 * a local headless Chromium (no Playwright dependency, nothing downloaded):
 *   G17 console errors, uncaught exceptions and failed or 4xx/5xx requests;
 *   G18 layout-bounds predicates on selectors (visible, inside the
 *       viewport, no horizontal overflow, size limits);
 *   G19 element screenshots diffed against approved baselines (0.01 of
 *       pixels by default);
 *   G20 accessibility checks at 1280 and 375 px: an axe-style rule subset
 *       (image alt, control and link names, form labels, document language
 *       and title, duplicate ids, text contrast).
 */
export interface VisualCheck {
  selector: string;
  visible?: boolean;
  withinViewport?: boolean;
  noOverflow?: boolean;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
}

export interface VisualSnapshot {
  name: string;
  selector: string;
  /** Regions of this snapshot whose content changes between runs, painted over (GT-N4-5). */
  mask?: string[];
}

/**
 * A DOM assertion (rule 29, GT-N4-6): the element is present (default) or
 * absent, and, when given, its text or an attribute (present, or equal to
 * `value`) is what the card declares.
 */
export interface DomAssertion {
  selector: string;
  present?: boolean;
  text?: string;
  attribute?: string;
  value?: string;
}

export interface VisualConfig {
  /** Page to check; `{port}` is replaced by the app's port. */
  url: string;
  /** Command that serves the app (argv); it gets PORT. Absent: the URL is already served. */
  start?: string[];
  readyTimeoutMs: number;
  viewports: number[];
  checks: VisualCheck[];
  snapshots: VisualSnapshot[];
  /** Fraction of differing pixels a snapshot may have. Default 0.01. */
  threshold: number;
  /**
   * New or changed baselines: failed until a person approves the candidate
   * ("human", the default, rule 31, GT-N4-1), or written and passed ("auto",
   * only when the project says so).
   */
  baselineApproval: "auto" | "human";
  a11y: boolean;
  /** Regions masked in every snapshot: content that changes between runs (GT-N4-5). */
  mask: string[];
  /** Fail two visible elements whose boxes intersect (GT-N4-4). Default true. */
  overlap: boolean;
  /** Overlaps the project declares, as selector pairs (either order). */
  allowOverlap: [string, string][];
  /** DOM assertions the project declares (GT-N4-6). */
  assertions: DomAssertion[];
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Selector pairs from `[["a", "b"], ...]`. */
export function parseOverlapPairs(v: unknown): [string, string][] {
  return (Array.isArray(v) ? v : [])
    .map((p) => strings(p))
    .filter((p) => p.length === 2)
    .map((p) => [p[0], p[1]] as [string, string]);
}

/** DOM assertions from `[[visual.assert]]` terms (or a card's declaration). */
export function parseDomAssertions(v: unknown): DomAssertion[] {
  return (Array.isArray(v) ? (v as Record<string, unknown>[]) : [])
    .filter((a) => a && typeof a.selector === "string")
    .map((a) => ({
      selector: String(a.selector),
      ...(typeof a.present === "boolean" ? { present: a.present } : {}),
      ...(typeof a.text === "string" ? { text: a.text } : {}),
      ...(typeof a.attribute === "string" ? { attribute: a.attribute } : {}),
      ...(typeof a.value === "string" ? { value: a.value } : {}),
    }));
}

export function parseVisualConfig(raw: unknown): VisualConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
  if (typeof t.url !== "string") return undefined;
  const arr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  return {
    url: t.url,
    ...(Array.isArray(t.start) ? { start: (t.start as unknown[]).map(String) } : {}),
    readyTimeoutMs: (typeof t.ready_timeout_s === "number" ? t.ready_timeout_s : 30) * 1000,
    viewports: Array.isArray(t.viewports) ? (t.viewports as number[]) : [1280, 375],
    checks: arr(t.check)
      .filter((c) => typeof c.selector === "string")
      .map((c) => ({
        selector: String(c.selector),
        ...(c.visible === true ? { visible: true } : {}),
        ...(c.within_viewport === true ? { withinViewport: true } : {}),
        ...(c.no_overflow === true ? { noOverflow: true } : {}),
        ...(typeof c.min_width === "number" ? { minWidth: c.min_width } : {}),
        ...(typeof c.max_width === "number" ? { maxWidth: c.max_width } : {}),
        ...(typeof c.min_height === "number" ? { minHeight: c.min_height } : {}),
      })),
    snapshots: arr(t.snapshot)
      .filter((s) => typeof s.name === "string" && typeof s.selector === "string")
      .map((s) => ({
        name: String(s.name),
        selector: String(s.selector),
        ...(strings(s.mask).length > 0 ? { mask: strings(s.mask) } : {}),
      })),
    threshold: typeof t.threshold === "number" ? t.threshold : 0.01,
    // Only an explicit "auto" skips the person (GT-N4-1).
    baselineApproval: t.baseline_approval === "auto" ? "auto" : "human",
    a11y: t.a11y !== false,
    mask: strings(t.mask),
    overlap: t.overlap !== false,
    allowOverlap: parseOverlapPairs(t.allow_overlap),
    assertions: parseDomAssertions(t.assert),
  };
}

// biome-ignore lint/suspicious/noExplicitAny: CDP event payloads are untyped JSON.
type Loose = any;

// --- CDP ------------------------------------------------------------------------

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
  sessionId?: string;
}

/** A minimal CDP session over the global WebSocket (Node 22+). */
export class CdpBrowser {
  private ws: WebSocket | undefined;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();
  private listeners: ((m: CdpMessage) => void)[] = [];
  private child: ChildProcess | undefined;
  private profile: string | undefined;

  /**
   * Start headless Chromium confined (S3a, SEC-16): its profile directory is
   * the only writable root, and the only network is its own DevTools port and
   * the loopback ports the caller names (the app under test).
   */
  public static async launch(
    chrome = findChrome(),
    options: {
      localPorts?: number[];
      restricted?: boolean;
      /** Why the browser did not start, when Chromium is installed but could not run. */
      onFailure?: (reason: string) => void;
    } = {},
  ): Promise<CdpBrowser | undefined> {
    if (!chrome) return undefined;
    const failed = async (b: CdpBrowser, reason: string) => {
      options.onFailure?.(reason);
      await b.close();
      return undefined;
    };
    const b = new CdpBrowser();
    b.profile = mkdtempSync(join(tmpdir(), "sekhemet-cdp-"));
    const cdpPort = await freePort();
    const child = await spawnConfined(
      chrome,
      [
        ...(isHeadlessShell(chrome) ? [] : ["--headless=new"]),
        // The Seatbelt profile is the sandbox; Chromium's own cannot nest in it.
        "--no-sandbox",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--hide-scrollbars",
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${b.profile}`,
        "about:blank",
      ],
      {
        root: b.profile,
        browser: true,
        denyHomeReads: true,
        localPorts: [cdpPort, ...(options.localPorts ?? [])],
        timeoutMs: 0,
        ...(options.restricted ? { restricted: true } : {}),
      },
    );
    if (!child) {
      return failed(b, "no confinement for the browser on this host (the sandbox fails closed)");
    }
    child.stdout.resume();
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-400);
    });
    b.child = child;
    const portFile = join(b.profile, "DevToolsActivePort");
    const deadline = Date.now() + 15_000;
    // A browser that died (refused, crashed) is not waited for.
    while (
      !existsSync(portFile) &&
      Date.now() < deadline &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      await sleep(50);
    }
    if (!existsSync(portFile)) {
      const how =
        child.exitCode !== null || child.signalCode !== null
          ? `Chromium exited (${child.exitCode ?? child.signalCode}) before opening its DevTools port`
          : "Chromium did not open its DevTools port within 15 s";
      return failed(b, `${how}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
    }
    const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("CDP connection failed")));
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as CdpMessage;
      if (msg.id !== undefined) {
        const p = b.pending.get(msg.id);
        b.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message));
        else p?.resolve(msg.result ?? {});
      } else for (const l of b.listeners) l(msg);
    });
    b.ws = ws;
    return b;
  }

  public send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws?.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  public on(listener: (m: CdpMessage) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** A fresh page with Page, Runtime, Log and Network enabled. */
  public async newPage(): Promise<CdpPage> {
    const { targetId } = (await this.send("Target.createTarget", { url: "about:blank" })) as {
      targetId: string;
    };
    const { sessionId } = (await this.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId: string };
    const page = new CdpPage(this, sessionId);
    await Promise.all(
      ["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"].map((m) => page.send(m)),
    );
    return page;
  }

  public async close(): Promise<void> {
    try {
      this.ws?.close();
    } catch {
      // Closed.
    }
    if (this.child) await stopProcessTree(this.child, 0);
    if (this.profile) {
      await sleep(100);
      rmSync(this.profile, { recursive: true, force: true });
    }
  }
}

export interface PageProblems {
  console: string[];
  network: string[];
}

export class CdpPage {
  public readonly problems: PageProblems = { console: [], network: [] };
  private loaded: (() => void) | undefined;

  constructor(
    private browser: CdpBrowser,
    private sessionId: string,
  ) {
    browser.on((m) => {
      if (m.sessionId !== sessionId) return;
      const p = (m.params ?? {}) as Record<string, Loose>;
      if (m.method === "Runtime.consoleAPICalled" && (p.type === "error" || p.type === "assert")) {
        this.problems.console.push(
          `console.${p.type}: ${(p.args ?? []).map((a: Loose) => a.value ?? a.description ?? "").join(" ")}`,
        );
      } else if (m.method === "Runtime.exceptionThrown") {
        this.problems.console.push(
          `uncaught: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "exception"}`.split(
            "\n",
          )[0] as string,
        );
      } else if (m.method === "Log.entryAdded" && p.entry?.level === "error") {
        this.problems.console.push(`log: ${p.entry.text}${p.entry.url ? ` (${p.entry.url})` : ""}`);
      } else if (m.method === "Network.loadingFailed" && !p.canceled) {
        this.problems.network.push(`request failed: ${p.errorText}`);
      } else if (m.method === "Network.responseReceived" && p.response?.status >= 400) {
        this.problems.network.push(`${p.response.status} ${p.response.url}`);
      } else if (m.method === "Page.loadEventFired") {
        this.loaded?.();
      }
    });
  }

  public send(method: string, params: Record<string, unknown> = {}) {
    return this.browser.send(method, params, this.sessionId);
  }

  public async setViewport(width: number, height = Math.round(width * 0.75)): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 768,
    });
  }

  public async goto(url: string, timeoutMs = 20_000): Promise<void> {
    const loaded = new Promise<void>((resolve) => {
      this.loaded = resolve;
    });
    await this.send("Page.navigate", { url });
    await Promise.race([loaded, sleep(timeoutMs)]);
    await sleep(300); // Late console errors and requests.
  }

  public async evaluate<T>(expression: string): Promise<T> {
    const r = (await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as {
      result?: { value?: T };
      exceptionDetails?: { text?: string };
    };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "evaluation failed");
    return r.result?.value as T;
  }

  /** A PNG of the element's box, or undefined when it has none. */
  public async screenshot(selector: string): Promise<Buffer | undefined> {
    const box = await this.evaluate<{ x: number; y: number; width: number; height: number } | null>(
      `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`,
    );
    if (!box || box.width < 1 || box.height < 1) return undefined;
    const { data } = (await this.send("Page.captureScreenshot", {
      format: "png",
      clip: { ...box, scale: 1 },
      captureBeyondViewport: true,
    })) as { data: string };
    return Buffer.from(data, "base64");
  }

  /** A PNG of the viewport as it stands (the vision checklist's screen). */
  public async screenshotViewport(): Promise<Buffer> {
    const { data } = (await this.send("Page.captureScreenshot", { format: "png" })) as {
      data: string;
    };
    return Buffer.from(data, "base64");
  }

  /**
   * Animations and transitions off (GT-N4-5): every CSS animation and
   * transition is removed, running ones are cancelled to their end state,
   * and the caret stops blinking, so a screenshot does not depend on when
   * it was taken.
   */
  public async freeze(): Promise<void> {
    await this.evaluate<void>(FREEZE_SCRIPT);
  }

  /** Paint an opaque box over every element the selectors match (GT-N4-5). */
  public async mask(selectors: readonly string[], tag: string): Promise<void> {
    if (selectors.length === 0) return;
    await this.evaluate<void>(
      `(${MASK_SCRIPT})(${JSON.stringify(selectors)}, ${JSON.stringify(tag)})`,
    );
  }

  /** Remove the masks painted under `tag`. */
  public async unmask(tag: string): Promise<void> {
    await this.evaluate<void>(
      `document.querySelectorAll('[data-sekhemet-mask=${JSON.stringify(tag)}]').forEach((e) => e.remove())`,
    );
  }
}

const FREEZE_SCRIPT = `(async () => {
  const style = document.createElement("style");
  style.setAttribute("data-sekhemet-freeze", "");
  style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }";
  document.documentElement.appendChild(style);
  for (const a of document.getAnimations ? document.getAnimations() : []) {
    try { a.finish(); } catch { a.cancel(); }
  }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
})()`;

const MASK_SCRIPT = `(selectors, tag) => {
  for (const sel of selectors) {
    let found = [];
    try { found = [...document.querySelectorAll(sel)]; } catch { continue; }
    for (const e of found) {
      const r = e.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const m = document.createElement("div");
      m.setAttribute("data-sekhemet-mask", tag);
      m.style.cssText = "position:absolute;margin:0;padding:0;border:0;pointer-events:none;z-index:2147483647;background:#ff00ff;" +
        "left:" + (r.left + scrollX) + "px;top:" + (r.top + scrollY) + "px;width:" + r.width + "px;height:" + r.height + "px";
      document.documentElement.appendChild(m);
    }
  }
}`;

// --- PNG decode and diff (G19) -------------------------------------------------------

export interface Rgba {
  width: number;
  height: number;
  data: Buffer;
}

/** Decode an 8-bit, non-interlaced RGB or RGBA PNG (what Chromium writes). */
export function decodePng(png: Buffer): Rgba {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString("ascii", pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error("only 8-bit non-interlaced PNGs");
      colorType = data[9] as number;
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] as number;
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? (line[x - channels] as number) : 0;
      const b = prev[x] as number;
      const c = x >= channels ? (prev[x - channels] as number) : 0;
      const v = line[x] as number;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = (v + add) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = line[x * channels] as number;
      out[o + 1] = line[x * channels + 1] as number;
      out[o + 2] = line[x * channels + 2] as number;
      out[o + 3] = channels === 4 ? (line[x * channels + 3] as number) : 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}

/** Fraction of pixels whose largest channel difference exceeds `tolerance`; 1 when sizes differ. */
export function pixelDiffRatio(a: Rgba, b: Rgba, tolerance = 16): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let diff = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 4; c++) {
      if (Math.abs((a.data[i + c] as number) - (b.data[i + c] as number)) > tolerance) {
        diff++;
        break;
      }
    }
  }
  return diff / (a.width * a.height || 1);
}

/** Encode RGBA pixels as an 8-bit RGBA PNG (the evidence's diff images, GT-N4-3). */
export function encodePng(img: Rgba): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = img.width * 4;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0;
    img.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A diff image of two same-sized screenshots: differing pixels (as
 * `pixelDiffRatio` counts them) in red over a faded copy of the baseline;
 * undefined when the sizes differ.
 */
export function diffImage(baseline: Rgba, actual: Rgba, tolerance = 16): Rgba | undefined {
  if (baseline.width !== actual.width || baseline.height !== actual.height) return undefined;
  const out = Buffer.alloc(baseline.data.length);
  for (let i = 0; i < baseline.data.length; i += 4) {
    let differs = false;
    for (let c = 0; c < 4; c++) {
      if (Math.abs((baseline.data[i + c] as number) - (actual.data[i + c] as number)) > tolerance) {
        differs = true;
        break;
      }
    }
    if (differs) {
      out[i] = 255;
      out[i + 1] = 0;
      out[i + 2] = 0;
    } else {
      const g =
        0.299 * (baseline.data[i] as number) +
        0.587 * (baseline.data[i + 1] as number) +
        0.114 * (baseline.data[i + 2] as number);
      const v = Math.round(255 - (255 - g) * 0.3);
      out[i] = v;
      out[i + 1] = v;
      out[i + 2] = v;
    }
    out[i + 3] = 255;
  }
  return { width: baseline.width, height: baseline.height, data: out };
}

// --- G18 layout predicates, G20 accessibility -------------------------------------------

function layoutScript(check: VisualCheck): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(check.selector)});
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      found: true,
      visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0,
      inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5,
      overflow: el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== "auto" && cs.overflowX !== "scroll",
      pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      width: r.width,
      height: r.height,
    };
  })()`;
}

/** An axe-style subset of WCAG rules, evaluated in the page. */
export const A11Y_SCRIPT = `(() => {
  const out = [];
  const name = (e) => (e.getAttribute("aria-label") || e.getAttribute("title") || e.innerText || e.value || "").trim() ||
    (e.getAttribute("aria-labelledby") || "").split(/\\s+/).map((id) => document.getElementById(id)?.innerText || "").join("").trim();
  const where = (e) => e.id ? "#" + e.id : e.tagName.toLowerCase() + (e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\\s+/)[0] : "");
  const hidden = (e) => { const s = getComputedStyle(e); return s.display === "none" || s.visibility === "hidden" || e.closest("[aria-hidden=true]"); };
  if (!document.documentElement.getAttribute("lang")) out.push({ rule: "html-has-lang", target: "html" });
  if (!document.title.trim()) out.push({ rule: "document-title", target: "title" });
  for (const img of document.querySelectorAll("img")) if (!hidden(img) && !img.hasAttribute("alt")) out.push({ rule: "image-alt", target: where(img) });
  for (const b of document.querySelectorAll("button, [role=button]")) if (!hidden(b) && !name(b) && !b.querySelector("img[alt]:not([alt=''])")) out.push({ rule: "button-name", target: where(b) });
  for (const a of document.querySelectorAll("a[href]")) if (!hidden(a) && !name(a) && !a.querySelector("img[alt]:not([alt=''])")) out.push({ rule: "link-name", target: where(a) });
  for (const i of document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea")) {
    if (hidden(i)) continue;
    const labelled = i.getAttribute("aria-label") || i.getAttribute("aria-labelledby") || i.getAttribute("title") || (i.id && document.querySelector('label[for="' + i.id + '"]')) || i.closest("label");
    if (!labelled) out.push({ rule: "label", target: where(i) });
  }
  const ids = new Map();
  for (const e of document.querySelectorAll("[id]")) ids.set(e.id, (ids.get(e.id) || 0) + 1);
  for (const [id, n] of ids) if (n > 1) out.push({ rule: "duplicate-id", target: "#" + id });
  const rgb = (s) => (s.match(/[\\d.]+/g) || []).map(Number);
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bg = (e) => { for (let n = e; n; n = n.parentElement) { const c = rgb(getComputedStyle(n).backgroundColor); if (c.length >= 3 && (c.length < 4 || c[3] > 0.5)) return c; } return [255, 255, 255]; };
  let checked = 0;
  for (const e of document.querySelectorAll("body *")) {
    if (checked > 400) break;
    if (hidden(e)) continue;
    const own = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    checked++;
    const s = getComputedStyle(e);
    const fg = rgb(s.color);
    const a = lum(fg), b = lum(bg(e));
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const large = parseFloat(s.fontSize) >= 24 || (parseFloat(s.fontSize) >= 18.66 && Number(s.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) out.push({ rule: "color-contrast", target: where(e), detail: ratio.toFixed(2) + ":1" });
  }
  return out;
})()`;

// --- GT-N4-4 overlap, GT-N4-6 DOM assertions -------------------------------------------

/**
 * Pairs of visible elements whose layout boxes intersect (rule 29, GT-N4-4).
 * Candidates are the page's boxes that are not inline text runs (block,
 * flex, grid and inline-block boxes, and replaced elements such as images
 * and controls), visible, with a size; an element and its own ancestor never
 * pair. Where a container pair and its descendants' pairs are the same
 * collision, only the outermost pair is named. An overlap is declared by a
 * selector pair: each element, or one of its ancestors, matches one side.
 */
const OVERLAP_SCRIPT = `(allowed) => {
  const REPLACED = new Set(["IMG", "VIDEO", "CANVAS", "SVG", "svg", "INPUT", "BUTTON", "SELECT", "TEXTAREA", "IFRAME", "OBJECT", "EMBED"]);
  const where = (e) => {
    const parts = [];
    for (let n = e; n && n !== document.body && parts.length < 4; n = n.parentElement) {
      if (n.id) { parts.unshift("#" + n.id); break; }
      let p = n.tagName.toLowerCase();
      if (typeof n.className === "string" && n.className.trim()) p += "." + n.className.trim().split(/\\s+/)[0];
      const same = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
      if (same.length > 1) p += ":nth-of-type(" + (same.indexOf(n) + 1) + ")";
      parts.unshift(p);
    }
    return parts.join(" > ");
  };
  const els = [];
  for (const e of document.querySelectorAll("body *")) {
    if (els.length >= 400) break;
    if (e.hasAttribute("data-sekhemet-mask")) continue;
    const s = getComputedStyle(e);
    if (s.display === "none" || s.display === "contents" || s.visibility === "hidden" || Number(s.opacity) === 0) continue;
    if (s.display === "inline" && !REPLACED.has(e.tagName)) continue;
    if (e.closest("svg") && e.tagName.toLowerCase() !== "svg") continue;
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    els.push({ e, r });
  }
  const matches = (e, sel) => { try { return e.closest(sel) !== null; } catch { return false; } };
  const declared = (a, b) => allowed.some(([x, y]) => (matches(a, x) && matches(b, y)) || (matches(a, y) && matches(b, x)));
  const hits = new Map();
  for (let i = 0; i < els.length; i++) {
    for (let j = i + 1; j < els.length; j++) {
      const a = els[i], b = els[j];
      if (a.e.contains(b.e) || b.e.contains(a.e)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w <= 1 || h <= 1) continue;
      if (declared(a.e, b.e)) continue;
      hits.set(i + ":" + j, { i, j, w, h });
    }
  }
  const index = new Map(els.map((x, k) => [x.e, k]));
  const ancestors = (k) => { const out = []; for (let n = els[k].e.parentElement; n; n = n.parentElement) { const x = index.get(n); if (x !== undefined) out.push(x); } return out; };
  const has = (x, y) => hits.has(Math.min(x, y) + ":" + Math.max(x, y));
  const out = [];
  for (const { i, j, w, h } of hits.values()) {
    if (ancestors(i).some((x) => x !== j && !els[x].e.contains(els[j].e) && has(x, j))) continue;
    if (ancestors(j).some((x) => x !== i && !els[x].e.contains(els[i].e) && has(i, x))) continue;
    out.push({ a: where(els[i].e), b: where(els[j].e), w: Math.round(w), h: Math.round(h) });
    if (out.length >= 5) break;
  }
  return out;
}`;

const DOM_SCRIPT = `(a) => {
  let found = [];
  try { found = [...document.querySelectorAll(a.selector)]; } catch { return { invalid: true, count: 0 }; }
  const e = found[0];
  return {
    count: found.length,
    text: e ? (e.innerText ?? e.textContent ?? "").replace(/\\s+/g, " ").trim() : null,
    attribute: e && a.attribute ? e.getAttribute(a.attribute) : null,
  };
}`;

/** What a DOM assertion found wrong, or undefined when it holds (GT-N4-6). */
export function domAssertionFailure(
  a: DomAssertion,
  found: { invalid?: boolean; count: number; text: string | null; attribute: string | null },
): { excerpt: string; expected: string; actual: string } | undefined {
  const present = a.present !== false;
  if (found.invalid) {
    return { excerpt: "not a valid selector", expected: "a valid selector", actual: "invalid" };
  }
  if (!present) {
    return found.count > 0
      ? {
          excerpt: `present (${found.count}), expected absent`,
          expected: "absent",
          actual: `present (${found.count})`,
        }
      : undefined;
  }
  if (found.count === 0) {
    return { excerpt: "absent, expected present", expected: "present", actual: "absent" };
  }
  if (a.text !== undefined) {
    const want = a.text.replace(/\s+/g, " ").trim();
    if (found.text !== want) {
      return {
        excerpt: `text ${JSON.stringify(found.text)}, expected ${JSON.stringify(want)}`,
        expected: JSON.stringify(want),
        actual: JSON.stringify(found.text),
      };
    }
  }
  if (a.attribute !== undefined) {
    const got = found.attribute;
    if (got === null) {
      const expected = a.value === undefined ? "present" : JSON.stringify(a.value);
      return { excerpt: `${a.attribute} absent, expected ${expected}`, expected, actual: "absent" };
    }
    if (a.value !== undefined && got !== a.value) {
      return {
        excerpt: `${a.attribute} ${JSON.stringify(got)}, expected ${JSON.stringify(a.value)}`,
        expected: JSON.stringify(a.value),
        actual: JSON.stringify(got),
      };
    }
  }
  return undefined;
}

// --- GT-N4-2 the vision checklist --------------------------------------------------------

/** The checklist's version: a qualification holds for one version only (rule 30). */
export const VISION_CHECKLIST_VERSION = "1";

/** A local vision model answering the fixed checklist, one "yes" or "no" per question. */
export interface VisionAdapter {
  /** The model's registry id: its qualification is recorded against it. */
  model: string;
  answer(
    png: Buffer,
    questions: readonly string[],
    options: { temperature: 0 },
  ): Promise<readonly ("yes" | "no")[]>;
}

/**
 * The vision model's measurement on the labelled screens (measurement T11),
 * as the model registry records it for one model and checklist version.
 */
export interface VisionQualification {
  model: string;
  checklistVersion: string;
  /** Screens a person approved, and how many of them the checklist failed. */
  approvedScreens: number;
  wrongFails: number;
  /** Screens with a seeded visual defect, and how many the checklist passed. */
  defectScreens: number;
  falsePasses: number;
}

function binomialCdf(k: number, n: number, p: number): number {
  let sum = 0;
  let logC = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    sum += Math.exp(logC + i * Math.log(p) + (n - i) * Math.log1p(-p));
  }
  return sum;
}

/**
 * The exact (Clopper-Pearson) one-sided upper confidence bound on a rate
 * with `k` events in `n` trials, at `confidence` (rule 30's 95%).
 */
export function exactUpperBound(k: number, n: number, confidence = 0.95): number {
  if (n <= 0 || k >= n) return 1;
  let lo = 0;
  let hi = 1;
  for (let t = 0; t < 60; t++) {
    const mid = (lo + hi) / 2;
    if (binomialCdf(k, n, mid) > 1 - confidence) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * Whether the vision checklist may fail a card (rule 30, GT-N4-2): only for
 * the model and checklist version the registry measured, on at least 60
 * approved and 30 seeded-defect screens, with a wrong-fail upper bound of
 * at most 5% and a false-pass rate of at most 50%.
 */
export function visionMayBlock(
  q: VisionQualification | undefined,
  model: string,
): { blocking: boolean; reason: string } {
  const no = (reason: string) => ({ blocking: false, reason });
  if (!q) return no(`no measurement recorded for ${model}`);
  if (q.model !== model) return no(`the measurement is for ${q.model}, not ${model}`);
  if (q.checklistVersion !== VISION_CHECKLIST_VERSION) {
    return no(`measured on checklist ${q.checklistVersion}, not ${VISION_CHECKLIST_VERSION}`);
  }
  if (q.approvedScreens < 60) return no(`${q.approvedScreens} approved screens, 60 needed`);
  if (q.defectScreens < 30) return no(`${q.defectScreens} seeded-defect screens, 30 needed`);
  const upper = exactUpperBound(q.wrongFails, q.approvedScreens);
  if (upper > 0.05) {
    return no(`wrong-fail rate's 95% upper bound ${(upper * 100).toFixed(1)}% is over 5%`);
  }
  const falsePass = q.falsePasses / q.defectScreens;
  if (falsePass > 0.5) return no(`false-pass rate ${(falsePass * 100).toFixed(0)}% is over 50%`);
  return { blocking: true, reason: "measured" };
}

// --- the gate -------------------------------------------------------------------------

/** A file the visual layer attaches to the evidence bundle (GT-N4-3). */
export interface VisualArtifact {
  kind: string;
  ref: string;
}

export interface VisualGateContext {
  root: string;
  config: VisualConfig;
  /** Where baselines live (the project's .sekhemet/visual). */
  stateDir: string;
  /** `--restricted`: confinement has no opt-out (the session does not start this layer at all). */
  restricted?: boolean;
  /** Serves the app; returns its port and a stop function. Default: run `config.start` with PORT. */
  serve?: () => Promise<{ port: number; stop: () => void } | undefined>;
  /** DOM assertions the card declares, checked with the project's (GT-N4-6). */
  assertions?: readonly DomAssertion[];
  /** Overlaps the card declares, as selector pairs (GT-N4-4). */
  allowOverlap?: readonly (readonly [string, string])[];
  /** The vision checklist (GT-N4-2): its adapter and, when measured, its qualification. */
  vision?: { adapter: VisionAdapter; qualification?: VisionQualification };
  /**
   * Why no vision checklist runs (GT-N4-2): no vision model has qualified
   * for this checklist version. The evidence's advisories say so.
   */
  visionNotRun?: string;
  /**
   * The card whose run this is (GT-N4-1): its candidates are kept under it,
   * so another card's run of the same screen never replaces them.
   */
  cardId?: string;
}

/** A visual failure with all six fields (rule 19): the page is re-checked by `check`. */
function fail(
  gate: string,
  excerpt: string,
  extra: Partial<GateFailure> = {},
): CompleteGateFailure {
  return {
    gate,
    rung: "visual",
    layer: "visual",
    exitCode: 1,
    errorExcerpt: excerpt,
    suggestedFixFiles: [],
    location: { file: "." },
    expected: `${gate} to pass`,
    actual: excerpt,
    minimalRepro: RERUN_GATES,
    suggestedAction: gateCopy.visualLayout,
    ...extra,
  };
}

/** The visual layer's checks, one outcome each. */
const VISUAL_CHECK_IDS = [
  "visual-console",
  "visual-layout",
  "visual-dom",
  "visual-snapshot",
  "visual-a11y",
];

/**
 * Every gate id the visual layer can put on a failure: its checks, the
 * vision checklist (an outcome only when it fails a card) and the
 * confinement failure (GT-M6-5 lists them from here).
 */
export const VISUAL_GATE_IDS: readonly string[] = [
  ...VISUAL_CHECK_IDS,
  "visual-vision",
  "visual-confinement",
];

/** The candidates of a run with no card (`sekhemet gate` on a bare tree). */
const NO_CARD = "_project";

/** A card's candidate directory: its id when that is a safe name, else a hash of it. */
function cardDir(cardId: string | undefined): string {
  if (cardId === undefined) return NO_CARD;
  return /^[\w.-]+$/.test(cardId) && cardId !== NO_CARD
    ? cardId
    : `card-${createHash("sha256").update(cardId).digest("hex").slice(0, 16)}`;
}

/**
 * Where a snapshot's baseline, candidate, screenshot and diff live. A
 * candidate is kept per card and screen, with a record of the card that wrote
 * it and its SHA-256 (GT-N4-1).
 */
function snapshotPaths(stateDir: string, key: string, cardId?: string) {
  const dir = join(stateDir, "visual");
  const candidates = join(dir, "candidates", cardDir(cardId));
  return {
    baseline: join(dir, "baselines", `${key}.png`),
    candidate: join(candidates, `${key}.png`),
    candidateRecord: join(candidates, `${key}.json`),
    actual: join(dir, "actual", `${key}.png`),
    diff: join(dir, "diff", `${key}.png`),
  };
}

function writeFile(path: string, data: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

const sha256Of = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

/** A screenshot waiting for a person (GT-N4-1). */
export interface VisualCandidate {
  /** `<name>-<width>`. */
  key: string;
  /** The card whose run wrote it; absent for a run with no card. */
  cardId?: string;
  /** The SHA-256 of the PNG, which the person approves by. */
  sha256: string;
  writtenAt: string;
}

function writeCandidate(stateDir: string, key: string, cardId: string | undefined, png: Buffer) {
  const p = snapshotPaths(stateDir, key, cardId);
  writeFile(p.candidate, png);
  const record: VisualCandidate = {
    key,
    ...(cardId !== undefined ? { cardId } : {}),
    sha256: sha256Of(png),
    writtenAt: new Date().toISOString(),
  };
  writeFileSync(p.candidateRecord, `${JSON.stringify(record)}\n`);
}

/** Every candidate waiting for a person, with the card that wrote it and its SHA-256. */
export function listVisualCandidates(stateDir: string): VisualCandidate[] {
  const root = join(stateDir, "visual", "candidates");
  if (!existsSync(root)) return [];
  const out: VisualCandidate[] = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of readdirSync(join(root, dir.name))) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(readFileSync(join(root, dir.name, f), "utf8")) as VisualCandidate;
        const png = join(root, dir.name, `${f.slice(0, -5)}.png`);
        if (typeof rec.key !== "string" || !existsSync(png)) continue;
        // The hash listed is the file's own, never only what the record says.
        out.push({ ...rec, sha256: sha256Of(readFileSync(png)) });
      } catch {
        // An unreadable record is not a candidate anyone can approve.
      }
    }
  }
  return out.sort(
    (a, b) => a.key.localeCompare(b.key) || (a.cardId ?? "").localeCompare(b.cardId ?? ""),
  );
}

export type VisualApproval =
  | { approved: true; key: string; cardId?: string; sha256: string }
  | { approved: false; reason: string; missing?: true };

/**
 * A person approves a candidate screenshot (`<name>-<width>`, rule 31,
 * GT-N4-1) as the baseline: the candidate the named card's run wrote, and
 * only when its SHA-256 is the one the person saw. The bytes hashed are the
 * bytes made the baseline, so a candidate replaced after the person looked is
 * never approved in its place. The caller records who approved it.
 */
export function approveVisualBaseline(
  stateDir: string,
  opts: { key: string; cardId?: string | undefined; sha256: string },
): VisualApproval {
  const { key, cardId } = opts;
  const p = snapshotPaths(stateDir, key, cardId);
  const whose = cardId ? `card ${cardId}` : "a run with no card";
  if (!existsSync(p.candidate) || !existsSync(p.candidateRecord)) {
    return {
      approved: false,
      reason: `no candidate ${key} from ${whose} is waiting`,
      missing: true,
    };
  }
  let record: VisualCandidate;
  try {
    record = JSON.parse(readFileSync(p.candidateRecord, "utf8")) as VisualCandidate;
  } catch {
    return { approved: false, reason: `the record of candidate ${key} cannot be read` };
  }
  if (record.key !== key || record.cardId !== cardId) {
    return { approved: false, reason: `candidate ${key} was not written by ${whose}` };
  }
  if (!/^[0-9a-f]{64}$/.test(opts.sha256)) {
    return { approved: false, reason: "an approval names the SHA-256 of the screenshot seen" };
  }
  const png = readFileSync(p.candidate);
  const sha256 = sha256Of(png);
  if (sha256 !== opts.sha256) {
    return {
      approved: false,
      reason: `candidate ${key} from ${whose} is ${sha256.slice(0, 12)}, which differs from the one approved (${opts.sha256.slice(0, 12)}); look at it again`,
    };
  }
  writeFile(p.baseline, png);
  rmSync(p.candidate, { force: true });
  rmSync(p.candidateRecord, { force: true });
  return { approved: true, key, ...(cardId !== undefined ? { cardId } : {}), sha256 };
}

export async function runVisualGates(ctx: VisualGateContext): Promise<{
  failures: CompleteGateFailure[];
  outcomes: RungOutcome[];
  advisories: string[];
  artifacts: VisualArtifact[];
}> {
  const started = Date.now();
  const outcome = (
    gate: string,
    passed: boolean,
    extra: Partial<RungOutcome> = {},
  ): RungOutcome => ({
    gate,
    rung: "visual",
    layer: "visual",
    passed,
    exitCode: passed ? 0 : 1,
    durationMs: Date.now() - started,
    ...extra,
  });
  const gates = VISUAL_CHECK_IDS;
  const skipped = (why: string) => ({
    failures: [],
    outcomes: gates.map((g) => outcome(g, true, { skipped: true })),
    advisories: [`visual gates skipped: ${why}`],
    artifacts: [],
  });
  const chrome = findChrome();
  if (!chrome) return skipped("no local Chromium (set SEKHEMET_CHROME)");
  // Chromium is installed but the layer cannot run confined: not a pass.
  // The card says which engine refused and why (S3a); a person decides.
  const notRun = (why: string) => {
    const excerpt = `visual gates not run: ${why} (sandbox engine: ${selectedEngine()})`;
    return {
      failures: [
        fail("visual-confinement", excerpt, {
          suggestedAction: gateCopy.gateNotRun("visual"),
          notRun: true,
        }),
      ],
      outcomes: gates.map((g) => outcome(g, false)),
      advisories: [excerpt],
      artifacts: [],
    };
  };
  const served = ctx.serve ? await ctx.serve() : await serveApp(ctx);
  if (served && "refused" in served) return notRun(served.refused);
  const target = ctx.config.url.replace("{port}", String(served?.port ?? ""));
  const appPort = (() => {
    try {
      const u = new URL(target);
      return Number(u.port || (u.protocol === "https:" ? 443 : 80));
    } catch {
      return undefined;
    }
  })();
  let launchFailure = "Chromium could not start confined";
  const browser = await CdpBrowser.launch(chrome, {
    ...(appPort ? { localPorts: [appPort] } : {}),
    ...(ctx.restricted ? { restricted: true } : {}),
    onFailure: (reason) => {
      launchFailure = reason;
    },
  });
  if (!browser) {
    served?.stop();
    return notRun(launchFailure);
  }
  const failures: CompleteGateFailure[] = [];
  const advisories: string[] = [];
  const artifacts: VisualArtifact[] = [];
  const snapshotArtifacts: VisualArtifact[] = [];
  const byGate = new Map<string, number>(gates.map((g) => [g, 0]));
  const add = (f: CompleteGateFailure) => {
    failures.push(f);
    byGate.set(f.gate as string, (byGate.get(f.gate as string) ?? 0) + 1);
  };
  const assertions = [...ctx.config.assertions, ...(ctx.assertions ?? [])];
  const allowOverlap = [...ctx.config.allowOverlap, ...(ctx.allowOverlap ?? [])];
  const vision = ctx.vision
    ? { ...ctx.vision, may: visionMayBlock(ctx.vision.qualification, ctx.vision.adapter.model) }
    : undefined;
  if (!vision && ctx.visionNotRun) advisories.push(`vision checklist not run: ${ctx.visionNotRun}`);
  try {
    const url = target;
    for (const width of ctx.config.viewports) {
      const page = await browser.newPage();
      await page.setViewport(width);
      await page.goto(url);
      // G17
      for (const p of [...page.problems.console, ...page.problems.network].slice(0, 5)) {
        add(
          fail("visual-console", `@${width}px ${p}`, {
            suggestedAction: gateCopy.visualConsole,
          }),
        );
      }
      // G18
      for (const check of ctx.config.checks) {
        const m = await page.evaluate<Record<string, Loose>>(layoutScript(check));
        const at = `${check.selector} @${width}px`;
        if (!m.found) add(fail("visual-layout", `${at}: not found`));
        else {
          if (check.visible && !m.visible) add(fail("visual-layout", `${at}: not visible`));
          if (check.withinViewport && !m.inViewport)
            add(fail("visual-layout", `${at}: extends outside the viewport`));
          if (check.noOverflow && (m.overflow || m.pageOverflow))
            add(fail("visual-layout", `${at}: content overflows horizontally`));
          if (check.minWidth !== undefined && m.width < check.minWidth)
            add(
              fail(
                "visual-layout",
                `${at}: ${Math.round(m.width)}px wide, under ${check.minWidth}`,
              ),
            );
          if (check.maxWidth !== undefined && m.width > check.maxWidth)
            add(
              fail("visual-layout", `${at}: ${Math.round(m.width)}px wide, over ${check.maxWidth}`),
            );
          if (check.minHeight !== undefined && m.height < check.minHeight)
            add(
              fail(
                "visual-layout",
                `${at}: ${Math.round(m.height)}px high, under ${check.minHeight}`,
              ),
            );
        }
      }
      // GT-N4-4: overlapping elements, unless declared.
      if (ctx.config.overlap) {
        const pairs = await page.evaluate<{ a: string; b: string; w: number; h: number }[]>(
          `(${OVERLAP_SCRIPT})(${JSON.stringify(allowOverlap)})`,
        );
        for (const p of pairs) {
          add(
            fail(
              "visual-layout",
              gateCopy.visualOverlapFound(p.a, p.b, `${width}`, `${p.w}x${p.h}`),
              {
                expected: gateCopy.visualOverlapExpected(p.a, p.b),
                actual: gateCopy.visualOverlapActual(`${p.w}x${p.h}`),
                suggestedAction: gateCopy.visualOverlap(p.a, p.b),
              },
            ),
          );
        }
      }
      // GT-N4-6: declared DOM assertions.
      for (const a of assertions) {
        const found = await page.evaluate<{
          invalid?: boolean;
          count: number;
          text: string | null;
          attribute: string | null;
        }>(`(${DOM_SCRIPT})(${JSON.stringify(a)})`);
        const wrong = domAssertionFailure(a, found);
        if (!wrong) continue;
        add(
          fail("visual-dom", `${a.selector} @${width}px: ${wrong.excerpt}`, {
            expected: wrong.expected,
            actual: wrong.actual,
            suggestedAction: gateCopy.visualDom(a.selector),
          }),
        );
      }
      // G20
      if (ctx.config.a11y) {
        const violations =
          await page.evaluate<{ rule: string; target: string; detail?: string }[]>(A11Y_SCRIPT);
        for (const v of violations.slice(0, 8)) {
          add(
            fail(
              "visual-a11y",
              `@${width}px ${v.rule}: ${v.target}${v.detail ? ` (${v.detail})` : ""}`,
              { actual: v.rule },
            ),
          );
        }
      }
      // GT-N4-5: screenshots with animations off and dynamic regions masked.
      await page.freeze();
      await page.mask(ctx.config.mask, "layer");
      // G19
      for (const snap of ctx.config.snapshots) {
        await page.mask(snap.mask ?? [], "snapshot");
        const png = await page.screenshot(snap.selector);
        await page.unmask("snapshot");
        const key = `${snap.name}-${width}`;
        const at = `${snap.name} @${width}px`;
        const paths = snapshotPaths(ctx.stateDir, key, ctx.cardId);
        if (!png) {
          add(
            fail(
              "visual-snapshot",
              `${snap.name} @${width}px: ${snap.selector} has no box to capture`,
            ),
          );
          continue;
        }
        writeFile(paths.actual, png);
        snapshotArtifacts.push({ kind: "screenshot", ref: paths.actual });
        if (!existsSync(paths.baseline)) {
          if (ctx.config.baselineApproval === "auto") {
            writeFile(paths.baseline, png);
            advisories.push(`visual baseline recorded: ${at}`);
          } else {
            // A person approves every new baseline (rule 31, GT-N4-1).
            writeCandidate(ctx.stateDir, key, ctx.cardId, png);
            add(
              fail(
                "visual-snapshot",
                `${snap.name} @${width}px: no approved baseline; a candidate was written for a person to approve`,
                { suggestedAction: gateCopy.visualBaseline(at) },
              ),
            );
          }
          continue;
        }
        const baseline = decodePng(readFileSync(paths.baseline));
        const actual = decodePng(png);
        snapshotArtifacts.push({ kind: "visual-baseline", ref: paths.baseline });
        const ratio = pixelDiffRatio(baseline, actual);
        if (ratio > ctx.config.threshold) {
          const diff = diffImage(baseline, actual);
          if (diff) {
            writeFile(paths.diff, encodePng(diff));
            snapshotArtifacts.push({ kind: "visual-diff", ref: paths.diff });
          }
          // A changed screen is a candidate for a person, never a baseline by itself.
          writeCandidate(ctx.stateDir, key, ctx.cardId, png);
          add(
            fail(
              "visual-snapshot",
              `${snap.name} @${width}px differs from its baseline in ${(ratio * 100).toFixed(2)}% of pixels (limit ${(ctx.config.threshold * 100).toFixed(2)}%)`,
              {
                actual: paths.actual,
                expected: paths.baseline,
                suggestedAction: gateCopy.visualChanged(at),
              },
            ),
          );
        }
      }
      // GT-N4-2: the vision checklist fails a card, never passes one.
      if (vision)
        await visionChecklist(page, width, vision, ctx.stateDir, add, advisories, artifacts);
    }
  } finally {
    await browser.close();
    served?.stop();
  }
  artifacts.unshift(...snapshotArtifacts);
  const outcomes = gates.map((g) => {
    if (g === "visual-dom" && assertions.length === 0) {
      return outcome(g, true, { skipped: true, reason: "no DOM assertions declared" });
    }
    return outcome(g, (byGate.get(g) ?? 0) === 0, {
      // The screenshots travel on the snapshot outcome into the evidence (GT-N4-3).
      ...(g === "visual-snapshot" && artifacts.length > 0 ? { artifacts } : {}),
    });
  });
  if (failures.some((f) => f.gate === "visual-vision")) {
    outcomes.push(outcome("visual-vision", false));
  }
  return { failures, outcomes, advisories, artifacts };
}

async function visionChecklist(
  page: CdpPage,
  width: number,
  vision: NonNullable<VisualGateContext["vision"]> & { may: { blocking: boolean; reason: string } },
  stateDir: string,
  add: (f: CompleteGateFailure) => void,
  advisories: string[],
  artifacts: VisualArtifact[],
): Promise<void> {
  const questions = gateCopy.visionChecklist;
  const png = await page.screenshotViewport();
  const shot = join(stateDir, "visual", "actual", `vision-${width}.png`);
  writeFile(shot, png);
  artifacts.push({ kind: "vision-screenshot", ref: shot });
  let answers: readonly ("yes" | "no")[];
  try {
    answers = await vision.adapter.answer(png, questions, { temperature: 0 });
  } catch (err) {
    advisories.push(
      `vision checklist not answered @${width}px: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (answers.length !== questions.length || answers.some((a) => a !== "yes" && a !== "no")) {
    advisories.push(`vision checklist not answered @${width}px: an unreadable reply`);
    return;
  }
  const noes = questions.filter((_q, i) => answers[i] === "no");
  if (noes.length === 0) {
    advisories.push(`vision checklist: every answer yes; never a pass (@${width}px)`);
    return;
  }
  for (const q of noes) {
    if (!vision.may.blocking) {
      advisories.push(`vision checklist (advisory: ${vision.may.reason}) @${width}px: no: ${q}`);
      continue;
    }
    add(
      fail("visual-vision", gateCopy.visionAnswered(`${width}`, vision.adapter.model, q), {
        expected: "yes",
        actual: "no",
        suggestedAction: gateCopy.visionNo(q),
      }),
    );
  }
}

/** A free loopback port. */
async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

/**
 * Run `config.start` with a free PORT and wait for the URL to answer. The
 * dev server is the project's code: it runs confined in the worktree with
 * the allowlisted environment and only its own port (S3a, SEC-16).
 */
async function serveApp(
  ctx: VisualGateContext,
): Promise<{ port: number; stop: () => void } | { refused: string } | undefined> {
  if (!ctx.config.start?.length) return undefined;
  const port = await freePort();
  const [cmd, ...args] = ctx.config.start as [string, ...string[]];
  const child = await spawnConfined(cmd, args, {
    root: ctx.root,
    env: { PORT: String(port) },
    localPorts: [port],
    timeoutMs: 0,
    ...(ctx.restricted ? { restricted: true } : {}),
  });
  // No confinement here: the page is not served, and the gate reports it.
  if (!child) return { refused: "no confinement for the dev server on this host" };
  child.stdout.resume();
  child.stderr.resume();
  const url = ctx.config.url.replace("{port}", String(port));
  const deadline = Date.now() + ctx.config.readyTimeoutMs;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (r.status < 500) break;
    } catch {
      // Not up yet.
    }
    await sleep(250);
  }
  // The whole tree: `npm run dev` leaves the real server as a grandchild.
  return { port, stop: () => void child.stop() };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
