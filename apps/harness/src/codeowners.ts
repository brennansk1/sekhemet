import { execFileSync } from "node:child_process";
import type { CardRecord, CardStore } from "@sekhemet/kernel";
import { ownersFor } from "@sekhemet/sync";
import { effectiveConfig } from "./config_apply.js";

/**
 * CODEOWNERS for Review (review-git §2.4.2, RG-N5-3/-4): the owners of a
 * card's files, from the last matching pattern for each file, mapped to
 * principals through the people's linked GitHub logins (integrations item 6).
 * A team (`@org/team`) or an unlinked login maps to no principal: it is
 * named as unmapped, never guessed.
 */
const LOCATIONS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

/**
 * The CODEOWNERS text the integration branch holds — `.github/`, then the
 * root, then `docs/` — read with `git show <branch>:<path>`, never from the
 * working tree, where an uncommitted edit (or a card's branch) could name
 * other owners. `branch` defaults to the project's `[review] integration_branch`.
 */
export function readCodeowners(repoPath: string, branch?: string): string | undefined {
  const ref = branch ?? effectiveConfig(repoPath).config.review.integrationBranch;
  for (const path of LOCATIONS) {
    try {
      return execFileSync("git", ["show", `${ref}:${path}`], {
        cwd: repoPath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      });
    } catch {
      // Not at this location on the branch: the next one.
    }
  }
  return undefined;
}

/** The owners of `files`, split into linked principals and unmapped entries. */
export function ownersOf(
  repoPath: string,
  store: CardStore,
  files: readonly string[],
): { principals: string[]; unmapped: string[] } {
  const text = readCodeowners(repoPath);
  if (!text || files.length === 0) return { principals: [], unmapped: [] };
  const principals = new Set<string>();
  const unmapped: string[] = [];
  for (const owner of ownersFor(text, files)) {
    const login = owner.replace(/^@/, "");
    const principal = owner.includes("/") ? undefined : store.principalForHandle("github", login);
    if (principal) principals.add(principal);
    else unmapped.push(owner);
  }
  return { principals: [...principals].sort(), unmapped };
}

/** RG-N5-3: the suggested accepters of a card, from the files in its declared scope. */
export function suggestedAccepters(
  repoPath: string,
  store: CardStore,
  card: Pick<CardRecord, "scopeFiles">,
): { principals: string[]; unmapped: string[] } {
  return ownersOf(repoPath, store, card.scopeFiles ?? []);
}
