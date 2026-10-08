import type { EventLog } from "@sekhemet/kernel";
import { mergeNetworkConfigs, policyFetch, policyRefusal } from "@sekhemet/sandbox";
import { userConfigPath } from "./config.js";
import { networkConfigs } from "./config_apply.js";
import { egressEvent } from "./egress_event.js";
import { networkHint } from "./github_transport.js";

/**
 * Learning that a release exists (surface item 34, NEW-surface-9; DEC-53
 * c5; FINDINGS_C1 INS-02). Sekhemet never asks on its own: this runs only
 * from `sekhemet doctor --check-updates`, which names the one host it will
 * ask and sends nothing before the person's yes (`--yes` for a script). The
 * request goes through the one network policy (item 24) as a plain GET of the
 * package's `latest` record — no identifier of the install or the person, no
 * cookie, no user agent of ours — and is recorded as egress where a ledger is
 * open. Where the policy does not allow the host, nothing is sent and the
 * setting that would allow it is printed (SUR-67).
 */

/** The npm registry, where the package of surface item 31 is published. */
export const UPDATE_HOST = "registry.npmjs.org";
export const PACKAGE_NAME = "sekhemet";
export const LATEST_URL = `https://${UPDATE_HOST}/${PACKAGE_NAME}/latest`;
/** Where a version's release notes are read. */
export const releaseNotesUrl = (version: string): string =>
  `https://github.com/brennansk1/sekhemet/releases/tag/v${version}`;

/** -1, 0 or 1 as `a` is older than, the same as or newer than `b` (numeric x.y.z; a pre-release is older). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  return 0;
}

export interface UpdateCheckDeps {
  repoPath: string;
  installed: string;
  /** The person's yes: `--yes`, or an answer at a terminal. Undefined when there is no terminal. */
  confirm: () => Promise<boolean | undefined>;
  /** The ledger to record the request in, where one is open. */
  log?: EventLog;
  print?: (line: string) => void;
}

/** Returns the exit code: 0 answered, 1 refused or failed, 2 not confirmed. */
export async function checkForUpdates(deps: UpdateCheckDeps): Promise<0 | 1 | 2> {
  const print = deps.print ?? ((l: string) => console.log(l));
  print(
    `This asks one host, ${UPDATE_HOST}, for the latest published version of ${PACKAGE_NAME}. It sends no identifier of this install or of you.`,
  );
  const n = networkConfigs(deps.repoPath, userConfigPath());
  const policy = mergeNetworkConfigs(n.user, n.project);
  const refused = policyRefusal(policy, UPDATE_HOST);
  if (refused) {
    const allow =
      refused === "offline"
        ? `Sekhemet is offline (the default): to allow this check, set [network] mode = "allowlist" with fetch_allow = ["${UPDATE_HOST}"] (or mode = "open") in your user config.toml`
        : networkHint(refused, UPDATE_HOST);
    print(`No request was made. ${allow}.`);
    return 1;
  }
  const yes = await deps.confirm();
  if (yes === undefined) {
    print(
      "No terminal to confirm in: nothing was sent. Run `sekhemet doctor --check-updates --yes` to ask.",
    );
    return 2;
  }
  if (!yes) {
    print("Nothing was sent.");
    return 2;
  }
  const log = deps.log;
  const record = log
    ? (r: Parameters<typeof egressEvent>[0]) =>
        log.append({ actor: "harness", principal: log.localPrincipal(), ...egressEvent(r) })
    : undefined;
  let latest: string | undefined;
  try {
    const res = await policyFetch(policy, {
      purpose: "update check",
      ...(record ? { record } : {}),
    })(LATEST_URL, { headers: { accept: "application/json" } });
    if (res.status === 404) {
      print(
        `Installed: ${deps.installed}. ${PACKAGE_NAME} is not published on ${UPDATE_HOST} yet.`,
      );
      return 1;
    }
    if (!res.ok) {
      print(`${UPDATE_HOST} answered ${res.status}; nothing is known about a newer release.`);
      return 1;
    }
    const body = (await res.json()) as { version?: unknown };
    latest = typeof body.version === "string" ? body.version : undefined;
  } catch (err) {
    print(
      `The check did not reach ${UPDATE_HOST}: ${err instanceof Error ? err.message : String(err)}.`,
    );
    return 1;
  }
  if (!latest) {
    print(`${UPDATE_HOST} did not name a version; nothing is known about a newer release.`);
    return 1;
  }
  const order = compareVersions(deps.installed, latest);
  print(`Installed: ${deps.installed}`);
  print(
    `Latest:    ${latest}${order < 0 ? " — a newer release exists" : order === 0 ? " — up to date" : " — this build is newer"}`,
  );
  print(`Release notes: ${releaseNotesUrl(latest)}`);
  return 0;
}
