import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A local Chromium for rendering pages (L20 `browse`, the visual gates):
 * SEKHEMET_CHROME, an installed Chrome or Chromium, or a Playwright-cached
 * headless shell. Nothing is downloaded.
 */
export function findChrome(): string | undefined {
  const env = process.env.SEKHEMET_CHROME;
  if (env && existsSync(env)) return env;
  // The headless shell first: it starts in a fraction of a second and exits
  // when done; a full Chrome can linger after --dump-dom.
  const shells: string[] = [];
  for (const root of [
    join(homedir(), "Library", "Caches", "ms-playwright"),
    join(homedir(), ".cache", "ms-playwright"),
  ]) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root)
      .filter((x) => x.startsWith("chromium_headless_shell"))
      .sort()
      .reverse()) {
      for (const sub of [
        "chrome-headless-shell-mac-arm64/chrome-headless-shell",
        "chrome-headless-shell-mac-x64/chrome-headless-shell",
        "chrome-headless-shell-linux64/chrome-headless-shell",
        "chrome-mac/headless_shell",
        "chrome-linux/headless_shell",
      ]) {
        shells.push(join(root, d, sub));
      }
    }
  }
  const full = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return [...shells, ...full].find((c) => existsSync(c));
}

/** True for a headless shell binary (no `--headless=new` flag; it is always headless). */
export function isHeadlessShell(path: string): boolean {
  return /headless[_-]shell/.test(path);
}

/** The rendered DOM of `url` (scripts run), through headless Chrome; undefined without Chrome. */
export function dumpDom(url: string, timeoutMs = 15_000): Promise<string | undefined> {
  const chrome = findChrome();
  if (!chrome) return Promise.resolve(undefined);
  const profile = mkdtempSync(join(tmpdir(), "sekhemet-chrome-"));
  return new Promise((resolve) => {
    const child = spawn(
      chrome,
      [
        ...(isHeadlessShell(chrome) ? [] : ["--headless=new"]),
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profile}`,
        "--virtual-time-budget=5000",
        "--dump-dom",
        url,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      rmSync(profile, { recursive: true, force: true });
      resolve(ok && out ? out : undefined);
    };
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0));
  });
}

/** Visible text of an HTML document: scripts, styles and tags dropped, whitespace folded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}
