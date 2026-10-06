import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CardStore } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { place, spawnCli } from "./support/cli_spawn.js";

// The operating-system notification through its door (C2d, FINDINGS_C1
// TST-01; dashboard NEW-dashboard-22): the built `sekhemet serve` spawned in a
// real repository, with `[notify] desktop` on in the user's configuration and
// a stand-in `osascript` and `notify-send` first on PATH that record their
// arguments. An issue enters In review on the server's own ledger while no
// tab holds the stream; the server raises the notification after its
// one-minute window. Before C2d this was proved by calling the notifier in
// process (desktop_notify.spec.ts).

describe("the desktop notification, raised by a spawned server (DB-N22-6)", () => {
  it(
    "DB-N22-6: a title holding quotes, $(…) and AppleScript reaches the tool as one argument, and runs nothing",
    { timeout: 150_000 },
    async () => {
      const p = place("sek-notify-");
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: p.repo });
      const bin = join(p.root, "bin");
      mkdirSync(bin);
      const calls = join(p.root, "calls");
      for (const tool of ["osascript", "notify-send"]) {
        // Each argument on its own record, so the argument list is exact.
        writeFileSync(
          join(bin, tool),
          `#!/bin/sh\nfor a in "$@"; do printf '%s\\037' "$a" >> "${calls}"; done\nprintf '\\036' >> "${calls}"\n`,
        );
        chmodSync(join(bin, tool), 0o755);
      }
      const userConfig = join(p.root, "user.toml");
      writeFileSync(userConfig, "[notify]\ndesktop = true\n");
      const server = spawnCli(["serve", "--port", "0"], p, {
        env: { PATH: `${bin}:${process.env.PATH ?? ""}`, SEKHEMET_USER_CONFIG: userConfig },
      });
      await server.until(/running at:\s+http:\/\/127\.0\.0\.1:\d+/);
      // The issue enters In review on the server's ledger, as the runner moves it.
      const pwned = join(p.root, "pwned");
      const title = `Fix "quotes" $(touch ${pwned}) \`touch ${pwned}\` " & (do shell script "touch ${pwned}") & "`;
      const { db, log } = openLocalLedger(p.repo);
      const store = new CardStore(db, log);
      await store.createCard({ id: "card_n1", tier: "story", title, status: "ready" });
      await store.updateCardStatus("card_n1", "in_progress", "started", "harness", {
        override: true,
      });
      await store.updateCardStatus("card_n1", "review", "verified", "harness", { override: true });
      db.close();
      // The window is a minute (DB-N22-3); the server reads its ledger every 2 s.
      const deadline = Date.now() + 90_000;
      while (!existsSync(calls) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 1000));
      await new Promise((r) => setTimeout(r, 500));
      await server.stop();
      const raised = readFileSync(calls, "utf8")
        .split("\u001e")
        .filter(Boolean)
        .map((c) => c.split("\u001f").slice(0, -1));
      expect(raised).toHaveLength(1);
      const args = raised[0] ?? [];
      const line = `n1 ${title} · waiting in In review`;
      if (process.platform === "darwin")
        expect(args).toEqual([
          "-e",
          "on run argv",
          "-e",
          'display notification (item 1 of argv) with title "Sekhemet"',
          "-e",
          "end run",
          line,
        ]);
      else expect(args).toEqual(["--app-name=Sekhemet", "--", "Sekhemet", line]);
      expect(existsSync(pwned)).toBe(false);
    },
  );
});
