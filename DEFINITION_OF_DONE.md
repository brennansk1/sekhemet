# Sekhemet — Comprehensive Definition of Done & Anti-Shallow Engineering Contract

> **Scope:** Monorepo (`/Users/brennankelley/Desktop/Sekhemet`)  
> **Applicability:** All contributing AI models, human engineers, and subagents.  
> **Version:** 2, 2026-09-22 — gates and trailers brought up to date with the harness; see §4–§6.  
> **Principle:** *Zero Vanity Testing. Zero Stubbed Code. Zero Hallucinated Completion.*

---

## 1. The Anti-Shallow Philosophy

A common pathology in AI-assisted coding is **shallow development**:
- Writing code that only satisfies a happy-path interface while omitting error handling, concurrency, boundary safety, and sanitization.
- Writing "vanity tests" that assert trivialities (`expect(res).toBeDefined()`, `expect(true).toBe(true)`) or rely on in-memory mocks that mask real-world failures.
- Declaring a feature "Done" when the agent finishes speaking, rather than when rigorous, deterministic verification gates confirm its correctness on disk.

In **Sekhemet**, this pathology is strictly outlawed. A card or release is **DONE** if and only if it satisfies the deep engineering invariants defined in this contract.

---

## 2. Anti-Shallow Testing Invariants

### A. Zero Mocking of Core Runtime Infrastructure
When testing kernel state, sandboxing, process execution, git synchronization, or database persistence:
1. **Real SQLite WAL Storage:** Tests for `@sekhemet/kernel` and `@sekhemet/board` must execute against real native `node:sqlite` database files on disk. In-memory synthetic mocks that disguise SQL syntax or lock contention are forbidden.
2. **Real Subprocess Containment:** Tests for `@sekhemet/sandbox` must spawn real OS subprocesses, verify real stdout/stderr pipes, and verify that timeout thresholds trigger real `SIGTERM` followed by un-catchable `SIGKILL`.
3. **Real Git Worktrees:** Tests for `@sekhemet/sync` must create real git worktrees (`git worktree add`), generate real commit objects, and update real ref namespaces (`refs/sekhemet/checkpoints/*`).

### B. Mandatory Fault Injection & Negative Testing
For every happy path tested, there must be at least **two negative or boundary test cases**:
1. **Malformed Inputs & Corrupt Data:** Test how the parser, serializer, and state machine handle truncated JSON, invalid types, empty strings, and out-of-range indices.
2. **Cryptographic Tamper Detection:** Event logs and hash chains must be tested by actively corrupting disk bytes (flipping a bit in an event payload or hash) and asserting that the verifier detects the exact corrupted sequence number.
3. **Permission Violations:** Test that directory traversal (`../../etc/passwd`), out-of-scope edits, and protected file modifications (`gates.toml`) are rejected with explicit `deny` tiers.
4. **Subprocess Failures:** Test non-zero exit codes, buffer overflows, and process killing under resource strain.

### C. Deep Structural & Value Assertions
1. **No Trivial Assertions:** Tests relying solely on `toBeDefined()`, `toBeTruthy()`, or `toBeInstanceOf()` are rejected.
2. **Exact Equality on State:** Tests must assert exact values (`toEqual`), complete returned schemas, and exact state transition results.
3. **Test Immutability Law:** An implementer agent is strictly forbidden from editing test fixtures, assertions, or expectations to make a test pass. Only the test author or human may modify test contracts.

---

## 3. Anti-Shallow Implementation Invariants

### A. Input Sanitization & Path Confinement
1. **Path Traversal Defense:** All file-accessing tools (`read_file`, `write_file`, `replace_lines`, `edit`, `read_symbol`) must reject relative path escapes (`../`) and absolute paths outside the active worktree.
2. **CRLF & Whitespace Tolerance:** All surgical line and symbol replacements must handle CRLF (`\r\n`) and LF (`\n`) line endings transparently without corrupting surrounding indentation.
3. **Exact Uniqueness Constraint:** Whole-string replacements (`edit`) must assert that the target chunk exists **exactly once** in the file. If zero or $>1$ occurrences exist, it must abort with an error rather than guessing.

### B. Three-Tier Permission Confinement
Every tool execution must pass through the `PermissionEngine`:
1. **Permanent Deny (Deny Always Wins):**
   - Modifying `gates.toml`, test files (for implementers), loop configs, or `.sekhemet/events.db`.
   - Modifying files outside the card's declared `scopeFiles`.
   - Path traversal outside the worktree.
2. **Ask Tier (Requires Human Confirmation):**
   - Destructive commands (`rm -rf`, `sudo`, `git reset --hard`).
   - Network commands (`curl`, `fetch`) when running in offline mode.
3. **Allow Tier:**
   - Safe reads and writes within declared card scope.

### C. Context Hygiene & Compaction
1. **RTK Command Output Condensing:** Command outputs exceeding line budgets must strip ANSI escapes and progress bars, preserving relevant head and tail compiler errors while omitting noise.
2. **In-Place Observation Masking:** Turn history older than 2 steps must mask verbose tool outputs into compact semantic pointers (`[Output of read_file from Turn 2 preserved in WAL: 85 lines omitted]`), keeping prompt token density near 100%.

### D. Complete Lifecycle Hook Engine
The kernel must provide all 10 waterfall lifecycle hooks (`card/start`, `pre-step`, `pre-tool`, `post-tool`, `pre-gate`, `post-gate`, `card/end`, `review/return`, `playbook/propose`, `turn-stopping`) with safe unregistration and error propagation.

---

## 4. Verification Gates

Two commands, both exit-code checked. Nothing is "done" or "releasable" because someone said so.

```bash
pnpm gate            # before every commit: rungs 1-5
pnpm release-gate    # before any release: rungs 1-8
```

| Rung | Checked by | Standard |
| :--- | :--- | :--- |
| **1. Formatting** | `biome check .` (in `pnpm gate`) | 0 unformatted files |
| **2. Static analysis** | `biome check .` | 0 errors across every workspace project |
| **3. Type system** | `tsc -b` | 0 compiler errors; strict composite references; exact optional types |
| **4. Tests** | `vitest run` | 100% pass; 0 skipped; 0 failed |
| **5. Build** | `tsc -b` | clean `.js` and `.d.ts` for every package |
| **6. Diagnostics** | `sekhemet doctor` (in `pnpm release-gate`) | exit 0: memory, weights, inference server, sandbox confinement, git, registers |
| **7. Dashboard** | `pnpm release-gate` | the page and `/api/board` return 200 |
| **8. MCP server** | `pnpm release-gate` | `tools/list` answers with the tool schemas |

Rungs 6–8 were written down on 2026-09-18 and first automated on 2026-09-22 (`scripts/release_gate.mjs`); until then, "releasable" was a claim.

---

## 5. Card-Level vs Release-Level Done

**A card is done** when, in order:
1. its acceptance tests were staged and **failed** before any work (red first; a types-only card is red on typecheck);
2. its diff is at most 200 lines across 1–3 files, inside its declared scope;
3. every declared gate passes, **and the three project gates pass**: *reachability* (no export the card added is used by nothing), *regression* (no test `main` already guarantees is broken or removed), *architecture* (no invariant the project's brief declares is broken);
4. its **evidence bundle** records the diff, every gate result, the stop reason, the model and settings it ran with (including the thinking policy and working method), and its reproducibility record;
5. a person accepted it, and it was squash-merged to `main` with full attribution trailers.

The model never certifies its own work: the gates decide, and a person accepts.

**The harness is releasable** when:
1. `pnpm release-gate` passes (rungs 1–8);
2. the **frozen suite** has been run on the release build, its score recorded in `docs/reference/SUITE_RUNS.md` against the suite hash, and **every failure attributed to a named cause** — none of them a known and unfixed harness defect;
3. the anti-shallow audit (§2, §3) has been run against the release commit and its findings fixed or recorded;
4. the documents are current: the README and the claims table in `docs/design/HARNESS_DESIGN.md` ("Product definition") say nothing the product does not do;
5. the working tree is clean.

---

## 6. Zero Tolerance Policy

Any contribution that introduces:
- a dummy test designed only to inflate test counts,
- a bypassed permission check or scope escape,
- a modified test assertion to hide an implementation failure, or
- a commit missing its structured trailers,

is a **critical invariant violation** and is reverted.

**Every commit carries these trailers** (decided 2026-09-22: `GateStatus` on every commit, not only checkpoints — it makes each commit's claim explicit):

```
Card: <card id or workstream id>
Agent-Model: <exact model id, e.g. claude-opus-5-5>
Agent-Harness: <e.g. claude-code>
Agent-Role: lead-driver | implementer | reviewer
GateStatus: pass | fail | partial | suspended-quota
Co-Authored-By: <the model, as the harness's attribution line gives it>
```

Checkpoint commits add `Step: X/Y`.
