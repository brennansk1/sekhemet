import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EventLog } from "@sekhemet/kernel";
import {
  type NetworkRequestRecord,
  mergeNetworkConfigs,
  policyFetch,
  policyRefusal,
} from "@sekhemet/sandbox";
import { networkConfigs } from "./config_apply.js";
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

/** The user's config.toml under the one user directory (SUR-25); the test override first. */
const userConfigPath = () => process.env.SEKHEMET_USER_CONFIG ?? userPaths().config;

/** The recorded answer, or undefined while the question is unanswered. */
export function researchAnswer(path = userConfigPath()): ResearchAnswer | undefined {
  return networkConfigs(process.cwd(), path).user.research;
}

/**
 * Record the answer in the user's config.toml: `research` in its `[network]`
 * table, set or replaced, every other line kept as it was.
 */
export function recordResearchAnswer(answer: ResearchAnswer, path = userConfigPath()): void {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  const entry = `research = "${answer}"`;
  const header = lines.findIndex((l) => /^\s*\[network\]\s*(#.*)?$/.test(l));
  if (header === -1) {
    const body = lines.join("\n").replace(/\n*$/, "");
    const text = `${body ? `${body}\n\n` : ""}[network]\n${entry}\n`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return;
  }
  let end = lines.length;
  for (let i = header + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  const existing = lines.slice(header + 1, end).findIndex((l) => /^\s*research\s*=/.test(l));
  if (existing === -1) lines.splice(header + 1, 0, entry);
  else lines[header + 1 + existing] = entry;
  writeFileSync(path, lines.join("\n").replace(/\n*$/, "\n"));
}

/**
 * Ask the question once (SEC-52): the recorded answer when there is one;
 * otherwise the person's, recorded — when there is a person to ask. With no
 * one to ask (no TTY, a headless run) nothing is recorded and research stays
 * offline: silence is never a yes.
 */
export async function askResearchOnce(options: {
  ask?: () => Promise<boolean>;
  path?: string;
}): Promise<ResearchAnswer | undefined> {
  const path = options.path ?? userConfigPath();
  const recorded = researchAnswer(path);
  if (recorded) return recorded;
  if (!options.ask) return undefined;
  const answer: ResearchAnswer = (await options.ask()) ? "yes" : "no";
  recordResearchAnswer(answer, path);
  return answer;
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
  const n = networkConfigs(repoPath);
  const policy = mergeNetworkConfigs(n.user, n.project);
  const record = (r: NetworkRequestRecord) => {
    void log
      .append({ actor: "harness", type: "harness/egress", payload: r })
      .catch(() => undefined);
  };
  const fetchVia = policyFetch(policy, { purpose: "research", research: true, record });
  return async (input, init) => {
    if (policy.research !== "yes") {
      const url = new URL(String(input));
      const reason = `research not allowed ([network] research is not "yes"${n.project.research === "no" ? " for this project" : ""})`;
      await log
        .append({
          actor: "harness",
          type: "harness/egress",
          payload: {
            url: url.toString(),
            host: url.hostname,
            purpose: "research",
            allowed: false,
            reason,
            payloadHash: "",
            at: new Date().toISOString(),
          } satisfies NetworkRequestRecord,
        })
        .catch(() => undefined);
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
  const n = networkConfigs(repoPath);
  const policy = mergeNetworkConfigs(n.user, n.project);
  return async (url, via) => {
    const u = new URL(url);
    const reason =
      policy.research !== "yes"
        ? `research not allowed ([network] research is not "yes"${n.project.research === "no" ? " for this project" : ""})`
        : policyRefusal(policy, u.hostname, { research: true });
    await log
      .append({
        actor: "harness",
        type: "harness/egress",
        payload: {
          url: u.toString(),
          host: u.hostname,
          purpose: `research:${via}`,
          allowed: reason === undefined,
          ...(reason ? { reason } : {}),
          payloadHash: "",
          at: new Date().toISOString(),
        } satisfies NetworkRequestRecord,
      })
      .catch(() => undefined);
    if (reason) throw new Error(`network policy refused ${u.hostname}: ${reason}`);
  };
}
