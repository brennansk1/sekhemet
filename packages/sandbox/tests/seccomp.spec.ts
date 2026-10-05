import { describe, expect, it } from "vitest";
import { AUDIT_ARCH, DENIED_SYSCALLS, bubblewrapArgv, seccompProgram } from "../src/index.js";

describe("seccomp filter for bubblewrap (S3)", () => {
  it("encodes a BPF program: arch check, (x64) the x32 refusal, one test per denied call, allow, deny EPERM", () => {
    for (const arch of ["x64", "arm64"] as const) {
      const prog = seccompProgram(arch);
      const n = Object.keys(DENIED_SYSCALLS).length;
      // x64 alone has the x32 ABI's calls to refuse: one more instruction.
      const pre = arch === "x64" ? 1 : 0;
      expect(prog.length).toBe((4 + pre + n + 2) * 8);
      const at = (i: number) => ({
        code: prog.readUInt16LE(i * 8),
        jt: prog.readUInt8(i * 8 + 2),
        jf: prog.readUInt8(i * 8 + 3),
        k: prog.readUInt32LE(i * 8 + 4),
      });
      const allowAt = 4 + pre + n;
      const denyAt = allowAt + 1;
      expect(at(0)).toEqual({ code: 0x20, jt: 0, jf: 0, k: 4 });
      expect(at(1).k).toBe(AUDIT_ARCH[arch]);
      expect(at(2)).toEqual({ code: 0x06, jt: 0, jf: 0, k: 0x00050001 });
      expect(at(3)).toEqual({ code: 0x20, jt: 0, jf: 0, k: 0 });
      if (pre === 1) {
        // nr >= __X32_SYSCALL_BIT jumps to the DENY.
        expect(at(4)).toMatchObject({ code: 0x35, k: 0x40000000, jf: 0 });
        expect(4 + 1 + at(4).jt).toBe(denyAt);
      }
      // Every jump lands on the final DENY.
      for (let i = 0; i < n; i++) {
        const j = at(4 + pre + i);
        expect(4 + pre + i + 1 + j.jt).toBe(denyAt);
      }
      expect(at(allowAt).k).toBe(0x7fff0000);
      expect(at(denyAt).k).toBe(0x00050001);
      const ptrace = DENIED_SYSCALLS.ptrace?.[arch];
      expect([...Array(n)].map((_, i) => at(4 + pre + i).k)).toContain(ptrace);
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

/**
 * Item 15 (B1): with the network granted the native engine shares the host's
 * network namespace, and with it the abstract socket namespace, so its
 * program refuses creating a Unix socket, as srt's does (`socket(AF_UNIX,
 * …)`), and io_uring, which can create one without that call; and a
 * datagram `socketpair(AF_UNIX, …)`, whose sockets can `sendto` any host
 * datagram socket, abstract or by path (B1 review blocker). A program is run
 * here on a `seccomp_data` (nr, arch, args) by a small classic-BPF evaluator
 * of the five instructions it uses.
 */
function run(prog: Buffer, nr: number, arch: number, args: number[] = []): number {
  const data = Buffer.alloc(64);
  data.writeUInt32LE(nr, 0);
  data.writeUInt32LE(arch, 4);
  args.forEach((a, i) => data.writeUInt32LE(a >>> 0, 16 + i * 8));
  let acc = 0;
  for (let pc = 0; pc * 8 < prog.length; pc++) {
    const code = prog.readUInt16LE(pc * 8);
    const jt = prog.readUInt8(pc * 8 + 2);
    const jf = prog.readUInt8(pc * 8 + 3);
    const k = prog.readUInt32LE(pc * 8 + 4);
    if (code === 0x20) acc = data.readUInt32LE(k);
    else if (code === 0x54) acc = (acc & k) >>> 0;
    else if (code === 0x15) pc += acc === k ? jt : jf;
    else if (code === 0x35) pc += acc >= k ? jt : jf;
    else if (code === 0x06) return k;
    else throw new Error(`unexpected instruction ${code}`);
  }
  throw new Error("the program fell off its end");
}

describe("seccomp: Unix sockets with the network granted (item 15)", () => {
  const ALLOW = 0x7fff0000;
  const EPERM = 0x00050001;
  const SOCKET = { x64: 41, arm64: 198 } as const;
  const IO_URING_SETUP = { x64: 425, arm64: 425 } as const;
  const SOCKETPAIR = { x64: 53, arm64: 199 } as const;
  const AF_UNIX = 1;
  const AF_INET = 2;
  const SOCK_STREAM = 1;
  const SOCK_DGRAM = 2;
  const SOCK_RAW = 3;
  const SOCK_SEQPACKET = 5;
  const SOCK_NONBLOCK = 0o4000;
  const SOCK_CLOEXEC = 0o2000000;
  const X32 = 0x40000000;

  it("refuses socket(AF_UNIX) and io_uring, and allows an IP socket", () => {
    for (const arch of ["x64", "arm64"] as const) {
      const prog = seccompProgram(arch, { refuseUnixSockets: true });
      const a = AUDIT_ARCH[arch];
      expect(run(prog, SOCKET[arch], a, [AF_UNIX, 1])).toBe(EPERM);
      expect(run(prog, IO_URING_SETUP[arch], a, [8, 0])).toBe(EPERM);
      expect(run(prog, SOCKET[arch], a, [AF_INET, 1])).toBe(ALLOW);
      // The calls every program refuses are still refused.
      expect(run(prog, DENIED_SYSCALLS.ptrace?.[arch] as number, a)).toBe(EPERM);
      expect(run(prog, 0, AUDIT_ARCH[arch === "x64" ? "arm64" : "x64"])).toBe(EPERM);
    }
  });

  it("refuses a Unix socketpair that is not connection-oriented: its datagram end can sendto any host socket", () => {
    for (const arch of ["x64", "arm64"] as const) {
      const prog = seccompProgram(arch, { refuseUnixSockets: true });
      const a = AUDIT_ARCH[arch];
      const pair = SOCKETPAIR[arch];
      // SOCK_DGRAM, with and without SOCK_CLOEXEC / SOCK_NONBLOCK in the high bits.
      expect(run(prog, pair, a, [AF_UNIX, SOCK_DGRAM])).toBe(EPERM);
      expect(run(prog, pair, a, [AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC | SOCK_NONBLOCK])).toBe(EPERM);
      // The kernel turns an AF_UNIX SOCK_RAW into SOCK_DGRAM.
      expect(run(prog, pair, a, [AF_UNIX, SOCK_RAW])).toBe(EPERM);
      // A stream or seqpacket pair is already joined: connect() gives EISCONN.
      expect(run(prog, pair, a, [AF_UNIX, SOCK_STREAM])).toBe(ALLOW);
      expect(run(prog, pair, a, [AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC])).toBe(ALLOW);
      expect(run(prog, pair, a, [AF_UNIX, SOCK_SEQPACKET])).toBe(ALLOW);
    }
  });

  it("x64: refuses every x32-ABI call, which carries the x64 arch with nr | 0x40000000", () => {
    const a = AUDIT_ARCH.x64;
    for (const prog of [
      seccompProgram("x64"),
      seccompProgram("x64", { refuseUnixSockets: true }),
    ]) {
      expect(run(prog, X32 | SOCKET.x64, a, [AF_UNIX, 1])).toBe(EPERM);
      expect(run(prog, X32 | (DENIED_SYSCALLS.ptrace?.x64 as number), a)).toBe(EPERM);
      expect(run(prog, X32 | (DENIED_SYSCALLS.mount?.x64 as number), a)).toBe(EPERM);
      expect(run(prog, X32 | 0, a)).toBe(EPERM);
      // An ordinary x64 call is unaffected.
      expect(run(prog, 0, a)).toBe(ALLOW);
    }
  });

  it("leaves the program without the network as it was: a Unix socket is the relays' (DEC-50)", () => {
    for (const arch of ["x64", "arm64"] as const) {
      const prog = seccompProgram(arch);
      expect(run(prog, SOCKET[arch], AUDIT_ARCH[arch], [AF_UNIX, 1])).toBe(ALLOW);
      expect(run(prog, DENIED_SYSCALLS.ptrace?.[arch] as number, AUDIT_ARCH[arch])).toBe(EPERM);
    }
  });
});
