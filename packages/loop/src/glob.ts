/**
 * Translate a glob to an anchored RegExp.
 *
 * Supports `**` (any depth, including none), `*` (within one segment), `?`, and
 * `[...]` classes. Everything else is escaped literally, so a pattern like
 * `src/(v1)/*.ts` matches the parentheses rather than forming a capture group.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;

    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` may match nothing at all, so the slash is part of the optional group.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }

    if (ch === "?") {
      out += "[^/]";
      continue;
    }

    if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close > i + 1) {
        const body = pattern.slice(i + 1, close).replace(/\\/g, "\\\\");
        out += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
        i = close;
        continue;
      }
    }

    out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  return new RegExp(`^${out}$`);
}

/** True when `relPath` matches `pattern`. A bare `*` matches every file. */
export function matchesGlob(relPath: string, pattern: string): boolean {
  if (pattern === "*" || pattern === "**") return true;
  const normalized = relPath.split("\\").join("/");
  if (globToRegExp(pattern).test(normalized)) return true;
  // A bare pattern with no separator matches on basename, as shells do.
  if (!pattern.includes("/")) {
    const base = normalized.slice(normalized.lastIndexOf("/") + 1);
    return globToRegExp(pattern).test(base);
  }
  return false;
}
