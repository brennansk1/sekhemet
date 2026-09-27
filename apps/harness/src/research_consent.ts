import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EventLog } from "@sekhemet/kernel";
import {
  type EffectiveNetworkPolicy,
  type NetworkRequestRecord,
  mergeNetworkConfigs,
  policyFetch,
  policyRefusal,
} from "@sekhemet/sandbox";
import { type NetworkTable, networkConfigs } from "./config_apply.js";
import { egressEvent } from "./egress_event.js";
import { researchCopy } from "./research/research_copy.js";
import { userPaths } from "./user_dir.js";

/**
 * The one-time research question (security.md item 29a, NEW-security-8;
 * owner decision O16's default, pending). Research before building needs the
 * network, and nothing leaves the machine without a person's yes: the first
 * time a person starts a new project the harness asks once, before any
 * outbound request, and records the answer as `[network] research =
 * "yes"|"no"` in the user's `config.toml` — the one authoritative source —
 * so no later project asks again. A yes enables only the harness's own
 * research requests, through `NetworkPolicy` and logged; it never opens a
 * route for a card's sandboxed commands. When to ask (a new project's first
 * plan) is design-stage's (S8).
 */

export type ResearchAnswer = "yes" | "no";

/**
 * Every host the harness's own research requests name: the plan's survey,
 * the registry tools (Seshat's and the Researcher's `find_library`,
 * `package_readme`) and the paper indexes. The question names each one
 * (DS-S8-2), and a yes covers exactly the hosts it named (DS-S8-8).
 */
export const RESEARCH_HOSTS = [
  "registry.npmjs.org",
  "pypi.org",
  "api.github.com",
  "huggingface.co",
  "export.arxiv.org",
  "api.openalex.org",
] as const;

/**
 * The hosts the question named before B4.5 added `pypi.org`: what a yes
 * recorded without a `research_hosts` list covers, and no more (DS-S8-8).
 */
export const UNLISTED_YES_HOSTS: readonly string[] = [
  "registry.npmjs.org",
  "api.github.com",
  "huggingface.co",
  "export.arxiv.org",
  "api.openalex.org",
];

/** The user's config.toml under the one user directory (SUR-25); the test override first. */
const userConfigPath = () => process.env.SEKHEMET_USER_CONFIG ?? userPaths().config;

/** The recorded answer, or undefined while the question is unanswered. */
export function researchAnswer(path = userConfigPath()): ResearchAnswer | undefined {
  return networkConfigs(process.cwd(), path).user.research;
}

/** The hosts the person's yes covers: none without a yes (DS-S8-8). */
export function coveredResearchHosts(user: NetworkTable): string[] {
  if (user.research !== "yes") return [];
  return [...(user.researchHosts ?? UNLISTED_YES_HOSTS)];
}

/** The research hosts a yes has not covered: not reached until a yes names them (DS-S8-8). */
export function awaitingResearchHosts(user: NetworkTable): string[] {
  if (user.research !== "yes") return [];
  const covered = coveredResearchHosts(user);
  return RESEARCH_HOSTS.filter((h) => !covered.includes(h));
}

/** The uncovered hosts not yet asked about: the next new project's question names these. */
export function unaskedResearchHosts(user: NetworkTable): string[] {
  const declined = user.researchHostsDeclined ?? [];
  return awaitingResearchHosts(user).filter((h) => !declined.includes(h));
}

/**
 * Why research may not reach `host` although research is allowed: it is one
 * of the research hosts and the person's yes did not name it (DS-S8-8).
 * Undefined for a covered host, and for a host outside `RESEARCH_HOSTS`,
 * which the network policy alone decides (security item 29a).
 */
export function researchHostRefusal(host: string, user: NetworkTable): string | undefined {
  const h = host.toLowerCase().replace(/\.$/, "");
  const named = RESEARCH_HOSTS.find((r) => h === r || h.endsWith(`.${r}`));
  if (!named || user.research !== "yes" || coveredResearchHosts(user).includes(named))
    return undefined;
  return (user.researchHostsDeclined ?? []).includes(named)
    ? researchCopy.hostDeclined(named)
    : researchCopy.hostAwaitsYes(named);
}

/**
 * A research request refused because the person's yes did not name its host
 * (DS-S8-8): its message says which host awaits a yes, and a tool shows it
 * rather than an empty result.
 */
export class ResearchHostAwaitsYes extends Error {
  constructor(
    readonly host: string,
    reason: string,
  ) {
    super(`network policy refused ${host}: ${reason}`);
    this.name = "ResearchHostAwaitsYes";
  }
}

const tomlList = (hosts: readonly string[]) => `[${hosts.map((h) => `"${h}"`).join(", ")}]`;

/**
 * Set keys in the user's config.toml `[network]` table, each set or
 * replaced, every other line kept as it was.
 */
function writeNetworkKeys(path: string, entries: ReadonlyArray<[string, string]>): void {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  const header = lines.findIndex((l) => /^\s*\[network\]\s*(#.*)?$/.test(l));
  if (header === -1) {
    const body = lines.join("\n").replace(/\n*$/, "");
    const table = entries.map(([k, v]) => `${k} = ${v}`).join("\n");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${body ? `${body}\n\n` : ""}[network]\n${table}\n`);
    return;
  }
  let end = lines.length;
  for (let i = header + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  const added: string[] = [];
  for (const [key, value] of entries) {
    const entry = `${key} = ${value}`;
    const at = lines
      .slice(header + 1, end)
      .findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    if (at === -1) added.push(entry);
    else lines[header + 1 + at] = entry;
  }
  lines.splice(header + 1, 0, ...added);
  writeFileSync(path, lines.join("\n").replace(/\n*$/, "\n"));
}

/**
 * Record the answer in the user's config.toml: `research` in its `[network]`
 * table, set or replaced, every other line kept as it was; with a yes, the
 * hosts the question named as `research_hosts` (DS-S8-8).
 */
export function recordResearchAnswer(
  answer: ResearchAnswer,
  path = userConfigPath(),
  hosts: readonly string[] = RESEARCH_HOSTS,
): void {
  writeNetworkKeys(path, [
    ["research", `"${answer}"`],
    ...(answer === "yes" ? [["research_hosts", tomlList(hosts)] as [string, string]] : []),
  ]);
}

/**
 * Record the answer to the question naming hosts an earlier yes did not
 * (DS-S8-8): a yes adds them to `research_hosts`, a no records them in
 * `research_hosts_declined`, so neither is asked again; either way the list
 * a yes without one covered is written out.
 */
export function recordResearchHostsAnswer(
  yes: boolean,
  hosts: readonly string[],
  path = userConfigPath(),
): void {
  const user = networkConfigs(process.cwd(), path).user;
  const covered = coveredResearchHosts(user);
  const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];
  writeNetworkKeys(path, [
    ["research_hosts", tomlList(yes ? union(covered, hosts) : covered)],
    ...(yes
      ? []
      : [
          ["research_hosts_declined", tomlList(union(user.researchHostsDeclined ?? [], hosts))] as [
            string,
            string,
          ],
        ]),
  ]);
}

/**
 * Ask the question once (SEC-52): the recorded answer when there is one;
 * otherwise the person's, recorded — when there is a person to ask — with
 * the hosts the question named. With no one to ask (no TTY, a headless run)
 * nothing is recorded and research stays offline: silence is never a yes.
 */
export async function askResearchOnce(options: {
  ask?: () => Promise<boolean>;
  path?: string;
  /** The hosts the question names; a yes covers exactly these (DS-S8-8). */
  hosts?: readonly string[];
}): Promise<ResearchAnswer | undefined> {
  const path = options.path ?? userConfigPath();
  const recorded = researchAnswer(path);
  if (recorded) return recorded;
  if (!options.ask) return undefined;
  const answer: ResearchAnswer = (await options.ask()) ? "yes" : "no";
  recordResearchAnswer(answer, path, options.hosts ?? RESEARCH_HOSTS);
  return answer;
}

/**
 * The effective network policy for research in this repository, each
 * `fetch_deny` rule and each ignored widening naming the file it came from
 * (design-stage DS-N4-3, DS-N4-4).
 */
export function researchPolicy(repoPath: string): {
  policy: EffectiveNetworkPolicy;
  project: NetworkTable;
  user: NetworkTable;
} {
  const user = userConfigPath();
  const n = networkConfigs(repoPath, user);
  return {
    policy: mergeNetworkConfigs(n.user, n.project, {
      user,
      project: join(repoPath, ".sekhemet", "config.toml"),
    }),
    project: n.project,
    user: n.user,
  };
}

/**
 * The Researcher's fetch (items 29a, 32; SEC-52a, SEC-52b): only when the
 * effective policy says research is allowed — the user's yes, not narrowed
 * by the project — then through `policyFetch` as research (the one exception
 * to `mode`, bounded by a non-empty `fetch_allow`, minus `fetch_deny`). Every
 * request, allowed or refused, is recorded on the ledger as `harness/egress`.
 */
export function researchFetch(
  repoPath: string,
  log: EventLog,
): (input: string | URL, init?: RequestInit) => Promise<Response> {
  const { policy, project, user } = researchPolicy(repoPath);
  const n = { project };
  // A request whose record fails fails too (security item 33).
  const record = (r: NetworkRequestRecord) => log.append({ actor: "harness", ...egressEvent(r) });
  const fetchVia = policyFetch(policy, { purpose: "research", research: true, record });
  return async (input, init) => {
    const url = new URL(String(input));
    const reason =
      policy.research !== "yes"
        ? `research not allowed ([network] research is not "yes"${n.project.research === "no" ? " for this project" : ""})`
        : researchHostRefusal(url.hostname, user);
    if (reason) {
      await log.append({
        actor: "harness",
        ...egressEvent({
          url: url.toString(),
          host: url.hostname,
          purpose: "research",
          allowed: false,
          reason,
          payloadHash: "",
          at: new Date().toISOString(),
        }),
      });
      throw new Error(`network policy refused ${url.hostname}: ${reason}`);
    }
    return fetchVia(input, init);
  };
}

/**
 * The same policy for research requests the harness cannot send through
 * `fetch` — a `gh` call, a page Crawl4AI's browser reads (NEW-security-8):
 * decided before the request, recorded on the ledger as `harness/egress`
 * with purpose `research:<via>`, and thrown as the refusal when refused.
 */
export function researchGate(
  repoPath: string,
  log: EventLog,
): (url: string, via: string) => Promise<void> {
  const { policy, project, user } = researchPolicy(repoPath);
  const n = { project };
  return async (url, via) => {
    const u = new URL(url);
    const reason =
      policy.research !== "yes"
        ? `research not allowed ([network] research is not "yes"${n.project.research === "no" ? " for this project" : ""})`
        : (researchHostRefusal(u.hostname, user) ??
          policyRefusal(policy, u.hostname, { research: true }));
    await log.append({
      actor: "harness",
      ...egressEvent({
        url: u.toString(),
        host: u.hostname,
        purpose: `research:${via}`,
        allowed: reason === undefined,
        ...(reason ? { reason } : {}),
        payloadHash: "",
        at: new Date().toISOString(),
      }),
    });
    if (reason) throw new Error(`network policy refused ${u.hostname}: ${reason}`);
  };
}
