/**
 * A seccomp-BPF filter for bubblewrap (S3): system calls a card's commands
 * never need, and that break the sandbox if they succeed, return EPERM.
 * Kernel modules, kexec, mount namespaces and pivot_root, ptrace and
 * cross-process memory access, BPF and perf events, the kernel keyring.
 * bubblewrap loads the program from a file descriptor (`--seccomp FD`).
 *
 * Landlock is not used: bubblewrap's read-only root with explicit writable
 * binds already gives the same filesystem confinement.
 *
 * Item 15 (B1): with the network granted, the command shares the host's
 * network namespace and with it every abstract Unix socket (X11's, some
 * session buses'), which no mount can hide. The program for that posture
 * also refuses creating a Unix socket, `socket(AF_UNIX, …)`, and io_uring,
 * which can create a socket without that call. A Unix `socketpair` is
 * allowed only connection-oriented (SOCK_STREAM, SOCK_SEQPACKET): such a
 * pair is already joined, and a second connect() gives EISCONN. A datagram
 * pair (SOCK_DGRAM, or SOCK_RAW, which the kernel turns into SOCK_DGRAM) is
 * refused: its socket can `sendto` any host datagram socket, abstract or by
 * path (the B1 review proved this in the Linux VM). srt's own apply-seccomp
 * refuses `socket(AF_UNIX)` but not that socketpair: its residual, named in
 * security.md item 15. With the network off the namespace is empty, and the
 * relays inside (DEC-50) need their Unix sockets.
 *
 * On x64 an x32-ABI call carries AUDIT_ARCH_X86_64 with
 * `nr | __X32_SYSCALL_BIT`, so every program refuses nr >= 0x40000000 there,
 * as libseccomp's and Docker's default profiles do; exact-number checks
 * would otherwise let `socket` and every denied call through x32.
 */
const BPF_LD_W_ABS = 0x20;
const BPF_ALU_AND_K = 0x54;
const BPF_JMP_JEQ_K = 0x15;
const BPF_JMP_JGE_K = 0x35;
const BPF_RET_K = 0x06;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO = 0x00050000;
const EPERM = 1;

export const AUDIT_ARCH = { x64: 0xc000003e, arm64: 0xc00000b7 } as const;

/** The denied calls, by name, with their numbers per architecture. */
export const DENIED_SYSCALLS: Record<string, { x64: number; arm64: number }> = {
  ptrace: { x64: 101, arm64: 117 },
  process_vm_readv: { x64: 310, arm64: 270 },
  process_vm_writev: { x64: 311, arm64: 271 },
  mount: { x64: 165, arm64: 40 },
  umount2: { x64: 166, arm64: 39 },
  pivot_root: { x64: 155, arm64: 41 },
  chroot: { x64: 161, arm64: 51 },
  unshare: { x64: 272, arm64: 97 },
  setns: { x64: 308, arm64: 268 },
  init_module: { x64: 175, arm64: 105 },
  finit_module: { x64: 313, arm64: 273 },
  delete_module: { x64: 176, arm64: 106 },
  kexec_load: { x64: 246, arm64: 104 },
  kexec_file_load: { x64: 320, arm64: 294 },
  bpf: { x64: 321, arm64: 280 },
  perf_event_open: { x64: 298, arm64: 241 },
  keyctl: { x64: 250, arm64: 219 },
  add_key: { x64: 248, arm64: 217 },
  request_key: { x64: 249, arm64: 218 },
  userfaultfd: { x64: 323, arm64: 282 },
  open_by_handle_at: { x64: 304, arm64: 265 },
  swapon: { x64: 167, arm64: 224 },
  swapoff: { x64: 168, arm64: 225 },
  reboot: { x64: 169, arm64: 142 },
  acct: { x64: 163, arm64: 89 },
};

/** `socket`, `socketpair` and `io_uring_setup`, for the Unix-socket refusal (item 15). */
const SOCKET_NR = { x64: 41, arm64: 198 } as const;
const SOCKETPAIR_NR = { x64: 53, arm64: 199 } as const;
const IO_URING_SETUP_NR = { x64: 425, arm64: 425 } as const;
const AF_UNIX = 1;
const SOCK_STREAM = 1;
const SOCK_SEQPACKET = 5;
/** `type & SOCK_TYPE_MASK` drops SOCK_NONBLOCK and SOCK_CLOEXEC. */
const SOCK_TYPE_MASK = 0xf;
const X32_SYSCALL_BIT = 0x40000000;
/** Where `seccomp_data.args[0]`'s and `args[1]`'s low words are (little-endian). */
const ARG0_LOW = 16;
const ARG1_LOW = 24;

function insn(code: number, jt: number, jf: number, k: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt16LE(code, 0);
  b.writeUInt8(jt, 2);
  b.writeUInt8(jf, 3);
  b.writeUInt32LE(k >>> 0, 4);
  return b;
}

/** A jump target: the next instruction, a labelled one, or the final ALLOW or DENY. */
type Target = "next" | "ALLOW" | "DENY" | `@${string}`;
type Line = { label?: string; code: number; k: number; jt?: Target; jf?: Target };

/** Lays the lines out, then the ALLOW and the DENY, resolving each jump forward. */
function assemble(lines: Line[], deny: number): Buffer {
  const at = new Map<string, number>();
  lines.forEach((l, i) => {
    if (l.label) at.set(`@${l.label}`, i);
  });
  at.set("ALLOW", lines.length);
  at.set("DENY", lines.length + 1);
  const offset = (from: number, t: Target = "next") => {
    if (t === "next") return 0;
    const to = at.get(t);
    if (to === undefined || to <= from || to - from - 1 > 255) {
      throw new Error(`seccomp: bad jump to ${t}`);
    }
    return to - from - 1;
  };
  return Buffer.concat([
    ...lines.map((l, i) => insn(l.code, offset(i, l.jt), offset(i, l.jf), l.k)),
    insn(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW),
    insn(BPF_RET_K, 0, 0, deny),
  ]);
}

/**
 * The filter program (struct sock_filter[], little-endian) for `arch`.
 * A call from another architecture (32-bit compat, and with it `socketcall`)
 * is refused outright, and on x64 so is every x32-ABI call.
 * `refuseUnixSockets`: the network-granted posture's program (item 15).
 */
export function seccompProgram(
  arch: "x64" | "arm64",
  options: { refuseUnixSockets?: boolean } = {},
): Buffer {
  const unix = options.refuseUnixSockets === true;
  const numbers = [
    ...Object.values(DENIED_SYSCALLS).map((s) => s[arch]),
    ...(unix ? [IO_URING_SETUP_NR[arch]] : []),
  ];
  const deny = SECCOMP_RET_ERRNO | EPERM;
  const lines: Line[] = [
    { code: BPF_LD_W_ABS, k: 4 }, // A = seccomp_data.arch
    { code: BPF_JMP_JEQ_K, k: AUDIT_ARCH[arch], jt: "@nr" }, // native arch: skip the refusal
    { code: BPF_RET_K, k: deny },
    { label: "nr", code: BPF_LD_W_ABS, k: 0 }, // A = seccomp_data.nr
    ...(arch === "x64" ? [{ code: BPF_JMP_JGE_K, k: X32_SYSCALL_BIT, jt: "DENY" as const }] : []),
    ...numbers.map((nr): Line => ({ code: BPF_JMP_JEQ_K, k: nr, jt: "DENY" })),
  ];
  if (unix) {
    lines.push(
      // socket(AF_UNIX, …): refused.
      { code: BPF_JMP_JEQ_K, k: SOCKET_NR[arch], jf: "@pair" },
      { code: BPF_LD_W_ABS, k: ARG0_LOW },
      { code: BPF_JMP_JEQ_K, k: AF_UNIX, jt: "DENY", jf: "ALLOW" },
      // socketpair(AF_UNIX, type): only a stream or seqpacket pair.
      { label: "pair", code: BPF_JMP_JEQ_K, k: SOCKETPAIR_NR[arch], jf: "ALLOW" },
      { code: BPF_LD_W_ABS, k: ARG0_LOW },
      { code: BPF_JMP_JEQ_K, k: AF_UNIX, jf: "ALLOW" },
      { code: BPF_LD_W_ABS, k: ARG1_LOW },
      { code: BPF_ALU_AND_K, k: SOCK_TYPE_MASK },
      { code: BPF_JMP_JEQ_K, k: SOCK_STREAM, jt: "ALLOW" },
      { code: BPF_JMP_JEQ_K, k: SOCK_SEQPACKET, jt: "ALLOW", jf: "DENY" },
    );
  }
  return assemble(lines, deny);
}

/** The architecture this host's kernel filters for, or undefined when unsupported. */
export function hostSeccompArch(): "x64" | "arm64" | undefined {
  return process.arch === "x64" || process.arch === "arm64" ? process.arch : undefined;
}
