import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareVersions } from "@sekhemet/sync";
import { ResearchCache } from "./polite.js";

/**
 * Repository and code intelligence for the Research Desk.
 *
 * Reading the code is usually a better answer than reading about it, and it
 * is free: no model, no page, no rate limit worth speaking of. Everything
 * here is `git` and the `gh` CLI behind a typed interface — a tree, a file at
 * a ref, a code search, the releases between the version installed and the
 * version proposed, the issue thread where the real behaviour is explained,
 * and blame for a line range.
 *
 * Reads are cached by commit SHA. A file at a pinned SHA cannot change, so
 * those entries never expire (`pinned:` keys in `ResearchCache.ttlFor`).
 */

export interface RepoRef {
  owner: string;
  repo: string;
}

const SLUG = /^([A-Za-z0-9][\w.-]*)\/([\w.-]+?)(?:\.git)?$/;
const REF = /^[\w.\-/]{1,120}$/;
const PATH = /^[\w.\-/@+]{1,300}$/;

/** `owner/repo`, or a GitHub URL, as a validated pair. Never a shell string. */
export function parseSlug(spec: string): RepoRef | undefined {
  const cleaned = spec
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\/(tree|blob)\/.*$/, "");
  const m = SLUG.exec(cleaned);
  if (!m?.[1] || !m[2] || cleaned.includes("..")) return undefined;
  return { owner: m[1], repo: m[2] };
}

const cache = new ResearchCache();

function gh(args: string[], timeoutMs = 20_000): string {
  return execFileSync("gh", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Whether `gh` exists and is authenticated; the caller degrades rather than throws. */
export function ghReady(): boolean {
  try {
    gh(["auth", "status"], 8000);
    return true;
  } catch {
    return false;
  }
}

function cached(key: string, produce: () => string): string {
  const hit = cache.get(key);
  if (hit) return hit.body;
  const body = produce();
  cache.set(key, 200, "text/plain", body);
  return body;
}

/** The commit SHA a ref points at, which is the cache key for everything below. */
export function resolveRef(r: RepoRef, ref = "HEAD"): string | undefined {
  if (!REF.test(ref)) return undefined;
  try {
    const key = `gh:sha:${r.owner}/${r.repo}@${ref}`;
    const sha = cached(key, () =>
      ref === "HEAD"
        ? (JSON.parse(gh(["api", `repos/${r.owner}/${r.repo}`])) as { default_branch: string })
            .default_branch &&
          gh(["api", `repos/${r.owner}/${r.repo}/commits/HEAD`, "--jq", ".sha"])
        : gh(["api", `repos/${r.owner}/${r.repo}/commits/${ref}`, "--jq", ".sha"]),
    );
    return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/** The file tree at a ref, optionally under a prefix. */
export function repoTree(r: RepoRef, ref = "HEAD", prefix = "", limit = 300): string {
  const sha = resolveRef(r, ref);
  if (!sha) return `Cannot resolve ${ref} in ${r.owner}/${r.repo}.`;
  const body = cached(`pinned:gh:tree:${sha}`, () =>
    gh(["api", `repos/${r.owner}/${r.repo}/git/trees/${sha}?recursive=1`, "--jq", ".tree[].path"]),
  );
  const paths = body
    .split("\n")
    .filter((p) => p && (!prefix || p.startsWith(prefix)))
    .slice(0, limit);
  return paths.length
    ? `${r.owner}/${r.repo} at ${sha.slice(0, 8)}${prefix ? ` under ${prefix}` : ""}:\n${paths.join("\n")}`
    : `No files${prefix ? ` under ${prefix}` : ""} at ${sha.slice(0, 8)}.`;
}

/** One file's text at a ref. The most accurate answer to most API questions. */
export function repoFile(r: RepoRef, path: string, ref = "HEAD", maxBytes = 60_000): string {
  if (!PATH.test(path) || path.includes("..")) return "Invalid path.";
  const sha = resolveRef(r, ref);
  if (!sha) return `Cannot resolve ${ref} in ${r.owner}/${r.repo}.`;
  try {
    const text = cached(`pinned:gh:file:${sha}:${path}`, () =>
      gh([
        "api",
        "-H",
        "Accept: application/vnd.github.raw",
        `repos/${r.owner}/${r.repo}/contents/${path}?ref=${sha}`,
      ]),
    );
    return text.length > maxBytes
      ? `${text.slice(0, maxBytes)}\n[truncated at ${maxBytes} bytes]`
      : text;
  } catch {
    return `No file ${path} at ${sha.slice(0, 8)} in ${r.owner}/${r.repo}.`;
  }
}

/** Code search, inside one repository or across GitHub. */
export function codeSearch(query: string, r?: RepoRef, limit = 20): string {
  const q = query.trim().slice(0, 200);
  if (!q) return "Empty query.";
  try {
    const args = ["search", "code", q, "--limit", String(limit), "--json", "path,repository"];
    if (r) args.push("--repo", `${r.owner}/${r.repo}`);
    const hits = JSON.parse(gh(args, 30_000)) as {
      path: string;
      repository?: { nameWithOwner?: string };
    }[];
    return hits.length
      ? hits
          .map(
            (h) => `${h.repository?.nameWithOwner ?? (r ? `${r.owner}/${r.repo}` : "?")}:${h.path}`,
          )
          .join("\n")
      : `No code matches for "${q}".`;
  } catch (err) {
    return `Code search unavailable: ${err instanceof Error ? err.message.slice(0, 200) : "failed"}`;
  }
}

/**
 * Issues and pull requests by query. Closed ones included on purpose: the
 * behaviour that is not in the documentation is usually explained there.
 */
export function issueSearch(query: string, r?: RepoRef, limit = 15): string {
  const q = query.trim().slice(0, 200);
  if (!q) return "Empty query.";
  try {
    const args = [
      "search",
      "issues",
      q,
      "--limit",
      String(limit),
      "--json",
      "title,url,state,updatedAt",
    ];
    if (r) args.push("--repo", `${r.owner}/${r.repo}`);
    const hits = JSON.parse(gh(args, 30_000)) as {
      title: string;
      url: string;
      state: string;
      updatedAt: string;
    }[];
    return hits.length
      ? hits
          .map((h) => `[${h.state}] ${h.title}\n  ${h.url} (${h.updatedAt.slice(0, 10)})`)
          .join("\n")
      : `No issues or pull requests match "${q}".`;
  } catch (err) {
    return `Issue search unavailable: ${err instanceof Error ? err.message.slice(0, 200) : "failed"}`;
  }
}

/** `a` is a later version than `b`, by SemVer precedence (DEC-44: the semver library). */
function newer(a: string, b: string): boolean {
  return compareVersions(a, b) > 0;
}

/**
 * Release notes for every version between the one installed and the one
 * proposed. This is the question an upgrade actually asks, and no single
 * page on the web answers it.
 */
export function releasesBetween(r: RepoRef, from: string, to: string, maxChars = 12_000): string {
  if (!REF.test(from) || !REF.test(to)) return "Invalid version.";
  try {
    const raw = cached(`gh:releases:${r.owner}/${r.repo}`, () =>
      gh(["api", `repos/${r.owner}/${r.repo}/releases?per_page=100`, "--jq", ".[] | @json"]),
    );
    const all = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { tag_name: string; name?: string; body?: string });
    const between = all
      .filter((rel) => newer(rel.tag_name, from) && !newer(rel.tag_name, to))
      .sort((a, b) => (newer(a.tag_name, b.tag_name) ? 1 : -1));
    if (!between.length)
      return `No releases between ${from} and ${to} in ${r.owner}/${r.repo} (${all.length} releases seen).`;
    let out = `${r.owner}/${r.repo}: ${between.length} release(s) from ${from} to ${to}\n`;
    for (const rel of between) {
      const entry = `\n## ${rel.tag_name}${rel.name && rel.name !== rel.tag_name ? ` — ${rel.name}` : ""}\n${(rel.body ?? "(no notes)").trim()}\n`;
      if (out.length + entry.length > maxChars) return `${out}\n[truncated]`;
      out += entry;
    }
    return out;
  } catch (err) {
    return `Releases unavailable: ${err instanceof Error ? err.message.slice(0, 200) : "failed"}`;
  }
}

/** Who last changed these lines, and in what commit, in the local repository. */
export function blame(repoPath: string, file: string, from: number, to: number): string {
  if (!PATH.test(file) || file.includes("..")) return "Invalid path.";
  const a = Math.max(1, Math.floor(from));
  const b = Math.max(a, Math.floor(to));
  try {
    return execFileSync("git", ["blame", "-L", `${a},${b}`, "--date=short", "--", file], {
      cwd: repoPath,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    }).trim();
  } catch (err) {
    return `Cannot blame ${file}:${a}-${b}: ${err instanceof Error ? err.message.slice(0, 160) : "failed"}`;
  }
}

const cloneRoot = (): string =>
  process.env.SEKHEMET_REPO_CACHE ?? join(homedir(), ".cache", "sekhemet", "repos");

/**
 * A shallow clone, for a question that needs more than a few files. After
 * this, reads are local: grep, tree-sitter, the whole toolchain.
 *
 * The clone and its refresh reach github.com, so the research network gate
 * (`researchGate`: the one network policy plus the person's research yes)
 * decides first and records the request; a refusal is thrown before any git
 * runs (security item 33, NEW-security-8).
 */
export async function shallowClone(
  r: RepoRef,
  gate: (url: string, via: string) => Promise<void>,
  ref = "HEAD",
): Promise<string | undefined> {
  const dir = join(cloneRoot(), `${r.owner}-${r.repo}`);
  await gate(`https://github.com/${r.owner}/${r.repo}.git`, "git");
  try {
    if (existsSync(join(dir, ".git"))) {
      execFileSync("git", ["-C", dir, "fetch", "--depth", "1", "origin", ref], {
        timeout: 120_000,
        stdio: "ignore",
      });
      execFileSync("git", ["-C", dir, "checkout", "-q", "FETCH_HEAD"], {
        timeout: 30_000,
        stdio: "ignore",
      });
      return dir;
    }
    execFileSync(
      "git",
      [
        "clone",
        "--depth",
        "1",
        ...(ref !== "HEAD" ? ["--branch", ref] : []),
        `https://github.com/${r.owner}/${r.repo}.git`,
        dir,
      ],
      { timeout: 180_000, stdio: "ignore" },
    );
    return dir;
  } catch {
    return undefined;
  }
}
