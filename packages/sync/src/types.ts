import type { GateStatus } from "@sekhemet/kernel";

export interface CheckpointCommitParams {
  cardId: string;
  step: number;
  totalSteps?: number;
  gateStatus: GateStatus;
  agentModel: string;
  agentHarness: string;
  agentRole: string;
  coAuthors?: string[];
  message?: string;
}

export interface WorktreeRecord {
  cardId: string;
  path: string;
  branch: string;
}

export interface GitSyncAdapter {
  createWorktree(
    cardId: string,
    baseBranch?: string,
    title?: string,
    parentCardId?: string | null,
  ): Promise<string>;
  commitCheckpoint(params: CheckpointCommitParams): Promise<string>;
  squashAndMerge(
    cardId: string,
    targetBranch: string,
    commitMsg: string,
    trailers?: Record<string, string>,
    title?: string,
  ): Promise<string>;
  removeWorktree(cardId: string): Promise<void>;
  listWorktrees(): Promise<WorktreeRecord[]>;

  /** HEAD sha of the repo or a card worktree. */
  getHeadSha(cwd?: string): Promise<string>;
  /** Fingerprint of working-tree state, including untracked files. */
  getRepoStateHash(cardId: string): Promise<string>;
  /** Unified diff of a card's changes. */
  generateDiff(cardId: string, baseBranch?: string): Promise<string>;
  /** Files touched and line deltas, for the bounds gate. */
  getDiffStats(cardId: string, baseBranch?: string): Promise<DiffStats>;
  /** Branch name a card's work lives on. */
  branchNameFor(cardId: string, title?: string): string;
}

/** Files touched and line deltas for a card's changes, used by the bounds gate. */
export interface DiffStats {
  filesTouched: string[];
  linesAdded: number;
  linesRemoved: number;
  /** Per-file deltas, so callers can exclude harness-staged files from bounds. */
  perFile?: { file: string; added: number; removed: number }[];
}

/** A rebase onto the integration branch (Y6). */
export type RebaseResult =
  | { ok: true; rebased: boolean; before: string; after: string }
  | {
      ok: false;
      before: string;
      failure: {
        kind: "rebase_conflict";
        onto: string;
        files: string[];
        excerpt: string;
        message: string;
      };
    };

/** The review diff (Y8). */
export interface StructuralDiff {
  engine: "difftastic" | "git";
  groups: Record<"tests" | "source" | "config" | "docs", string[]>;
  text: string;
}
