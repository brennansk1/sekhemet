import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { userPaths } from "../user_dir.js";

/**
 * A private SearXNG (AGPL-3.0, run as a separate service, not linked) for the
 * Researcher's web search, with no API key. Run the way Helga runs its own:
 * JSON output on, the rate limiter off (only we call it), and the engines that
 * answer reliably from a home connection. Google, Bing, DuckDuckGo, Brave and
 * Startpage are disabled because they CAPTCHA automated traffic, and Helga
 * measured that a CAPTCHA page gets cached as "nothing on the web about this".
 *
 * Its own container (sekhemet-searxng) on 127.0.0.1 only; Helga's are untouched.
 */

export const SEARXNG_CONTAINER = "sekhemet-searxng";
export const SEARXNG_PORT = Number(process.env.SEKHEMET_SEARXNG_PORT ?? 8890);
export const SEARXNG_URL = `http://127.0.0.1:${SEARXNG_PORT}`;
const IMAGE = "searxng/searxng:latest";

export function searxngSettings(secret: string): string {
  const on = (name: string, engine = name, extra = "") =>
    `  - name: ${name}\n    engine: ${engine}\n    disabled: false${extra}\n`;
  const off = (name: string) => `  - name: ${name}\n    engine: ${name}\n    disabled: true\n`;
  return `use_default_settings: true
general:
  instance_name: sekhemet-research
search:
  formats: [html, json]
  default_lang: en
  safe_search: 0
server:
  limiter: false
  image_proxy: false
  port: 8080
  bind_address: "0.0.0.0"
  secret_key: "${secret}"
outgoing:
  request_timeout: 6.0
  max_request_timeout: 10.0
  pool_connections: 20
engines:
${on("wikipedia")}${on("mojeek")}${on("yep")}${on("stackexchange", "stackexchange", "\n    api_site: stackoverflow")}${on("github")}${on("arxiv")}${on("npm")}${on("pypi")}${on("mdn")}${on("docker hub", "docker_hub")}${off("google")}${off("bing")}${off("duckduckgo")}${off("brave")}${off("startpage")}${off("qwant")}`;
}

export type Exec = (cmd: string, args: string[]) => Promise<string>;
const realExec: Exec = async (cmd, args) =>
  (await promisify(execFile)(cmd, args, { timeout: 120_000 })).stdout;

async function healthy(fetchFn: typeof fetch): Promise<boolean> {
  try {
    const r = await fetchFn(`${SEARXNG_URL}/search?q=sqlite&format=json`, {
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Make sure the private SearXNG is running. Returns its URL, or undefined when
 * Docker or the image is not available (web search then reports it is off).
 */
export async function ensureSearxng(
  opts: { exec?: Exec; fetch?: typeof fetch; configDir?: string } = {},
): Promise<string | undefined> {
  const exec = opts.exec ?? realExec;
  const f = opts.fetch ?? fetch;
  if (await healthy(f)) return SEARXNG_URL;
  try {
    await exec("docker", ["info", "--format", "{{.ServerVersion}}"]);
  } catch {
    return undefined;
  }
  const running = await exec("docker", [
    "ps",
    "-a",
    "--filter",
    `name=^${SEARXNG_CONTAINER}$`,
    "--format",
    "{{.State}}",
  ]).catch(() => "");
  if (running.trim() === "") {
    const images = await exec("docker", ["images", "-q", IMAGE]).catch(() => "");
    if (!images.trim()) return undefined; // never pull implicitly: a download needs consent
    const dir = opts.configDir ?? userPaths().searxng;
    mkdirSync(dir, { recursive: true });
    const settings = join(dir, "settings.yml");
    if (!existsSync(settings)) {
      writeFileSync(settings, searxngSettings(randomBytes(24).toString("hex")), { mode: 0o600 });
    }
    await exec("docker", [
      "run",
      "-d",
      "--name",
      SEARXNG_CONTAINER,
      "--restart",
      "unless-stopped",
      "-p",
      `127.0.0.1:${SEARXNG_PORT}:8080`,
      "-v",
      `${dir}:/etc/searxng:rw`,
      "--memory",
      "384m",
      IMAGE,
    ]);
  } else if (running.trim() !== "running") {
    await exec("docker", ["start", SEARXNG_CONTAINER]);
  }
  for (let i = 0; i < 30; i++) {
    if (await healthy(f)) return SEARXNG_URL;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return undefined;
}
