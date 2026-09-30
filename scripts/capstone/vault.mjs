/**
 * The hidden suite's vault (W2b G4; CAPSTONE_SELECTION "Isolation for an
 * agentic run").
 *
 * An agentic arm (Claude Code, Sekhemet) runs as this user, so anything this
 * user can read, it can read. The hidden suite, its scratch directory and
 * Web-Bench's checkout therefore live in an encrypted disk image that is
 * mounted only to migrate them and to score, and detached otherwise:
 *
 * - **The image:** a sparse APFS disk image made with the system's `hdiutil`,
 *   encrypted with AES-256, beside the hidden suite's directory
 *   (`~/.sekhemet/capstone-vault.sparseimage`, or `SEKHEMET_CAPSTONE_VAULT`).
 *   It is mounted only at `~/.sekhemet/capstone-vault` (the image's name
 *   without its extension), hidden from Finder, and its volume is mode 700.
 * - **The passphrase:** 32 random bytes, made here and handed to `hdiutil` and
 *   to `security` on standard input only. It is kept only in the macOS
 *   keychain (the login keychain, or `SEKHEMET_CAPSTONE_VAULT_KEYCHAIN`), as
 *   the item "Sekhemet capstone vault", whose access list trusts no
 *   application: every read asks the person. It is never written to a file,
 *   a log, the ledger or the repository, and never printed.
 * - **The sealed paths** (`capstone-hidden`, `capstone-hidden-scratch`,
 *   `webbench-src`) stay where the runner and scorer look for them, as links
 *   into the mount point. Detached, the links lead nowhere, so the isolation
 *   check (`grid.mjs isolationProblems`) finds nothing readable; it also
 *   refuses while the image is attached anywhere.
 * - **Scoring** mounts the vault, scores and unmounts it in a `finally` block
 *   (`withVault`, used by `score.mjs`).
 *
 *   node scripts/capstone/vault.mjs create [--size 4g]
 *   node scripts/capstone/vault.mjs migrate     # move the sealed material in (asks for the passphrase)
 *   node scripts/capstone/vault.mjs mount       # asks for the passphrase
 *   node scripts/capstone/vault.mjs unmount
 *   node scripts/capstone/vault.mjs status
 *   node scripts/capstone/vault.mjs restore     # the rollback: copy the material back out, remove the links
 *
 * macOS only. On Linux the same isolation comes from making the sealed paths
 * another user's, mode 700.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hiddenDir,
  sealedScratchRoot,
  vaultAttachments,
  vaultImage,
  vaultMountPoint,
  webbenchDir,
} from "./grid.mjs";

/** The keychain item's service; its account is the image's absolute path. */
export const KEYCHAIN_SERVICE = "sekhemet-capstone-vault";
const KEYCHAIN_LABEL = "Sekhemet capstone vault";
const VOLUME_NAME = "capstone-vault";
const SECURITY = "/usr/bin/security";
const HDIUTIL = "/usr/bin/hdiutil";
const DITTO = "/usr/bin/ditto";
/** How long a keychain read waits for the person to answer its dialog. */
const ASK_TIMEOUT_MS = 5 * 60_000;

function macOnly() {
  if (process.platform !== "darwin")
    throw new Error(
      "The vault uses macOS's hdiutil and keychain. On another system, make the sealed directories another user's, mode 700 (CAPSTONE_SELECTION, Isolation for an agentic run).",
    );
}

/** The sealed paths, by their name inside the vault. */
export function sealedEntries(env = process.env) {
  return [
    { name: "capstone-hidden", path: hiddenDir(env) },
    { name: "capstone-hidden-scratch", path: sealedScratchRoot(env) },
    { name: "webbench-src", path: webbenchDir(env) },
  ];
}

const keychainArgs = (env) =>
  env.SEKHEMET_CAPSTONE_VAULT_KEYCHAIN ? [resolve(env.SEKHEMET_CAPSTONE_VAULT_KEYCHAIN)] : [];

/** Text from a command, with the passphrase replaced if it ever appears. */
const scrub = (text, secret) => {
  const t = String(text ?? "").trim();
  return secret ? t.split(secret).join("[passphrase]") : t;
};

const realOrSelf = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

const within = (child, parent) => {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(`${p}${sep}`);
};

/** A link whose target lies in the vault's mount point. */
function linksIntoVault(path, env) {
  try {
    if (!lstatSync(path).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  return within(resolve(dirname(path), readlinkSync(path)), vaultMountPoint(env));
}

// --- the keychain ---------------------------------------------------------------------

/** Whether the keychain holds this image's passphrase. Reads attributes only: no dialog. */
export function passphraseStored({ env = process.env, image = vaultImage(env) } = {}) {
  if (process.platform !== "darwin") return false;
  const r = spawnSync(
    SECURITY,
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", image, ...keychainArgs(env)],
    { encoding: "utf8", env },
  );
  return r.status === 0;
}

/**
 * Whether reading this image's passphrase asks the person: its access list's
 * decrypt entry trusts no application. Read from `security dump-keychain -a`
 * (access lists, not secrets: no dialog). Null when the item is not found.
 */
export function passphraseAsks({ env = process.env, image = vaultImage(env) } = {}) {
  if (process.platform !== "darwin") return null;
  const r = spawnSync(SECURITY, ["dump-keychain", "-a", ...keychainArgs(env)], {
    encoding: "utf8",
    env,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) return null;
  for (const block of r.stdout.split(/^keychain: /m)) {
    if (
      !block.includes(`"svce"<blob>="${KEYCHAIN_SERVICE}"`) ||
      !block.includes(`"acct"<blob>="${image}"`)
    )
      continue;
    const entries = block.split(/^\s+entry \d+:\s*$/m).slice(1);
    const decrypt = entries.find((e) => /authorizations \(\d+\):[^\n]*\bdecrypt\b/.test(e));
    if (!decrypt) return false;
    return /^\s+applications \(0\):/m.test(decrypt);
  }
  return null;
}

/**
 * Keep the passphrase in the keychain, through `security -i` so that it is
 * on standard input, never in a process's arguments. The access list trusts
 * no application unless `trustedApps` names some (the automated test trusts
 * `security` itself, in a keychain of its own, so that it can mount without
 * a dialog); a person's vault is always made with none.
 */
function storePassphrase({ env, image, secret, trustedApps }) {
  const quoted = (s) => {
    if (/["\\\n]/.test(s)) throw new Error(`a path with a quote, backslash or newline: ${s}`);
    return `"${s}"`;
  };
  const trust = trustedApps.length ? trustedApps.map((a) => `-T ${quoted(a)}`).join(" ") : '-T ""';
  const kc = keychainArgs(env).map(quoted).join(" ");
  const line = `add-generic-password -a ${quoted(image)} -s ${KEYCHAIN_SERVICE} -l ${quoted(KEYCHAIN_LABEL)} -D ${quoted("disk image password")} -w ${secret} ${trust} ${kc}\n`;
  const r = spawnSync(SECURITY, ["-i"], { input: line, encoding: "utf8", env });
  if (r.status !== 0 || !passphraseStored({ env, image }))
    throw new Error(
      `the keychain did not keep the vault's passphrase: ${scrub(r.stderr || r.stdout, secret) || `exit ${r.status}`}`,
    );
}

/** The passphrase, read from the keychain: this is where the person is asked. */
function readPassphrase({ env, image, timeoutMs = ASK_TIMEOUT_MS }) {
  const r = spawnSync(
    SECURITY,
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", image, "-w", ...keychainArgs(env)],
    { encoding: "utf8", env, timeout: timeoutMs },
  );
  const secret = r.status === 0 ? r.stdout.replace(/\n$/, "") : "";
  if (!secret)
    throw new Error(
      `the vault's passphrase was not read from the keychain (refused, not answered in time, or missing): ${scrub(r.stderr) || `exit ${r.status}`}`,
    );
  return secret;
}

// --- the image ------------------------------------------------------------------------

function attach(image, mountPoint, secret, env) {
  mkdirSync(mountPoint, { recursive: true, mode: 0o700 });
  const r = spawnSync(
    HDIUTIL,
    [
      "attach",
      "-stdinpass",
      "-mountpoint",
      mountPoint,
      "-nobrowse",
      "-noautoopen",
      "-owners",
      "on",
      "-quiet",
      image,
    ],
    { input: secret, encoding: "utf8", env, timeout: 120_000 },
  );
  if (r.status !== 0)
    throw new Error(`the vault would not mount: ${scrub(r.stderr, secret) || `exit ${r.status}`}`);
  const want = realOrSelf(mountPoint);
  if (!vaultAttachments(image).some((a) => a.mountPoints.some((m) => realOrSelf(m) === want)))
    throw new Error(`the vault was attached, but is not mounted at ${mountPoint}`);
}

/**
 * Make the vault: the image, its passphrase in the keychain, and inside it
 * the three sealed directories, mode 700. Refused when an image or a stored
 * passphrase already exists, since a second one would orphan the first.
 * Leaves it unmounted.
 */
export function createVault({ env = process.env, size = "4g", trustedApps = [] } = {}) {
  macOnly();
  const image = vaultImage(env);
  const mountPoint = vaultMountPoint(env);
  if (!image.endsWith(".sparseimage"))
    throw new Error(`the vault's image must be named *.sparseimage, not ${image}`);
  if (!/^[1-9][0-9]*[kmgt]$/.test(size))
    throw new Error(`a size is a number and k, m, g or t (such as 4g), not ${size}`);
  if (existsSync(image)) throw new Error(`a vault already exists at ${image}`);
  if (passphraseStored({ env, image }))
    throw new Error(
      `the keychain already holds a passphrase for ${image}; if its image is gone, remove the item first: security delete-generic-password -s ${KEYCHAIN_SERVICE} -a "${image}"`,
    );
  mkdirSync(dirname(image), { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString("base64url");
  const made = spawnSync(
    HDIUTIL,
    [
      "create",
      "-size",
      size,
      "-fs",
      "APFS",
      "-encryption",
      "AES-256",
      "-stdinpass",
      "-volname",
      VOLUME_NAME,
      "-type",
      "SPARSE",
      "-quiet",
      image,
    ],
    { input: secret, encoding: "utf8", env, timeout: 300_000 },
  );
  if (made.status !== 0 || !existsSync(image)) {
    rmSync(image, { force: true });
    throw new Error(
      `hdiutil did not make the image: ${scrub(made.stderr, secret) || `exit ${made.status}`}`,
    );
  }
  try {
    storePassphrase({ env, image, secret, trustedApps });
  } catch (err) {
    rmSync(image, { force: true });
    throw err;
  }
  attach(image, mountPoint, secret, env);
  try {
    chmodSync(mountPoint, 0o700);
    for (const e of sealedEntries(env)) mkdirSync(join(mountPoint, e.name), { mode: 0o700 });
  } finally {
    unmountVault({ env });
  }
  return { image, mountPoint };
}

/**
 * Mount the vault at its mount point, asking the person for the passphrase
 * through the keychain. Returns the mount point; already mounted there, it
 * returns at once. Attached anywhere else, it is refused.
 */
export function mountVault({ env = process.env, timeoutMs } = {}) {
  macOnly();
  const image = vaultImage(env);
  const mountPoint = vaultMountPoint(env);
  if (!existsSync(image))
    throw new Error(
      `no vault at ${image}: make one with \`node scripts/capstone/vault.mjs create\``,
    );
  const at = vaultAttachments(image);
  const want = realOrSelf(mountPoint);
  if (at.some((a) => a.mountPoints.some((m) => realOrSelf(m) === want))) return mountPoint;
  if (at.length)
    throw new Error(
      `the vault is attached elsewhere (${at.map((a) => a.mountPoints.join(", ") || a.device).join("; ")}): unmount it first`,
    );
  // The dialog is the only barrier, and an agent can raise the same one: say
  // when this one is the runner's, so a person allows only that.
  process.stderr.write(`${MOUNT_NOTICE}\n`);
  attach(image, mountPoint, readPassphrase({ env, image, timeoutMs }), env);
  return mountPoint;
}

/** Said just before the keychain asks, every time the vault is mounted. */
export const MOUNT_NOTICE =
  'Mounting the capstone vault now: the keychain will ask to use "Sekhemet capstone vault". Choose Allow (never Always Allow) only when this line has just appeared and no arm is working; a request at any other time is not the runner\'s, so choose Deny.';

/**
 * Detach the vault wherever it is attached, forcing it when something holds
 * it open. True when it was attached. Throws when it is still attached.
 */
export function unmountVault({ env = process.env } = {}) {
  const image = vaultImage(env);
  if (!existsSync(image)) return false;
  const at = vaultAttachments(image);
  for (const a of at) {
    const r = spawnSync(HDIUTIL, ["detach", a.device, "-quiet"], {
      encoding: "utf8",
      env,
      timeout: 120_000,
    });
    if (r.status !== 0)
      spawnSync(HDIUTIL, ["detach", a.device, "-force", "-quiet"], {
        encoding: "utf8",
        env,
        timeout: 120_000,
      });
  }
  const left = vaultAttachments(image);
  if (left.length)
    throw new Error(
      `the vault is still mounted (${left.map((a) => a.mountPoints.join(", ") || a.device).join("; ")}): close what is using it, then run \`node scripts/capstone/vault.mjs unmount\``,
    );
  return at.length > 0;
}

// --- moving the sealed material -------------------------------------------------------

/**
 * One hash over a directory's tree: every entry's relative path, kind,
 * permission bits and content (a file's SHA-256, a link's target), not
 * following links below the top. The top itself is followed.
 */
export function treeDigest(dir) {
  const root = realpathSync(dir);
  const lines = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const path = rel ? `${rel}/${name}` : name;
      const full = join(root, path);
      const st = lstatSync(full);
      const mode = (st.mode & 0o7777).toString(8);
      if (st.isSymbolicLink()) lines.push(`${path}\tlink\t${mode}\t${readlinkSync(full)}`);
      else if (st.isDirectory()) {
        lines.push(`${path}\tdir\t${mode}`);
        walk(path);
      } else if (st.isFile())
        lines.push(
          `${path}\tfile\t${mode}\t${createHash("sha256").update(readFileSync(full)).digest("hex")}`,
        );
      else lines.push(`${path}\tother\t${mode}`);
    }
  };
  walk("");
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** Copy a tree with `ditto` (links, modes and extended attributes kept), mode 700 at the top, and check it. */
function copyChecked(from, to, env) {
  const r = spawnSync(DITTO, [from, to], { encoding: "utf8", env, timeout: 30 * 60_000 });
  if (r.status !== 0) throw new Error(`ditto could not copy ${from}: ${(r.stderr || "").trim()}`);
  chmodSync(to, 0o700);
  if (treeDigest(from) !== treeDigest(to)) {
    rmSync(to, { recursive: true, force: true });
    throw new Error(`the copy of ${from} differs from it; nothing was moved`);
  }
}

const emptyOrAbsent = (dir) => !existsSync(dir) || readdirSync(dir).length === 0;

/**
 * Move the sealed material into the vault. Each sealed directory is copied
 * in, checked entry by entry, then replaced by a link to its copy, and the
 * original is deleted; a missing one is made empty in the vault and linked.
 * One already linked is left alone. The vault is unmounted afterwards,
 * whatever happened. Returns what was moved.
 */
export function migrateVault({ env = process.env, timeoutMs } = {}) {
  macOnly();
  const mountPoint = vaultMountPoint(env);
  const todo = [];
  for (const e of sealedEntries(env)) {
    if (linksIntoVault(e.path, env)) continue;
    let st = null;
    try {
      st = lstatSync(e.path);
    } catch {}
    if (st && !st.isDirectory())
      throw new Error(
        `${e.path} is not a directory (nor a link into the vault): nothing was moved`,
      );
    todo.push({ ...e, exists: Boolean(st) });
  }
  if (!todo.length) return [];
  mountVault({ env, timeoutMs });
  const moved = [];
  try {
    for (const e of todo) {
      const dest = join(mountPoint, e.name);
      if (!emptyOrAbsent(dest))
        throw new Error(
          `the vault already holds ${e.name}, which is not overwritten; nothing more was moved`,
        );
      if (e.exists) {
        rmSync(dest, { recursive: true, force: true });
        copyChecked(e.path, dest, env);
        const aside = `${e.path}.moving-to-vault`;
        renameSync(e.path, aside);
        symlinkSync(dest, e.path);
        rmSync(aside, { recursive: true, force: true });
      } else {
        mkdirSync(dest, { recursive: true, mode: 0o700 });
        mkdirSync(dirname(e.path), { recursive: true });
        symlinkSync(dest, e.path);
      }
      moved.push({ name: e.name, from: e.path, to: dest, copied: e.exists });
    }
  } finally {
    unmountVault({ env });
  }
  return moved;
}

/**
 * The rollback: copy each sealed directory back out of the vault to where it
 * was, mode 700, checked, in place of its link. The vault keeps its copy and
 * is unmounted afterwards.
 */
export function restoreVault({ env = process.env, timeoutMs } = {}) {
  macOnly();
  const todo = sealedEntries(env).filter((e) => linksIntoVault(e.path, env));
  if (!todo.length) return [];
  const mountPoint = mountVault({ env, timeoutMs });
  const restored = [];
  try {
    for (const e of todo) {
      const src = join(mountPoint, e.name);
      const tmp = `${e.path}.restoring`;
      rmSync(tmp, { recursive: true, force: true });
      if (existsSync(src)) copyChecked(src, tmp, env);
      else mkdirSync(tmp, { mode: 0o700 });
      rmSync(e.path);
      renameSync(tmp, e.path);
      restored.push({ name: e.name, to: e.path });
    }
  } finally {
    unmountVault({ env });
  }
  return restored;
}

/** Whether any sealed path lives in the vault (a link into its mount point). */
export function inVault(env = process.env) {
  return sealedEntries(env).some((e) => linksIntoVault(e.path, env));
}

/**
 * Run `work` with the vault mounted, and unmount it in a `finally` block,
 * whether `work` succeeded or not. When the sealed material is not in a
 * vault, `work` simply runs. If unmounting fails after `work` succeeded,
 * that failure is thrown: the isolation check would refuse the next agentic
 * run.
 */
export async function withVault(work, { env = process.env, timeoutMs } = {}) {
  if (!inVault(env)) return work();
  mountVault({ env, timeoutMs });
  let done = false;
  let stillMounted = null;
  let result;
  try {
    result = await work();
    done = true;
  } finally {
    try {
      unmountVault({ env });
    } catch (err) {
      stillMounted = err;
      if (!done) console.error(err instanceof Error ? err.message : String(err));
    }
  }
  if (stillMounted) throw stillMounted;
  return result;
}

// --- status ---------------------------------------------------------------------------

function whereIs(path, env) {
  if (linksIntoVault(path, env)) return "in the vault";
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return "missing";
  }
  if (st.isSymbolicLink()) return "a link outside the vault";
  if (!st.isDirectory()) return "not a directory";
  try {
    readdirSync(path);
    return "a plain directory, readable";
  } catch {
    return "a plain directory, not readable by this user";
  }
}

/** Where the vault and the sealed paths stand. Asks nothing of the person. */
export function vaultStatus({ env = process.env } = {}) {
  const image = vaultImage(env);
  const mountPoint = vaultMountPoint(env);
  const exists = existsSync(image);
  const mac = process.platform === "darwin";
  const encrypted =
    exists && mac
      ? /encrypted: YES/.test(
          spawnSync(HDIUTIL, ["isencrypted", image], { encoding: "utf8", env }).stdout,
        )
      : null;
  const at = exists ? vaultAttachments(image) : [];
  const want = realOrSelf(mountPoint);
  return {
    image,
    mountPoint,
    exists,
    encrypted,
    passphraseStored: mac ? passphraseStored({ env, image }) : false,
    passphraseAsks: mac && exists ? passphraseAsks({ env, image }) : null,
    attachedAt: at.flatMap((a) =>
      a.mountPoints.length
        ? a.mountPoints.map((m) => (realOrSelf(m) === want ? mountPoint : m))
        : [a.device],
    ),
    sealed: sealedEntries(env).map((e) => ({ ...e, where: whereIs(e.path, env) })),
  };
}

// --- the command line -----------------------------------------------------------------

function statusText(s) {
  const lines = [];
  if (!s.exists) lines.push(`No vault at ${s.image}.`);
  else {
    lines.push(`Vault: ${s.image} (${s.encrypted ? "encrypted" : "NOT encrypted"}).`);
    lines.push(
      s.passphraseAsks === true
        ? "Passphrase: in the keychain; reading it asks you each time."
        : s.passphraseStored
          ? "Passphrase: in the keychain, but reading it does not ask you (an application was allowed always): remove that application from the item's access list in Keychain Access."
          : "Passphrase: not in the keychain.",
    );
    lines.push(s.attachedAt.length ? `Mounted at ${s.attachedAt.join(", ")}.` : "Not mounted.");
  }
  for (const e of s.sealed) lines.push(`${e.name}: ${e.where} (${e.path})`);
  const open = s.sealed.filter((e) => e.where === "a plain directory, readable");
  if (s.attachedAt.length || open.length)
    lines.push(
      "An agentic run is refused until the vault is unmounted and every sealed path is in it.",
    );
  else if (s.exists) lines.push("The vault is closed: the isolation check can pass.");
  return lines.join("\n");
}

function sizeFlag(argv) {
  const i = argv.indexOf("--size");
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv) {
  const [command] = argv;
  if (command === "create") {
    const size = sizeFlag(argv) ?? "4g";
    const v = createVault({ size });
    console.log(
      [
        `Created the vault at ${v.image}: APFS, AES-256, up to ${size}. It is not mounted.`,
        `Its passphrase is in the keychain as "${KEYCHAIN_LABEL}"; reading it asks you each time. Choose Allow when asked, never Always Allow.`,
        "Next: node scripts/capstone/vault.mjs migrate",
      ].join("\n"),
    );
    return 0;
  }
  if (command === "mount") {
    const at = mountVault();
    console.log(
      `Mounted at ${at}. Unmount it before any agentic run: node scripts/capstone/vault.mjs unmount`,
    );
    return 0;
  }
  if (command === "unmount") {
    console.log(unmountVault() ? "Unmounted." : "The vault was not mounted.");
    return 0;
  }
  if (command === "status") {
    console.log(statusText(vaultStatus()));
    return 0;
  }
  if (command === "migrate") {
    const moved = migrateVault();
    for (const m of moved)
      console.log(
        m.copied
          ? `${m.name}: copied into the vault, checked, and replaced by a link (${m.from}).`
          : `${m.name}: made empty in the vault and linked (${m.from}).`,
      );
    if (!moved.length) console.log("Everything is already in the vault.");
    console.log(statusText(vaultStatus()));
    return 0;
  }
  if (command === "restore") {
    const back = restoreVault();
    for (const r of back) console.log(`${r.name}: copied back to ${r.to}, checked.`);
    if (!back.length) console.log("Nothing is in the vault to restore.");
    console.log(statusText(vaultStatus()));
    return 0;
  }
  console.error(
    "usage: vault.mjs create [--size 4g] | migrate | mount | unmount | status | restore",
  );
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    },
  );
}
