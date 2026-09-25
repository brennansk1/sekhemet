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

/**
 * One conflicting file, as the typed failure the Worker already knows how to
 * repair (Y6).
 *
 * Structurally identical to `GateFailure` in `@sekhemet/gates`, and declared
 * here rather than imported because sync sits below gates in the package
 * graph. The point of the shape is that a rebase conflict reaches the next
 * attempt through the same channel as a typecheck error: a conflict reported
 * as a one-line `blockedReason` is a fact about the card that the model
 * repairing it never sees.
 *
 * The rung is `parse`: a file with conflict markers in it does not parse, and
 * that is the gate a repair should expect to satisfy first.
 */
export interface RebaseConflictFailure {
  rung: "parse";
  layer: "static";
  gate: "rebase";
  exitCode: number;
  errorExcerpt: string;
  suggestedFixFiles: string[];
  location: { file: string };
  minimalRepro: string;
  suggestedAction: string;
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
        /** One per conflicting file, for the next attempt's failure block. */
        failures: RebaseConflictFailure[];
        /**
         * Conflicting files the card never declared it would touch.
         *
         * A conflict inside a card's own scope is work it can do; a conflict
         * outside it is someone else's change the card has no mandate to
         * resolve, so the card is parked for a person rather than sent back
         * to a Worker that would have to violate its scope to succeed.
         */
        outOfScope: string[];
        /** The cards whose integration commits touch the conflicting files (RG-N1-3). */
        otherCards?: string[];
      };
    };

/** The review diff (Y8). */
export interface StructuralDiff {
  engine: "difftastic" | "git";
  groups: Record<"tests" | "source" | "config" | "docs", string[]>;
  text: string;
}
