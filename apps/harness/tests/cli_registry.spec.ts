import { describe, expect, it } from "vitest";
import { KNOWN_FLAGS, PRIMARY_COMMANDS, routeFrontDoor } from "../src/cli_commands.js";
import { COMMAND_REGISTRY, findCommand, parseCommandArgs } from "../src/commands/registry.js";
import { sandboxDirs, sekhemet } from "./cli_fixture.js";

/**
 * Surface T4, item 17 (FINDINGS_C1 NAM-02): one registry of commands — name,
 * visibility, flags, handler and help — feeds the parser, the dispatcher and
 * both help screens. The commands move into it one at a time (strangler); every
 * entry is tested here (SUR-17).
 */

describe("SUR-17: every registry entry", () => {
  it("holds the commands this workstream moved", () => {
    expect(COMMAND_REGISTRY.map((c) => c.name).sort()).toEqual(
      [
        "accept",
        "doctor",
        "editors",
        "egress",
        "engine",
        "resume",
        "review",
        "run",
        "status",
      ].sort(),
    );
  });

  it("is found by its name, and its flags are flags the command line knows", () => {
    for (const spec of COMMAND_REGISTRY) {
      expect(findCommand(spec.name)).toBe(spec);
      for (const flag of Object.keys(spec.options)) {
        expect(KNOWN_FLAGS.has(`--${flag}`), `${spec.name} --${flag}`).toBe(true);
      }
    }
  });

  it("appears in exactly one help screen", () => {
    const where = sandboxDirs();
    const front = sekhemet(["--help"], where);
    const dev = sekhemet(["dev", "--help"], where);
    expect(front.status).toBe(0);
    expect(dev.status).toBe(0);
    for (const spec of COMMAND_REGISTRY) {
      const inFront = front.stdout.includes(spec.usage);
      const inDev = dev.stdout.includes(spec.usage);
      expect([spec.name, inFront, inDev]).toEqual([
        spec.name,
        spec.visibility === "front",
        spec.visibility === "dev",
      ]);
    }
    // The front door's rows for the moved commands come from the registry.
    for (const spec of COMMAND_REGISTRY.filter((c) => c.visibility === "front")) {
      expect(PRIMARY_COMMANDS).toContainEqual({ usage: spec.usage, what: spec.what });
    }
  });

  // Each of these two spawns the built CLI once per registry entry, so their time
  // grows with the registry; the assertions are unchanged.
  it(
    "answers `<command> --help` with its own synopsis and an example, exit 0",
    { timeout: 60_000 },
    () => {
      const where = sandboxDirs();
      for (const spec of COMMAND_REGISTRY) {
        expect(routeFrontDoor([spec.name, "--help"])).toEqual({
          kind: "command-help",
          name: spec.name,
        });
        const r = sekhemet([spec.name, "--help"], where);
        expect(r.status, spec.name).toBe(0);
        expect(r.stdout).toContain(`Usage: ${spec.synopsis}`);
        expect(r.stdout).toContain(spec.what);
        expect(r.stdout).toContain(`Example: ${spec.example}`);
        expect(spec.example.startsWith(`sekhemet ${spec.name}`)).toBe(true);
      }
    },
  );

  it(
    "parses its flags from its own schema: a flag another command takes is a usage error, exit 2",
    { timeout: 60_000 },
    () => {
      const where = sandboxDirs();
      for (const spec of COMMAND_REGISTRY) {
        const foreign = spec.options.ack ? "--worker" : "--ack";
        const issue = spec.positionals.min > 0 ? ["c1"] : [];
        expect(parseCommandArgs(spec, [spec.name, ...issue, foreign, "x"])).toMatchObject({
          error: expect.stringContaining(foreign),
        });
        const r = sekhemet([spec.name, ...issue, foreign, "x"], where);
        expect(r.status, `${spec.name}: ${r.stderr}`).toBe(2);
        expect(r.stderr).toContain(foreign);
        expect(r.stderr).toContain(`sekhemet ${spec.name} --help`);
        expect(r.stdout).toBe("");
      }
    },
  );

  it("keeps the global flags every command takes", () => {
    for (const spec of COMMAND_REGISTRY) {
      const issue = spec.positionals.min > 0 ? ["c1"] : [];
      const parsed = parseCommandArgs(spec, [
        spec.name,
        ...issue,
        "--repo",
        "/r",
        "--restricted",
        "--trust",
      ]);
      expect("error" in parsed ? parsed.error : undefined).toBeUndefined();
    }
  });
});
