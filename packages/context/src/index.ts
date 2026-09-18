export interface ContextBudget {
  maxTokens: number;
  systemBudget: number;
  repoMapBudget: number;
  filesBudget: number;
  historyBudget: number;
}

export interface FileSnippet {
  filePath: string;
  content: string;
  startLine?: number;
  endLine?: number;
  isTruncated: boolean;
}

export interface ContextPack {
  systemPrompt: string;
  repoMapText: string;
  fileSnippets: FileSnippet[];
  prompt: string;
  totalEstimatedTokens: number;
}

export interface ContextEngine {
  buildPack(cardId: string, repoRoot: string, budget: ContextBudget): Promise<ContextPack>;
}
