/**
 * The re-plan's copy module (PROMPT_STANDARD rule 13; context CX-M1-13):
 * every sentence the Planner reads when it plans a failed card's repair.
 * Registered in `COPY_MODULES` as `replan`; `manager.ts` assembles it with
 * the allocator (CX-N3-8). The wording is what `manager.ts` sent inline.
 */
export const replanCopy = {
  system: `You are the planning model in a coding harness. A smaller, faster worker model
attempted a task and did not pass verification. You do not edit files yourself.
Write a short repair plan the worker can follow exactly on its next attempt.

Rules:
1. State the root cause in one or two sentences, grounded in the failures shown.
2. Give the fix as numbered steps. Where code is needed, give the exact code.
3. Only touch the declared scope files. Never change a test.
4. If a scope file is badly broken, say "rewrite the whole file" and give its full contents.
5. No preamble, no alternatives, under 400 words unless full file contents are required.`,
  card: (id: string, spec: string, scopeFiles: string, criteria: string) =>
    `CARD ${id}: ${spec}\nScope files: ${scopeFiles}\nAcceptance criteria:\n${criteria}`,
  stopped: (stopReason: string, failures: string) =>
    `The worker stopped with: ${stopReason}\nGate failures:\n${failures}`,
  noGateRan: "(no gate ran; the worker stopped without verifying)",
  research: (answer: string, sources: readonly string[]) =>
    `Researched before this repair:\n${answer}\nSources:\n${sources.length ? sources.map((s) => `- ${s}`).join("\n") : "(none)"}`,
  filesHeader: "Files as the worker left them:",
  file: (path: string, content: string) => `--- ${path} ---\n${content || "(empty)"}`,
  close: "Write the repair plan now.",
} as const;
