---
name: tdd-contract
description: Contract-first TDD discipline with immutable test fixtures
triggers: ["test", "spec", "tdd", "contract"]
budgetTokens: 250
---
# Contract-First TDD Discipline

1. **Tests First:** Write type definitions in `src/types.ts` and failing test cases in `tests/*.spec.ts` before creating implementation logic.
2. **Red Before Green:** Verify the test suite fails (`exitCode != 0`) on missing implementation before writing logic.
3. **Test Immutability Law:** The implementer is strictly forbidden from weakening, commenting out, or altering assertions in `tests/*.spec.ts` to make tests pass.
4. **Card Bounds:** All changes must stay under 200 diff lines across 1–3 files.
