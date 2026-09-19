import { describe, expect, it } from "vitest";
import { AUDIT_ARCH, DENIED_SYSCALLS, bubblewrapArgv, seccompProgram } from "../src/index.js";

describe("seccomp filter for bubblewrap (S3)", () => {
  it("encodes a BPF program: arch check, one test per denied call, allow, deny EPERM", () => {
    for (const arch of ["x64", "arm64"] as const) {
      const prog = seccompProgram(arch);
      const n = Object.keys(DENIED_SYSCALLS).length;
      expect(prog.length).toBe((4 + n + 2) * 8);
      const at = (i: number) => ({
        code: prog.readUInt16LE(i * 8),
        jt: prog.readUInt8(i * 8 + 2),
        jf: prog.readUInt8(i * 8 + 3),
        k: prog.readUInt32LE(i * 8 + 4),
      });
      expect(at(0)).toEqual({ code: 0x20, jt: 0, jf: 0, k: 4 });
      expect(at(1).k).toBe(AUDIT_ARCH[arch]);
      expect(at(2)).toEqual({ code: 0x06, jt: 0, jf: 0, k: 0x00050001 });
      expect(at(3)).toEqual({ code: 0x20, jt: 0, jf: 0, k: 0 });
      // Every jump lands on the final DENY.
      for (let i = 0; i < n; i++) {
        const j = at(4 + i);
        expect(4 + i + 1 + j.jt).toBe(4 + n + 1);
      }
      expect(at(4 + n).k).toBe(0x7fff0000);
      expect(at(4 + n + 1).k).toBe(0x00050001);
      const ptrace = DENIED_SYSCALLS.ptrace?.[arch];
      expect([...Array(n)].map((_, i) => at(4 + i).k)).toContain(ptrace);
    }
  });

  it("hands the filter to bubblewrap on a file descriptor", () => {
    const argv = bubblewrapArgv(
      { allowedPaths: ["/w"], allowNetwork: false, timeoutMs: 1, cwd: "/w" },
      "node",
      ["-v"],
      3,
    );
    expect(argv.slice(argv.indexOf("--seccomp"), argv.indexOf("--seccomp") + 2)).toEqual([
      "--seccomp",
      "3",
    ]);
    expect(argv.indexOf("--seccomp")).toBeLessThan(argv.indexOf("--"));
  });
});
