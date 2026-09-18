import type { SandboxOptions } from "./types.js";

export function generateSeatbeltProfile(options: SandboxOptions): string {
  const writeAllowRules = options.allowedPaths
    .map((p) => `  (allow file-write* (subpath "${p.replace(/"/g, '\\"')}"))`)
    .join("\n");

  const networkRule = options.allowNetwork ? "  (allow network*)" : "  (deny network*)";

  return `;; Sekhemet Seatbelt Containment Profile
(version 1)
(deny default)

;; Allow basic process primitives
(allow process-exec)
(allow process-fork)
(allow sysctl-read)
(allow signal (target self))

;; Read permissions (system libs and binaries)
(allow file-read*)

;; Scoped write permissions
${writeAllowRules}

;; Network egress controls
${networkRule}
`;
}
