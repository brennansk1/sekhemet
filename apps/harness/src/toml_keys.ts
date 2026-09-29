import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Set keys in one table of a TOML file — the user's config.toml — each set
 * or replaced, every other line kept as it was; the table is added at the
 * end when the file has none. `entries` are TOML values already written out
 * (`"yes"`, `["a", "b"]`). The one line-preserving writer the research
 * question's answer and the secret-store choice share.
 */
export function writeTomlTableKeys(
  path: string,
  table: string,
  entries: ReadonlyArray<[string, string]>,
): void {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  const name = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = lines.findIndex((l) => new RegExp(`^\\s*\\[${name}\\]\\s*(#.*)?$`).test(l));
  if (header === -1) {
    const body = lines.join("\n").replace(/\n*$/, "");
    const rows = entries.map(([k, v]) => `${k} = ${v}`).join("\n");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${body ? `${body}\n\n` : ""}[${table}]\n${rows}\n`);
    return;
  }
  let end = lines.length;
  for (let i = header + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  const added: string[] = [];
  for (const [key, value] of entries) {
    const entry = `${key} = ${value}`;
    const at = lines
      .slice(header + 1, end)
      .findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    if (at === -1) added.push(entry);
    else lines[header + 1 + at] = entry;
  }
  lines.splice(header + 1, 0, ...added);
  writeFileSync(path, lines.join("\n").replace(/\n*$/, "\n"));
}
