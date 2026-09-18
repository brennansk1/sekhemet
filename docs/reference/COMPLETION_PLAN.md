# Completion plan: every inventory unit BUILT

**The gate (set by the user, 2026-09-18).** Every unit in FEATURE_INVENTORY_REAUDIT.md, 302 now plus any added later, must be **BUILT**:
- it implements its specification to depth;
- a production path calls it (the CLI, the queue, the card runner or session, or the dashboard server);
- a real test proves it (DEFINITION_OF_DONE §2).

Nothing may remain SHALLOW, DEAD or MISSING. The final evaluation (Chronicle and the Showcase Trifecta) runs only after the gate passes.

**Starting point (re-audit, 2026-09-18):** 59 built, 109 shallow, 19 dead, 114 missing, 1 undetermined.

## Method

Two builders run at once (the session limit), each owning disjoint packages so they never edit the same file. The lead wires cross-package APIs into apps/harness, verifies each wave (build, lint, full tests) and commits.

Every builder report lists, per unit: status, commit, the test that proves it, and the production caller.

| Wave | Builder A | Builder B | Lead |
|---|---|---|---|
| 1 (running) | models and context, benchmark tier | loop, gates, kernel, sandbox and board, benchmark tier, plus the 8 defects | integration review fixes in the harness (`82e0a4d`, `3e16c26`) |
| 2 | the rest of models (M), context (C), sync, planner (P) | the rest of loop (L), gates (G), kernel (K), sandbox (S), board (B) | harness units (H), wiring wave-1 APIs |
| 3 | eval (E), cross-cutting (X, Y) | dashboard (U) and the harness UI surfaces | remaining harness units (H), docs |
| Verify | a **fresh, independent** re-audit agent re-scores all units against the code with production callers | fixes for anything it finds | repeat until zero units are not BUILT |

## Rules that keep it honest

- **The builders do not grade themselves.** The gate is the independent re-audit, not the builders' reports.
- **Dead code does not count.** A unit reachable only from tests is DEAD.
- **Designing units away needs sign-off.** A unit whose design is superseded (for example, replaced by a better built feature) is marked SUPERSEDED with the replacing unit named. That needs the user's approval; it is never a way to skip work.
- **Tests gate commits.** A commit goes in only when its tests pass, gated on the exit code.
