import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cli } from "./support/g2_cli.js";
import { gateProject } from "./support/g4_gate.js";

// `--restricted` through its door (C2d, FINDINGS_C1 TST-01; security item 20,
// SEC-19): the built `sekhemet gate <card>` spawned over a real pnpm workspace
// whose changed package's own `test` script leaves a file where it runs.
// Without the flag the package gate starts (the control); with it, nothing
// the package declares starts. Before C2d this was proved by calling
// wave2.ts's runPackageGates in process (confined_runs.spec.ts), a function
// no command calls; the gate pipeline's workspace stage is what runs them.

/** A pnpm workspace whose package's own `test` script leaves `ran` in the package folder. */
const MONOREPO = {
  "package.json": '{ "name": "root", "private": true, "type": "module" }\n',
  "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
  ".sekhemet/gates.toml": `[[gate]]\nid = "unit"\nrung = "test"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\nparser = "generic"\ntimeout_s = 60\n`,
  "packages/a/package.json": JSON.stringify({
    name: "@x/a",
    version: "1.0.0",
    scripts: { test: `node -e 'require("fs").writeFileSync("ran", "x")'` },
  }),
  "packages/a/src/index.ts": "export const x = 1;\n",
};

describe("--restricted starts nothing a package declares (SEC-19)", () => {
  it(
    "SEC-19: `gate --restricted` starts no package gate; the same command without it does",
    { timeout: 180_000 },
    async () => {
      const p = await gateProject({
        files: MONOREPO,
        card: { "packages/a/src/index.ts": "export const x = 2;\n" },
        cardInput: { scopeFiles: ["packages/**"] },
      });
      const ran = join(p.worktree, "packages", "a", "ran");
      const restricted = await cli(["gate", "c1", "--restricted"], {
        cwd: p.repo,
        env: p.env,
        timeoutMs: 120_000,
      });
      expect(restricted.stdout, restricted.stderr).toMatch(/✓ unit \(\d+ ms\)/);
      expect(restricted.stdout).not.toContain("@x/a:test");
      expect(existsSync(ran)).toBe(false);
      // The control: unrestricted, the package's own gate starts in its folder.
      const open = await cli(["gate", "c1"], { cwd: p.repo, env: p.env, timeoutMs: 120_000 });
      expect(open.stdout, open.stderr).toMatch(/✓ @x\/a:test \(\d+ ms\)/);
      expect(existsSync(ran)).toBe(true);
    },
  );
});

describe.runIf(process.platform === "darwin")(
  "a package gate runs confined in the card's verification (SEC-17)",
  () => {
    it(
      "SEC-17: `gate <card>` runs the changed package's own `test` script in its folder, and the marker it writes outside the worktree stays absent",
      { timeout: 180_000 },
      async () => {
        const outside = realpathSync(mkdtempSync(join(tmpdir(), "sek-pkg-out-")));
        const marker = join(outside, "marker");
        try {
          const script = `const fs = require("fs"); fs.writeFileSync("ran", "x"); fs.writeFileSync(${JSON.stringify(marker)}, "escaped")`;
          const p = await gateProject({
            files: {
              ...MONOREPO,
              "packages/a/package.json": JSON.stringify({
                name: "@x/a",
                version: "1.0.0",
                scripts: { test: `node -e ${JSON.stringify(script)}` },
              }),
            },
            card: { "packages/a/src/index.ts": "export const x = 2;\n" },
            cardInput: { scopeFiles: ["packages/**"] },
          });
          const r = await cli(["gate", "c1"], { cwd: p.repo, env: p.env, timeoutMs: 120_000 });
          // It started, in its package folder inside the card's worktree ...
          expect(existsSync(join(p.worktree, "packages", "a", "ran")), r.stdout + r.stderr).toBe(
            true,
          );
          expect(r.stdout).toContain("@x/a:test");
          // ... and its write outside the worktree was refused, so the gate failed.
          expect(existsSync(marker)).toBe(false);
          expect(r.stdout).not.toMatch(/✓ @x\/a:test/);
          expect(r.status).not.toBe(0);
        } finally {
          rmSync(outside, { recursive: true, force: true });
        }
      },
    );
  },
);
