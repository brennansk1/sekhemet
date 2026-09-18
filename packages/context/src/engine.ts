import type { BuildContextPackParams, ContextEngine, ContextPack, FileSnippet } from "./types.js";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class DefaultContextEngine implements ContextEngine {
  public async buildPack(params: BuildContextPackParams): Promise<ContextPack> {
    const { systemPrompt, prompt, files, repoSymbols = [], budget } = params;

    // 1. Build repo map text within repoMapBudget
    const maxRepoMapChars = budget.repoMapBudget * 4;
    let repoMapText = repoSymbols.join("\n\n");
    if (repoMapText.length > maxRepoMapChars) {
      repoMapText = `${repoMapText.slice(0, maxRepoMapChars)}\n\n// ... [repo map truncated] ...`;
    }

    // 2. Fit files within filesBudget
    const maxTotalFileChars = budget.filesBudget * 4;
    const maxCharsPerFile =
      files.length > 0 ? Math.floor(maxTotalFileChars / files.length) : maxTotalFileChars;

    const fileSnippets: FileSnippet[] = [];
    for (const f of files) {
      if (f.content.length <= maxCharsPerFile) {
        fileSnippets.push({
          filePath: f.filePath,
          content: f.content,
          isTruncated: false,
        });
      } else {
        const truncatedChars = Math.max(100, maxCharsPerFile - 80);
        const truncatedContent = `${f.content.slice(0, truncatedChars)}\n\n// [TRUNCATED: file exceeded token budget limit]`;
        fileSnippets.push({
          filePath: f.filePath,
          content: truncatedContent,
          isTruncated: true,
        });
      }
    }

    const totalEstimatedTokens =
      estimateTokens(systemPrompt) +
      estimateTokens(repoMapText) +
      fileSnippets.reduce((acc, s) => acc + estimateTokens(s.content), 0) +
      estimateTokens(prompt);

    return {
      systemPrompt,
      repoMapText,
      fileSnippets,
      prompt,
      totalEstimatedTokens,
    };
  }
}
