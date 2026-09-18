---
name: ast-refactor
description: Surgical AST symbol edits avoiding non-semantic formatting diffs
triggers: ["refactor", "rename", "ast", "clean"]
budgetTokens: 200
---
# AST-Guided Surgical Refactoring

1. **Targeted Edits:** Use `replace_lines` with precise line numbers or exact search strings rather than overwriting full files.
2. **Preserve Comments:** Retain all documentation, type annotations, and comments untouched.
3. **No Unrelated Changes:** Never reformat unrelated lines or change import order unless required by the gate check.
