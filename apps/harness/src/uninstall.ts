import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatBytes } from "@sekhemet/models";
import { type InventoryItem, installInventory } from "./install_inventory.js";
import { keychainStore } from "./keychain.js";
import { type ServiceRunner, defaultRunner, unregisterAtLogin } from "./login_service.js";

/**
 * `sekhemet uninstall` (surface item 33, NEW-surface-7; SUR-58, SUR-59):
 * `--dry-run` lists what this install wrote outside its package, with sizes,
 * keychain items by name and never by value, containers by name, and
 * changes nothing; `--yes` removes them, keeping each project's ledger and
 * every backup unless `--include-ledgers`, and ends with the package
 * manager's own line that removes the package.
 */

export const REMOVE_PACKAGE_LINE = "npm uninstall -g sekhemet";

function row(i: InventoryItem): string {
  const size = i.bytes !== undefined ? formatBytes(i.bytes).padStart(9) : "         ";
  return `  ${size}  ${i.name}  — ${i.what}`;
}

/** The listing `--dry-run` prints (SUR-58). */
export function inventoryLines(items: InventoryItem[], includeLedgers: boolean): string[] {
  const removed = items.filter((i) => includeLedgers || !i.ledger);
  const kept = items.filter((i) => !includeLedgers && i.ledger);
  const lines: string[] = [];
  if (items.length === 0) {
    lines.push("This install wrote nothing outside its package that is still here.");
    return lines;
  }
  lines.push("`sekhemet uninstall --yes` would remove:");
  for (const i of removed.filter((x) => x.kind === "path" || x.kind === "unit")) lines.push(row(i));
  const keychain = removed.filter((i) => i.kind === "keychain");
  if (keychain.length) {
    lines.push("Keychain items (by name; no value is read or shown):");
    for (const i of keychain) lines.push(`  ${i.name}  — ${i.what}`);
  }
  const containers = removed.filter((i) => i.kind === "container");
  if (containers.length) {
    lines.push("Containers:");
    for (const i of containers) lines.push(`  ${i.name}  — ${i.what}`);
  }
  if (kept.length) {
    lines.push(
      "Kept, since a ledger cannot be rebuilt (add --include-ledgers to remove them too):",
    );
    for (const i of kept) lines.push(row(i));
  }
  for (const i of items.filter((x) => x.keep?.length && !x.ledger))
    lines.push(`  ${i.name}: never removed, the repository's own: ${(i.keep ?? []).join(", ")}`);
  const total = removed.reduce((n, i) => n + (i.bytes ?? 0), 0);
  lines.push(`Together: ${formatBytes(total)}.`);
  return lines;
}

export interface UninstallDeps {
  run?: ServiceRunner;
  print?: (line: string) => void;
}

/** `--yes` (SUR-59): remove each item; returns how many could not be removed. */
export function uninstall(includeLedgers: boolean, deps: UninstallDeps = {}): number {
  const print = deps.print ?? ((l: string) => console.log(l));
  const run = deps.run ?? defaultRunner;
  const items = installInventory();
  let failed = 0;
  const done = (what: string) => print(`  Removed ${what}`);
  const leftover = (what: string, why: string) => {
    failed += 1;
    print(`  Not removed: ${what} (${why})`);
  };
  // Units first, while their record is still in the user directory.
  for (const i of items.filter((x) => x.kind === "unit")) {
    const r = unregisterAtLogin(i.folder as string, { run });
    if (r.ok) done(i.name);
    else leftover(i.name, r.message);
  }
  for (const i of items.filter((x) => x.kind === "keychain")) {
    const store = keychainStore();
    const account = i.name.replace(/^sekhemet \/ /, "");
    if (!store) {
      leftover(i.name, "no secret store answers here");
      continue;
    }
    try {
      store.delete(account);
      done(i.name);
    } catch (err) {
      leftover(i.name, err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err));
    }
  }
  for (const i of items.filter((x) => x.kind === "container")) {
    const r = run("docker", ["rm", "-f", i.name]);
    if (r.status === 0) done(`the container ${i.name}`);
    else leftover(`the container ${i.name}`, (r.stderr || "docker did not answer").trim());
  }
  const gitRoots = new Set<string>();
  for (const i of items.filter((x) => x.kind === "path")) {
    if (i.ledger && !includeLedgers) continue;
    try {
      // The repository's own entries are never removed (`keep`).
      const keep = [...(includeLedgers ? [] : (i.except ?? [])), ...(i.keep ?? [])];
      if (keep.length === 0) rmSync(i.name, { recursive: true, force: true });
      else
        for (const n of readdirSync(i.name))
          if (!keep.includes(n)) rmSync(join(i.name, n), { recursive: true, force: true });
      if (i.name.endsWith(".sekhemet") && !i.ledger) gitRoots.add(dirname(i.name));
      done(i.name);
    } catch (err) {
      leftover(i.name, err instanceof Error ? err.message : String(err));
    }
  }
  // The card worktrees' records in each repository's own git folder (real git).
  for (const root of gitRoots)
    if (existsSync(join(root, ".git"))) run("git", ["-C", root, "worktree", "prune"]);
  return failed;
}
