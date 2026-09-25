import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
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
}

const STRICTNESS: Record<NetworkMode, number> = { offline: 0, allowlist: 1, open: 2 };

/** Merge the user's and the project's `[network]` tables (item 28). */
export function mergeNetworkConfigs(
  user: NetworkConfig,
  project: NetworkConfig,
): EffectiveNetworkPolicy {
  const userMode = user.mode ?? "offline";
  const mode =
    project.mode && STRICTNESS[project.mode] < STRICTNESS[userMode] ? project.mode : userMode;
  const userAllow = (user.fetchAllow ?? []).map((h) => h.toLowerCase());
  const fetchAllow = project.fetchAllow
    ? userAllow.filter((h) => project.fetchAllow?.map((p) => p.toLowerCase()).includes(h))
    : userAllow;
  const fetchDeny = [...new Set([...(user.fetchDeny ?? []), ...(project.fetchDeny ?? [])])].map(
    (h) => h.toLowerCase(),
  );
  const research = user.research === "yes" && project.research !== "no" ? "yes" : "no";
  return { mode, fetchAllow, fetchDeny, research };
}

const denied = (host: string, policy: EffectiveNetworkPolicy) =>
  policy.fetchDeny.length > 0 && domainAllowed(host, policy.fetchDeny);

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
  if (denied(host, policy)) return sandboxCopy.policyReason.denied;
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
  options: { purpose: string; record?: (r: NetworkRequestRecord) => void; research?: boolean },
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
    const refuse = (reason: string): never => {
      options.record?.({ ...base, allowed: false, reason });
      throw new Error(`network policy refused ${host}: ${reason}`);
    };
    const refusal = policyRefusal(policy, host, options);
    if (refusal) refuse(refusal);
    try {
      const res = await send(
        isLoopback(host) ? loopbackUrl(url, host) : url,
        init,
        isLoopback(host),
      );
      options.record?.({ ...base, allowed: true, status: res.status });
      return res;
    } catch (err) {
      return refuse(err instanceof Error ? err.message : String(err));
    }
  };
}

/** Statuses a `Response` may not carry a body for. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

function send(url: URL, init: RequestInit | undefined, loopback: boolean): Promise<Response> {
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
