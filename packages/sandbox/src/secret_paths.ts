import { isAbsolute, join, resolve } from "node:path";

/**
 * The user's secret-bearing paths, relative to the home directory (security
 * item 10, SEC-23; B-2). This one table feeds all three engines: the Seatbelt
 * profile denies reads under each path, bubblewrap hides each behind an empty
 * mount, and srt receives them as `denyRead`. So the lists cannot drift.
 *
 * Package caches and toolchains stay readable (`homeToolchainPaths`): a build
 * needs them, and they hold no credentials, except the registry tokens named
 * here, which are masked inside them. Build configuration that may carry an
 * index password but that builds read (`~/.m2/settings.xml`, `pip.conf`,
 * `.yarnrc.yml`) is not listed: masking it would break the build.
 *
 * No entry is a prefix of another.
 */
export const HOME_SECRET_PATHS: readonly { path: string; why: string }[] = [
  // Keys and cloud credentials.
  { path: ".ssh", why: "SSH private keys and known hosts" },
  { path: ".aws", why: "AWS access keys" },
  { path: join(".config", "gcloud"), why: "Google Cloud credentials" },
  { path: ".azure", why: "Azure CLI tokens" },
  { path: ".kube", why: "Kubernetes cluster credentials" },
  { path: ".docker", why: "container registry logins" },
  { path: ".gnupg", why: "GPG private keys" },
  // Package registries and git hosts.
  { path: ".npmrc", why: "npm registry tokens" },
  { path: ".pypirc", why: "PyPI upload tokens" },
  { path: ".netrc", why: "passwords for any host" },
  { path: ".git-credentials", why: "git's stored passwords" },
  { path: join(".config", "git", "credentials"), why: "git's stored passwords (XDG)" },
  { path: join(".config", "gh"), why: "GitHub CLI tokens" },
  { path: join(".cargo", "credentials"), why: "crates.io token (old name)" },
  { path: join(".cargo", "credentials.toml"), why: "crates.io token" },
  { path: join(".gem", "credentials"), why: "RubyGems API key" },
  { path: ".pgpass", why: "PostgreSQL passwords" },
  { path: join(".config", "hub"), why: "the hub CLI's GitHub token" },
  { path: ".vault-token", why: "HashiCorp Vault token" },
  { path: join(".terraform.d", "credentials.tfrc.json"), why: "Terraform Cloud tokens" },
  // AI tools' own sign-ins (the people this product serves use them).
  { path: join(".claude", ".credentials.json"), why: "Claude Code sign-in (Linux)" },
  { path: join(".codex", "auth.json"), why: "Codex CLI sign-in" },
  { path: join(".config", "github-copilot"), why: "GitHub Copilot tokens" },
  { path: join(".cache", "huggingface", "token"), why: "Hugging Face token (in a readable cache)" },
  { path: join(".huggingface", "token"), why: "Hugging Face token (old place)" },
  // Sekhemet's own user directory: models registry, tokens' file (SEC-27).
  { path: ".sekhemet", why: "Sekhemet's user directory" },
  { path: join(".config", "sekhemet"), why: "integration tokens' file (SEC-27)" },
  // Keychains and password stores.
  { path: join("Library", "Keychains"), why: "macOS keychains" },
  { path: join(".local", "share", "keyrings"), why: "GNOME keyring" },
  { path: join(".local", "share", "kwalletd"), why: "KWallet" },
  { path: ".password-store", why: "pass" },
  { path: join(".config", "op"), why: "1Password CLI" },
  // Key agents' sockets in the home: each signs with keys `.ssh` hides (SEC-15).
  { path: ".1password", why: "1Password's SSH agent socket" },
  { path: ".bitwarden-ssh-agent.sock", why: "Bitwarden's SSH agent socket" },
  // Browser profiles: cookies, saved passwords, session tokens.
  { path: ".mozilla", why: "Firefox profiles" },
  { path: join(".config", "google-chrome"), why: "Chrome profiles" },
  { path: join(".config", "chromium"), why: "Chromium profiles" },
  { path: join(".config", "BraveSoftware"), why: "Brave profiles" },
  { path: join(".config", "microsoft-edge"), why: "Edge profiles" },
  { path: join("snap", "firefox"), why: "Firefox profiles (snap)" },
  { path: join("snap", "chromium"), why: "Chromium profiles (snap)" },
  { path: join(".config", "vivaldi"), why: "Vivaldi profiles" },
  { path: join(".config", "opera"), why: "Opera profiles" },
  { path: join(".var", "app", "org.mozilla.firefox"), why: "Firefox profiles (Flatpak)" },
  { path: join(".var", "app", "com.google.Chrome"), why: "Chrome profiles (Flatpak)" },
  { path: join(".var", "app", "org.chromium.Chromium"), why: "Chromium profiles (Flatpak)" },
  { path: join(".var", "app", "com.brave.Browser"), why: "Brave profiles (Flatpak)" },
  { path: join(".var", "app", "com.microsoft.Edge"), why: "Edge profiles (Flatpak)" },
  { path: join(".var", "app", "com.vivaldi.Vivaldi"), why: "Vivaldi profiles (Flatpak)" },
  { path: join("Library", "Application Support", "Vivaldi"), why: "Vivaldi profiles" },
  {
    path: join("Library", "Application Support", "com.operasoftware.Opera"),
    why: "Opera profiles",
  },
  { path: join("Library", "Application Support", "Google", "Chrome"), why: "Chrome profiles" },
  { path: join("Library", "Application Support", "Chromium"), why: "Chromium profiles" },
  { path: join("Library", "Application Support", "Firefox"), why: "Firefox profiles" },
  { path: join("Library", "Application Support", "BraveSoftware"), why: "Brave profiles" },
  { path: join("Library", "Application Support", "Microsoft Edge"), why: "Edge profiles" },
  { path: join("Library", "Safari"), why: "Safari data" },
  { path: join("Library", "Cookies"), why: "macOS cookie stores" },
];

/**
 * The absolute secret-bearing paths for `home`, plus the user directory moved
 * by `SEKHEMET_CONFIG_DIR` (surface NEW-surface-1), denied the same way.
 */
export function secretReadDenies(home: string): string[] {
  return HOME_SECRET_PATHS.map((e) => join(home, e.path)).concat(configDirDeny());
}

function configDirDeny(): string[] {
  const dir = process.env.SEKHEMET_CONFIG_DIR?.trim();
  // Resolved as the harness resolves it (sekhemetConfigDir): a relative one is still denied.
  return dir ? [resolve(dir)] : [];
}

/**
 * The session's sockets, outside the home (W1 review, G2/G3). A socket
 * reached by its path is not isolated by an empty network namespace, and the
 * environment allowlist dropping `DBUS_SESSION_BUS_ADDRESS` does not hide a
 * path everyone knows: through these a sandboxed command could ask the
 * Secret Service (GNOME Keyring, KWallet) for every unlocked secret, sign
 * with gpg-agent or an ssh-agent whose key files `.gnupg` and `.ssh` hide,
 * or drive the Docker daemon, which is root on the host. bubblewrap hides
 * each one behind an empty mount and srt receives them as `denyRead`
 * (docs/research/SANDBOX_REUSE.md: "/run/user is not masked"). macOS has
 * none of these paths; there its sockets need the network, which Seatbelt
 * denies unless the card was granted it.
 */
export const SESSION_SECRET_PATHS: readonly { path: string; why: string }[] = [
  {
    path: "/run/user",
    why: "each login session's sockets: the D-Bus session bus (Secret Service, KWallet), gpg-agent, the keyring's ssh-agent",
  },
  { path: "/run/docker.sock", why: "the Docker daemon, which is root on the host" },
  { path: "/var/run/docker.sock", why: "the Docker daemon (the older path)" },
  // Fix round F3: the other sockets a Linux host serves outside /run/user and
  // /tmp that answer a process of the person's (SEC-15).
  {
    path: "/run/dbus",
    why: "the system bus: logind, udisks and PackageKit power the machine off, mount disks and install packages for the active session without a password",
  },
  { path: "/run/podman", why: "rootful Podman's API, which is root on the host" },
  { path: "/run/containerd", why: "containerd's API, which is root on the host" },
  { path: "/run/libvirt", why: "libvirt's daemons: the libvirt group is root on the host" },
  {
    path: "/var/snap/lxd/common/lxd/unix.socket",
    why: "LXD (snap): the lxd group is root on the host",
  },
  { path: "/var/lib/lxd/unix.socket", why: "LXD: the lxd group is root on the host" },
  { path: "/var/lib/incus/unix.socket", why: "Incus: its group is root on the host" },
  { path: "/run/pcscd", why: "the smart-card daemon: keys on smart cards and security keys" },
  {
    path: "/run/screen",
    why: "GNU screen's sessions: a connection types into the person's terminal",
  },
];

/**
 * The absolute session paths to hide: the table, plus where this session's
 * environment says its runtime directory, ssh-agent socket and GnuPG home
 * are, when they lie elsewhere, and its terminal multiplexers' sockets:
 * tmux's (the path before the first comma of `$TMUX`, and `tmux-<uid>` in
 * `$TMUX_TMPDIR`) and screen's (`$SCREENDIR`), through either of which a
 * connection types into the person's own terminal. A relative value is
 * ignored.
 */
export function sessionSecretDenies(env: NodeJS.ProcessEnv = process.env): string[] {
  const uid = process.getuid?.();
  const tmuxDir = env.TMUX_TMPDIR?.trim();
  const named = [
    env.XDG_RUNTIME_DIR,
    env.SSH_AUTH_SOCK,
    env.GNUPGHOME,
    env.TMUX?.split(",")[0],
    tmuxDir && uid !== undefined ? join(tmuxDir, `tmux-${uid}`) : undefined,
    env.SCREENDIR,
  ]
    .map((v) => v?.trim())
    .filter((v): v is string => !!v && isAbsolute(v));
  return [...new Set([...SESSION_SECRET_PATHS.map((e) => e.path), ...named])];
}

/**
 * The Unix sockets outside its granted paths that a macOS command with the
 * network granted may still connect to (W1 finding, macOS parity). Seatbelt's
 * `(allow network*)` includes connecting to any Unix socket by its path — the
 * ssh-agent at `$SSH_AUTH_SOCK` or launchd's agent sockets, a gpg-agent, the
 * Docker daemon — so both engines refuse every Unix-socket connect outside
 * the granted paths but these, and then refuse the session and home secrets
 * above even inside a grant. With the network off, Seatbelt refuses them all.
 */
export const SOCKET_CONNECT_ALLOW: readonly { path: string; why: string }[] = [
  { path: "/var/run/mDNSResponder", why: "the system's name resolver: every DNS lookup on macOS" },
];

/**
 * The macOS services that hold or hand out keychain secrets (W2b finding,
 * SEC-23b). Seatbelt denies `mach-lookup` of each, under both engines: the
 * native profile otherwise allows every lookup, and srt's allowlist names
 * `com.apple.SecurityServer` and `com.apple.securityd.xpc` itself. Without
 * them a sandboxed `security find-generic-password -w` printed any item whose
 * access list trusts `/usr/bin/security` — which every item Sekhemet stores
 * does — from any keychain file it could read, and a keychain file may lie
 * anywhere under any name. Also here, since nothing a build runs needs them
 * (fix round F1 review): iCloud Keychain's sharing messenger and escrow
 * backup, and the Touch ID and password prompts of LocalAuthentication and
 * CoreAuthentication, which gate items with an access control and would let a
 * card put a system password dialog in front of the person. Certificate trust
 * (`com.apple.trustd*`) is not here: TLS needs it, and it holds no secret. A
 * `prefix` entry covers every service whose name starts with it.
 */
export const KEYCHAIN_MACH_SERVICES: readonly { name: string; prefix?: true; why: string }[] = [
  {
    name: "com.apple.SecurityServer",
    why: "securityd: every file keychain, the login keychain among them",
  },
  {
    name: "com.apple.securityd.",
    prefix: true,
    why: "secd and the System keychain's daemon: the data-protection and iCloud keychains, the System keychain",
  },
  { name: "com.apple.security.agent", why: "the password dialogs a keychain request raises" },
  { name: "com.apple.security.agent.login", why: "the login window's password agent" },
  { name: "com.apple.security.authhost", why: "the authorization host" },
  {
    name: "com.apple.security.authtrampoline",
    why: "running a tool as root after a password (AuthorizationExecuteWithPrivileges)",
  },
  {
    name: "com.apple.security.KeychainStasher",
    why: "keeps the login keychain's password across a restart",
  },
  { name: "com.apple.security.octagon", why: "iCloud Keychain's trust circle" },
  { name: "com.apple.security.kcsharing", why: "shared keychain groups" },
  { name: "com.apple.security.escrow-update", why: "iCloud Keychain escrow" },
  { name: "com.apple.security.cloudkeychainproxy3", why: "iCloud Keychain sync" },
  { name: "com.apple.keychainsharingmessagingd", why: "messages for shared keychain groups" },
  {
    name: "com.apple.SecureBackupDaemon",
    prefix: true,
    why: "iCloud Keychain's escrow backup",
  },
  {
    name: "com.apple.LocalAuthentication.",
    prefix: true,
    why: "Touch ID and password prompts, and the application passwords that gate keychain items",
  },
  {
    name: "com.apple.CoreAuthentication.",
    prefix: true,
    why: "the daemon and agent behind LocalAuthentication's prompts",
  },
  {
    name: "com.apple.ctkd.",
    prefix: true,
    why: "CryptoTokenKit: keys on smart cards and in the Secure Enclave",
  },
];

/**
 * Keychain files outside the home (SEC-23b): the System keychain and a
 * network home's. The user's own are `~/Library/Keychains` in
 * `HOME_SECRET_PATHS`. macOS only; Linux has none of these.
 */
export const SYSTEM_KEYCHAIN_PATHS: readonly { path: string; why: string }[] = [
  { path: "/Library/Keychains", why: "the System keychain" },
  { path: "/Network/Library/Keychains", why: "keychains of a network home" },
];

/**
 * A keychain file wherever it lies (SEC-23b): a person or a tool (fastlane, a
 * CI script) may make one anywhere, and its database, read out, can be
 * attacked offline for its password. Its content is refused by the name's
 * ending, in any case (APFS is case-insensitive), and so is the save file
 * securityd writes beside it (`<name>.keychain-db.sb-<hex>-<random>`,
 * `KEYCHAIN_SAVE_SUFFIX`). A file with such a name may not be written either,
 * so one inside a granted root cannot be renamed, swapped or hard-linked away
 * from its name and then read (fix round F1). A keychain file made under any
 * other name is matched only when `SEKHEMET_KEYCHAIN_FILE` names it
 * (`keychainFileDenies`).
 */
export const KEYCHAIN_FILE_SUFFIXES: readonly string[] = [".keychain", ".keychain-db"];

/** The start of the suffix securityd gives a keychain's save file, before it renames it over the keychain. */
export const KEYCHAIN_SAVE_SUFFIX = ".sb-";

/**
 * The keychain a person or a CI names by `SEKHEMET_KEYCHAIN_FILE` for
 * Sekhemet's own items (SEC-23b): denied by its path, whatever its name, so a
 * keychain named like no keychain still holds Sekhemet's items out of reach.
 * Resolved as `keychain.ts` hands it to `security` from the harness's
 * directory. Any other keychain file under a name no pattern matches, outside
 * the home, is readable: Seatbelt judges a file by its path, never its
 * content (security item 11a's residual).
 */
export function keychainFileDenies(env: NodeJS.ProcessEnv = process.env): string[] {
  const file = env.SEKHEMET_KEYCHAIN_FILE?.trim();
  return file ? [resolve(file)] : [];
}
