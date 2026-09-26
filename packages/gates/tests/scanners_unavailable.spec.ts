import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BuiltinGateId, runBuiltinGates } from "../src/builtin.js";
import { builtinStage, runGatePipeline } from "../src/pipeline.js";
import type { GateProjectConfig } from "../src/types.js";

// GT-T1-3: osv, semgrep or gitleaks exiting with empty or unparseable output
// is `unavailable`, never passed. The scanners run confined (Seatbelt).

const project: GateProjectConfig = { protected: [], maxFiles: 3, maxDiffLines: 200 };

describe.runIf(platform() === "darwin")(
  "a scanner with no readable report is unavailable (GT-T1-3)",
  () => {
    let root: string;
    let bin: string;
    const git = (...a: string[]) =>
      execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const diff = () => {
      git("add", "-A");
      return git("diff", "--cached", "--unified=0", "main");
    };
    function fake(name: string, stdout: string, exit: number): string {
      const path = join(bin, name);
      writeFileSync(path, `#!/bin/sh\nprintf '%s' '${stdout}'\nexit ${exit}\n`);
      chmodSync(path, 0o755);
      return path;
    }

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "unavail-"));
      bin = mkdtempSync(join(tmpdir(), "unavail-bin-"));
      git("init", "-q", "-b", "main");
      git("config", "user.email", "t@t.t");
      git("config", "user.name", "T");
      writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
      writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
      mkdirSync(join(root, ".sekhemet"));
      writeFileSync(join(root, ".sekhemet", "semgrep.yml"), "rules: []\n");
      git("add", "-A");
      git("commit", "-q", "-m", "seed");
      git("checkout", "-q", "-b", "card");
      writeFileSync(join(root, "a.ts"), "export const a = 1;\nexport const b = 2;\n");
    });
    afterEach(() => {
      for (const d of [root, bin]) rmSync(d, { recursive: true, force: true });
    });

    const cases: [BuiltinGateId, string, string, number][] = [
      ["secrets", "gitleaks", "", 0],
      ["secrets", "gitleaks", "not json", 0],
      ["secrets", "gitleaks", "not json", 1],
      ["osv", "osv-scanner", "", 0],
      ["osv", "osv-scanner", "<html>", 0],
      ["semgrep", "semgrep", "", 0],
      ["semgrep", "semgrep", "", 1],
      ["semgrep", "semgrep", "garbage", 0],
    ];
    for (const [gate, program, stdout, exit] of cases) {
      it(`${program} exiting ${exit} with ${stdout ? `"${stdout}"` : "no output"} is unavailable`, async () => {
        const r = await runGatePipeline(
          [
            builtinStage({
              root,
              base: "main",
              diff: diff(),
              project,
              gates: [gate],
              programs: { [program]: [fake(program, stdout, exit)] },
            }),
          ],
          { cwd: root },
        );
        const o = r.rungResults.find((x) => x.gate === gate);
        expect(o).toMatchObject({ passed: false, unavailable: true });
        expect(o?.reason).toBeTruthy();
        expect(r.passed).toBe(false);
        expect(r.failures.every((f) => f.notRun)).toBe(true);
      });
    }

    it("a clean, readable report still passes", async () => {
      const r = await runBuiltinGates({
        root,
        base: "main",
        diff: diff(),
        project,
        gates: ["secrets", "osv", "semgrep"],
        programs: {
          gitleaks: [fake("gitleaks", "[]", 0)],
          "osv-scanner": [fake("osv-scanner", '{"results":[]}', 0)],
          semgrep: [fake("semgrep", '{"results":[],"errors":[]}', 0)],
        },
      });
      expect(r.failures).toEqual([]);
      for (const g of ["secrets", "osv", "semgrep"]) {
        expect(r.outcomes.find((o) => o.gate === g)?.passed, g).toBe(true);
      }
    });

    it("gitleaks' report is read from its report file when it prints nothing to stdout", async () => {
      // Writes "[]" to the path after --report-path, and nothing to stdout.
      const path = join(bin, "gitleaks");
      writeFileSync(
        path,
        `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "--report-path" ]; then printf '[]' > "$2"; fi; shift; done\nexit 0\n`,
      );
      chmodSync(path, 0o755);
      const r = await runBuiltinGates({
        root,
        base: "main",
        diff: diff(),
        project,
        gates: ["secrets"],
        programs: { gitleaks: [path] },
      });
      expect(r.failures).toEqual([]);
      expect(r.outcomes.find((o) => o.gate === "secrets")).toMatchObject({ passed: true });
    });

    // The real tool, confined as the product runs it: skipped only when
    // gitleaks is not installed on this machine.
    const realGitleaks = (() => {
      try {
        return execFileSync("sh", ["-c", "command -v gitleaks"], { encoding: "utf8" }).trim();
      } catch {
        return "";
      }
    })();
    it.runIf(realGitleaks !== "")(
      "the real gitleaks on a clean change passes, not unavailable",
      async () => {
        const r = await runGatePipeline(
          [builtinStage({ root, base: "main", diff: diff(), project, gates: ["secrets"] })],
          { cwd: root },
        );
        const o = r.rungResults.find((x) => x.gate === "secrets");
        expect(o?.reason).toBeUndefined();
        expect(o).toMatchObject({ passed: true });
        expect(o?.unavailable).toBeUndefined();
        expect(r.passed).toBe(true);
      },
      60_000,
    );
  },
);
