# Sekhemet — Comprehensive Definition of Done & Anti-Shallow Engineering Contract

> **Scope:** this repository — every package, the app, the documents.  
> **Applicability:** All contributing AI models, human engineers, and subagents.  
> **Version:** 3, 2026-09-22, revised 2026-09-24 (§2B risk-based negative tests, §3 pointing at the specs, §5.1 red rules per change kind) — adds what done means for a specification, a workstream and the product (§5–§7). Version 2 brought the gates and trailers up to date.  
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
In the core packages — `kernel`, `sandbox`, `sync`, `gates`, `loop` and `context` — every happy path tested has at least **two negative or boundary test cases**. Elsewhere the rule is risk-based: every public behaviour has at least one negative case, and anything that parses input, crosses a trust boundary or changes persistent state has two (decided 2026-09-24; [gates](docs/design/specs/gates.md) §8). The cases to cover:
1. **Malformed Inputs & Corrupt Data:** Test how the parser, serializer, and state machine handle truncated JSON, invalid types, empty strings, and out-of-range indices.
2. **Cryptographic Tamper Detection:** Event logs and hash chains must be tested by actively corrupting disk bytes (flipping a bit in an event payload or hash) and asserting that the verifier detects the exact corrupted sequence number.
3. **Permission Violations:** Test that directory traversal (`../../etc/passwd`), out-of-scope edits, and protected file modifications (`gates.toml`) are rejected with explicit `deny` tiers.
4. **Subprocess Failures:** Test non-zero exit codes, buffer overflows, and process killing under resource strain.

### C. Deep Structural & Value Assertions
1. **No Trivial Assertions:** Tests relying solely on `toBeDefined()`, `toBeTruthy()`, or `toBeInstanceOf()` are rejected.
2. **Exact Equality on State:** Tests must assert exact values (`toEqual`), complete returned schemas, and exact state transition results.
3. **Test Immutability Law:** An implementer agent is strictly forbidden from editing test fixtures, assertions, or expectations to make a test pass. Only the test author or human may modify test contracts.

### D. Test infrastructure that keeps the loop fast and honest
1. **Unit and integration are split by what a test touches**, read from the files (`scripts/test_split.mjs`): a spec that uses real git, on-disk SQLite, a listening server or a child process is an integration test. `pnpm test:unit` and `pnpm test:integration` run each; `pnpm test` runs both; `pnpm dev` is the development loop.
2. **The Worker loop is testable without a model**: a scripted inference adapter replays tool calls, so the loop, stall detection, the repair ladder and condensing are verified offline and deterministically.
3. **Fixture repositories are cheap to create**: a helper builds a throwaway git repository from `fixtures/` for a test and removes it afterwards. The 2026-09-17 target of under 10 ms per repository assumed in-memory SQLite and is not kept: a real git repository on disk is the requirement (§2A); speed is watched as in item 4.
4. **Speed is watched, not bought with mocks.** The unit project should stay fast enough to run on every save (the 2026-09-17 target was under 3 seconds); the integration project is allowed to be slower because it is real (§2A). A speed target never justifies replacing real infrastructure with a mock.

---

## 3. Anti-Shallow Implementation Invariants

### A. Input Sanitization & Path Confinement
1. **Path Traversal Defense:** All file-accessing tools (`read_file`, `write_file`, `replace_lines`, `edit`, `read_symbol`) must reject relative path escapes (`../`) and absolute paths outside the active worktree.
2. **CRLF & Whitespace Tolerance:** All surgical line and symbol replacements must handle CRLF (`\r\n`) and LF (`\n`) line endings transparently without corrupting surrounding indentation.
3. **Exact Uniqueness Constraint:** Whole-string replacements (`edit`) must assert that the target chunk exists **exactly once** in the file. If zero or $>1$ occurrences exist, it must abort with an error rather than guessing.

### B. Confinement: permissions, sandbox and network
The mechanism is specified in [security](docs/design/specs/security.md) (the permission engine and its tiers, the protected paths including the extension files, the sandbox, and the network policy, items 20–29 and 35–49); this contract requires that it hold:
1. **Deny always wins**, and a deny is explicit, never a silent skip: writes outside the card's declared scope, to protected paths (`gates.toml`, tests for the implementer role, the harness's own loop, gate and sandbox sources, `.sekhemet/events.db`, extension files), into git metadata, and path traversal.
2. **Destructive commands need a person** (`rm -rf`, `sudo`, `git reset --hard`, and the rest of security's Ask list).
3. **Offline means no route out**, not an approval prompt: in offline mode the sandbox has no network at all ([security](docs/design/specs/security.md) item 29); research reaches the network only when a person has said yes to it (`[network] research`), and never through the sandbox.
4. **Confinement fails closed:** no confinement mechanism on the host means no Worker commands, unless a person explicitly opts out (S3b).

### C. Context hygiene
The mechanism is specified in [context](docs/design/specs/context.md); this contract requires:
1. **Command output is condensed** — ANSI escapes and progress bars stripped, the relevant head and tail kept — and nothing the next repair needs is dropped (context rule 17).
2. **Older observations are masked into pointers** that `recall` can expand, in batches that keep the prompt prefix byte-stable; the five most recent observations stay whole ([context](docs/design/specs/context.md) rule 3, [DEC-24](docs/design/DECISIONS.md)). Pointers use plain words, not internal jargon.
3. **Budgets are asserted on the live path**, at the reference window ([DEC-27](docs/design/DECISIONS.md)).

### D. Lifecycle hooks
The hook events and their semantics are specified in [extensibility](docs/design/specs/extensibility.md); this contract requires that every hook can be unregistered safely, that a hook's error is propagated and recorded rather than swallowed, and that a hook can veto only what its event allows (a veto is a recorded stop reason, `hook_veto`).

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

## 5. Done at every level

Five levels, each built on the one before. Nothing is done at a level because someone said so; each has a check.

### 5.1 A card is done when, in order:
1. its acceptance tests were staged before any work and shown to test something, by the rule for the card's `change` ([DEC-26](docs/design/DECISIONS.md#dec-26--one-vocabulary-for-the-kind-of-card-and-the-run), [gates](docs/design/specs/gates.md)):
   - `feature` and `fix`: the tests **failed** at an assertion before any work (red first; a types-only card is red on typecheck);
   - `characterize`: the tests **pass** on the unchanged code — they capture what it does — and fail against stand-in implementations of the code they cover;
   - `refactor`: every existing test stays green and no public behaviour changes (the source index shows the exported surface unchanged, unless the card says otherwise);
   - `upgrade`: the tests the upgrade must keep passing are named, and pass after it;
2. the lines the Worker wrote are at most 200 across 1–3 files, inside its declared scope; lines applied by a tool on the Worker's behalf (a rename, a formatter, a lockfile) are bounded separately by the project's `max_tool_applied_lines` ([gates](docs/design/specs/gates.md) §3);
3. every declared gate passes, **and the three project gates pass**: *reachability* (no export the card added is used by nothing), *regression* (no test `main` already guarantees is broken or removed), *architecture* (no invariant the project's brief declares is broken);
4. its **evidence bundle** records the diff, every gate result, the stop reason, the model and settings it ran with (including the thinking policy and working method), and its reproducibility record;
5. a person accepted it — or it was auto-accepted under a person's recorded standing decision, which names that person on every acceptance and is never available in the Team setup — and it was merged to `main` with full attribution trailers.

The model never certifies its own work: the gates decide, and a person accepts.

### 5.2 A specification is ready for building when:
1. its front matter and its "State today" table agree with the code;
2. every `partial` or `not-built` capability names a change ID in `docs/reference/COVERAGE.md`;
3. every change has acceptance criteria written as `WHEN … THE SYSTEM SHALL …`, each specific enough to be a failing test;
4. it contradicts no other specification, [DECISIONS.md](docs/design/DECISIONS.md) or [SPINE.md](docs/design/SPINE.md), and its open questions each carry a recommendation;
5. every restoration listed for it in the trace's correction files ([DESIGN_TRACE.md](docs/reference/DESIGN_TRACE.md) §2) is applied.

### 5.3 A workstream is done when:
1. it started from a ready specification (5.2) and a numbered plan;
2. each acceptance criterion it carries was written as a test **first**, seen failing, then made to pass — without weakening any existing test;
3. an **independent review** (a separate model instance or person whose only job is critique) found no unresolved defect;
4. `pnpm gate` passes, and the frozen suite was re-run if the workstream touched anything a card's run depends on (loop, context, gates, models, sandbox, the runner);
5. the specification was updated in the same commit — its status, its State table and any behaviour that changed — and the COVERAGE row is marked done with its commit;
6. `main` was fast-forwarded to it ([DEC-10](docs/design/DECISIONS.md#dec-10)).

### 5.4 A specification is built when:
every acceptance criterion in its "v1 acceptance" section is a test that passes, and every capability it describes is reachable from a command a user runs. Code reachable only from tests does not count. Its front matter then says `status: built`.

### 5.5 The harness is releasable when:
1. `pnpm release-gate` passes (rungs 1–8);
2. the **frozen suite** has been run on the release build, its score recorded in `docs/reference/SUITE_RUNS.md` against the suite hash, and **every failure attributed to a named cause** — none of them a known and unfixed harness defect;
3. the anti-shallow audit (§2, §3) has been run against the release commit and its findings fixed or recorded;
4. the documents are current: the executable documentation checks pass (COVERAGE T10), and the README and the claims table in [SPINE.md](docs/design/SPINE.md) say nothing the product does not do;
5. the working tree is clean.

---

## 6. The product is done for v1 when

All of these hold on one release commit. This is the target the plan works toward; the ceiling run with a frontier model ([DEC-07](docs/design/DECISIONS.md#dec-07)) comes after it.

1. **Every specification is built** (5.4) — the SPINE status table reads `built` on every row.
2. **The spine is kept, in code.** Every COVERAGE Tier 0 item (S1–S10) is closed, each with a test that fails when its fix is removed, and a fresh independent security review of the release commit finds no open critical or high issue. Because the Worker is uncensored ([DEC-04](docs/design/DECISIONS.md#dec-04)), the sandbox tests include a Worker that *tries* to leave it: writes to `.git`, to linked dependencies and outside the worktree, network egress, and code run through the gates' own processes — each refused and logged.
3. **The measurement is valid and recorded.** Every Tier 1 item (M1–M12) is closed. The full frozen suite ran on the release build with the recorded Worker and settings, reported as a pass rate with an exact 95% interval, with every failure named. The planning measure (COVERAGE T7) ran once and its score is recorded. Any comparison between settings is paired and states the smallest difference it could detect.
4. **The three audiences can do their jobs**, each proven by an end-to-end test against the real dashboard and a real board:
   - a **developer** finds which card is blocked and why within three actions from the board, at 1440 and 1100 pixels wide;
   - a **beginner**, with the Learn layer on, reaches the explanation of a WIP limit from the board by keyboard alone;
   - a **non-developer** starts a new project and gets its status in plain words without a terminal, including at 400 pixels wide.
5. **Accessible.** Every colour pair the tokens use as text or as a control's only edge meets WCAG 2.2 AA, asserted by a test over the tokens as used; every control has an accessible name; nothing a person needs is available only on hover.
6. **The Team setup works** ([DEC-35](docs/design/DECISIONS.md#dec-35--one-product-two-setups-solo-and-team), extending [DEC-06](docs/design/DECISIONS.md#dec-06)): bound to a non-loopback address, an unauthenticated request cannot change anything, each of the four access levels can do only what [teams](docs/design/specs/teams.md) §2.2 allows, a person the project's Accept rule does not name cannot accept, and every event names its person.
7. **A new user reaches a first card.** From a fresh clone and an empty repository, one documented first run leads to a card built and gated, on the reference machine, without editing a file by hand.
8. **Releasable** (5.5), and `main` is at the release commit.

---

## 7. Zero Tolerance Policy

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
