import { matchesGlob } from "./glob.js";

export type PermissionTier = "allow" | "ask" | "deny";

export interface PermissionCheckRequest {
  toolName: string;
  targetPath?: string | undefined;
  command?: string | undefined;
  declaredScopeFiles?: string[] | undefined;
  agentRole?: string | undefined;
  allowNetwork?: boolean | undefined;
  /** The program, when the command was given as program + args rather than a shell line. */
  program?: string | undefined;
  /** Programs the project itself provides (node_modules/.bin), trusted like the toolchain. */
  localBinaries?: ReadonlySet<string> | undefined;
}

/** Which rule produced a non-allow verdict, so callers can react per rule. */
export type PermissionRule =
  | "traversal"
  | "protected_system"
  | "protected_file"
  | "scope"
  | "destructive"
  | "network"
  | "external_binary";

export interface PermissionCheckResult {
  tier: PermissionTier;
  allowed: boolean;
  reason?: string;
  /** Set on every deny and ask verdict. */
  rule?: PermissionRule;
}

/**
 * Paths no agent may modify, at any tier.
 *
 * The loop driver, gates runner, sandbox and permission tables are included
 * deliberately (design §1253): a self-improving harness must not be able to
 * edit the machinery that constrains it.
 */
const PROTECTED_SYSTEM_PATTERNS = [
  /\bgates\.toml\b/i,
  /\bconfig\.toml\b/i,
  /\.sekhemet\/(?:events\.db|checkpoints|artifacts)/i,
  /\.githooks\//i,
  /\.git\//i,
  /packages\/loop\/src\/(?:session|tools|paths)\.ts$/i,
  /packages\/gates\/src\/runner\.ts$/i,
  /packages\/sandbox\/src\/(?:executor|permissions|seatbelt)\.ts$/i,
];

const DESTRUCTIVE_COMMAND_PATTERNS = [
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f\b/,
  /\brmdir\b/,
  /\bkill\s+-9\b/,
  /\bsudo\b/,
  /\bchmod\s+777\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-zA-Z]*f\b/,
];

const NETWORK_COMMAND_PATTERNS = [/\bcurl\b/, /\bwget\b/, /\bfetch\b/, /\bssh\b/, /\bscp\b/];

/**
 * Programs a card may run without asking (S8's external-binary tier): the
 * toolchains the gates use, POSIX text and file utilities, and the shell.
 * Anything else (a downloaded binary, a system tool with side effects) is
 * the ask tier, as is any binary the project does not itself provide.
 */
export const KNOWN_TOOLCHAIN = new Set([
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "corepack",
  "tsc",
  "tsx",
  "vitest",
  "jest",
  "biome",
  "eslint",
  "prettier",
  "git",
  "python",
  "python3",
  "pip",
  "pip3",
  "pytest",
  "ruff",
  "mypy",
  "uv",
  "cargo",
  "rustc",
  "go",
  "make",
  "sh",
  "bash",
  "zsh",
  "env",
  "echo",
  "printf",
  "true",
  "false",
  "test",
  "[",
  "ls",
  "pwd",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "tee",
  "xargs",
  "find",
  "diff",
  "cmp",
  "mkdir",
  "touch",
  "cp",
  "mv",
  "rm",
  "ln",
  "chmod",
  "stat",
  "file",
  "du",
  "date",
  "which",
  "basename",
  "dirname",
  "realpath",
  "sleep",
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "sed",
  "awk",
  "jq",
  "tar",
  "gzip",
  "gunzip",
  "zip",
  "unzip",
  "sqlite3",
  "time",
  "timeout",
  "command",
  // Network clients: gated by the network rule and the domain allowlist instead.
  "curl",
  "wget",
  // Shell builtins.
  "exit",
  "cd",
  "export",
  "set",
  "unset",
  "read",
  "return",
  "shift",
  "source",
  ".",
  "eval",
  "local",
  "trap",
  "wait",
  "exec",
  "type",
  "hash",
  "ulimit",
  "umask",
  ":",
]);

/** The leading program of each `&&`, `||`, `;`, `|` segment (after VAR=value assignments). */
/** Keywords that precede a command in the same segment (`then make`, `do echo`). */
const PREFIX_KEYWORDS = new Set([
  "do",
  "then",
  "else",
  "elif",
  "if",
  "while",
  "until",
  "!",
  "{",
  "time",
]);
/** Segments that name no program (`for x in ...`, `case`, `done`, `fi`). */
const NON_COMMAND = new Set(["for", "case", "select", "in", "done", "fi", "esac", "}", "function"]);

export function commandPrograms(line: string): string[] {
  // Quoted text is data, not a program.
  const unquoted = line.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
  const out: string[] = [];
  for (const seg of unquoted.split(/&&|\|\||;|\||\n/)) {
    let words = seg
      .trim()
      .split(/\s+/)
      .filter((w) => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    while (words[0] && PREFIX_KEYWORDS.has(words[0])) words = words.slice(1);
    if (words[0] === "command" || words[0] === "exec") words = words.slice(1);
    const first = (words[0] ?? "").replace(/^[({]+/, "");
    if (first && !NON_COMMAND.has(first)) out.push(first);
  }
  return out;
}

/** Hosts named by URLs in a command line. */
export function commandHosts(line: string): string[] {
  return [...line.matchAll(/\bhttps?:\/\/([A-Za-z0-9.-]+)/g)].map((m) =>
    (m[1] as string).toLowerCase(),
  );
}

function hostAllowed(host: string, allowed: readonly string[]): boolean {
  // Loopback is the card's own background processes (L23): the sandbox
  // admits only their ports.
  if (host === "localhost" || host === "127.0.0.1") return true;
  return allowed.some((d) => {
    const domain = d.toLowerCase().replace(/^\*\./, "");
    return host === domain || host.endsWith(`.${domain}`);
  });
}

export interface PermissionEngineOptions {
  /**
   * Glob patterns the implementer role may never modify, from
   * `gates.toml [project] protected`.
   *
   * Defaults preserve the built-in test-immutability behaviour when a project
   * ships no config.
   */
  protectedGlobs?: string[];
  /**
   * Domains a network command may reach without asking (S8's domain
   * allowlist; the egress proxy enforces the same list, S5).
   */
  allowedDomains?: string[];
  /** Ask before running a program outside the toolchain (S8). Default on. */
  askExternalBinaries?: boolean;
}

const DEFAULT_PROTECTED_GLOBS = ["**/*.spec.ts", "**/*.test.ts", "tests/acceptance/**"];

export class PermissionEngine {
  private protectedGlobs: string[];
  private allowedDomains: string[];
  private askExternalBinaries: boolean;

  constructor(options: PermissionEngineOptions = {}) {
    this.allowedDomains = options.allowedDomains ?? [];
    this.askExternalBinaries = options.askExternalBinaries !== false;
    // An empty list is treated as "not configured", never as "nothing is
    // protected": dropping test immutability must be an explicit decision.
    this.protectedGlobs =
      options.protectedGlobs && options.protectedGlobs.length > 0
        ? [...options.protectedGlobs]
        : DEFAULT_PROTECTED_GLOBS;
  }

  /** The globs in force, for diagnostics and the tool prompt. */
  public get protectedPatterns(): readonly string[] {
    return this.protectedGlobs;
  }

  /** True when `target` matches any project-declared protected pattern. */
  private isProtected(target: string): boolean {
    const normalized = target.replace(/^\.\//, "");
    return this.protectedGlobs.some((pattern) => matchesGlob(normalized, pattern));
  }

  public evaluate(req: PermissionCheckRequest): PermissionCheckResult {
    // 1. Permanent Deny: Path Traversal
    if (req.targetPath && (req.targetPath.includes("../") || req.targetPath.startsWith("/"))) {
      return {
        tier: "deny",
        allowed: false,
        reason: `Path traversal or absolute path outside worktree denied: ${req.targetPath}`,
        rule: "traversal",
      };
    }

    // 2. Permanent Deny: System & Gate Invariant Files
    if (req.targetPath) {
      for (const pattern of PROTECTED_SYSTEM_PATTERNS) {
        if (pattern.test(req.targetPath)) {
          return {
            tier: "deny",
            allowed: false,
            reason: `Modifying protected gate or harness configuration denied: ${req.targetPath}`,
            rule: "protected_system",
          };
        }
      }
    }

    // 3. Permanent Deny: Test Immutability for Implementers.
    // Scoped to the implementer role by design (AGENTS.md 3.1): the test author
    // and a human may legitimately change assertions, an implementer may not.
    if (req.agentRole === "implementer" && req.targetPath) {
      const isWrite =
        req.toolName.startsWith("write") ||
        req.toolName.startsWith("replace") ||
        req.toolName === "edit" ||
        req.toolName === "insert_after_symbol";

      if (isWrite && this.isProtected(req.targetPath)) {
        return {
          tier: "deny",
          allowed: false,
          reason: `Implementer role is forbidden from modifying protected files (Test Immutability Law): ${req.targetPath}`,
          rule: "protected_file",
        };
      }
    }

    // 4. Permanent Deny: Out-of-Scope File Modifications
    if (req.declaredScopeFiles && req.declaredScopeFiles.length > 0 && req.targetPath) {
      const isWriteTool =
        req.toolName === "write_file" ||
        req.toolName === "replace_lines" ||
        req.toolName === "replace_symbol_body" ||
        req.toolName === "insert_after_symbol" ||
        req.toolName === "edit";

      if (isWriteTool) {
        const target = req.targetPath.replace(/^\.\//, "");
        // Scope entries are globs: `src/**` must admit `src/a/b.ts`. Plain string
        // equality made every glob-shaped scope deny everything it declared.
        const isScopeMatch = req.declaredScopeFiles.some((scope) => {
          const pattern = scope.replace(/^\.\//, "");
          return (
            target === pattern || target.endsWith(`/${pattern}`) || matchesGlob(target, pattern)
          );
        });
        if (!isScopeMatch) {
          return {
            tier: "deny",
            allowed: false,
            reason: `File modification outside declared scope [${req.declaredScopeFiles.join(", ")}] denied: ${req.targetPath}`,
            rule: "scope",
          };
        }
      }
    }

    // 5. Ask Tier: Destructive Shell Commands
    if (req.command) {
      for (const pattern of DESTRUCTIVE_COMMAND_PATTERNS) {
        if (pattern.test(req.command)) {
          return {
            tier: "ask",
            allowed: false,
            reason: `Destructive command requires explicit developer approval: ${req.command}`,
            rule: "destructive",
          };
        }
      }

      // Check network commands if network is disabled. A command whose every
      // URL is on the domain allowlist is allowed (S8); the egress proxy
      // still decides what actually leaves the machine (S5).
      const hosts = commandHosts(req.command);
      const allowlisted =
        hosts.length > 0 && hosts.every((h) => hostAllowed(h, this.allowedDomains));
      if (!req.allowNetwork && !allowlisted) {
        for (const pattern of NETWORK_COMMAND_PATTERNS) {
          if (pattern.test(req.command)) {
            return {
              tier: "ask",
              allowed: false,
              reason: `Network command requires developer confirmation in offline mode: ${req.command}`,
              rule: "network",
            };
          }
        }
      }
    }

    // 6. Ask Tier: a program outside the toolchain and the project's own bin (S8).
    if (req.command && this.askExternalBinaries) {
      const unknown = (req.program ? [req.program] : commandPrograms(req.command)).filter((p) => {
        const name = p.split("/").pop() ?? p;
        if (p.startsWith("./node_modules/.bin/") || p.startsWith("node_modules/.bin/"))
          return false;
        return !KNOWN_TOOLCHAIN.has(name) && !req.localBinaries?.has(name);
      });
      if (unknown.length > 0) {
        return {
          tier: "ask",
          allowed: false,
          reason: `Running ${unknown.join(", ")}, which is not part of the project's toolchain, requires developer approval`,
          rule: "external_binary",
        };
      }
    }

    // 7. Default Allow
    return {
      tier: "allow",
      allowed: true,
    };
  }
}
