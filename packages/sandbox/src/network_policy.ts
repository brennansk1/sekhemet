import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { relative, sep } from "node:path";
import { Readable } from "node:stream";
import { useAgent } from "request-filtering-agent";
import { sandboxCopy } from "./copy.js";
import { canonicalHost, domainAllowed } from "./egress.js";

/**
 * The one network policy (security items 28–33, S3).
 *
 * The user's `config.toml` is authoritative; a project's may only narrow it
 * (deny more hosts, allow fewer, turn research off) and never widen `mode`
 * or `research`; `fetch_deny` wins over everything. A card's sandboxed
 * commands are narrowed once more by the repository's `gates.toml`
 * `network_allow`. Harness-side requests go through `policyFetch`, which
 * applies the mode, refuses private and metadata addresses after DNS
 * resolution (`request-filtering-agent`, DEC-39) and records every request.
 */
export type NetworkMode = "offline" | "allowlist" | "open";

export interface NetworkConfig {
  mode?: NetworkMode;
  fetchAllow?: string[];
  fetchDeny?: string[];
  research?: "yes" | "no";
}

export interface EffectiveNetworkPolicy {
  mode: NetworkMode;
  fetchAllow: string[];
  fetchDeny: string[];
  research: "yes" | "no";
  /** Each `fetch_deny` rule with the file that wrote it, so a refusal names both (DS-N4-3). */
  denyRules?: NetworkRule[];
  /** What a project's file tried to widen and was ignored (DS-N4-4). */
  ignored?: IgnoredWidening[];
}

/** One rule of a `[network]` list and the file it came from. */
export interface NetworkRule {
  rule: string;
  /** The file's path, or its label: shown to the person, never recorded. */
  file: string;
  /**
   * Which file it is. A refusal's reason names the file by this role, never
   * by its path: the reason goes onto the ledger (`harness/egress`), where a
   * home directory's path would put the person's name in a field that
   * cannot be erased.
   */
  role?: "user" | "project";
}

/** A project's attempt to widen the user's policy: ignored, and reported. */
export interface IgnoredWidening {
  file: string;
  key: "mode" | "fetch_allow" | "research";
  value: string;
}

/** Where each `[network]` table was read from; labels when no path is known. */
export interface NetworkConfigFiles {
  user?: string;
  project?: string;
}

const DEFAULT_FILES: Required<NetworkConfigFiles> = {
  user: "the user's config.toml",
  project: "the project's .sekhemet/config.toml",
};

/**
 * A config file's path as a refusal names it: relative to the project's
 * root when it is under `root`, from `~` when it is under the home
 * directory, never an absolute home path (a refusal reaches a model and a
 * log). Any other path is given as it is.
 */
export function displayConfigPath(path: string, root?: string): string {
  if (!path) return path;
  const under = (dir: string) => dir !== "" && (path === dir || path.startsWith(`${dir}${sep}`));
  if (root && under(root)) return relative(root, path) || ".";
  const home = homedir();
  if (under(home)) return `~${path.slice(home.length)}`;
  return path;
}

const STRICTNESS: Record<NetworkMode, number> = { offline: 0, allowlist: 1, open: 2 };

/** Merge the user's and the project's `[network]` tables (item 28). */
export function mergeNetworkConfigs(
  user: NetworkConfig,
  project: NetworkConfig,
  files: NetworkConfigFiles = {},
): EffectiveNetworkPolicy {
  const userFile = files.user ?? DEFAULT_FILES.user;
  const projectFile = files.project ?? DEFAULT_FILES.project;
  const userMode = user.mode ?? "offline";
  const mode =
    project.mode && STRICTNESS[project.mode] < STRICTNESS[userMode] ? project.mode : userMode;
  const userAllow = (user.fetchAllow ?? []).map((h) => h.toLowerCase());
  const projectAllow = project.fetchAllow?.map((p) => p.toLowerCase());
  const fetchAllow = projectAllow ? userAllow.filter((h) => projectAllow.includes(h)) : userAllow;
  const denyRules: NetworkRule[] = [
    ...(user.fetchDeny ?? []).map((rule) => ({
      rule: rule.toLowerCase(),
      file: userFile,
      role: "user" as const,
    })),
    ...(project.fetchDeny ?? []).map((rule) => ({
      rule: rule.toLowerCase(),
      file: projectFile,
      role: "project" as const,
    })),
  ];
  const fetchDeny = [...new Set(denyRules.map((r) => r.rule))];
  const research = user.research === "yes" && project.research !== "no" ? "yes" : "no";
  // DS-N4-4: a project's file may only narrow; each widening is ignored and named.
  const ignored: IgnoredWidening[] = [
    ...(project.mode && STRICTNESS[project.mode] > STRICTNESS[userMode]
      ? [{ file: projectFile, key: "mode" as const, value: project.mode }]
      : []),
    ...(projectAllow ?? [])
      .filter((h) => !userAllow.includes(h))
      .map((h) => ({ file: projectFile, key: "fetch_allow" as const, value: h })),
    ...(project.research === "yes" && user.research !== "yes"
      ? [{ file: projectFile, key: "research" as const, value: "yes" }]
      : []),
  ];
  return { mode, fetchAllow, fetchDeny, research, denyRules, ignored };
}

const denied = (host: string, policy: EffectiveNetworkPolicy) =>
  policy.fetchDeny.length > 0 && domainAllowed(host, policy.fetchDeny);

/** The `fetch_deny` rule that covers `host`, with its file when the policy kept it. */
function denyHit(host: string, policy: EffectiveNetworkPolicy): NetworkRule {
  return (
    policy.denyRules?.find((r) => domainAllowed(host, [r.rule])) ?? {
      rule: policy.fetchDeny.find((r) => domainAllowed(host, [r])) ?? host,
      file: "",
    }
  );
}

/**
 * Why a denied host is refused, with the file and the rule that refused it
 * (DS-N4-3). The file is named by its role ("the user's config.toml"), never
 * by its path: this reason is recorded on the ledger. A policy built without
 * provenance names the rule alone.
 */
function deniedReason(host: string, policy: EffectiveNetworkPolicy): string {
  const hit = denyHit(host, policy);
  const where = hit.role ? `${DEFAULT_FILES[hit.role]}: ${hit.rule}` : hit.rule;
  return `${sandboxCopy.policyReason.denied} [${where}]`;
}

/**
 * The hosts a card's sandboxed commands may reach: the effective allowlist,
 * narrowed by the repository's `network_allow`, minus `fetch_deny`. Offline,
 * nothing (item 30).
 */
export function cardAllowlist(
  policy: EffectiveNetworkPolicy,
  networkAllow: readonly string[],
): string[] {
  if (policy.mode === "offline") return [];
  return networkAllow
    .map((h) => h.toLowerCase())
    .filter(
      (h) => (policy.mode === "open" || domainAllowed(h, policy.fetchAllow)) && !denied(h, policy),
    );
}

/** An ecosystem whose generator card zero runs (design-stage DS-P2-1, -2). */
export type GeneratorRegistry = "npm" | "python" | "rust" | "go";

/** Each ecosystem's package registry hosts: all card zero's generator steps may reach. */
export const GENERATOR_REGISTRY_HOSTS: Readonly<Record<GeneratorRegistry, readonly string[]>> = {
  npm: ["registry.npmjs.org"],
  python: ["pypi.org", "files.pythonhosted.org"],
  rust: ["crates.io", "static.crates.io", "index.crates.io"],
  go: ["proxy.golang.org", "sum.golang.org"],
};

/**
 * The hosts card zero's generator steps may reach (DS-P2-1, -2): a person's
 * Create project approved the named generator, so its steps — and only
 * they, on that card only — reach that ecosystem's package registry, whatever
 * `mode` says; `fetch_deny` still wins. Nothing else is widened.
 */
export function generatorAllowlist(
  policy: EffectiveNetworkPolicy,
  registry: GeneratorRegistry,
): string[] {
  return GENERATOR_REGISTRY_HOSTS[registry].filter((h) => !denied(h, policy));
}

/** Upload-capable hosts: an allowlist entry for one is an exfiltration route (item 31a). */
const UPLOAD_CAPABLE = [
  "github.com",
  "gist.github.com",
  "gitlab.com",
  "bitbucket.org",
  "pastebin.com",
  "transfer.sh",
  "file.io",
  "api.github.com",
  "uploads.github.com",
];

export interface AllowlistWarning {
  host: string;
  reason: string;
}

/** SEC-15b: wildcard and upload-capable entries, warned when added and recorded on every card. */
export function allowlistWarnings(hosts: readonly string[]): AllowlistWarning[] {
  return hosts.flatMap((host) => {
    const h = host.toLowerCase();
    if (h.includes("*")) return [{ host, reason: "a wildcard entry allows every subdomain" }];
    if (UPLOAD_CAPABLE.some((u) => h === u || h.endsWith(`.${u}`))) {
      return [{ host, reason: "an upload-capable host can carry data out" }];
    }
    return [];
  });
}

export interface NetworkRequestRecord {
  url: string;
  host: string;
  purpose: string;
  allowed: boolean;
  reason?: string;
  status?: number;
  payloadHash: string;
  at: string;
}

const isLoopback = (host: string) =>
  host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));

/** `localhost` is sent to 127.0.0.1 itself, never to a resolver (B1 review). */
const loopbackUrl = (url: URL, host: string): URL => {
  if (host !== "localhost") return url;
  const u = new URL(url);
  u.hostname = "127.0.0.1";
  return u;
};

/**
 * A `fetch` for harness-side requests (item 32): registry lookups, research
 * fetches, clones. Every call is decided by the policy and recorded; allowed
 * public requests run through `request-filtering-agent`, which refuses a
 * private, loopback or metadata address after resolution.
 */
/**
 * Why the policy refuses a request to `host`, or undefined when it allows it:
 * the one decision `policyFetch` applies, for a request the harness cannot
 * send itself — a `gh` call or a page a browser reads (NEW-security-8).
 */
export function policyRefusal(
  policy: EffectiveNetworkPolicy,
  host: string,
  options: { research?: boolean } = {},
): string | undefined {
  if (isLoopback(host)) return undefined;
  const researchOk = options.research === true && policy.research === "yes";
  if (denied(host, policy)) return deniedReason(host, policy);
  if (policy.mode === "offline" && !researchOk) return sandboxCopy.policyReason.offline;
  if (policy.mode === "allowlist" && !researchOk && !domainAllowed(host, policy.fetchAllow)) {
    return sandboxCopy.policyReason.notAllowed;
  }
  // Item 29a: research is the one exception to `mode`, still bounded by a
  // non-empty `fetch_allow`.
  if (researchOk && policy.fetchAllow.length > 0 && !domainAllowed(host, policy.fetchAllow)) {
    return sandboxCopy.policyReason.researchOutside;
  }
  return undefined;
}

/**
 * Whether the policy refuses no public host for this purpose — the only case
 * in which a reader whose own requests the policy cannot see (a browser's
 * sub-requests) may run (NEW-security-8).
 */
export function policyAllowsEveryHost(
  policy: EffectiveNetworkPolicy,
  options: { research?: boolean } = {},
): boolean {
  if (policy.fetchDeny.length > 0) return false;
  if (options.research === true && policy.research === "yes") return policy.fetchAllow.length === 0;
  return policy.mode === "open";
}

export function policyFetch(
  policy: EffectiveNetworkPolicy,
  options: {
    purpose: string;
    record?: (r: NetworkRequestRecord) => undefined | Promise<unknown>;
    research?: boolean;
    /**
     * Stream the body instead of buffering it: a model download is gigabytes
     * (models MD-N12-6, SEC-53), decided and recorded like any other request.
     */
    stream?: boolean;
  },
): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = new URL(String(input));
    const canon = canonicalHost(url.hostname.replace(/^\[|\]$/g, ""));
    const host = "host" in canon ? canon.host : url.hostname;
    const body = typeof init?.body === "string" ? init.body : "";
    const base = {
      url: url.toString(),
      host,
      purpose: options.purpose,
      payloadHash: createHash("sha256")
        .update(`${init?.method ?? "GET"} ${url}\n${body}`)
        .digest("hex"),
      at: new Date().toISOString(),
    };
    // Each decision is recorded before the caller sees it, and a record that
    // cannot be written fails the request (security item 33).
    const refuse = async (reason: string, where?: string): Promise<never> => {
      await options.record?.({ ...base, allowed: false, reason });
      throw new Error(`network policy refused ${host}: ${reason}${where ? ` (${where})` : ""}`);
    };
    const refusal = policyRefusal(policy, host, options);
    // The person is told the file's path; only its role is recorded (DS-N4-3).
    const file = denied(host, policy) ? denyHit(host, policy).file : "";
    const where = file ? displayConfigPath(file) : "";
    if (refusal) return refuse(refusal, where && !refusal.includes(where) ? where : undefined);
    let res: Response;
    try {
      res = await send(
        isLoopback(host) ? loopbackUrl(url, host) : url,
        init,
        isLoopback(host),
        options.stream === true,
      );
    } catch (err) {
      return refuse(err instanceof Error ? err.message : String(err));
    }
    await options.record?.({ ...base, allowed: true, status: res.status });
    return res;
  };
}

/** Statuses a `Response` may not carry a body for. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

function send(
  url: URL,
  init: RequestInit | undefined,
  loopback: boolean,
  stream = false,
): Promise<Response> {
  const req = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const r = req(
      url,
      {
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers ?? {})),
        ...(loopback ? {} : { agent: useAgent(url.toString()) }),
        ...(init?.signal ? { signal: init.signal } : {}),
        timeout: 15_000,
      },
      (res) => {
        if (stream) {
          const status = res.statusCode ?? 0;
          resolve(
            new Response(
              NULL_BODY.has(status) ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>),
              { status, headers: res.headers as Record<string, string> },
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve(
            new Response(NULL_BODY.has(res.statusCode ?? 0) ? null : Buffer.concat(chunks), {
              status: res.statusCode ?? 0,
              headers: res.headers as Record<string, string>,
            }),
          ),
        );
        res.on("error", reject);
      },
    );
    r.on("timeout", () => r.destroy(new Error("request timed out")));
    r.on("error", reject);
    if (typeof init?.body === "string") r.write(init.body);
    r.end();
  });
}
