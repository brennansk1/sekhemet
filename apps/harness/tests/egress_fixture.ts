import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CardStore } from "@sekhemet/kernel";
import { egressEvent } from "../src/egress_event.js";
import { openLocalLedger } from "../src/ledger_cmds.js";

/**
 * A project whose ledger holds one record of each kind that leaves the
 * machine (security item 33a, NEW-security-11): a GitHub request a person's
 * sync made, an issue's request the card proxy refused, and a model download.
 * The download is recorded now, so it is the newest. Shared by the CLI,
 * HTTP and browser entry-point tests.
 */
export const EGRESS_TIMES = {
  github: "2024-01-01T09:00:00.000Z",
  refused: "2024-01-02T10:30:00.000Z",
};

export async function seedEgress(repo: string): Promise<void> {
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Jane Doe");
  git("config", "user.email", "jane@example.com");
  writeFileSync(join(repo, ".gitignore"), ".sekhemet/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  const { db, log } = openLocalLedger(repo);
  try {
    const store = new CardStore(db, log);
    const me = log.localPrincipal();
    await store.createCard({ id: "c1", tier: "story", title: "Fetch exchange rates" });
    await log.append({
      actor: "harness",
      principal: me,
      ...egressEvent({
        url: "https://api.github.com/repos/o/r/issues?page=1",
        host: "api.github.com",
        purpose: "integration:github",
        allowed: true,
        status: 200,
        payloadHash: "",
        at: EGRESS_TIMES.github,
      }),
    });
    await log.append({
      actor: "system",
      type: "card/egress",
      cardId: "c1",
      payload: {
        at: EGRESS_TIMES.refused,
        method: "CONNECT",
        host: "paste.example.net",
        port: 443,
        allowed: false,
        payloadHash: "0".repeat(64),
        bytes: 2048,
        reason: "not on the allowlist",
      },
    });
    await log.append({
      actor: "human",
      type: "model/downloaded",
      principal: me,
      payload: {
        model: "qwen3-8b",
        source: "huggingface.co",
        sha256: "a".repeat(64),
        bytes: 5 * 1024 ** 3,
        principal: me,
        verified: true,
      },
    });
  } finally {
    db.close();
  }
}
