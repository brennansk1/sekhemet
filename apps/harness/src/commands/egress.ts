import { CardStore } from "@sekhemet/kernel";
import { egressLines, egressRows, parseSince } from "../egress_view.js";
import { setupFor } from "../planner_live.js";
import { type Audience, audienceFromAccess, soloAudience } from "../pm/audience.js";
import { Access } from "../team/access.js";
import { personName } from "../team/members.js";
import { type EgressResult, baseResult } from "./cli_result.js";
import type { CommandHandler } from "./registry.js";

/**
 * `sekhemet egress [--since <time>] [--refused] [--json]` (security item 33a,
 * NEW-security-11; FINDINGS INS-08): every recorded request that left, or
 * tried to leave, the machine — `harness/egress`, `card/egress` and
 * `model/downloaded` — newest first, the rows Configuration › Project ›
 * *Network activity* shows for the same ledger (DB-N24-1). Read-only: it
 * records nothing. In the Team setup it holds only what the person at the
 * terminal may read.
 */
export const egressCommand: CommandHandler = async (args, env) => {
  const sinceArg = typeof args.values.since === "string" ? args.values.since : undefined;
  const since = parseSince(sinceArg);
  if (sinceArg !== undefined && since === undefined) {
    const message =
      "--since needs a date or time, such as 2026-10-01 or 2026-10-01T09:00; `sekhemet egress --help` lists what it takes";
    console.error(`sekhemet: ${message}`);
    return env.json ? baseResult("egress", 2, message) : 2;
  }
  const { db, log } = await env.kernel("read");
  try {
    const me = log.localPrincipal();
    const audience: Audience =
      setupFor(env.repoPath) === "team"
        ? audienceFromAccess(() => new Access({ db, setup: "team", localPrincipal: () => me }), db)
        : soloAudience();
    const store = new CardStore(db, log);
    const titles = new Map<string, { title: string; projectId?: string }>();
    for (const c of await store.listCards())
      titles.set(c.id, { title: c.title, ...(c.projectId ? { projectId: c.projectId } : {}) });
    const rows = await egressRows(
      log,
      { ...(since ? { since } : {}), refusedOnly: args.values.refused === true },
      {
        issue: (id) => titles.get(id),
        personName: (p) => personName(db, p),
        localPrincipal: me,
        canSee: (project) => audience.canSee(me, project),
      },
    );
    const lines = egressLines(rows);
    for (const l of lines) console.log(l);
    const result: EgressResult = {
      ...baseResult(
        "egress",
        0,
        rows.length === 0 ? (lines[0] as string) : `${rows.length} recorded request(s).`,
      ),
      rows,
    };
    return result;
  } finally {
    db.close();
  }
};
