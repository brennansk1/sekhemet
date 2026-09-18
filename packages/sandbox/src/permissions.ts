export type PermissionTier = "allow" | "ask" | "deny";

export interface PermissionCheckRequest {
  toolName: string;
  targetPath?: string | undefined;
  command?: string | undefined;
  declaredScopeFiles?: string[] | undefined;
  agentRole?: string | undefined;
  allowNetwork?: boolean | undefined;
}

export interface PermissionCheckResult {
  tier: PermissionTier;
  allowed: boolean;
  reason?: string;
}

const PROTECTED_SYSTEM_PATTERNS = [
  /\bgates\.toml\b/i,
  /\.sekhemet\/(?:events\.db|checkpoints)/i,
  /\.githooks\//i,
  /\.git\//i,
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

export class PermissionEngine {
  public evaluate(req: PermissionCheckRequest): PermissionCheckResult {
    // 1. Permanent Deny: Path Traversal
    if (req.targetPath && (req.targetPath.includes("../") || req.targetPath.startsWith("/"))) {
      return {
        tier: "deny",
        allowed: false,
        reason: `Path traversal or absolute path outside worktree denied: ${req.targetPath}`,
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
          };
        }
      }
    }

    // 3. Permanent Deny: Test Immutability for Implementers
    if (req.agentRole === "implementer" && req.targetPath) {
      if (req.targetPath.includes(".spec.") || req.targetPath.includes(".test.")) {
        if (
          req.toolName.startsWith("write") ||
          req.toolName.startsWith("replace") ||
          req.toolName === "edit"
        ) {
          return {
            tier: "deny",
            allowed: false,
            reason: `Implementer role is forbidden from modifying test assertions (Test Immutability Law): ${req.targetPath}`,
          };
        }
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
        const isScopeMatch = req.declaredScopeFiles.some(
          (scope) => req.targetPath === scope || req.targetPath?.endsWith(`/${scope}`),
        );
        if (!isScopeMatch) {
          return {
            tier: "deny",
            allowed: false,
            reason: `File modification outside declared scope [${req.declaredScopeFiles.join(", ")}] denied: ${req.targetPath}`,
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
          };
        }
      }

      // Check network commands if network is disabled
      if (!req.allowNetwork) {
        for (const pattern of NETWORK_COMMAND_PATTERNS) {
          if (pattern.test(req.command)) {
            return {
              tier: "ask",
              allowed: false,
              reason: `Network command requires developer confirmation in offline mode: ${req.command}`,
            };
          }
        }
      }
    }

    // 6. Default Allow
    return {
      tier: "allow",
      allowed: true,
    };
  }
}
