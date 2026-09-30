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
];

/**
 * The absolute session paths to hide: the table, plus where this session's
 * environment says its runtime directory, ssh-agent socket and GnuPG home
 * are, when they lie elsewhere. A relative value is ignored.
 */
export function sessionSecretDenies(env: NodeJS.ProcessEnv = process.env): string[] {
  const named = [env.XDG_RUNTIME_DIR, env.SSH_AUTH_SOCK, env.GNUPGHOME]
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
