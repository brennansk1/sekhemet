---
name: gate-repair
description: Reading typed GateFailure error contracts and applying targeted repairs
triggers: ["error", "fail", "repair", "fix", "typecheck"]
budgetTokens: 200
---
# Gate Failure Repair Policy

1. **Read Excerpt:** Inspect the `errorExcerpt` and `suggestedFixFiles` from the typed `GateFailure`.
2. **Zero Hallucination:** Do not speculate on missing symbols. Verify types in the imported module before using them.
3. **Run Single Gate:** Test the fix using `pnpm typecheck` or the specific failing test command rather than guessing.
4. **Halt on 3-Turn Loop:** If alternating between two failing states, stop and report typed error to break oscillation.
