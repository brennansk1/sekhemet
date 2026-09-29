/**
 * B4.10 — a team shares one server (teams §2.2, §2.3, §2.7; DoD §6.6).
 *
 * A real Team server (`team.mjs`): five people at four levels sign in
 * through its own routes; each tries the same actions and gets exactly what
 * teams item 6 gives their level, every permitted write naming its person;
 * the project's lead sets an Accept rule naming one Member, and only that
 * Member can accept; and the queue gives each person fair turns on the
 * model, costed in tokens (runtime RUN-34): the product's `fairOrder` picks
 * each next issue and the product's Worker loop builds it against the
 * stand-in model, whose reported usage the ledger charges to the person who
 * delegated the issue. No model loads.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { built, check, useIsolatedEnv } from "./core.mjs";
import { buildCards, openKernel, startFakeModel } from "./stand_in.mjs";
import { RANK, startTeamServer } from "./team.mjs";

/** The five people of the milestone, at four levels. */
export const PEOPLE = [
  ["ada", "Ada Admin", "ada@northwind.test", "admin"],
  ["lee", "Lee Lead", "lee@northwind.test", "member"],
  ["mo", "Mo Member", "mo@northwind.test", "member"],
  ["sam", "Sam Stakeholder", "sam@northwind.test", "stakeholder"],
  ["vi", "Vi Viewer", "vi@northwind.test", "viewer"],
];

/** A server with its five people signed in (shared with B4.11). */
export async function signedInTeam(base) {
  const team = await startTeamServer(base);
  const [first, ...rest] = PEOPLE;
  const ada = await team.setup(first[0], first[1], first[2]);
  for (const [key, name, email, level] of rest) await team.invite(ada, key, name, email, level);
  // Each signs in again with a password: a new session of their own.
  for (const p of Object.values(team.people)) await team.signIn(p);
  const levels = {};
  for (const p of Object.values(team.people)) levels[p.key] = (await team.session(p))?.level;
  return { team, levels };
}

/** What each level may do, from teams item 6 (and `team/access.ts` ACTIONS). */
const PROBES = [
  {
    action: "file an issue",
    needs: "stakeholder",
    req: (p, ctx) => [
      "POST",
      `/api/projects/${ctx.project}/cards`,
      { title: `Filed by ${p.name}` },
    ],
  },
  {
    action: "comment",
    needs: "viewer",
    req: (_p, ctx) => ["POST", `/api/cards/${ctx.probe}/comments`, { text: "Seen this too." }],
  },
  {
    action: "change priority",
    needs: "member",
    req: (_p, ctx) => ["PATCH", `/api/cards/${ctx.probe}`, { priority: 3 }],
  },
  {
    action: "delegate to the Agent",
    needs: "member",
    req: (_p, ctx) => ["PATCH", `/api/cards/${ctx.probe}`, { assignee: "worker" }],
  },
  {
    action: "invite a person",
    needs: "admin",
    req: (p) => [
      "POST",
      "/api/invites",
      { level: "viewer", email: `guest-of-${p.key}@northwind.test` },
    ],
  },
];

/** The fair-share order the ledger's tokens call for (VTC: input ×1, output ×2), ties in input order. */
export function fairReplay(order, costOf, personOf) {
  const remaining = [...order];
  const spent = new Map();
  const out = [];
  while (remaining.length > 0) {
    let best = 0;
    for (let i = 1; i < remaining.length; i++) {
      if ((spent.get(personOf(remaining[i])) ?? 0) < (spent.get(personOf(remaining[best])) ?? 0))
        best = i;
    }
    const [id] = remaining.splice(best, 1);
    out.push(id);
    spent.set(personOf(id), (spent.get(personOf(id)) ?? 0) + costOf(id));
  }
  return out;
}

export async function run(flags = []) {
  const base = mkdtempSync(join(tmpdir(), "milestone-b4-10-"));
  const checks = [];
  const details = {};
  const { team, levels } = await signedInTeam(base);
  useIsolatedEnv(team.env);
  const k = await openKernel(team.repo, { setup: "team" });
  const { ada, lee, mo, sam, vi } = team.people;
  try {
    checks.push(
      check(
        "five people at four levels sign in",
        Object.entries(levels).every(([key, level]) => team.people[key].level === level),
        Object.entries(levels)
          .map(([key, level]) => `${team.people[key].name} ${level}`)
          .join(", "),
      ),
    );

    const project = (
      await k.kernel.EventLog.actingFor(ada.principal, () =>
        k.store.ensureProject({ rootPath: team.repo, name: "Chronicle" }),
      )
    ).id;
    const anonymous = await team.send("POST", `/api/projects/${project}/cards`, undefined, {
      title: "From nobody",
    });
    checks.push(
      check(
        "an unauthenticated request changes nothing",
        anonymous.status === 401,
        `answered ${anonymous.status}`,
      ),
    );

    // The lead and the Accept rule (teams items 6-7, TEAM-32).
    const named = await team.send("PATCH", `/api/projects/${project}/settings`, ada, {
      lead: lee.principal,
    });
    const rule = await team.send("PATCH", `/api/projects/${project}/settings`, lee, {
      accept_rule: [mo.principal],
    });
    const notLead = await team.send("PATCH", `/api/projects/${project}/settings`, mo, {
      require_resolved_threads: true,
    });
    checks.push(
      check(
        "the Admin names the lead; the lead sets the Accept rule; a Member who is not lead cannot",
        named.status === 200 && rule.status === 200 && notLead.status === 403,
        `lead ${named.status}, Accept rule [Mo Member] ${rule.status}, Mo edits settings ${notLead.status}`,
      ),
    );

    // Each level's actions, each person on a fresh issue a Stakeholder filed,
    // so no attempt finds the change already made by someone before them.
    const matrix = [];
    let filedAll = true;
    for (const p of Object.values(team.people)) {
      const filed = await team.send("POST", `/api/projects/${project}/cards`, sam, {
        title: `The export button is hidden on small screens (seen by ${p.name})`,
      });
      const ctx = { project, probe: filed.data?.card?.id };
      if (!ctx.probe) filedAll = false;
      for (const probe of PROBES) {
        const [method, path, body] = probe.req(p, ctx);
        const since = team.mark();
        const r = await team.send(method, path, p, body);
        const expected = RANK[p.level] >= RANK[probe.needs];
        const events = team.personEvents(since);
        const named = events.every((e) => e.principal === p.principal);
        matrix.push({
          action: probe.action,
          person: p.name,
          level: p.level,
          expected: expected ? "allowed" : "refused",
          status: r.status,
          ok: expected ? r.status < 400 && events.length > 0 && named : r.status === 403,
          ...(r.status === 403 ? { refusal: r.data?.error } : {}),
        });
      }
    }
    details.matrix = matrix;
    const wrong = matrix.filter((m) => !m.ok);
    checks.push(
      check(
        "each person gets only their level's actions, every write naming its person",
        filedAll && wrong.length === 0,
        wrong.length === 0
          ? `${matrix.length} attempts (${PROBES.map((p) => p.action).join(", ")}) × 5 people, each as teams item 6 says`
          : `wrong: ${wrong.map((m) => `${m.person} ${m.action} → ${m.status}`).join(", ")}`,
      ),
    );

    // Fair turns: Lee delegates three issues, Mo two; Mo's first is costly.
    const want = [
      ["mo", "Import the old ledger", 9000, 1500],
      ["mo", "Export the ledger", 9000, 1500],
      ["lee", "Show the balance", 800, 100],
      ["lee", "Show the history", 800, 100],
      ["lee", "Show the totals", 800, 100],
    ];
    const plan = {};
    const queued = [];
    for (const [who, title, input, output] of want) {
      const person = team.people[who];
      const slug = title.toLowerCase().replace(/[^a-z]+/g, "_");
      const created = await team.send("POST", `/api/projects/${project}/cards`, person, {
        title,
        spec: `${title}.`,
        scopeFiles: [`src/${slug}/index.ts`],
        acceptanceCriteria: [`${title}.`],
      });
      const id = created.data?.card?.id;
      // Ready by its filer (the board's move; teams item 6: a Member moves issues).
      await k.kernel.EventLog.actingFor(person.principal, () =>
        k.boardService.transitionCard({
          cardId: id,
          fromStatus: "backlog",
          toStatus: "ready",
          actor: "human",
          reason: "ready to build",
        }),
      );
      const delegated = await team.send("PATCH", `/api/cards/${id}`, person, {
        assignee: "worker",
      });
      if (delegated.status !== 200) throw new Error(`${who} delegating ${id}: ${delegated.status}`);
      plan[id] = {
        title,
        path: `src/${slug}/index.ts`,
        content: `export const ${slug} = (): string => "${title}";\n`,
        usage: [input, output],
      };
      queued.push({ id, who });
    }
    const { fairOrder } = await built("apps/harness/dist/team/fair_queue.js");
    const sinceSeq = team.mark();
    const records = await Promise.all(queued.map((q) => k.store.getCard(q.id)));
    const fake = await startFakeModel(plan);
    let ran;
    try {
      ran = await buildCards({
        repo: team.repo,
        modelUrl: fake.url,
        cards: queued.map((q) => ({ id: q.id })),
        kernel: k,
        order: () =>
          fairOrder(records, { db: k.db, cardStore: k.store, cap: 1, maxWaitS: 600, sinceSeq }),
      });
    } finally {
      await fake.close();
    }
    const whoOf = new Map(queued.map((q) => [q.id, q.who]));
    const steps = k.db
      .prepare(
        `SELECT card_id AS id, SUM(json_extract(payload, '$.usage.promptTokens')) AS input,
                SUM(json_extract(payload, '$.usage.completionTokens')) AS output
           FROM events WHERE type = 'card/step' AND seq > ? GROUP BY card_id`,
      )
      .all(sinceSeq);
    const cost = new Map(steps.map((s) => [s.id, s.input + 2 * s.output]));
    const order = ran.map((r) => r.id);
    const expected = fairReplay(
      queued.map((q) => q.id),
      (id) => cost.get(id) ?? 0,
      (id) => whoOf.get(id),
    );
    const byCount = ["mo", "lee", "mo", "lee", "lee"];
    const tokens = {};
    for (const s of steps) {
      const who = whoOf.get(s.id);
      tokens[who] = (tokens[who] ?? 0) + s.input + 2 * s.output;
    }
    details.queue = {
      order: ran.map(
        (r) => `${whoOf.get(r.id)}:${r.id} ${r.passed ? "passed" : "failed"}, ${r.status}`,
      ),
      expected,
      tokens,
    };
    checks.push(
      check(
        "fair turns on the model, in tokens: the queue runs the order each person's tokens call for",
        // Each built and gated; one may wait In Progress while Review is at its
        // WIP limit (review back-pressure, RG-S6-2), which is not the queue's order.
        ran.every((r) => r.passed) &&
          order.join() === expected.join() &&
          order.map((id) => whoOf.get(id)).join() !== byCount.join(),
        `ran ${order.map((id) => whoOf.get(id)).join(", ")} (weighted tokens: Mo ${tokens.mo}, Lee ${tokens.lee}); turns by count would have been ${byCount.join(", ")}; each passed its checks, ${ran.filter((r) => r.status === "review").length} in Review${ran.some((r) => r.status !== "review") ? ` and ${ran.filter((r) => r.status !== "review").length} held In Progress while Review is at its limit (RG-S6-2)` : ""}`,
      ),
    );

    // The Accept rule decides: only Mo accepts Lee's first issue.
    const target = queued.find((q) => q.who === "lee").id;
    const tries = {};
    for (const p of [ada, lee, sam, vi]) {
      const r = await team.send("POST", `/api/cards/${target}/accept`, p, {
        acknowledgedFindings: [],
      });
      tries[p.name] = { status: r.status, error: r.data?.error };
    }
    await team.send("POST", `/api/cards/${target}/opened`, mo, { filesShown: [plan[target].path] });
    const accepted = await team.send("POST", `/api/cards/${target}/accept`, mo, {
      acknowledgedFindings: [],
    });
    tries[mo.name] = { status: accepted.status, error: accepted.data?.error };
    const acceptedEvent = k.db
      .prepare(
        "SELECT principal FROM events WHERE type = 'card/accepted' AND card_id = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(target);
    const status = (await k.store.getCard(target))?.status;
    details.accept = tries;
    checks.push(
      check(
        "the project's Accept rule decides who may accept",
        [ada, lee, sam, vi].every((p) => tries[p.name].status === 403) &&
          accepted.status === 200 &&
          status === "done" &&
          acceptedEvent?.principal === mo.principal,
        `Ada (Admin) ${tries[ada.name].status}, Lee (lead) ${tries[lee.name].status}, Sam ${tries[sam.name].status}, Vi ${tries[vi.name].status}; Mo (named) ${accepted.status}, the issue ${status}${tries[ada.name].error ? `; Ada was told: ${tries[ada.name].error}` : ""}`,
      ),
    );
  } finally {
    k.close();
    await team.stop();
    if (!flags.includes("--keep")) rmSync(base, { recursive: true, force: true });
    else details.kept = base;
  }
  return { checks, details };
}
