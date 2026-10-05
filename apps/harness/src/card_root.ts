import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CardStore } from "@sekhemet/kernel";
import { projectIsolationDenies, registerCardIsolation } from "@sekhemet/sandbox";
import { realPath, workspaceFolderOf } from "./workspace_locator.js";

/**
 * Runtime item 2a (NEW-runtime-16; DEC-57): each card runs in its own
 * project's root. A card's project gives its root, the project's
 * `root_path`, and everything the card does — its worktree, the project's
 * configuration, gates and acceptance tests, its branch and its Accept merge
 * — is resolved from that root, never from the folder the server started
 * in. The workspace's state (the ledger, evidence, transcripts, live files,
 * locks) stays in the workspace folder.
 */

interface CardPlace {
  repoPath: string;
  workspaceFolder?: string;
  cardStore: CardStore;
}

/** The root of the card's project, when the card has one the ledger knows. */
export function projectRootOf(
  cardStore: CardStore,
  card: { projectId?: string | undefined },
): string | undefined {
  return card.projectId ? cardStore.getProject(card.projectId)?.rootPath : undefined;
}

/**
 * Runtime RUN-88, RUN-94: why none of a card's project's cards may start —
 * its root no longer holds its repository (a restore found it gone, or it
 * was moved) — with the command that names the new folder; undefined when
 * the card has no project the ledger knows, or its repository is there.
 */
export function projectRepositoryMissing(
  cardStore: CardStore,
  card: { projectId?: string | undefined },
): string | undefined {
  const project = card.projectId ? cardStore.getProject(card.projectId) : undefined;
  if (!project || existsSync(join(project.rootPath, ".git"))) return undefined;
  return `${project.name}'s repository is missing — expected at ${project.rootPath}; name its folder with \`sekhemet project move ${project.id} <folder>\``;
}

/** The context a card runs in: its project's root, and the workspace folder for state. */
export function contextForCard<T extends CardPlace>(
  ctx: T,
  card: { projectId?: string | undefined },
): T {
  const workspaceFolder = ctx.workspaceFolder ?? workspaceFolderOf(ctx.repoPath);
  const root = projectRootOf(ctx.cardStore, card);
  if (!root || realPath(root) === realPath(ctx.repoPath)) return { ...ctx, workspaceFolder };
  return { ...ctx, repoPath: root, workspaceFolder };
}

/** A card's worktree in its project's root (`git_adapter.ts`). */
export function cardWorktree(projectRoot: string, cardId: string): string {
  return join(projectRoot, ".sekhemet", "worktrees", cardId);
}

/**
 * Security item 10a (NEW-security-13): for the card's run, every confined
 * command in its worktree is denied the workspace's state, the other cards'
 * worktrees and the other projects' roots. `ctx` is the card's context
 * (`contextForCard`). Returns the release.
 */
export function isolateCard(ctx: CardPlace, cardId: string): () => void {
  return isolateCheckout(ctx, cardWorktree(ctx.repoPath, cardId));
}

/**
 * Item 10a for any checkout a project's commands run in — a card's worktree,
 * the scratch checkout of an integration or restack gate at Accept, the main
 * check, the repository itself for `sekhemet gate`: every confined command
 * there is denied the workspace's state, the other checkouts and the other
 * projects' roots. `ctx.repoPath` is the project's root. Returns the release.
 */
export function isolateCheckout(ctx: CardPlace, checkout: string): () => void {
  const workspaceFolder = ctx.workspaceFolder ?? workspaceFolderOf(ctx.repoPath);
  const worktree = checkout;
  return registerCardIsolation(
    worktree,
    projectIsolationDenies({
      workspaceFolder,
      projectRoots: ctx.cardStore.listProjects().map((p) => p.rootPath),
      ownRoot: ctx.repoPath,
      ownWorktree: worktree,
    }),
  );
}
