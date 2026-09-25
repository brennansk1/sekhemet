import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inflateSync } from "node:zlib";
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
  /** New baselines: written and passed ("auto") or failed until approved ("human"). */
  baselineApproval: "auto" | "human";
  a11y: boolean;
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
      .map((s) => ({ name: String(s.name), selector: String(s.selector) })),
    threshold: typeof t.threshold === "number" ? t.threshold : 0.01,
    baselineApproval: t.baseline_approval === "human" ? "human" : "auto",
    a11y: t.a11y !== false,
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
}

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

// --- the gate -------------------------------------------------------------------------

export interface VisualGateContext {
  root: string;
  config: VisualConfig;
  /** Where baselines live (the project's .sekhemet/visual). */
  stateDir: string;
  /** `--restricted`: confinement has no opt-out (the session does not start this layer at all). */
  restricted?: boolean;
  /** Serves the app; returns its port and a stop function. Default: run `config.start` with PORT. */
  serve?: () => Promise<{ port: number; stop: () => void } | undefined>;
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
const VISUAL_CHECK_IDS = ["visual-console", "visual-layout", "visual-snapshot", "visual-a11y"];

/**
 * Every gate id the visual layer can put on a failure: its checks and the
 * confinement failure (GT-M6-5 lists them from here).
 */
export const VISUAL_GATE_IDS: readonly string[] = [...VISUAL_CHECK_IDS, "visual-confinement"];

export async function runVisualGates(
  ctx: VisualGateContext,
): Promise<{ failures: CompleteGateFailure[]; outcomes: RungOutcome[]; advisories: string[] }> {
  const started = Date.now();
  const outcome = (gate: string, passed: boolean, skipped = false): RungOutcome => ({
    gate,
    rung: "visual",
    layer: "visual",
    passed,
    exitCode: passed ? 0 : 1,
    durationMs: Date.now() - started,
    ...(skipped ? { skipped: true } : {}),
  });
  const gates = VISUAL_CHECK_IDS;
  const skipped = (why: string) => ({
    failures: [],
    outcomes: gates.map((g) => outcome(g, true, true)),
    advisories: [`visual gates skipped: ${why}`],
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
  const byGate = new Map<string, number>(gates.map((g) => [g, 0]));
  const add = (f: CompleteGateFailure) => {
    failures.push(f);
    byGate.set(f.gate as string, (byGate.get(f.gate as string) ?? 0) + 1);
  };
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
      // G19
      for (const snap of ctx.config.snapshots) {
        const png = await page.screenshot(snap.selector);
        const base = join(ctx.stateDir, "visual", "baselines", `${snap.name}-${width}.png`);
        if (!png) {
          add(
            fail(
              "visual-snapshot",
              `${snap.name} @${width}px: ${snap.selector} has no box to capture`,
            ),
          );
          continue;
        }
        if (!existsSync(base)) {
          const candidate =
            ctx.config.baselineApproval === "auto"
              ? base
              : join(dirname(base), "..", "candidates", `${snap.name}-${width}.png`);
          mkdirSync(dirname(candidate), { recursive: true });
          writeFileSync(candidate, png);
          if (ctx.config.baselineApproval === "human") {
            add(
              fail(
                "visual-snapshot",
                `${snap.name} @${width}px: no approved baseline; a candidate was written for a person to approve`,
                { suggestedAction: gateCopy.visualBaseline(`${snap.name} @${width}px`) },
              ),
            );
          } else advisories.push(`visual baseline recorded: ${snap.name} @${width}px`);
          continue;
        }
        const ratio = pixelDiffRatio(decodePng(readFileSync(base)), decodePng(png));
        if (ratio > ctx.config.threshold) {
          const out = join(ctx.stateDir, "visual", "actual", `${snap.name}-${width}.png`);
          mkdirSync(dirname(out), { recursive: true });
          writeFileSync(out, png);
          add(
            fail(
              "visual-snapshot",
              `${snap.name} @${width}px differs from its baseline in ${(ratio * 100).toFixed(2)}% of pixels (limit ${(ctx.config.threshold * 100).toFixed(2)}%)`,
              { actual: out, expected: base },
            ),
          );
        }
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
    }
  } finally {
    await browser.close();
    served?.stop();
  }
  return {
    failures,
    outcomes: gates.map((g) => outcome(g, (byGate.get(g) ?? 0) === 0)),
    advisories,
  };
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
