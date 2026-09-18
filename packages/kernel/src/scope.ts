/**
 * True when a scope entry covers a file path (B6 overlap, dependency
 * inference). Scope entries are paths or globs: `*` matches within one path
 * segment, `**` across segments, `?` one character.
 */
export function matchesScope(file: string, pattern: string): boolean {
  const f = file.replace(/^\.\//, "");
  const p = pattern.replace(/^\.\//, "");
  if (f === p) return true;
  if (!/[*?]/.test(p)) return false;
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i] as string;
    if (ch === "*") {
      if (p[i + 1] === "*") {
        re += ".*";
        i++;
        if (p[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(f);
}
