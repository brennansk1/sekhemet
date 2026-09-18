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

export interface GitSyncAdapter {
  createWorktree(cardId: string, baseBranch: string): Promise<string>;
  commitCheckpoint(params: CheckpointCommitParams): Promise<string>;
  squashAndMerge(cardId: string, targetBranch: string, commitMsg: string): Promise<string>;
  removeWorktree(cardId: string): Promise<void>;
}
