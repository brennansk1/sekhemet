import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeSettings } from "../src/integrations.js";
import { SCRIPTED_MODEL, scriptEnv, scriptedModel } from "./support/g2_model.js";
import { fakeGh, fakeGitHub } from "./support/g3_github.js";
import { cliAsync, eventsOf, g6Repo, inReview, statusOf, write } from "./support/g6_review.js";

/**
 * An accepted card awaiting its pull request, and Review's back-pressure, at
 * the doors a person and the product use (C2d, FINDINGS_C1 TST-01; kernel.md
 * rule 23, NEW-kernel-3 K-N3-3): `sekhemet accept` spawned on a project whose
 * Accept opens a pull request — against a local GitHub (GHES paths, the
 * `support/g3_github.ts` fake), a fake `gh` and a real bare remote — and then
 * `sekhemet queue` spawned with its Worker a scripted model at the HTTP
 * boundary (`g2_model.ts`), with a real gate process. No request leaves the
 * machine and no model is loaded.
 */

const BIN = resolve(import.meta.dirname, "../dist/index.js");
const QUALIFY = resolve(import.meta.dirname, "support/g2_qualify.mjs");
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) {
      c.kill("SIGKILL");
      await new Promise((r) => c.once("close", r));
    }
  }
});

const GATES =
  '[project]\nmax_files = 3\nmax_diff_lines = 200\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\ntimeout_s = 60\nparser = "generic"\n';

describe("an accepted card awaiting its pull request stays in Review outside its limit (K-N3-3)", () => {
  it("K-N3-3: `accept` with pull-request-on-accept records card/pr_opened {pr, url, headSha} and holds the card in Review awaiting the merge; with Review filled to its limit by such cards, the next `queue` card still enters Verify and Review", async () => {
    const r = g6Repo("sek-k-n3-3-");
    // The GitHub repository is read from the remote's URL; pushes go to `upstream`.
    r.git("remote", "add", "origin", "https://github.com/o/r.git");
    const upstream = join(r.root, "upstream.git");
    execFileSync("git", ["init", "-q", "--bare", upstream]);
    r.git("remote", "add", "upstream", upstream);
    // Review's limit, fixed by the person at 4.
    write(r.repo, ".sekhemet/config.toml", '[review]\nremote = "upstream"\nwip = 4\n');
    write(r.repo, ".sekhemet/gates.toml", GATES);
    for (const [k, v] of Object.entries(r.env())) vi.stubEnv(k, v);
    try {
      writeSettings(r.repo, { githubPrOnAccept: true });
    } finally {
      vi.unstubAllEnvs();
    }
    await r.ledger(async ({ store, log }) => {
      const project = await store.ensureProject({ rootPath: r.repo, name: "Timesheets" });
      log.appendNow({
        actor: "human",
        type: "project/settings_changed",
        principal: log.localPrincipal(),
        payload: { project: project.id, push_to_remote: true },
      });
    });
    const api = await fakeGitHub();
    const bin = fakeGh(join(r.root, "bin"));
    const env = {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_GH_TOKEN: "gho_fake",
      SEKHEMET_GITHUB_HOST: api.url,
    };

    const held = ["m1", "m2", "m3", "m4"];
    const reviewFull = async () => {
      const status = await cliAsync(r, ["status", "--json"], { env });
      return (
        JSON.parse(status.stdout.trim().split("\n").at(-1) as string) as { reviewFull: boolean }
      ).reviewFull;
    };
    for (const id of held) {
      await inReview(r, id, {
        files: { [`src/${id}.ts`]: `export const ${id} = 1;\n` },
        scope: [`src/${id}.ts`],
      });
    }
    // Four cards waiting on a person fill Review to its limit.
    expect(await reviewFull()).toBe(true);
    for (const id of held) {
      const accepted = await cliAsync(r, ["accept", id], { env });
      expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
      const [opened] = await eventsOf(r, id, ["card/pr_opened"]);
      expect(opened?.payload).toMatchObject({
        pr: 5,
        url: "https://github.com/o/r/pull/5",
        headSha: expect.stringMatching(/^[0-9a-f]{40}$/),
      });
      const card = await r.ledger(({ store }) => store.getCard(id));
      expect(card?.status).toBe("review");
      expect(card?.hold).toMatchObject({ kind: "awaitingMerge", pr: 5 });
    }

    // Awaiting their merges, they no longer count toward it.
    expect(await reviewFull()).toBe(false);
    // A further card, run by the queue.
    await r.ledger(({ store }) =>
      store.createCard({
        id: "c5",
        tier: "story",
        title: "Write c5",
        status: "ready",
        scopeFiles: ["src/c5.ts"],
        stepBudget: 4,
        spec: "Export a constant named c5 from src/c5.ts",
        acceptanceCriteria: ["src/c5.ts exports c5"],
      }),
    );
    const { preload, record } = scriptedModel(r.home);
    // A scripted model is reached over HTTP: the load guard is off for it.
    const runEnv = { ...env, SEKHEMET_MODEL_LOADS: "on" };
    execFileSync(process.execPath, [QUALIFY, SCRIPTED_MODEL, "[{}]"], {
      env: r.env({ env: runEnv }),
    });
    const out = await new Promise<string>((done) => {
      const child = spawn(
        process.execPath,
        ["--import", preload, BIN, "queue", "--worker", SCRIPTED_MODEL],
        {
          cwd: r.repo,
          env: r.env({
            env: {
              ...runEnv,
              ...scriptEnv(record, {
                worker: [
                  [
                    {
                      name: "write_file",
                      arguments: { path: "src/c5.ts", content: "export const c5 = 5;\n" },
                    },
                  ],
                  [{ name: "finish_card" }],
                ],
              }),
            },
          }),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      children.push(child);
      let text = "";
      let reported = false;
      const read = (b: Buffer) => {
        text += String(b);
        if (!reported && /Report: \S+queue_report\.json/.test(text)) {
          reported = true;
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          }, 2000);
        }
      };
      child.stdout.on("data", read);
      child.stderr.on("data", read);
      const timer = setTimeout(() => child.kill("SIGKILL"), 150_000);
      child.on("close", () => {
        clearTimeout(timer);
        done(text);
      });
    });
    // Not held by back-pressure: the awaiting-merge cards do not count toward Review's limit.
    expect(await statusOf(r, "c5"), out).toBe("review");
    expect(await eventsOf(r, "c5", ["card/held"])).toEqual([]);
    const moves = (await eventsOf(r, "c5", ["card/status_changed"])).map(
      (e) => (e.payload as { toStatus: string }).toStatus,
    );
    expect(moves).toEqual(expect.arrayContaining(["verify", "review"]));
    // The held cards are still in Review, awaiting their merge.
    for (const id of held) expect(await statusOf(r, id)).toBe("review");
  }, 300_000);
});
