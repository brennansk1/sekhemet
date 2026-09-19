/**
 * A seccomp-BPF filter for bubblewrap (S3): system calls a card's commands
 * never need, and that break the sandbox if they succeed, return EPERM.
 * Kernel modules, kexec, mount namespaces and pivot_root, ptrace and
 * cross-process memory access, BPF and perf events, the kernel keyring.
 * bubblewrap loads the program from a file descriptor (`--seccomp FD`).
 *
 * Landlock is not used: bubblewrap's read-only root with explicit writable
 * binds already gives the same filesystem confinement.
 */
const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
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

function insn(code: number, jt: number, jf: number, k: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt16LE(code, 0);
  b.writeUInt8(jt, 2);
  b.writeUInt8(jf, 3);
  b.writeUInt32LE(k >>> 0, 4);
  return b;
}

/**
 * The filter program (struct sock_filter[], little-endian) for `arch`.
 * A call from another architecture (32-bit compat) is refused outright.
 */
export function seccompProgram(arch: "x64" | "arm64"): Buffer {
  const numbers = Object.values(DENIED_SYSCALLS).map((s) => s[arch]);
  const n = numbers.length;
  const deny = SECCOMP_RET_ERRNO | EPERM;
  const program: Buffer[] = [
    insn(BPF_LD_W_ABS, 0, 0, 4), // A = seccomp_data.arch
    insn(BPF_JMP_JEQ_K, 1, 0, AUDIT_ARCH[arch]), // native arch: skip the refusal
    insn(BPF_RET_K, 0, 0, deny),
    insn(BPF_LD_W_ABS, 0, 0, 0), // A = seccomp_data.nr
    // Each match jumps over the rest of the list and the ALLOW to the DENY.
    ...numbers.map((nr, i) => insn(BPF_JMP_JEQ_K, n - i, 0, nr)),
    insn(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW),
    insn(BPF_RET_K, 0, 0, deny),
  ];
  return Buffer.concat(program);
}

/** The architecture this host's kernel filters for, or undefined when unsupported. */
export function hostSeccompArch(): "x64" | "arm64" | undefined {
  return process.arch === "x64" || process.arch === "arm64" ? process.arch : undefined;
}
