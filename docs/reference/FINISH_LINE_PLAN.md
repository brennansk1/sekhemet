# Finish-line plan: from feature complete to a published product

*Written 2026-09-28 (a Monday), while the Phase B close-out ran. It picks up where [MODERNIZATION_PLAN.md](MODERNIZATION_PLAN.md) stops: Phase B's build workstreams are committed (B0–B4.11), and Phase C ("measure, then release") had no schedule. It uses the research in §R, a read-only audit of this tree on the same day, [DEFINITION_OF_DONE.md](../../DEFINITION_OF_DONE.md) §5–6, and the five sprints already proposed, which are folded into §E.*

**What "published" means here:** outside people can install Sekhemet from a public channel, reach a first accepted issue without help, and rely on it. Every claim it makes is true, a person can report a problem, and a fix reaches them as a versioned release.

**How to read it:**
- §A is the quality bar;
- §B the gaps, ranked;
- §C and §D how they are found and held shut;
- §E the schedule;
- §F how a release is cut;
- §G when we stop;
- §H what can go wrong.

Sources are in §S. A claim marked *(unverified)* was not confirmed at its source this session. A number with no source is a policy choice, and it is labelled as one.

---

## R. What the research says, and where it applies

Two products are at stake:
- **the harness** Claude built across many sessions, an AI brownfield by the modernization plan's own account;
- **the software Sekhemet's local models build** for users.

A finding can apply to either one or to both.

| Shortcoming (source) | Finding | In the harness Claude built | In what Sekhemet's models build |
| --- | --- | --- | --- |
| Security flaws [S1–S4] | Veracode: 45% of samples had OWASP Top-10 flaws, and newer or larger models were no safer. Pearce: about 40% of Copilot programs were vulnerable. Perry: people using an assistant wrote less secure code and believed it more secure. Apiiro: privilege-escalation paths +322% | Found here: the dashboard has no Host check, CSP or framing guard (B-1), and Linux confinement leaves home readable (B-2) | Bundled semgrep rules, secret scan and OSV run per card (gates rules 13–15). No check covers authorisation logic |
| Hallucinated dependencies [S5, S6] | 19.7% of 2.23M generated package references did not exist; open models 21.7% against commercial 5.2%. 43% of the invented names recur on every rerun, so attackers can register them | Low risk: new dependencies need the owner's yes (DEC-40) and the lockfile is committed. No audit of our own lockfile runs (B-9) | The dependency gate checks existence, age and typosquat distance (`builtin.ts:436-954`). Local models are the high-risk group in the study |
| Test gaming [S7–S10] | o3 reward-hacked 30.4% of RE-Bench runs, and telling it not to barely helped. GPT-5 "passed" 76% of impossible tasks by editing tests or special-casing. SWE-Bench+: 31% of "resolved" patches were suspect because the tests were weak | Builders wrote tests alongside code in B4.8 (Entry 56). The independent review per workstream is the defence, plus the frozen suite | Red-first, stub-kill, diff-scoped mutation and `gate_suspected` exist (gates 6a, 18, 32). No fixture proves that an impossible issue ends parked rather than passed (C-4) |
| Error handling and edge cases [S11] | AI pull requests had about 1.7× the issues, nearly 2× the error-handling gaps and +75% logic issues (CodeRabbit, 470 PRs) | The CLI prints raw stack traces (B-9). No fault-injection suite exists (B-13) | Property-test seeds sit in the test-strength record. The capstone's edge cases (midnight, daylight saving, stacked rules) test this directly |
| Duplication and dead code [S12] | Cloned blocks rose 8× in 2024; moved (refactored) lines fell from 24.1% to 9.5% | The reachability gate is meant to run over Sekhemet itself (modernization rule 3). No clone check exists | Reachability is checked; duplication is not (B-19) |
| Architectural drift across sessions [S3, S13, S14] | Architectural design flaws +153% (Apiiro). 41.8% of multi-agent failures are specification failures (MAST). Every model degrades as its context grows (context rot) | The spec-in-same-commit rule and `docs.spec.ts`. Drift is still found: stale §4 rows, teams' front matter, the SPINE claims table (B-7) | The architecture gate checks the brief's invariants; project documents live in the repository |
| Accessibility [S15–S17] | Generated UIs omit labels and alt text, or fill them with meaningless values. axe finds about 57% of issues by volume | axe runs in Chromium at three widths and both themes (`a11y.spec.ts`). No keyboard or screen-reader pass covers the B4.7–B4.11 pages (B-10) | The visual gate runs axe (`packages/gates/src/visual.ts`). Nothing checks meaningless names |
| Performance and observability | No 2024–2026 study with numbers was found *(research gap)* | No budgets and no performance tests (B-15). One daemon log with no levels (B-16) | Not checked. The evidence must say so: "may do less, never claims more" (SPINE) |
| Licensing and reproduced code [S18] | 0.88–2.01% of output was strikingly similar to existing code, mostly without licence information | Holders differ between LICENSE and NOTICE, and model-weight licences are not recorded (B-4, B-17) | The licence gate and the SPDX classifier. Copied snippets are not detected *(no check exists)* |
| Stability and maintainability [S19, S20] | DORA 2024: +25% AI adoption came with −7.2% delivery stability. DORA 2025: AI amplifies what a team already does, and instability still rises | Complexity is reported on changed files, not yet gated (modernization guardrails) | Card size (≤ 200 lines, 1–3 files) and three project gates |
| Overconfidence and false "done" [S21–S23] | METR: developers were 19% slower while believing they were 20% faster. In one benchmark, 44–76% of agent failures were confident completions contradicted by the environment. 91.5% of 20,574 agent sessions needed correction | DEV_LOG says "Linux via CI" (Entry 32), but no CI exists (B-3). A claim must cite gate output on the exact tree | The spine: gates decide, a person accepts, and the Reviewer states no confidence |
| Destructive actions and ignored instructions [S24, S25] | Replit's agent deleted a production database during a code freeze. Gemini CLI overwrote files after an unchecked `mkdir` | Git hardening and worktrees. Accept is reversible (B3.2) | The sandbox, the permission engine and `--auto-accept` limited to measurement repositories |

**Release practice** [S26–S33]:
- a feature freeze, then betas (fixes only), then release candidates, then final (Python's PEP 602);
- provenance-signed npm packages from CI (Sigstore), SLSA build levels, and an SBOM in CycloneDX or SPDX (`npm sbom`);
- OpenSSF Scorecard's checks (pinned dependencies, signed releases);
- SemVer, where 0.y.z means "anything may change" and a prerelease such as `1.0.0-rc.1` sorts before its release;
- Keep a Changelog, with an *Unreleased* section;
- expand-and-contract migrations;
- local-first, opt-in telemetry as Go does it: counters stay on the machine, and nothing is uploaded until the person turns it on.

**Fast testing** [S34–S41]:
- risk = likelihood × impact decides depth and order (ISTQB);
- selection by change halves the cost at over 99.9% fault detection (Meta);
- Vitest's `--changed` follows static imports only, so it can miss tests;
- about 16% of Google's tests flake, and 84% of pass-to-fail transitions were flakes, so quarantine is worth having;
- mutation testing pays when it is diff-scoped and shown in review (Google);
- Stryker's incremental mode;
- property-based testing (fast-check), consumer-driven contracts (Pact), and fault injection against a defined steady state.

**Usability evaluation** [S42–S52]:
- Nielsen's ten heuristics, with severity rated 0–4 as the mean of three evaluators;
- cognitive walkthroughs' four questions;
- five users per round, or three per group when there are three or more groups, in several small rounds rather than one large one;
- SUS: 68 is average, "acceptable" is above 70 (Bangor), and A is about 80.8 or more;
- WCAG 2.2 AA, including 2.4.11 *Focus Not Obscured* and 2.5.8 *Target Size* (24 × 24 px);
- Core Web Vitals: INP ≤ 200 ms, LCP ≤ 2.5 s, CLS ≤ 0.1;
- response-time limits of 0.1 s, 1 s and 10 s;
- Playwright's `toHaveScreenshot`, with baselines per OS and browser.

AI evaluators are a first pass only:
- one study found a GPT-4o heuristic evaluation reached 21.2% of the experts' issues, while another reports higher coverage with misread elements;
- UXAgent's own reviewers treat simulated users as a pilot before human testing.

**Trusting agents** [S53–S57]:
- grade the outcome and the final state, and read the transcripts;
- report pass^k, not only pass@k;
- use contamination-free, hidden tests;
- a single trial is not a finding.

Users' top complaint is output that is "almost right, but not quite" (45%), and 46% distrust the accuracy of AI tools.

---

## A. The quality bar

"Claude-desktop quality" and "professional" become checkable items. Each has a threshold and the check that measures it. A threshold with no research source is marked *policy*.

| Area | Item | Threshold | Checked by |
| --- | --- | --- | --- |
| **Visual system** | Colours, type, spacing and radii come only from tokens | 0 raw colour or size literals in `packages/ui/web/*` outside the token module | New lint test, W6 |
| | Every dashboard-v3 mockup screen has a built page that matches its layout | Each deviation fixed, or accepted by the owner in writing | Design-system audit, W5 (the list is in §D) |
| | Light and dark parity | Every page renders in both themes and passes contrast in both | `a11y.spec.ts` (exists), the visual baselines in W6 |
| **States** | Every data view has empty, loading and error states, and the error state offers a next action | 100% of views in the W5 inventory | State inventory, W5; one test per view, W6 |
| | Nothing raw reaches a person | 0 stack traces, error codes without words, or `undefined`/`NaN` in the UI or CLI output | Copy scan, W3 and W6 |
| | Long work shows progress | Any wait over 1 s shows a state; over 10 s shows progress and what is happening [S49] | W5 inventory, W9 measurement |
| **Responsiveness** | Interaction latency | INP-like p75 ≤ 200 ms on the board, the issue page and Review [S48] | Chromium measurement harness, W9 |
| | First render of a page | ≤ 2.5 s LCP-like on localhost with a *policy* board of 500 issues [S48] | W9 |
| | Layout stability | CLS ≤ 0.1 [S48] | W9 |
| | CLI start | *Policy:* measured and recorded, then held to +20% of that figure in CI | W9 |
| **Keyboard and accessibility** | WCAG 2.2 AA | axe finds 0 violations on every page at 1440, 1100 and 400 px in both themes, plus a manual pass on 2.4.11, 2.5.8, 2.1.1 and 2.4.7 | `a11y.spec.ts`; W6 manual pass |
| | Keyboard-only audience tasks | Each DoD §6.4 task completes by keyboard alone, with focus never lost or hidden | End-to-end tests, W10 |
| | Screen reader | The three audience tasks complete with VoiceOver, with no unnamed control and no meaningless name ("image", "click here") [S17] | Manual pass by a person, D.4 |
| | Motion | `prefers-reduced-motion` honoured everywhere animation exists | W6 test |
| **Copy** | Vocabulary | DEC-31 scans pass on the web and the CLI | `professional_language.spec.ts` (exists) |
| | Error messages | Each says what happened, why, and what to do next, never blames the person, and appears next to its cause [S44] | NN/g rubric review, W5; fixes in W3 and W6 |
| | Voice | Plain, exact and calm, never "done" for "I think so" (SPINE, *Voice*) | W5 review |
| **Reliability** | Durable state | 0 events lost or corrupted in the fault-injection suite (C.6) | W8 tests, R14 |
| | Recovery | After every injected fault the issue ends in a recorded stop reason and `resume` continues | W8 tests |
| | Soak | 8 *policy* hours of queue and dashboard: no crash, and no monotonic growth in RSS or open handles | R14 |
| **Install** | Clean machine | From a fresh macOS account and a fresh Ubuntu VM: install, then reach a first issue built, gated and accepted, with no file edited by hand (DoD §6.7) | Walk script, W10; R9 |
| | Every install failure is actionable | Each failure mode the walk hits prints its cause and its fix | Walk log review |
| **CLI** | Help | Every command has `--help` with a synopsis and an example | Test generated from the command table, W3 |
| | Errors | Unknown commands and flags exit 2 (exists); an unexpected error prints one line and a report path, with the stack only under `--debug` | W3 test |

---

## B. The gap register

**Where the evidence comes from:**
- A read-only audit of this tree on 2026-09-28 found these gaps.
- The lead re-checked B-1, B-2, B-3, B-5 and B-9 against the code.
- The other line references are the audit's, and a workflow re-checks each before fixing it.

**How the rows are ordered:** by release risk, meaning the harm to an outside user times the likelihood they hit it.

**What each row names:**
- the workflow that fixes it (W-ids, §E.3);
- the check that holds it shut (C-ids, §C).

| # | Gap | Evidence | Risk | Fix route |
| --- | --- | --- | --- | --- |
| **B-1** | **The dashboard is exposed to other web pages.** Server responses set only `nosniff`: no CSP and no `frame-ancestors`. A mutation is trusted when it has a constant header and no Origin. No Host allowlist exists, so DNS rebinding can read the board, the diffs and the evidence (the user's source code), and a framing page can click Accept (a merge) | `apps/harness/src/server.ts:317-322`, `:237-240`; `security.md:246`, `runtime.md:216`, `dashboard.md:428` (all not-built) | Critical | W1; C-2 (a rebinding test, a framing test, a no-token mutation refused) |
| **B-2** | **Linux confinement exposes home-directory secrets and has never run on Linux.** bubblewrap binds `/` read-only with no mask over `~/.ssh`, `~/.aws`, `~/.npmrc` or `~/.sekhemet`, while Seatbelt denies those reads. bwrap's tests check argv only. About 40 test calls are gated to darwin, and none exercises bubblewrap at runtime | `packages/sandbox/src/bubblewrap.ts:35-49`; `seatbelt.ts:232-247` (audit); `security.md:220`, `:230`; DEC-42 ("Linux via CI") | Critical on Linux | W1 (masks); R9 (Lima); W7 (CI) |
| **B-3** | **There is no CI, and the release gate is unproven.** There is no `.github/` or other CI configuration. DoD rung 4 requires "0 skipped", yet every gate run skips 37, mostly tests whose tool (semgrep, gitleaks, cargo, a mutation tool, Chromium) is not installed. Rung 9 fails until a context version is stamped by an A/B. No passing `pnpm release-gate` is recorded | Repository root listing; `DEFINITION_OF_DONE.md:88`; `DEV_LOG.md:89`, `:755` | High | W7; R5 (the stamp); owner decision O-8 |
| **B-4** | **A new user cannot get working models, and model licences are unrecorded.** Only the Coding model has a download source. The Planning and Research defaults have none. PROVENANCE has no weight-licence rows. Qualification is recorded for one host, and only the Coding role is gated on it | `models.md:305`, `:306`, `:328`, `:357` (audit); PROVENANCE (grep) | High | W11; R2; O-5 |
| **B-5** | **Neither install path exists outside this machine.** The npm tarball builds but is unpublished. The server image has never been built or run on Linux. The image starts a `dev` command. `install.sh` checks Node ≥ 22 where 22.13 is needed | `docs/reference/INSTALL.md:3`, `:45`; `packaging/server/Dockerfile` (last line); `scripts/install.sh:13-14` (audit) | High | W3 (entrypoint, script); W7 (image in CI); R9 |
| **B-6** | **The measurement a release must carry is incomplete.** No Review model is admitted: gpt-oss-20b reached 18% recall against the 0.3 bar, and every review was cut off at high reasoning. The baseline is paused in round 2, so no RunProfile is frozen. The planning measure waits on labels. The model-facing wording changes have no A/B. F23 and F24 are open | `DEV_LOG.md:84-87`, `:227`; SUITE_RUNS (B2.5 schedule) | High | R2–R8; W0 (F23, F24) |
| **B-7** | **The product says more than is true, in both directions.** The SPINE claims table still says Team setup and teaching are "not built". Teams' front matter says `not-built` over built code. The README status is dated 2026-09-22 and claims 1,164 tests. Several §4 rows are stale. DoD §5.5.4 fails | `SPINE.md` claims table; `teams.md:3-5`; `README.md:10`; `security.md:244`, `integrations.md:178`, `models.md:305` (audit) | High | W4; C-9 (a claims-table test) |
| **B-8** | **No user documentation.** There is no user guide, per-command reference, troubleshooting page, SECURITY.md (how to report a vulnerability) or CHANGELOG. `docs.spec.ts` forbids new root files | `docs/README.md:3`; audit item 7 | High | W3; O-11 |
| **B-9** | **CLI failures are raw.** An uncaught error prints its stack (`console.error(err)`), there is no `unhandledRejection` handler, `--help` shows only the front door, and three parsers share one `main` of about 1,600 lines | `apps/harness/src/index.ts:3766-3771`; `front_door.ts:366-367`; `surface.md:235` | High (it is the first thing a new user meets) | W3 |
| **B-10** | **The newest UI has never been seen or walked.** B4.7–B4.11's pages were not seen in a browser beyond a sweep. There is no visual regression. No audience end-to-end test covers DoD §6.4. Take-over (DS-TO-15) is partial. Accessibility beyond axe is partial | `DEV_LOG.md:100`, `:263`; `dashboard.md:398`, `:424`, `:427`; `design-stage.md:267` (audit) | High | W5, W6, W10; D.1–D.6 |
| B-11 | Our own supply chain: about 268 locked packages with no audit, no SBOM, no provenance and no signing | Audit item 9; `security.md:256` | Medium | W7 |
| B-12 | On Linux, integration tokens sit in a plaintext 0600 file. The keychain is used only on darwin | `apps/harness/src/keychain.ts:34`; `integrations.ts:98-129` (audit) | Medium | W1 |
| B-13 | No fault-injection or soak tests. Recovery code exists (stop reasons, `resume`, the watchdog) but is proven only by unit tests | Audit "present and good"; no soak test found | Medium | W8; R14 |
| B-14 | Team operations have gaps: no mail relay for password resets, no per-project level of *none*, no undo of an override, and watcher email needs `nodemailer`, not yet downloaded | `teams.md:237`, `:244`; `DEV_LOG.md:96` | Medium (Team setup only) | W0 (email, if approved); W4 (scope decision) |
| B-15 | No performance budget anywhere | Audit item 13 | Medium | W9 |
| B-16 | Observability: one daemon log with no levels, no crash-report bundle, and traces served but never shown | `daemon.ts:157`; `runtime.md:225` (audit) | Medium | W8 |
| B-17 | Licence metadata: LICENSE names "Sekhemet Contributors" while NOTICE names a person, and workspace packages have neither `license` nor `"private": true` | Audit item 17 | Medium (legal clarity) | W3; O-6 |
| B-18 | No supported-platform statement; Windows fails closed without saying so | `executor.ts:340` (audit) | Low | W3 |
| B-19 | Software the models build is not checked for duplication | No clone check in `gates.md` | Low | Phase C proposal (O-4) |
| B-20 | Seven change ids are *not built* inside committed workstreams, with no owner or deferral | `DEV_LOG.md:215` | Medium (DoD §6.1) | W4 |

**Present and good** (the audit, not re-checked here):
- migrations numbered in `user_version`, with a backup first and a newer database refused;
- a model server's death mid-issue becomes a recorded stop;
- a first-run flow and `doctor`;
- the dependency, OSV, licence and secret gates for users' code;
- Team cookies and CSRF;
- offline/reconnecting states in the live stream;
- no telemetry SDK of any kind.

---

## C. Test strategy

### C.1 Levels

| Level | What it proves | Today | Added by this plan |
| --- | --- | --- | --- |
| Unit | Functions and modules, with real SQLite, git and subprocesses where the DoD requires them | About 650 spec files and 5,020 tests (`DEV_LOG.md:89`) | Property tests where invariants are algebraic (C.5) |
| Contract | Shapes between parts that change separately | `PM_CONTRACT.md` shapes are partly asserted | Dashboard ↔ server schemas; model adapters against recorded OpenAI-compatible and Ollama replies; the GitHub adapter against recorded payloads (W8) |
| Integration | Packages together: queue, gates, sandbox, kernel | Present (the vitest integration project) | Fault injection (C.6) |
| System | The product as shipped: the packed tarball, the image, the CLI | `install_package.spec.ts`; `release_gate.mjs` rungs 6–8 | A clean-machine walk on macOS and Ubuntu; the image in CI (W7, W10) |
| Acceptance | The DoD §6.4 audience tasks and the frozen suite | Unit-level only for the audiences; the suite runs | Four browser end-to-end tests (W10); the capstone's hidden suite (W2) |
| Non-functional | Security, performance, accessibility, reliability, installability | axe in Chromium; the injection fixtures on macOS | Hardening tests (W1), budgets (W9), a keyboard and screen-reader pass (D.4), soak (R14), Linux containment (R9) |

### C.2 Risk-based priority

Risk is likelihood × impact [S34]. Tests are written and run in this order, and each workflow's brief carries its tier.

1. **Tier 1: data, containment and trust.**
   - The ledger and migrations;
   - the sandbox on both OSes;
   - dashboard mutations, Accept and merge;
   - the gates that decide done;
   - secrets.

   A defect here loses work, leaks code or certifies wrong work.
2. **Tier 2: first contact.**
   - Install;
   - first run;
   - model setup;
   - CLI errors;
   - the three audience tasks.

   A defect here loses the user.
3. **Tier 3: daily use.**
   - Board, Review, Status, Inbox and Seshat;
   - performance;
   - accessibility.
4. **Tier 4: the rest.**
   - Integrations;
   - Team extras;
   - Insights.

### C.3 What runs when

| Cadence | Runs | Stops on |
| --- | --- | --- |
| **Per edit (local loop)** | `tsc -b` on the package, then `vitest run <changed files>` with `--pool=forks --poolOptions.forks.maxForks=1` while a model is loaded. Never an empty file list | First failure |
| **Per commit** | `pnpm gate` (`tsc -b && biome check . && vitest run`), already ordered fail-fast (types, then lint, then tests). Run on the snapshot being committed (DEC-10). CI then runs the same on macOS and Ubuntu | Any failure; any skip not platform-gated (O-8) |
| **Nightly (Stream 1)** | Preflight R0, then the night's model run. When no model run is planned: the soak (R14), incremental mutation on tier-1 packages (C.5), and the Chromium suite at all widths | Preflight failure stops the night before the model loads |
| **Per release candidate** | `pnpm release-gate` on macOS and Linux, plus: the frozen suite on the RC build (R15); the planning measure (R8); clean-machine walks; the fault-injection suite; the visual baselines; the audience tests; a fresh independent security review (W13); SBOM, OSV and licence checks | Any open critical or high finding |

`vitest --changed` is a convenience in the local loop only. It follows static imports and can miss tests [S37], so it never replaces the full run before a commit.

### C.4 Preflight and smoke before every long run

These are the owner's live-testing ladder, made mandatory. No model loads until R0 passes, and no long run starts until R1 passes. A failure that would show in the first minutes must be caught in the first minutes.

**R0, the preflight (no model, minutes):**
1. The snapshot is at the intended commit, with its own `dist/` and its own registry copy (`SEKHEMET_MODEL_REGISTRY`, per F23).
2. `sekhemet doctor` passes on that snapshot.
3. The model is qualified for this build and this role (F24).
4. Every file the run reads exists and matches its hash: fixtures, reference solutions, the hidden suite's recorded hash, the seed repository, the pinned toolchain.
5. Disk space is free for the run's worktrees.
6. Swap is under 4 GB and at least 60% of memory is free (DEC-42).
7. No `tsc -b` or `pnpm gate` is running.
8. Chromium is closed.
9. The owner's Hermes server on port 8080 is stopped.
10. The driver's log watches only lines written after the wait starts (the lesson of 2026-09-27).

**R1, the smoke run:**
- load the model and record the load time;
- check `/health`, and check `/props` against the profile;
- run one generation and one tool call;
- run the first issue's first steps;
- unload.

**Then climb the ladder:** one issue → each arm on 2–3 issues → the full run. Stop early on:
- a harness error;
- exit 143;
- swap over 4 GB;
- a repeating stop reason that points at the harness.

### C.5 Mutation and property testing, where they pay

**Mutation:** Stryker in incremental mode [S40] on tier-1 packages only: `kernel`, `sandbox`, the gate decision code, and the Team access checks.
- It runs nightly on changed files and reports survivors to the next workflow.
- A threshold is set only after the first measured run (*policy*: none invented).
- It needs a download (O-4).

**Property tests with fast-check** [S38] (a download, O-4) on the algebraic invariants:
- the issue state machine: no sequence of legal events reaches an illegal state;
- the hash chain: any byte flipped is detected;
- erasure: replay names every gap;
- semver ordering;
- `stats.ts`' exact tests against their pinned reference values;
- redaction: no generated secret survives.

### C.6 Fault injection and soak

**Steady state:** the ledger verifies, no issue is lost, and every issue ends in a recorded stop reason [S41].

**Faults injected (W8 builds them; R14 runs them nightly):**
- `kill -9` of the model server mid-step;
- `kill -9` of the daemon mid-transaction;
- the models volume unmounted during a load;
- a full disk during a worktree write;
- a corrupt configuration file;
- a clock jump;
- a network drop during research;
- two servers on one project;
- two projects on one machine ([models](../design/specs/models.md) MD-N17-4).

**Soak:** 8 *policy* hours of `queue` on a fixture, with the dashboard open over SSE. Recorded: RSS, open handles, event-log growth, and SSE reconnects.

### C.7 Flaky tests

A test that fails and then passes on the same tree is quarantined in a checked-in list, with its owner, the date and an issue.
- **Quarantine never loosens the gate:** a quarantined test still runs, and its failures are reported. Tier-1 tests cannot be quarantined.
- **The release gate refuses** any quarantine entry older than 14 days (*policy*).

This matters because 84% of Google's pass-to-fail transitions were flakes [S36]. Without a list, people learn to ignore red.

### C.8 Each AI shortcoming, caught by a named check

| Shortcoming | In the harness (Claude-built) | In software Sekhemet builds |
| --- | --- | --- |
| Security flaws | W1's hardening tests (C-2). Our own gates run over Sekhemet (dogfood: semgrep rules, gitleaks, OSV). A fresh independent security review per RC (W13, DoD §6.2) | Semgrep, secret and OSV gates (exist). The injection fixtures prove the sandbox, not the code, so they say so |
| Hallucinated dependencies | Frozen lockfile. Any new dependency needs the owner's yes and appears in the SBOM diff (W7) | The dependency gate (exists). **C-3:** a test feeding it names from the slopsquatting study's recurring set must refuse each one *(the study's name list is unverified as available)* |
| Test gaming | Tests first; the independent review reads the test diff before the code; the frozen suite untouched; mutation on tier 1 (C.5) | Red-first, stub-kill and mutation (exist). **C-4:** "impossible issue" fixtures, built ImpossibleBench-style outside the frozen suite, must end parked (`gate_suspected`) or failed, never accepted [S8] |
| Missing error handling | Fault injection (C.6); the CLI error tests (W3) | The Reviewer's per-criterion findings; the capstone's hidden edge-case tests (midnight, daylight saving, stacked overtime) |
| Duplication and dead code | The reachability gate run over Sekhemet itself on each RC (modernization rule 3). A clone check (proposal, O-4) | Reachability (exists). Clone detection proposed for Phase C (B-19) |
| Architectural drift | Spec in the same commit; `docs.spec.ts`; **C-9**, a test that the SPINE claims table matches each spec's front matter | The architecture gate (exists) |
| Accessibility | axe (exists), a manual keyboard and VoiceOver pass (D.4), and a meaningless-name lint (W6) | The visual gate's axe (exists). The capstone's timesheet grid is scored for accessibility |
| Performance and observability | W9's budgets; W8's log levels and crash bundle | Not checked. The issue's evidence says "performance not measured" (SPINE: never claim more) |
| Docs and licensing | A docs test that every CLI command appears in the reference (W3); SBOM and licence checks (W7) | The licence gate (exists); `CHANGELOG` when in scope |
| Maintainability | Biome complexity on changed files, gated at RC once its baseline is recorded | Lint gates; issue size ≤ 200 lines |
| Hollow features (they look done, but do nothing real or handle only the happy path) | C.9: the dead-control crawl, the entry-point criterion report, the stub scan and the unhappy-path matrix (W16) | The Reviewer's per-criterion findings; stub-kill; the capstone's hidden edge-case tests; the soak |
| Missing features (professionals expect them, but no spec asked) | C.9: the professional-parity checklist and exploratory charters (W16); the owner's dogfooding | The capstone brief's stakeholder conversation and change request; the requirement graph's Must/Should/Could |
| False "done" | Builders never grade themselves (§H). A DEV_LOG claim needs gate output from the exact tree. The claims table is tested (C-9) | Gates decide and a person accepts (the spine). pass^k over 2–3 trials in the capstone [S54] |

---

### C.9 Hollow and missing features: what AI builders most often leave behind

Tests written with the code prove what the builder thought of. These checks look for what it did not. Each produces a list, and every entry is fixed, or deferred by a DEC, before a release candidate.

1. **Dead-control crawl.** On a seeded project, every page in Chromium: each interactive element is activated and must produce an observable effect (a request, a state change, a visible response, or a disabled control that names the level it needs) with no console error. Pages at 1440, 1100 and 400 px. It stays as a permanent Playwright test, so a new dead control fails the gate.
2. **Wiring audit.**
   - Every server route is exercised through HTTP by at least one test.
   - Every URL the web client fetches exists on the server.
   - Every CLI command runs `--help` and one smoke invocation.
   - The reachability gate runs over Sekhemet itself: no exported feature code is unreachable from an entry point.
3. **Entry-point criterion report.** Each EARS criterion marked *built* needs at least one test that goes through a real entry point: HTTP, the CLI, the UI or the queue. A criterion whose only tests call a function directly is listed as *unit-only*, and each one gets an end-to-end test or a reason.
4. **Stub and placeholder scan over Sekhemet** (the stub-kill and ast-grep rules the product runs on users' code). It catches:
   - "not implemented" throws;
   - TODO or FIXME in shipped code;
   - "coming soon", lorem ipsum, hard-coded demo data;
   - empty `catch` blocks, and functions that always return a constant.
5. **The unhappy-path matrix.** Every feature crossed with: empty, loading, error, slow, model down, offline, permission denied, large data (500 and 10,000 issues), concurrent edit, undo, retry or idempotency, and a restart mid-operation. Each cell is a test or an explicit *n/a* with its reason. It is generated from the specs' criteria lists, so no feature is skipped.
6. **Professional parity checklist.** What teams expect from Linear, Jira and GitHub Projects, from their public docs:
   - search and saved filters;
   - bulk edit;
   - keyboard shortcuts and undo;
   - notification preferences;
   - import and export;
   - large-list performance;
   - permissions and audit;
   - backup and restore;
   - upgrade and uninstall;
   - per-feature docs.

   Each item is *present*, *missing* (it goes to the gap register) or *out of scope by a DEC*.
7. **Exploratory charters** (session-based test management). Agents, and then the owner while dogfooding, work time-boxed missions: "break the review flow", "run a project as a junior for an hour", "take over a messy repository". Each defect is logged with its reproduction.
8. **What agents forget, checked every time:**
   - config validation and defaults;
   - migrations;
   - cleanup of temp files, worktrees and child processes (checked after the soak);
   - idempotent retries;
   - timezones, daylight saving and clock skew;
   - Unicode and space-containing paths;
   - read-only and full disks;
   - log redaction;
   - uninstall.

Mutation testing (C.5) is the backstop for shallow tests: a test that survives its mutants proves nothing.

### C.10 The vibe-coding gap audit

**The owner's requirement:** everything AI lacks that could stop vibe coding from reaching a finished product is accounted for, twice:
- in **the harness**, which Claude agents built;
- in **the software Sekhemet's models build**, which is Sekhemet's purpose.

**How the rows were made (2026-09-28):**
- The taxonomy comes from 2024–2026 studies, incident reports, practitioner write-ups and enterprise surveys. Each row cites its source in §S.
- *(search summary)* means the figure was read in a search result, not at the source page. *(unverified)* means it was not confirmed at all. *(research gap)* means no study with numbers was found.
- Each mechanism was checked by Grep in `docs/design/specs/` and `packages/gates/`. *(exists)* means a spec names it and the code path is cited there; many such rows are still *partial* in their spec's §4. *(new, W#)* means this plan adds it.
- **Status:** *covered* means a named, scheduled check already existed in this plan. *added* means this section adds the missing check. *out of v1 (part)* means part of the row is deferred, and the named decision must record it.

**What it found:**
- 52 failure modes in 19 groups.
- 18 were already covered by a scheduled check in both columns.
- 26 needed a check added in at least one column.
- 8 are partly out of v1, and each needs a recorded decision (O-12, O-13). Four of them also gained a check for the part that is in v1.
- Three more rows keep a small part out of v1 behind an existing decision or O-13: V-7 (clones, O-4), V-13 (API-level deprecation) and V-14 (the crawl of users' web apps).
- The biggest gaps were in the software Sekhemet builds: authorisation, web configuration, data safety and "does it run from a clean clone" had no check. The depth profile named the quality rows but did not expand them into concrete criteria.

| # | Failure | Source | Harness check (Sekhemet itself) | Check in the software Sekhemet builds | Status; owner and schedule |
| --- | --- | --- | --- | --- | --- |
| **Requirements** | | | | | |
| V-1 | Misreads intent; writes code instead of asking when a requirement is ambiguous | [S72] misinterpretation is a top bug class; [S73] models rarely ask, and fall over 30% on ambiguous specs *(search summary)* | Specs are the truth; the independent review reads the spec, not the builder's summary (E.3) | Seshat's one batch of up to five questions, each with a default; "not stated — assumed" in the brief; the criterion lint *(exists)* | Covered. R6, R8 |
| V-2 | Unstated needs: what a professional expects but nobody asked for | [S66] the last 30%; [S63] 0 of 15 test-passing agent PRs mergeable | The professional-parity checklist (C.9 item 6) | Depth profile and ISO 25010 checklist; comparable products *(exists)*. **The checklist expanded into concrete criteria per row, C-16** *(new, W17)* | Added. W16; W17 |
| V-3 | Scope creep and over-building | [S69] PR size +154% with AI *(search summary)*; [S71] verbosity | Feature freeze at K4; W4's v1 scope | Bounds (3 files, 200 lines), `scope_violation` stop, non-goals and appetite in the brief *(exists)* | Covered. Every card; K4 |
| V-4 | Building the wrong thing | [S85] "no market need" is the top startup failure reason *(pre-2024; background)*; [S84] 95% of enterprise pilots show no P&L return *(secondary)* | D.3 sessions; the beta (§G.12); the capstone against Claude (W12) | Problem, Outcome and baseline in the brief; the riskiest assumption as the first card after the contract; a person accepts each slice *(exists)*. Market validation is the person's: the user guide says so *(new, W3 G1)* | Covered. D.3, R13; W3 |
| **Architecture** | | | | | |
| V-5 | Architecture drifts across sessions | [S3], [S13], [S86] "development hell" as a code base grows *(search summary)* | Spec in the same commit; `docs.spec.ts`; C-9 | The architecture gate; ADRs exported to `docs/decisions/`; the dossier *(exists)* | Covered. Per commit; per card |
| V-6 | Over-engineering and high complexity | [S71] every model tested: over 90% of issues were code smells *(search summary)* | Biome complexity on changed files, gated at RC (C.8) | Bounds; the Reviewer's "does this do what the card asked" *(exists)*. A complexity gate is out of v1 | Out of v1 (part): O-13. RC gate |
| V-7 | Duplication and dead code | [S12] | Reachability over Sekhemet (W16 G1) | Reachability *(exists)*; clone detection is Phase C (B-19, O-4) | Covered; clones out of v1 via O-4. W16 |
| **Correctness** | | | | | |
| V-8 | Missing corner cases; happy path only | [S72] "missing corner case" class; [S66] | Property tests (C.5); the unhappy-path matrix (W16 G3) | Path slicing makes retries and boundaries their own cards; a release is refused while a must-have is unproven *(exists)*; the capstone's hidden edge cases (W2, R10) | Covered. W16; R10 |
| V-9 | Concurrency errors and resource leaks | [S71] resource leaks and concurrency errors in every model *(search summary)* | Fault injection: two servers on one project, `kill -9` (C.6); handle growth in the soak (R14) | Hard invariants ("exactly once", "idempotent") scheduled right after the contract, with property tests *(exists)*. **The hidden capstone suite gains a concurrent-edit case** *(new, W2 G3)* | Added. W2; R10 |
| V-10 | Time zones, daylight saving and clock skew | [S72] corner cases; no study with numbers *(research gap)* | The clock-jump fault (C.6); C.9 item 8 | The capstone's midnight and daylight-saving cases (W2) | Covered. R10 |
| V-11 | Numeric precision: money and rounding | No study with numbers *(research gap)* | `stats.ts` exact tests (C.5) | **The hidden capstone suite gains overtime-pay rounding cases** *(new, W2 G3)* | Added. W2; R10 |
| V-12 | Hallucinated APIs and objects | [S72] "hallucinated object"; [S76] | `tsc -b` in `pnpm gate` | The typecheck in the gates; half-done detection of imports that do not exist *(exists)*. A Python project with no type checker has no equivalent: the evidence says so | Covered. Per card |
| V-13 | Deprecated APIs and stale library knowledge | [S76] 25–38% deprecated-API use *(search summary)* | **CI reports Node deprecation warnings; each is fixed or listed** *(new, W7)* | **The dependency gate flags a package its registry marks deprecated, C-15** *(new, W17 G4)*. API-level deprecation only through the project's own lint | Added; API level out of v1 (O-13). W7; W17 |
| **Hollow features** | | | | | |
| V-14 | Hollow or stubbed features that look done | [S66]; [S63] a quarter of test-passing runs still failed core functionality | C.9 (W16) | Stub-kill, half-done detection, the Reviewer *(exists)*. A dead-control crawl of users' web apps is Phase C | Covered; the crawl out of v1 (O-13). W16 |
| V-15 | Passes its tests but does not run as a system: configuration and integration | [S65] over 95% of failures happen before business logic; [S64] best model 61.8% end to end *(search summary)*; [S70] 45% of AI-code deployments have problems | Clean-machine walks (W10, R9) | **The clean-clone check at slice acceptance, C-13** *(new, W17 G5)* | Added. W17; R16 |
| **Tests** | | | | | |
| V-16 | Test gaming | [S7], [S8], [S10] | Tests first; review reads the test diff first; frozen suite | Red-first, stub-kill, mutation, `gate_suspected` *(exists)*; **C-4 now has a run: R16** | Added (schedule). R16 |
| V-17 | Tests assert the buggy behaviour they were written from | [S74] prompts with buggy code produce tests that assert the bug *(search summary)* | Tests written before code | Acceptance tests written from the criteria before the code exists, then red-first *(exists)* | Covered. Every card |
| V-18 | Weak tests inflate pass rates | [S9], [S63] | Mutation on tier 1 (C.5) | Diff-scoped mutation and the test-strength rule per depth profile *(exists)* | Covered. Every card |
| **Security** | | | | | |
| V-19 | Broken object-level authorisation; missing row-level security | [S60] 170 of 1,645 Lovable apps readable and writable *(search summary)*; [S61] 5,600 apps, 2,000+ vulnerabilities, 175 PII exposures; [S62] *(AI link disputed)* | Team access checks under mutation (C.5); W1 | **C-10, a two-user authorisation fixture** and **C-16's security criteria** *(new, W17 G1)* | Added. W17; R16 |
| V-20 | Unauthenticated endpoints | [S61] | W1 G1's per-session mutation token | **C-16:** every non-public route requires authentication, as a criterion with a test *(new, W17 G1)* | Added. W17 |
| V-21 | Injection: SQL, command, path, XSS, SSRF | [S1], [S2] | Our semgrep rules over Sekhemet (C.8) | 34 bundled semgrep rules *(exists)* | Covered. Every card |
| V-22 | Secrets hard-coded or shipped in the client bundle | [S61] 400+ exposed secrets, service-role keys in bundles; [S77] Copilot repositories leak 40% more *(search summary)* | gitleaks over Sekhemet; W1 | The secret gate on added lines *(exists)*; **C-11's client-bundle and service-role-key rules** *(new, W17 G2)* | Added. W17 |
| V-23 | CORS and CSRF misconfiguration | [S61] misconfigured APIs; practitioner checklists *(unverified)* | W1: Host allowlist, CSP, `frame-ancestors`; Team CSRF *(exists)* | **C-11:** CORS `*` with credentials, cookies without `HttpOnly`/`Secure`/`SameSite`; **C-16:** CSRF protection for cookie sessions *(new, W17)* | Added. W17 |
| V-24 | No rate limits on sign-in and costly routes | Practitioner checklists *(unverified)* | Team sign-in limits (teams.md, NIST 800-63B) *(exists)* | Rules slicing defers rate limits to later cards. **C-16 makes sign-in and reset limits a production must-have** *(new, W17 G1)* | Added. W17 |
| V-25 | Vulnerable dependencies, including CVEs found after release | [S1]; [S83] CRA reporting duties from 11 Sep 2026 | W7 OSV; **a weekly scheduled OSV run on the release branch** *(new, W7)* | OSV per card on new findings *(exists)*; **OSV over the whole lockfile at slice release, C-15** *(new, W17 G4)* | Added. W7; W17 |
| V-26 | Hallucinated packages (slopsquatting) | [S5], [S6] | Frozen lockfile; the owner's yes | The dependency gate *(exists)*; C-3 | Covered. W17 G4 runs C-3 |
| V-27 | A compromised dependency's install script | [S79] s1ngularity drove AI CLIs to steal credentials *(search summary)* | pnpm 10 skips dependency install scripts by default [S89 *(unverified)*]; **a test that every allowed build script has a reason** *(new, W7)* | Installs run confined; the dependency tree is not writable from a card (security item 24) *(exists)* | Added. W7 |
| V-28 | Prompt injection through repository files, issues or pages, including invisible Unicode | [S78] rules-file backdoor; [S80] wiper prompt in a shipped extension; [S88] Trojan Source | **C-12 over Sekhemet's own tree** (specs, `CLAUDE.md`, skills) *(new, W17 G3)* | Untrusted text confined and tagged; other agents' configuration inert (security 38a) *(exists)*; **C-12 refuses bidi and zero-width characters in prompt input and diffs** *(new, W17 G3)* | Added. W17 |
| V-29 | Destructive actions | [S24], [S25] | Git hardening, worktrees | Sandbox, permission engine, reversible Accept *(exists)* | Covered |
| **Data** | | | | | |
| V-30 | A schema change with no migration; a destructive migration | [S24]; practitioner reports *(unverified)* | Numbered migrations with a backup first; W8 upgrade tests | **C-14** *(new, W17 G4)*; half-done detection covers take-over only *(exists)* | Added. W17 |
| V-31 | No backup and no tested restore | [S24] | Backup before migration *(exists)*; parity checklist (W16) | **C-16:** production profile requires a documented, tested backup and restore *(new, W17 G1)* | Added. W17 |
| V-32 | Personal data: no erasure, no export, PII in logs | [S61] 175 PII exposures; [S62] | Erasure register, NDJSON export (runtime) *(exists)*; log redaction (C.9 item 8) | **C-16:** when the brief names personal data, erasure, export and "no personal field in logs" become criteria *(new, W17 G1)* | Added. W17 |
| **Resilience** | | | | | |
| V-33 | Missing error handling | [S11] | Fault injection (C.6); CLI error tests (W3) | Reliability row; the Reviewer *(exists)*; **C-16 error states per view** *(new)* | Added. W8; W17 |
| **Performance** | | | | | |
| V-34 | Slow code, no budgets | [S75] generated code about 3× slower than the best human solution *(search summary)* | W9's budgets | The performance row needs a criterion with a concrete value (criterion lint) *(exists)*; the evidence says "not measured" otherwise. Load testing is out of v1 | Out of v1 (part): O-13. W9 |
| **Observability** | | | | | |
| V-35 | No logs, metrics or crash reports | *(research gap)* | W8: log levels, `doctor --report` | **C-16:** production maintainability requires error logging without secrets and a health route *(new, W17 G1)*. Metrics and crash reporting are out of v1 | Out of v1 (part): O-13. W8; W17 |
| **Operations** | | | | | |
| V-36 | Configuration hard-coded; environments missing | [S65]; [S70] | Config validation (C.9 item 8); W3 install | **C-13 runs with `.env.example` values only** *(new, W17 G5)* | Added. W17 |
| V-37 | Deployment failures and no rollback | [S70] 72% of organisations had an incident from AI code | W7 image in CI; downgrade refused (W8); **release notes say how to return to the previous version from the backup** *(new, W15)* | Sekhemet does not deploy users' software. A tagged release per slice *(exists)*. Deployment is out of v1 | Out of v1 (part): O-13. W15 |
| V-38 | Breaking changes on upgrade | Agent refactors break compatibility more often *(unverified)*; [S32] | W8 upgrade tests; **C-18: the previous release's ledger and config load with no gap** *(new, W8)* | The regression gate; the `upgrade` card with named tests; SemVer per slice *(exists)* | Added. W8 |
| **Accessibility and language** | | | | | |
| V-39 | Inaccessible UI; meaningless names | [S15]–[S17] | axe, the manual pass, the meaningless-name lint (W6) | The visual gate's axe *(exists)*; **the W6 meaningless-name rule reused in the visual gate** *(new, W17 G5)* | Added. W6; W17 |
| V-40 | Internationalisation: hard-coded strings and locale formats | Practitioner write-ups *(unverified; research gap)* | Sekhemet is English only; the claims table says so | Not checked unless the brief asks | Out of v1: O-13 |
| **UX** | | | | | |
| V-41 | No empty, loading or error states; inconsistent UI | [S66] polish is the last 30% | W5 state inventory; W6 tests | **C-16:** each data view in a production brief gets empty, loading and error criteria *(new, W17 G1)* | Added. W17 |
| **Documentation** | | | | | |
| V-42 | Missing docs; a README whose steps do not run | [S63] documentation missing in 75% of test-passing PRs | W3; the CLI reference test | Project documents, release notes and changelog *(exists)*; **C-13 runs the README's commands** *(new, W17 G5)* | Added. W3; W17 |
| **Licensing and IP** | | | | | |
| V-43 | Reproduced code without its licence | [S18] | **C-17 over Sekhemet's own tree** *(new, W17 G2)* | The licence gate on dependencies *(exists)*; **C-17 licence-header scan** *(new, W17 G2)*. Similarity search against public code is out of v1 | Out of v1 (part): O-13. W17 |
| V-44 | Copyright status of AI-written code | [S82] purely AI-generated material is not protected *(search summary)* | O-12; LICENSE and NOTICE wording (W3) | Commit trailers record the model (`Agent-Model`) *(exists)*; **the user guide states what this means and gives no legal advice** *(new, W3 G1)* | Added. O-12; W3 |
| **Maintainability** | | | | | |
| V-45 | Code smells; conventions not followed | [S71], [S12] | Biome in `pnpm gate` | The project's own lint as a project gate *(exists)*. A smell gate is out of v1 | Out of v1 (part): O-13 |
| V-46 | Dependency and version drift | [S76] | Weekly OSV (W7) | The `upgrade` card *(exists)*; C-15 | Added. W7; W17 |
| **The agent** | | | | | |
| V-47 | Context limits and memory loss across sessions | [S14], [S81] | DEV_LOG, a fresh session per workstream, specs as the map (CLAUDE.md) | One allocator with capped sections, compaction, the dossier *(exists)* | Covered. R4, R5 measure it |
| V-48 | Runaway loops and cost | [S65] debugging loops; [S87] *(unverified)* | E.3 sizing; the owner's 5-hour share | Stall and oscillation stops, step budgets, the memory guard *(exists)* | Covered. R14 |
| V-49 | False "done" and premature stopping | [S21]–[S23]; [S65] premature halting | C.8's false-"done" row | Gates decide; a person accepts; pass^k *(exists)* | Covered. R10, R15, R16 |
| **The human** | | | | | |
| V-50 | Review becomes the bottleneck; reviewers tire | [S69] review time +91% *(search summary)* | D.7's short checkpoints; one review per workflow | The Review WIP limit; the Reviewer shown first *(exists)* | Covered. D.3 times the review task |
| V-51 | Skills atrophy; people stop understanding the code they own | [S67] comprehension 50% against 67%, debugging hit hardest; [S68]; [S66] | K4, K5 spot checks; SPINE and specs held true by C-9 | Tips and the Learn layer *(exists, partial)*. **D.3 adds a comprehension question after Accept** *(new, D.3)* | Added. D.3 |
| **Law and compliance** | | | | | |
| V-52 | Regulatory duties: vulnerability reporting, privacy law | [S83] | SECURITY.md (W3); **O-12 records Sekhemet's CRA position** *(new)* | The *regulated* profile claims no compliance (design-stage §2.8, SPINE lock) *(exists)* | Out of v1 (part): O-12 |

**New checks this section adds** (each is written test first):
- **C-10, the two-user authorisation fixture.** A production brief whose records belong to users. The depth profile must produce an object-level authorisation criterion. A Worker diff without an ownership check must fail a gate. The hidden test is: user B asks for user A's record and is refused. W17 builds it; R16 runs it with the real model.
- **C-11, web-configuration rules.** New bundled semgrep rules, each with a positive and a negative fixture:
  - CORS `*` with credentials;
  - session cookies without `HttpOnly`, `Secure` or `SameSite`;
  - a service-role or admin key in client code;
  - an open storage or database rule file (Firebase, Supabase);
  - request bodies assigned whole to a model (mass assignment).
- **C-12, invisible characters.** Bidi controls and zero-width characters in any file entering a prompt, or in a diff, are a finding with file and line. The same test runs over Sekhemet's own tree.
- **C-13, the clean-clone check.** At slice acceptance, a fresh confined worktree runs the README's install, build, test and start commands with `.env.example` values only. A server's documented health route must answer. A failure blocks the slice's release proposal.
- **C-14, data changes.**
  - A card that changes a schema with no migration fails.
  - A migration that drops a table or column, or deletes without a condition, needs a person's approval in Review.
  - Each migration runs up from the previous accepted schema with seeded rows.
- **C-15, dependency health.** The dependency gate flags a package its registry marks deprecated. At slice release, OSV runs over the whole lockfile, and the release notes list what it finds. C-3 runs in the same group.
- **C-16, the checklist expanded.** Each production must-have row becomes named criteria:
  - security: authentication on every non-public route, object-level authorisation, sign-in and reset rate limits, CSRF for cookie sessions, a CORS allowlist, secrets from the environment;
  - reliability: a documented and tested backup and restore;
  - interaction capability: empty, loading and error states per data view;
  - maintainability: error logging without secrets, and a health route for a server;
  - when the brief names personal data: erasure, export, and no personal field in logs.

  A test proves each profile yields its criteria and a prototype yields none.
- **C-17, the licence-header scan.** A copyright or licence header in a Worker's diff that differs from the project's licence is a finding. It also runs over Sekhemet's tree.
- **C-18, upgrade replay.** A ledger and a configuration written by the previous release load and replay under the new one, with no gap and no refusal (W8).

**Rows out of v1 need a decision.** O-12 and O-13 in §O. Until the DEC is recorded, the row counts as open in §G.16.

## D. UI/UX and usability audits

### D.1 Heuristic evaluation

W5 runs it; nobody on W5 fixes anything.
- **Who:** three independent AI evaluators (fresh agents), each driving Chromium through every page at 1440, 1100 and 400 px, in both themes.
- **What each produces:** findings against Nielsen's ten heuristics [S42], with a screenshot and a 0–4 severity [S43].
- **Severity** is the mean of the three ratings.
- **Why three:** one evaluator's ratings are not reliable enough [S43].
- **Why AI is only the first pass:** AI evaluators miss many issues and misread some [S51, S52]. So the owner confirms every finding rated 3 or 4 before it is fixed (checkpoint K3).

### D.2 Cognitive walkthroughs

At each step, ask NN/g's four questions [S45]: will they try it, notice it, connect it to the goal, and see progress?

| Audience | Persona (from the specs) | Tasks walked |
| --- | --- | --- |
| Developer | A senior engineer in a team repository | Find the blocked issue and why within three actions (DoD §6.4). Review and accept a pull request with a thread. Send back with an anchor |
| Junior | A first-job developer with Tips on | Reach the explanation of a WIP limit by keyboard. Learn why an issue is sliced thin. Read a check failure and know what to do |
| Non-developer | A stakeholder with no terminal, on a 400 px phone | Start a project by talking to Seshat. Ask "how is it going" and get plain words. Approve a plan. Take over a half-built repository (DS-TO-15) |

### D.3 Task-based usability sessions with people

**Who and how many:**
- **Participants:** outside people recruited by the owner (O-9); three per audience, because there are three groups [S46].
- **Rounds:** two, with fixes between them. That is 18 sessions of about 45 minutes each (*policy*).
- **Moderator:** the owner, or a moderator the owner names. The AI does not moderate.
- **Pilot:** a UXAgent-style simulated pilot [S50] runs each script first to catch broken tasks. It never counts as a session.

**What is recorded:**
- task success;
- time on task;
- errors;
- SUS [S47];
- one comprehension question after each Accept: "what does this change do, and how would you know if it broke?" Answered in the person's words and scored by the moderator (C.10 V-51; [S67]).

**Targets for round 2:**
- mean SUS ≥ 70 per audience ("acceptable", Bangor) [S47];
- 80.8 is the stretch goal (grade A);
- no severity-4 issue open.

### D.4 Accessibility

- **Automated:** axe on every page, at every width, in both themes (exists; extended to every page in W6).
- **Manual, W6, by an agent with the keyboard, then confirmed by a person:**
  - keyboard only through the four audience tasks;
  - focus visible and never hidden (2.4.11);
  - targets at least 24 × 24 px (2.5.8);
  - reduced motion;
  - 200% zoom at 1100 px.
- **Screen reader, by a person** (the owner or a beta tester): VoiceOver on macOS through the three audience tasks. An AI cannot judge the spoken experience.

axe covers about 57% of issues [S16], which is why the manual passes exist.

### D.5 Visual regression and the design-system audit

**Visual regression:** Playwright screenshots [S31] of every page, in both themes, at 1440 and 400 px.
- Baselines are generated per OS.
- They are updated only by a person's reviewed commit.
- They need `@playwright/test` (O-4).
- They run in the RC gate and nightly, never beside a loaded model.

**Design-system audit (W5):** each `dashboard-v3` mockup against its built page.

| Mockup | Built page |
| --- | --- |
| Main, SoloBoard | `board.js` |
| Login | `signin.js` |
| Projects | `projects.js` |
| Status, StatusPhone | `status.js` |
| Members | `members.js` |
| Inbox | `inbox.js` |
| Start, StartPlan | `create.js`, `pm_view.js` |
| Configuration | `configuration.js` |
| Issue | `issue_view.js` |
| Review, ReviewPhone | `review.js` |
| TipsBoard | `learn.js` |
| Logo | the brand mark |

The audit checks:
- every deviation in layout, tokens, type or copy;
- raw values used instead of tokens;
- components built twice.

The spec wins over a mockup (docs index). A deviation that follows the spec is recorded, not "fixed".

### D.6 Performance budgets, error messages and empty states, first run

- **Performance budgets:** W9 measures the §A budgets with `PerformanceObserver` in Chromium, on a seeded 500-issue board (*policy* size), and fixes what fails.
- **Error messages:** every error string in the web and the CLI is scored on NN/g's rubric [S44] (W5), then rewritten in the copy modules (W3, W6).
- **Empty states:** the W5 state inventory marks, for each view, whether its empty state tells a person what goes there and how to start.
- **First-run test:** on a clean macOS account and a clean Ubuntu VM, record every step from `npm install` to the first accepted issue (W10, R9). Then repeat it with a person from each audience in the D.3 sessions.

### D.7 The owner's checkpoints (short and few)

| # | When | What | Time (estimate) |
| --- | --- | --- | --- |
| K1 | Week 1, day 1 | The decisions in §O | 30 min |
| K2 | Week 1 | Confirm the pending labels: Seshat's 20 conversations (30–45 min, Entry 56), the golden briefs and held-out drafts (B2.4), and the capstone's hidden suite | 2–3 h in total |
| K3 | Week 2 | Confirm W5's severity 3–4 findings and the mockup deviations: one screen-shared walk at 1440 and 400 px | 45 min |
| K4 | Week 4 | Accept the Phase B report and the v1 scope; declare the feature freeze | 30 min |
| K5 | RC | Read the release notes and the claims table; run the VoiceOver pass or name who does | 1–2 h |
| K6 | Final | Tag `1.0.0` (RG-N4-1: 1.0 is a person's tag) | 10 min |

The usability sessions (D.3) are the owner's largest cost: 18 × 45 minutes, plus recruiting.

---

## E. The dual-stream schedule

### E.1 How the streams share one machine

| Slot | Model | Chromium | Tests | Builds |
| --- | --- | --- | --- | --- |
| **Night (Stream 1)** | One model, loaded after R0 and R1 | Never | Changed files only, `maxForks=1` | Never on the run's snapshot. Main may build, but not the snapshot's `dist/` |
| **Model day** | One model, for short rungs, admissions and qualification | Never | As at night | Workflows on main, one builder at a time |
| **Browser day** | None | UI audits, `a11y.spec.ts`, visual baselines, end-to-end tests | Full gate with at most 2 workers | Workflows on main |

**Rules for sharing:**
- Every model run uses a **frozen snapshot**: a `git worktree` at a commit with its own `dist/` and its own registry copy (F23). A commit on main never changes what a run measures.
- **Before any load**, check `ollama ps` and `memory_pressure -Q`, and apply DEC-42's bar. Unload after the run. A load lasts about 5 minutes from the USB drive (CLAUDE.md). Copy models to the internal SSD while there is space; placement keeps 20 GB free (B4.1).
- **Chromium and the 13–14 GB model never overlap.** The machine recovered from an OOM before (Entry 15).
- **The feedback loop:**
  1. Night run R finds defect F.
  2. The lead triages it in the morning (short).
  3. The day's workflow gets a fix group, test first.
  4. Gate, commit, a new snapshot.
  5. The next night re-runs **the smallest rung that showed F** before the long run.

  Every night's result is written to SUITE_RUNS or DEV_LOG before the next workflow launches.

### E.2 Stream 1: the run catalogue (local models)

| Id | Run | Model | Preflight beyond R0 | Duration (basis) | What it unblocks |
| --- | --- | --- | --- | --- | --- |
| R0 | Preflight | — | — | Minutes | Every load |
| R1 | Smoke | The run's model | — | About 5 min load, plus minutes | Every long run |
| R2 | Re-qualification per build and role, after F23 and F24: the Coding model (nail-mtp, Cyber-Tiel), the Planning model, and GLM-4.7-Flash for Review. Includes a check that qualifying on one snapshot leaves another's qualification intact | Each in turn | F23 and F24 committed (W0) | Not yet recorded; R2 records it | Every later run; B-6 |
| R3 | Reviewer admission: `measure reviewer` (22 seeded defects) on GLM-4.7-Flash, a family other than Qwen. If it fails, gpt-oss-20b at medium with a thinking cap measured first (F25) | Review | R2 passed for Review | Not recorded for GLM. gpt-oss ran 22 reviews per arm (Entry 57) | RG-P8-13; the Reviewer filled, or shipped unfilled and said so |
| R4 | The paused baseline: round 2's remaining arms on snapshot `5937e83` (thinking-all, strict, fixed-tools, evidence-gate), then `measure admit` and the RunProfile frozen | Cyber-Tiel | That snapshot's own registry | 3–4 h per arm (the ladder memory; SUITE_RUNS), so two nights | B2.5's baseline; the Phase C comparison; "the overnight baseline" milestone |
| R5 | Prompt A/B batch: the model-facing wording (DEC-31 titles, gitleaks names, the invariant parser, the `teamNote`), paired, two runs per arm | Coding | R4 done (it is the comparison) | About 8 machine-hours per paired A/B (MODERNIZATION_PLAN) | NEW-dashboard-7; release-gate rung 9's stamp |
| R6 | Seshat old against new, `measure seshat-compare` (20 conversations) | Planning | K2: the owner confirmed the conversations | Not recorded | PM-P6-13 |
| R7 | Reuse-query admission, `research --reuse-eval --planner` (network to GitHub, npm, PyPI and deps.dev, allowed 2026-09-28) | Planning | Network policy recorded | Not recorded | DS-S8-3's path turned on, or kept off |
| R8 | Planning measure (T7) | Planning | K2: golden briefs confirmed | Not recorded | DoD §6.3 |
| R9 | Linux containment in a Lima VM: the injection fixtures against the real Coding model, served from the host through Lima's port forward, plus the clean-Ubuntu install walk | Coding (on the host) | Lima and an Ubuntu image downloaded (O-2). VM size set so DEC-42's bar holds with the model loaded | Unknown; the first run records it | B-2, B-5; the B1 milestone on Linux |
| R10 | Capstone, Sekhemet arm: one dry run, then 2–3 runs | Planning, then Coding | The hidden suite frozen and hashed (W2, K2); the seed repository pinned | Unmeasured. The suite's recent pace (30 issues in about 3 h) suggests hours per run; the dry run records it | Sprint 4's comparison; the B4.11 milestone |
| R11 | One Web-Bench project, Sekhemet arm, 2 runs | Coding | Licence confirmed (Apache-2.0 against CC BY 4.0, CAPSTONE_SELECTION) | 20 tasks, unmeasured | The external comparison |
| R12 | A team of five on the capstone: a person as Admin and accepter, four scripted actors at the other levels through the API | Planning and Coding (Smart Swap) | R10 dry run clean | Unmeasured | The B4.11 milestone; DoD §6.6 |
| R13 | A non-developer starts a project live: a person at 400 px talks to Seshat | Planning | A browser day. Chromium with the Planning model only if DEC-42's bar holds with both | About 1 h of the person's time (*policy*) | The B4.4 milestone; DoD §6.4 |
| R14 | Soak and fault-injection night (C.6) | Coding | W8 committed | 8 h (*policy*) | §A reliability |
| R15 | RC measurement: the full frozen suite on the RC build with the frozen RunProfile, 2–3 trials for an exact interval, plus the planning measure | Coding, Planning | Everything above clean | 30 issues ≈ 3 h per trial (SUITE_RUNS) | DoD §5.5.2, §6.3 |
| R16 | **Vibe-gap fixtures with the real model** (C.10): the C-4 impossible issues, the C-10 two-user authorisation brief, and one slice through the C-13 clean-clone check. Two trials each, reported as pass^k; one trial is not a finding | Planning, then Coding | W17 committed; the C-4 fixtures built (W17 G4) | Unmeasured; the first run records it | §G.16; C-4 gets its first scheduled run |

**The Claude comparison arms (Sprint 4)** run Claude Code on the same brief in a fresh repository: Opus 5.5, Sonnet 5 and Haiku 4.5, 2–3 runs each. They need no local model, so they take model-free days. They are scored by the hidden suite in a browser slot. They spend the owner's Claude usage, the same pool as Stream 2 (O-7).

**Added 2026-09-29, R-tune (Stream 1):** ref against thinking-surgical on **nail-mtp**, the shipped Coding model (DEC-47), on the current build, 2+ rounds, paired. The B2.5 baseline measured Cyber-Tiel, where surgical led by 5 of 60 (not established), so its verdict does not carry over to another model. This run decides nail-mtp's shipped thinking policy (PROMPT_STANDARD 35.4). About 3 h a round, on nights after R2's re-qualification.

**Added 2026-09-29, the Reviewer (R3's results):**
- gpt-oss-20b at low reasoning: 18% recall.
- gpt-oss-20b at high reasoning: every review cut off by its thinking.
- GLM-4.7-Flash: 0% (it rubber-stamps: every criterion "met", even at the seeded line).

Two runs follow:
- **R3b:** a Reviewer prompt that makes the model prove each verdict (quote the line that satisfies the criterion, or report it unmet, starting from "find what is wrong"). It is written in the next fix round and admitted by the seeded-set A/B on both models (PROMPT_STANDARD 35.4).
- **R3c:** gpt-oss-20b at medium reasoning with a larger thinking cap, as a per-model setting (W18 G2).

Until one passes RG-P8-13, the Review role ships unfilled (DEC-47).

## The path to 1.0, revised after C1 (2026-10-01, DEC-56)

**Why this revision.** C1 audited the product against the quality bar and against what a professional team expects. It found 245 findings, 5 of them release-blocking, and 54 design gaps (`FINDINGS_C1.md`, `DESIGN_GAPS_C1.md`). Two research reports were also written: the zero-spend branding and go-to-market report, and the ecosystem report on working alongside other tools. Every pending decision is taken (DEC-51 to DEC-55, under the owner's delegation of 2026-10-01). This section replaces the consolidated C2–C7 table further down; the rest of the plan (§A quality bar, §C test strategy, §F release engineering, §G exit criteria) still holds, with the additions at the end of this section.

**Order of work: design first, then build, then prove, then release.**

| Step | What | Inputs | Leaves when | Tokens (est.) |
| --- | --- | --- | --- | --- |
| **D1** Design update (running) | DESIGN_GAPS (b): 25 drafted changes, 85 criteria, applied to their specs. The DEC-51 to DEC-55 decisions written into the specs: mockup deviations, the professional words, the (c) items, integration rules. The v1 limitations stated in the SPINE claims table | C1's registers; DEC-51 to DEC-55 | Every change has its id, EARS criteria and a "not built" row naming its C-workflow; review clean; gate green | ~2M |
| **C2a** The core surfaces | **The UI release blocker and the K3 majors:** BRD-01 (the board on a phone and at 1440 px), REV-01 and REV-02, ISS-01 to ISS-03, STA-01 to STA-03, ERR-01 and ERR-03, SHL-01 to SHL-04, SEC-01 (Viewers' 403 toasts). **DEC-51's mockup work:** the Issue properties rail, the Inbox in two panes, Members' Invites and Access, Configuration's cards, primary buttons in dark ink, the brand mark. **DESIGN_GAPS:** b19, b20, b21, b22, b24 and b25 (the Start page with a live draft). **DEC-57's switchers:** the project switcher and the workspace switcher in the sidebar (SHL-01). **NAM-03:** the dashboard server's 2,559-line closure split behind tests as its routes are touched (strangler). **The one-pass rename (DEC-52):** the rename table (55 rows, nine of them amended by DEC-52); card → issue, cycle → sprint, no ids or API paths in product text. The remaining BRD, ISS, REV, STA, SHL, ERR, A11Y and VIS findings | FINDINGS_C1 by area; the mockups | K3 items 1, 6–11 and 13–17 closed (item 12 is C2b's); the crawl finds no dead control; axe clean; every changed view has an entry-point test | ~5M |
| **C2b** The team process | **DESIGN_GAPS:** b6 (the sprint lifecycle: start, complete, carry-over), b4 (Stakeholder intake and triage), b14 (full-text search on FTS5), b13 (the retrospective), b15 (lessons for the practice a person performs), b12 (a member leaving; DEC-53 says no Accept fallback). Reopen and Revert in the dashboard. **DEC-53:** c4 (a browser notification when work waits), c6 (push to the remote after Accept), c8 (maintenance releases). K3 item 12 (PM-01, PM-02: Seshat's raw error, status without a model). **DEC-57:** a server hosting many projects; New project (a new folder with `git init`, or a taken-over repository); My issues, the Inbox and search across projects (PRC-06). The remaining PRC, TEAM and PM findings | PRC findings; planner-pm, teams and dashboard specs after D1 | The four audience tasks still pass; every new criterion has an entry-point test | ~5M |
| **C2c** CLI, trust and Linux | **CLI-01** (the CLI cannot accept an issue with AI review findings; severity 4). DEC-53 c11 (`--json`). The CLI findings. **DEC-55's v1 items:** other agents' config flagged in Review, Ollama `:cloud` refused, the Jira CSV fixed, the MCP gate-run tool described as a pre-check, Check Run annotations in batches of 50, editor snippets. **DEC-50:** Linux relays for the proxy route and named ports. **The fix-round leftovers:** reuse admission to PROMPT_STANDARD 35.4, srt TLS trust, Chromium under the keychain rules. **b17's view:** Network activity in the dashboard and `sekhemet egress` (NEW-dashboard-24, security). **NAM-02:** the CLI's 2,917-line `main` split into a command registry behind tests as commands are touched (T4, strangler). The remaining SEC and CLI findings | The ecosystem report's §5 v1 list; c2_extra_findings | B1's four Linux network tests pass in the VM | ~5M |
| **C2d** Entry-point tests | **TST-01** (severity 4): 404 of 537 built criteria have only unit tests. Test writers work in parallel by spec, on test files only, each criterion reached through HTTP, the CLI, the UI or the queue. A criterion that cannot pass is a finding for C2a to C2c, not a weaker test. Also: TST-02 (browser entry points and fault injection; DB-1 to DB-12 cited by tests), TST-03 (the unhappy-path matrix, every cell a test or a reasoned n/a), TST-04 (the reachability gate sees dynamic imports), SPEC-01 (one status per criterion across all State rows, every criterion cited by a row and a test) | The C1 entry-point report (`c1/entry-points.json`) | The entry-point report shows no unit-only built criterion (§G 14) | ~5M |
| **C3** Models | W11 and W18. **DESIGN_GAPS:** b1 (the Team server's engines, one per role), b5 (the first hour: the engine found, both floors stated), b23 (downloads that resume). **DEC-53 c7:** *Get the inference engine* (pinned, hash-verified, on a click). The CFG findings. The Reviewer's admission: R3b and R3c from Stream 1 | Stream 1's admission runs | Every role admitted, or shipped unfilled and saying so (§G 4) | ~4.5M |
| **C4** Reliability | W8 and W9. **DESIGN_GAPS:** b2 (backups outside the repository, daily by default: REL-01, severity 4), b3 (the machine stays awake while it works), b7 (a full disk is a named stop), b16 (the power-loss window, stated and tested), b10 (two projects on one machine), and DEC-57's workspace parts: NEW-kernel-12 (one ledger per workspace, no migration), NEW-runtime-18 (backups per workspace) and NEW-security-14 (the credential store per workspace). SPEC-02 (the ledger export writes projections and blobs, or runtime item 37 says it does not). The REL findings | REL findings; runtime and kernel specs after D1 | The fault-injection and soak tests pass; the §A budgets hold | ~5M |
| **C5** Install, docs and journeys | W3 and W10. **INS-01** (the Team image cannot run as written; severity 4). **DESIGN_GAPS:** b8 (upgrade and uninstall), b11 (doctor's checks, each with its next step), b9 (a Team install with no identity provider), b17 (what leaves the machine, listed and shown; its dashboard view is C2c's), b18 (a health route for the Team server). **DEC-53:** c5 (the update check and *What's new*) and c10 (start at login). **DEC-54 before the beta:** c2's pre-publication pass (gitleaks over the history, `.claude/launch.json` untracked, machine operations out of CLAUDE.md, the drive paths parameterised), and CONTRIBUTING, CODE_OF_CONDUCT, SUPPORT, issue and PR templates. **The marketing report's README redesign:** hero, a five-command quickstart, honest limits, the licence in plain words, *source-available* never *open source*. The user guide, troubleshooting and the INS findings | The marketing report §6; the C1 rename table for docs | A timed clean-machine walk to a first accepted issue on macOS and Ubuntu (§G 8) | ~5M |
| **C6** Vibe-gap checks | W17 and R3b's Reviewer prompt (unchanged) | C.10 | C-10 to C-18 pass; R16 recorded | ~4M |
| **C7** Release candidate | W12, W13 and W15. **DEC-54 c1:** the release-only workflow (npm provenance, SBOM, SHA256SUMS, image). The pre-publication pass re-checked on the release commit (§G 18). **The marketing report's claims audit:** every README and post sentence tied to a file | §F; §G | §G holds on one RC | ~3.5M |

**Routing rule.** A finding or change named in one workflow belongs to that workflow. "The remaining … findings" means the ones no workflow names. The specs' State rows and COVERAGE.md name the same workflow as this table.

**Stream 1 (local models, beside the builds; the owner's K2 checks gate the capstone):**
1. **Now:** the injection fixtures re-run on the current tree (B1's stale check), the Worker loaded with DEC-42's checks first.
2. **R-srt:** the containment suite under srt on macOS and in the VM, then a frozen-suite run. If it passes, srt becomes the default (DEC-39), which closes item 15's residual for B1.
3. R3b and R3c (Reviewer admission), Seshat's prompt A/B, and the planning measure (it needs the golden-brief labels).
4. The capstone runs and Web-Bench after K2 and C2a. Demo assets are recorded during the Sekhemet arm (marketing report §6.4).
5. R15 on each RC.

**K2 stays with the owner.** Confirming the hidden suite's expected values and Seshat's conversations is a person's check that the capstone's disclosure depends on ("confirmed by a person"), not a decision. The delegation does not cover it.

**The milestones, with what each still needs:**

| Milestone | Today | Turns PASS when |
| --- | --- | --- |
| B1 containment, macOS and Linux | **PASS** (61be5a5, 2026-10-05; DEV_LOG Entry 79; first passed f73255d, Entry 75) | Re-run on the RC; a change to the sandbox or the Worker's tools makes the injection run stale again |
| B2.5 baseline | NOT RUN (planning measure) | The planning measure is recorded (golden-brief labels) |
| B3 safe accept, crash and upgrade | PASS | Re-run on the RC |
| B4.4 starting a project by conversation | NOT RUN | A live-model run after C2a and C3 |
| B4.10 a team on one server | PASS | Re-run on the RC |
| B4.11 a team of five, conversation to release | NOT RUN | A live run after C2b, C3 and C5 |

**Time.** About 2M tokens for D1, then about 42M for the nine C-workflows, which is five to six 5-hour windows at the calibrated rate (1% ≈ 83k tokens), with Stream 1 at night. The policy steps then decide the dates:
- two weeks of dogfooding with no open P0 or P1 before 1.0 (§G 12);
- the public pre-release 0.9.0 after C5, whose pre-publication pass comes first. Anyone may install it; no outside beta users are recruited, because DEC-47's deferral stands and §G 12 is unchanged;
- Show HN only at 1.0.0 (DEC-54).

**After 1.0 (v1.x), in order:**
1. The external-agent hand-off with Sekhemet's checks deciding (DEC-55): Aider and Goose on a local endpoint behind Sekhemet's logging proxy, so every prompt is recorded. Seshat's read-only MCP tools, each pinned by its description (NEW-extensibility-8).
2. Slack replies to Seshat.
3. `sekhemet gates --ci` (JUnit and SARIF).
4. Linear, then Jira, pull-only sync, then the Linear agent app on a Team server.
5. Platform checks for vibe-coded prototypes (Supabase RLS, Firebase rules).
6. Sentry as a proposed Bug.

Then DEC-53's v1.x items: test services for gates (c9, after DEC-50), nested AGENTS.md after its A/B (c12) and signed commits (c13).

**Additions to §G (exit criteria):**
- **17:** every release blocker in DESIGN_GAPS (d) is closed, and no severity-4 finding is open.
- **18:** DEC-54's pre-publication pass is done on the release commit.
- **19:** the README and every launch post pass the claims audit, and none says *open source*.

---

**Added 2026-09-29, the sandbox engine (DEC-39's steps 2–4, which this plan had not scheduled):** the shipped confinement engine is meant to be Anthropic's `sandbox-runtime` (srt), which drives Seatbelt on macOS and bubblewrap with seccomp on Linux, and is the engine Claude Code uses. Today `native` (our own) is the default.
- **R-srt:**
  - the containment suite under `SEKHEMET_SANDBOX_ENGINE=srt` on macOS (a model-free run), then in the Lima VM (with R9);
  - then one frozen-suite run on srt, against the latest native run on the same build (no clear difference required).
- **If both pass:** a small workflow step makes srt the default and deletes `seatbelt.ts`, `bubblewrap.ts` and `seccomp.ts`, with security.md updated in the same commit (DEC-39 step 5). W1's shared secret-path table is kept as srt's deny configuration.
- **Shipping:**
  - macOS uses the built-in Seatbelt, with nothing to install;
  - Linux needs `bubblewrap` and `socat` from the distribution (`doctor` checks them);
  - the Team image carries them.
- **Not shipped:** Windows is not supported in v1, and the Lima VM is test infrastructure only.

**Consolidated 2026-09-30 (superseded for C2–C7 by the revision above, 2026-10-01; the lead, under DEC-47; the owner asked for a faster timeline within the 5-hour window):** the remaining workflows become seven. Workflows so far used 1.4–2.9M tokens, about 20–35% of a window, while wall-clock time (builders one at a time, the full suite run twice) was the bottleneck. Three changes:

1. **Read-only work runs in parallel.** Audits and reviews edit no code.
2. **Related workflows merge,** at about 4.5–5.5M tokens each, inside one window with margin.
3. **The sweep runs only the browser checks and the changed files' tests.** The full gate still runs once, on the exact tree, before every commit.

The quality floor is unchanged: tests first, the spec in the same commit, one independent review, the full gate.

| New | Combines | Shape | Tokens (est.) |
| --- | --- | --- | --- |
| C1 Audit sprint | W4, W16's audits, W5 | Parallel read-only agents, plus W4's documentation edits; one ranked findings register | ~4.5M |
| C2 Fix sprint | W16's fixes, W6, C1's findings, R9's Linux network relays (DEC-50) and the fix-round leftovers (reuse admission to PROMPT_STANDARD 35.4, srt TLS trust, Chromium under the keychain rules) | Builders, review, fix | ~5M |
| C3 Models | W11, W18 | Builders | ~4.5M |
| C4 Reliability | W8, W7 (CI deferred), W9 | Builders | ~5M |
| C5 Docs and journeys | W3, W10 | Builders; browser tests on model-free days | ~5M |
| C6 Vibe-gap checks | W17, R3b's Reviewer prompt | Builders | ~4M |
| C7 Release candidate | W12, W13 (parallel, read-only), W15 | Parallel review, then the cut | ~3.5M |

**The workflow template (from C1 on):**
- one setup step builds shared fixtures, such as a seeded demo workspace, once;
- read-only audits run in parallel;
- browser work runs as headless Playwright scripts, at most two at a time;
- builders run one at a time, on disjoint files;
- review is split per group and runs in parallel, with one fixer and a low-effort re-check of blockers only;
- the sweep runs only the browser checks and the changed files' tests;
- a final gate step builds the snapshot and runs the full gate the moment the fixer ends;
- digests to the lead are kept short.

Expected: about 5–7 days instead of 2–3 weeks. Stream 1 continues beside the builds: the planner set-up, the admissions, R9 (Lima) and the capstone runs, mostly at night. The owner's K2 checks (the hidden suite; Seshat's conversations) gate the capstone runs, so doing them early moves the capstone forward.

### E.3 Stream 2: the workflows (Claude Opus 5.5)

Every workflow follows the same pattern:
- groups run one at a time;
- tests first;
- one independent review by a fresh agent that reads the spec and the diff, never the builder's summary;
- a fixer;
- a re-check of blockers only;
- `pnpm gate` on the exact tree;
- the spec updated in the same commit.

**Sizing:** token figures come from past workflows (B4.6 1.94M, B4.7 2.34M, compliance 2.42M, B4.8 2.67M, B4.11 2.91M). The owner is asked for the remaining share of the 5-hour window before each launch.

| Id | Workflow | Groups | Tokens (estimate) | Inputs | Outputs | Needs |
| --- | --- | --- | --- | --- | --- | --- |
| W0 | **Close-out** (running) | F23/F24; qualification per build and role; watcher email; B4.11's partial rows; milestone evidence runners | (running) | Entry 57 | Commit; R2 unblocked | nodemailer download (O-3) |
| W1 | **Security hardening** | G1 dashboard: Host allowlist, a per-session mutation token in Solo, CSP, `frame-ancestors 'none'`, Referrer-Policy. G2 bwrap: the same deny list as Seatbelt, plus a test that reads `~/.ssh` in the sandbox and fails. G3 a Linux secret store (`secret-tool`), or the limitation stated in the product and docs. G4 top-level `unhandledRejection` handling | 2.5M | `security.md:220,229,230,246`; `runtime.md:216`; `dashboard.md:428`; SANDBOX_REUSE | B-1, B-2 (code), B-12 closed in code | — |
| W2 | **Capstone preparation** (Sprint 1) | G1 the brief and the scripted stakeholder conversation, with the California change at a fixed turn. G2 the seed repository and pinned toolchain. G3 **the hidden suite, written by a sealed agent** that never sees any contestant's work; stored outside the repository with only its SHA-256 committed. It includes a concurrent-edit case and overtime-pay rounding cases (C.10 V-9, V-11). G4 the Web-Bench project chosen and its licence checked. G5 the arms runner and scorer (hidden pass rate by Must/Should/Could, regressions after the change, time, tokens, mutation score, findings, a blind mergeability review) | 2.5M | CAPSTONE_SELECTION protocol | A frozen protocol; K2 input | Stryker for the mutation metric (O-4) |
| W3 | **Docs, install and CLI** | G1 a user guide (install, first run, models, Solo and Team, troubleshooting), with a *What Sekhemet does not do* page: it does not validate a market, deploy, translate, or make legal claims about AI-written code (C.10 V-4, V-40, V-44). G2 a CLI reference generated from the command table, with a test that every command appears. G3 per-command `--help`; one-line errors, `--debug` and a report path. G4 README refreshed; platforms stated; `install.sh` checks Node 22.13; a non-`dev` serve entrypoint in the Dockerfile. G5 CHANGELOG (Keep a Changelog), SECURITY.md, licence metadata, `"private": true` on the workspace packages | 2.5M | B-5, B-8, B-9, B-17, B-18 | Docs a stranger can follow | O-6, O-11 |
| W4 | **Spec truth and the v1 scope** | G1 every §4 row re-marked against the code. The mechanical row checks may use a cheaper model (CLAUDE.md), and each change is reviewed. G2 teams' front matter; the SPINE claims table; the C-9 test. G3 an owner or a deferral for each of the 7 not-built ids. G4 **the v1 scope proposal**: each partial row either built by a named workflow, or deferred to 1.x with a DEC | 1.5M | Audit §4 counts (422 built, 166 partial, 61 not built); B-7, B-20 | A true SPINE; the K4 input | — |
| W16 | **Completeness audit: hollow and missing features** (C.9) | G1 the dead-control crawl and the wiring audit. G2 the entry-point criterion report and the stub scan over Sekhemet. G3 the unhappy-path matrix, from the specs. G4 the professional-parity checklist and three exploratory charters. Then a fix round on what it finds | 2.5M, plus a fix round | W4's true §4 rows | Findings in the gap register; the permanent crawl and matrix tests | Browser day, after W4 and before W5 |
| W17 | **Vibe-gap checks for the software Sekhemet builds** (C.10) | G1 C-16, the checklist expanded into criteria, and the C-10 authorisation fixture. G2 C-11's web-configuration rules and C-17's licence-header scan. G3 C-12, invisible characters, in prompt input, diffs and Sekhemet's own tree. G4 C-14 data changes; C-15 dependency health with C-3; the C-4 impossible-issue fixtures. G5 C-13, the clean-clone check, and W6's meaningless-name rule reused in the visual gate | 3M (five groups across the kernel, planner, gates and context: above W1 and W3 at 2.5M, near B4.11's 2.91M) | C.10; `design-stage.md` §2.8; `gates.md` | Every C.10 row marked *new, W17* built and tested; R16 unblocked | After W4 and W6; before K4's feature freeze |
| W5 | **UI/UX audit** (read-only; browser day) | G1–G3 three heuristic evaluators. G4 cognitive walkthroughs for the three audiences. G5 the design-system audit against dashboard-v3. G6 the state inventory and the error-message rubric | 1.5–2M (screenshots are costly; calibrate on G1) | §D; the mockups | A findings register with severities; the K3 input | — |
| W6 | **UI fixes and accessibility** | Fixes from W5's confirmed findings; the token lint; visual baselines; reduced motion; the meaningless-name lint; axe on every page; the manual keyboard pass | 2.5M | W5 register after K3 | B-10 (UI part) closed | `@playwright/test` (O-4) |
| W7 | **CI and supply chain** | A CI workflow running the gate on macOS and Ubuntu, with the Linux sandbox tests unskipped; the image built in CI; OSV over our lockfile; a CycloneDX SBOM of the tarball; npm provenance from CI [S27]; pinned actions (Scorecard [S30]); a weekly scheduled OSV run on the release branch; Node deprecation warnings reported, each fixed or listed; a test that every dependency allowed to run a build script has a reason (C.10 V-13, V-25, V-27) | 2M | B-3, B-5, B-11 | Evidence of green CI on both OSes | O-1, O-2; each push is the owner's yes |
| W8 | **Reliability and upgrade** | The fault-injection suite (C.6); log levels; a local crash bundle (`sekhemet doctor --report`: redacted, written to disk, never sent); upgrade tests from a recorded database of each earlier schema; C-18 (the previous release's ledger and configuration load and replay with no gap); downgrade refused; contract tests (C.1) | 2.5M | B-13, B-16 | R14 unblocked | — |
| W9 | **Performance budgets** | The measurement harness; a seeded 500-issue board; CLI start time; fixes until the §A budgets hold | 2M | B-15 | Budgets in `dashboard.md` and `surface.md`, with tests | Browser day |
| W10 | **Audience and first-run end-to-end tests** (whatever W0 leaves) | The developer's three actions at 1440 and 1100 px; the junior's keyboard path; the non-developer at 400 px; take-over DS-TO-15; the clean-clone first issue (DoD §6.7) | 2.5M | DoD §6.4, §6.7 | B-10 (acceptance part) | Browser day |
| W11 | **Models for new users** | A default set per hardware tier, each with source, hash and licence in PROVENANCE; `models fetch` for every role; qualification required for every role, shown by `doctor`; a supported-hardware table. Per-model settings and tuning are W18's | 2M | B-4; `models.md:305,328,330` | A stranger can obtain and qualify models | O-5 |
| W18 | **Model settings and the benchmark, built out** (owner, 2026-09-29) | **G0, research and design, spec first:**<ul><li>what LM Studio, Ollama, Jan, Msty and Open WebUI expose;</li><li>which parameters matter for agentic coding, per role, with evidence;</li><li>tuning methods that are fast on one machine (a small screening set, successive halving, the paired statistics);</li><li>dashboard §2.16 and models.md updated;</li><li>a short owner design review (K-models, 20 min).</li></ul>**G1, three layers on Configuration › Models:**<ul><li>the simple setup card (one row per role, *Use recommended*);</li><li>per-role *Customize* with tabs: Basics (model, a context slider with live fit, and the Fast/Balanced/Careful preset), Sampling (temperature, top-p, top-k, min-p, repeat and presence penalty, seed), Reasoning (thinking policy and budget, the floor), Engine (KV type, flash attention, GPU layers, slots, MTP, load mode) and Harness (tool arm, working method, evidence gate, step budget);</li><li>every value graded (Measured, From the model card, Estimated, Default) with *Reset*.</li></ul>**G2, per-model settings in the combination** (the registry): any change marks the role *Needs verifying*, with *Verify now*; role-aware hints, never hard blocks; the Admin level in Team; export and import of a role's settings.<br>**G3, *Find best settings*** (`sekhemet tune` and the page): a per-role tuning run over sampling, context and the harness switches on a small hard subset; adoption only under PROMPT_STANDARD 35.4's rule; *Apply*; the overnight tier settles close calls; the standup says *best combination* or *no clear difference*.<br>**G4, the benchmark build-out:** a settings dimension in the combination builder; a comparison view with history and charts; the capstone and Web-Bench results shown with their protocol | 3–3.5M, plus a fix round | dashboard §2.16; models.md rules 27a, 30a; W11; R-tune's result | A customizable, self-tuning Models page for beginners and professionals | After W11; browser days for G1 and G4 |
| W12 | **The Phase B report and the Phase C proposal** (Sprint 5) | The baseline against the current build; the capstone comparison; the admissions; what is deferred | 1.5M | R4–R12, the Claude arms | A report the owner accepts (K4) | R10, R11 and the Claude arms done |
| W13 | **Independent release security review** | A fresh agent, read-only, on the RC commit, with the research's security list as its lens | 1M | RC commit | DoD §6.2 evidence | Per RC |
| W14 | **Beta fix rounds** | One per beta round: triage, fix, test first | 2–2.5M each | Beta reports | — | Per round |
| W15 | **Cut the release** | Version bump, changelog, SBOM, provenance, image, release notes (including how to return to the previous version from the backup, C.10 V-37), claims check | 1M | §F | A tagged release | K5, K6 |

**W2 status (2026-09-29):**
- **G1, built:** the frozen input in `fixtures/capstone/timesheet/`:
  - `brief.md`, the stakeholder's brief (a fictional bakery owner), silent on the edge cases a PM should ask about. But every arm gets the FAQ up front (the owner's identical-input rule), so the capstone does not measure whether a PM asks the right questions;
  - `stakeholder_script.json`, her answers by topic, with a default answer and the change request's fixed point (release 1 finished, or its budget spent: 360 minutes, then 180 for the change, `runner.mjs` `AGENTIC`, proposed for the owner to confirm);
  - the technical notes (`contract.md`, `contract_change.md`) and the change letter;
  - `prompt.md` and `change_request.md`, rendered from those by `scripts/capstone/render_prompt.mjs`, with their SHA-256 in `manifest.json` (`--check` refuses any drift; `apps/harness/tests/capstone_prompt.spec.ts`).
- **G2, built:** the seed repository `fixtures/capstone/timesheet/seed/`: Node.js 26.0.0, TypeScript 5.9.3 and `@types/node` 26.0.1 pinned with a lockfile; Node's built-in test runner; no application code.
  - `scripts/capstone/seed.mjs` materialises one run's repository at the same commit every time (`a11835e7…`, frozen with every file's SHA-256 in `seed.json`).
  - It refuses the wrong Node.js, a destination inside the repository or the hidden suite's directory, and any drift (`--check`).
  - `--render` gives the seed as text for a one-shot cell.
  - Tests: `apps/harness/tests/capstone_seed.spec.ts`.
- **G4, built:** the second run is Web-Bench's `projects/fastify` (TypeScript, 20 dependent tasks, a Playwright spec per task), pinned at commit `7b31ca2b…`.
  - **Its licence:** Apache-2.0, from its `LICENSE.md`, for the code and tests. CC BY 4.0 is the paper's licence and applies only to quoting its baseline (Fastify, pass@2 best of five: Claude-3.7-Sonnet 40%).
  - **Where it lives:** fetched to `~/.sekhemet/webbench-src`, outside the repository. `fixtures/capstone/webbench/` holds `choice.md` and a SHA-256-only `manifest.json`.
  - **The script:** `scripts/capstone/webbench.mjs` checks the checkout (`--check`) and hands out task n's text byte for byte (`--task`). Tests: `apps/harness/tests/capstone_webbench.spec.ts`.
  - **Not installed:** `@playwright/test` 1.57.0 and its Chromium build, and the project's packages. R11 needs them.
- **G3, built; its person check (K2) is pending:** the hidden suite, sealed outside the repository. Its record is `fixtures/capstone/hidden.manifest.json`: hashes and counts only, and never inside the contestant-visible `timesheet/`.
  - **What it holds:** 112 tests (75 Must, 32 Should, 5 Could; 84 for release 1, 28 for the change). They include the concurrent-edit, rounding, midnight and daylight-saving cases (C.10 V-9 to V-11).
  - **Not run:** 5 browser checks are written down but not run, so WCAG and the 400-pixel layout have no executed hidden check.
  - **The proof:** re-run on 2026-09-29. The seed scores 0/84 and 0/111; the reference scores 84/84 and 111/111; the release-1 reference passes 0 of the 28 change tests.
  - **Disclosed:** the suite and the reference that "proves" it were written by one agent, `claude-opus-5-5`, of the same family as three contestant columns, so execution is circular.
    - It waits for K2 and is not registered in `fixtures/eval_assets.json`.
    - The scorer publishes nothing until a person's labels are registered.
    - Two cases that go slightly beyond the frozen text, and the missing partly-correct variants, are listed for K2 (CAPSTONE_SELECTION "The hidden suite, as built").
- **G5, built:** the arms runner, the scorer and the showcase screenshots, in `scripts/capstone/` (CAPSTONE_SELECTION "The runner, the scorer and the screenshots, as built").
  - **The runner** (`runner.mjs`): a fresh seed repository per run under `~/capstone-runs/`, never inside `~/.sekhemet`. Every frozen text is hash-checked just before it is given.
    - **One shot:** one request per phase, no tools, no retries, through the product's adapter or `claude -p --tools ""`.
      - The second request carries the first request and its reply, then the change request.
      - Every cell shares one window (131,072 tokens, and the local server's `n_ctx` is checked and recorded), reasoning off and one time limit.
    - **Claude Code:** driven by the runner through `claude -p`, with the operator's configuration pinned out (`--safe-mode`, `--strict-mcp-config`, project settings only, one effort and one permission mode, no web tools). A question it ends on is answered from the FAQ, and the change is given at the budgeted point.
    - **Sekhemet:** `sekhemet prepare`, then `sekhemet drive`. The person-simulator `person.mjs` answers only from the FAQ. She accepts on the checks, and on the AI review too where a reviewer is configured.
    - **Isolation:** every agentic run is refused unless the OS makes the hidden suite, its scratch directory, Web-Bench's checkout and every other run unreadable to the run's user.
  - **The scorer** (`score.mjs`):
    - **What it reports:** the sealed suite (checked against its manifest before and after) at `release-1` and after the change, regressions, time and tokens from the log, and type, lint, security and accessibility findings. Hygiene counts debug output only, and Sekhemet's checks are always its npm template. Mutation is NOT RUN without Stryker.
    - **Statistics:** only valid runs are pooled. Two arms are compared over the same k. The statistics give pass^k and pass@k with exact intervals, and paired McNemar comparisons for rows and columns, reading "no clear difference" when they are unresolved.
    - **The blind packet:** no arm identity.
    - **Proof:** the seed scores 0/84 and 0/111; the reference solution scores 84/84 and 111/111.
  - **The screenshots** (`screenshots.mjs`): six fixed views at 1440 and 400 pixels, through the visual gate's Chromium, into `docs/showcase/capstone/`, with a comparison README. The Chromium run itself is not yet run.
  - Tests: `capstone_runner`, `capstone_score` and `capstone_screenshots` specs. The sealed runs (the scorer and screenshots against the reference) run only with `SEKHEMET_CAPSTONE_SEALED_TESTS=1`, never in every gate, and copy nothing sealed into the shared temp directory.
  - **Open:**
    - **The Sekhemet arm cannot take `prompt.md` whole:** Seshat's message route keeps 8,000 characters. Beyond the first step, its driver is not built.
    - **No agentic run can start on this machine** until the hidden suite, its scratch directory and Web-Bench's checkout are migrated into the vault. The vault is built (W2b G4: `scripts/capstone/vault.mjs`, an AES-256 APFS disk image whose passphrase is only in the keychain and asks the person; the scorer mounts it and unmounts it in a `finally` block; `capstone_vault.spec.ts`). The migration is the lead's step (`vault.mjs create`, then `migrate`; `restore` is the rollback). The isolation check refuses every run until then, and whenever the vault is mounted.
    - **The owner confirms** the agentic budget (360 and 180 minutes, 20 FAQ answers per phase) and Claude Code's `--effort high`. A cheap dry run confirms the pinned `claude -p` command unattended.
    - **Stryker** before the first run, or the report says the mutation metric `prompt.md` promises was not delivered.
    - **The Web-Bench runner and scorer are built** (W2b G3: `webbench.mjs prepare`, `run` and `stats`; `fixtures/capstone/webbench/choice.md`, *The run, as built*). The project's packages are still to install (one approved download), and the per-attempt budgets are proposed.
    - **The B4.11 milestone** (teams.md §6, five people) needs R12's scripted-actors driver. This arm is Solo, with one simulated person.
    - **The blind packet** still keeps harness fingerprints: changelogs, card ids and the PM's documents.

### E.4 The first two weeks, day by day

Week 1 runs Monday 28 September to Sunday 4 October; week 2 runs Monday 5 to Sunday 11 October. **A day** is one Stream 2 workflow in the owner's waking window. **A night** is Stream 1, unattended.

| Date | Stream 2 (day) | Stream 1 (day) | Stream 1 (night) |
| --- | --- | --- | --- |
| Mon 28 Sep | W0 close-out (running); K1 decisions | — (W0 uses the machine) | **R4, part 1**: R0 on snapshot `5937e83`, then thinking-all r2 and strict r2 (≈ 7 h). It needs no W0 output |
| Tue 29 | **W1** security hardening | R0, R1 on W0's snapshot; **R2** re-qualification (all roles) | **R4, part 2**: fixed-tools r2 and evidence-gate r2; `measure admit`; RunProfile frozen |
| Wed 30 | **W2** capstone preparation | **R3** Reviewer admission, GLM-4.7-Flash | **R5, part 1**: prompt A/B, arm A ×2 |
| Thu 1 Oct | **W4** spec truth and scope | K2 labels confirmed by the owner; **R9** Lima containment (W1's bwrap masks are in) | **R5, part 2**: arm B ×2; stamp the context version (rung 9) |
| Fri 2 | **W16** completeness audit, hollow and missing features (browser day) | — (Chromium) | **R6** Seshat A/B, then **R7** reuse-query admission |
| Sat 3 | **W5** UI/UX audit (browser day) | — (Chromium) | **R8** planning measure (if the golden briefs are confirmed); otherwise a Smart Swap calibration night |
| Sun 4 | Fix round from the week's model runs (a small helper, or W-fix) | — | **R10 dry run**: capstone, Sekhemet arm (hidden suite frozen by W2 and K2) |
| Mon 5 | **W3** docs, install, CLI | Claude arms: a Haiku 4.5 dry run of the capstone (model-free day) | **R10 run 1** |
| Tue 6 | **W6** UI fixes and accessibility (K3 before it) | — (Chromium) | **R11** Web-Bench run 1 |
| Wed 7 | **W8** reliability and upgrade; W7's supply-chain part (SBOM, OSV, lockfile; CI deferred, DEC-47) | Claude arms: Sonnet 5 run 1, Opus 5.5 run 1 | **R10 run 2** |
| Thu 8 | **W9** performance (browser day) | — (Chromium) | **R14** soak and fault injection (W8 in) |
| Fri 9 | **W11** models for new users | **R13** non-developer live start (a person, 400 px) | **R11** Web-Bench run 2 |
| Sat 10 | **W10** audience end-to-end tests (browser day) | — | **R12** team of five on the capstone |
| Sun 11 | Fix round | Claude arms: run 2 of each | **R10 run 3**, if the interval needs it |

**Order (fixed 2026-09-28):** W4 makes the §4 rows true before W16 audits against them, and W16's and W5's findings feed one fix round (Sun 4) before W6. W17 (vibe-gap checks) follows in week 3, before the feature freeze.

**If a night fails preflight:** the slot takes the next ready run in the catalogue. It never takes a longer run whose short rung has not passed.

### E.5 After the first two weeks

| Week | Stream 2 | Stream 1 | Gate to leave |
| --- | --- | --- | --- |
| 3 (12–18 Oct) | **W17** vibe-gap checks (first, before the freeze); W12 report; fixes from R10–R14; the Claude arms' run 3 | **R16** once W17 is committed; the capstone's third runs; the Web-Bench Claude arms; re-runs of anything fixed | W12 accepted at K4; **feature freeze** |
| 4 (19–25 Oct) | W13 security review on **1.0.0-rc.1**; fixes; D.3 usability round 1 (9 people) | **R15** on rc.1 | No open critical or high issue; §G items 1–6 hold |
| 5–6 (26 Oct–8 Nov) | **Public beta** `0.9.0` to outside users (§F); W14 per round; D.3 round 2 | Nightly R14, R15 on each new RC | §G holds on one RC for two consecutive weeks (*policy*) |
| 7 | W15: cut **1.0.0** | R15 on the release commit | K6: the owner tags |

These dates hold only if the local model's results do not force re-scoping (§H) and the owner's checkpoints land on time.

---

## F. Release engineering

- **Version line:** before 1.0, a breaking change bumps the minor (RG-N4-1), and SemVer lets 0.y.z change freely [S32].
  - Public beta: `0.9.0`, then `0.9.x` fixes.
  - Candidates: `1.0.0-rc.N`, which sort before `1.0.0` [S32].
  - `1.0.0` is tagged by a person.
- **Feature freeze** at K4 (week 3). After it, only fixes, tests, docs and spec truth land. A model-facing change still needs its A/B. A beta takes fixes only, as in PEP 602 [S26].
- **A release candidate is cut** when:
  - `pnpm release-gate` passes on macOS and Linux CI;
  - R15 is recorded, with every failure named;
  - W13 finds no critical or high issue;
  - the claims table test passes;
  - the tree is clean.

  The candidate is built from the snapshot the gate passed (DEC-10).
- **Betas with outside users:**
  - Three people per audience (O-9), each with the published install path, the user guide and one feedback route.
  - Each beta round ends with W14.
  - A beta is Solo-only unless O-10 says the Team setup is in.
- **Changelog:** `CHANGELOG.md` in Keep a Changelog form, with an *Unreleased* section kept by every workflow [S33]. The existing slice-changelog code generates the users' projects' changelogs, not ours.
- **Install paths:**
  - **npm:** the bundled tarball from `pack_npm.mjs`, published from CI with provenance [S27]. The package name and registry are O-6.
  - **The server image:** built and started on Ubuntu in CI; published to a registry named in O-6. It starts a non-`dev` command (W3).
  - **From source**, for contributors.
- **Signed artifacts and SBOM:**
  - npm provenance through Sigstore [S27] gives SLSA build L2 when built on a hosted runner [S28].
  - A CycloneDX SBOM for the tarball and the image, attached to each release [S29].
  - Image signing with cosign is optional, if O-4 allows the download.
- **Migrations:** already numbered and backed up. Each release adds an upgrade test from the previous release's database (W8). A migration that would break rollback follows expand, migrate, contract [S58 *(unverified)*].
- **Telemetry and crash reports:** none leave the machine in v1. `doctor --report` writes a redacted bundle that a person can choose to attach to an issue. That is the Go model [S31a] without the upload. An upload stays a Phase C proposal behind an explicit opt-in.
- **Support:**
  - SECURITY.md with a private reporting route;
  - an issue tracker (O-6);
  - a troubleshooting page generated from `doctor`'s checks;
  - the owner names the response time he can keep (O-9).
- **DoD §6 on one release commit:** W15 checks §6.1–6.8 with the evidence in §G, as one table in the release notes. A row that is not met blocks the release, or is deferred by a recorded owner decision (O-10) and said in the claims table.

---

## G. Exit criteria for "published"

All of these hold on one release commit. Each is tied to its evidence.

| # | Criterion | Evidence |
| --- | --- | --- |
| 1 | The release gate is green on macOS and in the Lima Ubuntu VM (CI deferred, DEC-47; Ubuntu CI replaces the VM once it exists). Every test skipped on one machine runs on another in the matrix, with its tools installed (O-8) | The CI run's URL and the release-gate output, committed with the release |
| 2 | No open critical or high security issue. The dashboard hardening tests pass. The injection fixtures pass on macOS and in Linux (Lima and CI) | W13's review; SUITE_RUNS' containment rows |
| 3 | The frozen suite on the release build: a pass rate with an exact 95% interval, every failure named, none a known unfixed harness defect. The planning measure recorded. The comparison with the B2.5 baseline is paired | SUITE_RUNS (R15), and R4's frozen RunProfile |
| 4 | Every role either has an admitted model or is shipped unfilled and says so on screen and in the docs | R3, R6 and R7 records; the models spec |
| 5 | The four audience tasks pass as end-to-end tests. The owner's dogfooding sessions and the agent cognitive walkthroughs are done (outside rounds deferred, DEC-47). Mean SUS ≥ 70 in the owner's sessions. No severity-4 issue open | W10 tests; the D.3 session records |
| 6 | WCAG 2.2 AA: axe clean everywhere; the manual keyboard pass; a person's VoiceOver pass on the three tasks | `a11y.spec.ts`; the D.4 records |
| 7 | The §A performance budgets hold | W9 tests in the RC gate |
| 8 | Clean-machine install and first accepted issue, on macOS and on Ubuntu, with no file edited by hand | R9 and W10 walk logs |
| 9 | The claims table, the README and the spec front matter agree with the code | C-9; `docs.spec.ts` |
| 10 | A user guide, a CLI reference with a coverage test, troubleshooting, SECURITY.md, a CHANGELOG, LICENSE and NOTICE consistent, and model licences recorded | W3, W11; `registers.spec.ts` |
| 11 | SBOM attached; OSV finds no known high or critical issue in shipped dependencies, or each is waived with a reason; provenance verifies | W7 artefacts |
| 12 | Beta: deferred by the owner (DEC-47). Until outside betas, the owner's dogfooding sessions show no open P0 or P1 for two consecutive weeks (*policy*) | The issue tracker; the dogfooding log |
| 13 | The capstone and Web-Bench results are published with their protocol and 2–3 runs per arm, whatever they show | W12's report |
| 14 | No dead control on any page. Every built criterion has an entry-point test. The unhappy-path matrix has no empty cell. The parity checklist has no *missing* item without a DEC | W16's crawl and matrix tests; the entry-point report; the checklist |
| 15 | DoD §6.1–6.8 each met, or deferred by a recorded owner decision and stated | The release notes' §6 table |
| 16 | Every C.10 row has its scheduled check passing in both columns, or its out-of-v1 part recorded by a DEC (O-12, O-13) and said in the claims table and the user guide. C-10 to C-18 pass. R16 is recorded with two trials per fixture | The C.10 table with each check's test or run id; R16 in SUITE_RUNS |

---

## H. Risks and mitigations

| Risk | Early sign | Mitigation |
| --- | --- | --- |
| **The local model's ceiling.** The Coding model runs under an override (multi_step 40% at q1.2). Suite passes sit near two-thirds (SUITE_RUNS). Local models hallucinate packages four times as often as commercial ones [S5] | The capstone's Sekhemet arm stalls on the stacked-overtime rules | Publish the numbers as measured (§G.13). The claims table never says more. Split issues rather than retry. The Review role may ship unfilled (existing risk) |
| **The one machine.** Model runs, Chromium, gates and builds compete for 24 GB | Swap over 4 GB; a night lost to a failed preflight | §E.1's slots. Snapshots with their own registry. Linux and the image moved to CI. Short rungs first |
| **The owner's time.** Labels, K1–K6, 18 sessions, recruiting, CI pushes | A checkpoint slips a week | Checkpoints batched and short (D.7). Runs that need no labels go first (R2–R5). The beta can start Solo-only |
| **AI overconfidence: builders grading themselves** (the research's strongest finding [S21–S23]) | A DEV_LOG claim with no gate output; "Linux via CI" with no CI | 1. One independent review per workflow by a fresh agent, reading the spec and the diff, not the builder's summary. 2. Claims need the exact tree's gate output. 3. The hidden capstone suite is written by a sealed agent and confirmed by a person. 4. AI UX findings are confirmed by a person (K3). 5. Outside beta users are the final independent check. 6. The owner's spot checks at K4 and K5 |
| **The Claude comparison competes with Stream 2** for the same usage | A workflow cannot launch in its window | The owner sets the comparison's budget (O-7). The arms run on days without a workflow |
| **Contamination.** Web-Bench has been public since May 2025 | Claude arms score far above the task's history | It is the secondary result only (CAPSTONE_SELECTION). The private capstone carries the finding |
| **Linux confinement fails in the VM** | An injection fixture escapes in R9 | Stop, and ship macOS-only (O-2). DEC-04's reopen condition applies |
| **Apple deprecates `sandbox-exec`** | A macOS release notes it | Fail closed (built); a VM per issue is researched (security §8) |
| **Downloads refused** (Stryker, fast-check, `@playwright/test`, Lima, nodemailer) | O-2, O-3 or O-4 answered no | Each has a fallback: the harness's own mutation pre-check; hand-written generators; `playwright-core` with a pixel diff written by us; Linux proven in CI only; no watcher email in v1 |
| **Scope does not converge** (166 partial rows) | W4 finds more work than the calendar holds | W4's proposal defers rows to 1.x with DECs. v1 is a smaller true product, not a larger claimed one |

---

## O. Decisions the owner needs to take (K1)

**Decided 2026-09-28** ([DEC-47](../design/DECISIONS.md#dec-47--the-finish-line-decisions), the lead under the owner's delegation; the licence is [DEC-48](../design/DECISIONS.md#dec-48--the-licence-is-fsl-11-alv2), superseding DEC-46). Every item below is settled there except item 14, which needs the owner's own judgement. Beta users (O-9) and CI (O-1) are deferred by the owner.

1. **O-1, CI host.** Push to a GitHub repository (public or private) so CI runs on macOS and Ubuntu? Each push is the owner's yes (DEC-42).
2. **O-2, Linux.**
   - Download Lima (Apache-2.0, a CNCF project [S59]) and an Ubuntu cloud image for R9?
   - If Linux is not proven by week 4, ship v1 macOS-only?
3. **O-3, nodemailer** (MIT-0, approved in DEC-44). Download it now for watcher email?
4. **O-4, test tooling downloads.** Each is a yes or no:
   - Stryker (mutation; also the capstone's metric);
   - fast-check;
   - `@playwright/test` (screenshots);
   - a CycloneDX SBOM tool;
   - cosign (optional);
   - a clone detector for users' code (Phase C).
5. **O-5, models for new users.**
   - Which default models per hardware tier the product recommends and links, with their licences.
   - Whether 16 GB is supported at v1, since SPINE says 16–128 GB.
6. **O-6, publication identity.**
   - The copyright holder (LICENSE and NOTICE disagree).
   - The npm package name and scope.
   - The container registry.
   - The public issue tracker.
7. **O-7, the comparison's budget.** The Claude arms run 3 models × 2–3 runs on two projects, from the same usage as the build workflows.
8. **O-8, DoD rung 4.** "0 skipped" read as "every test runs on at least one machine of the release matrix, with its tools installed there". Today, 37 tests skip on this Mac, mostly for a missing tool, and about 40 run on darwin only.
9. **O-9, betas and sessions.**
   - Recruit 9 outside people (3 per audience) for two rounds.
   - Name the moderator.
   - Name the support response time.
10. **O-10, the v1 scope.**
    - Whether the Team setup is in the first public release, or follows in 1.1.
    - Whether rows W4 proposes to defer may be deferred.
11. **O-11, root documents.** Allow `CHANGELOG.md`, `SECURITY.md` and `CONTRIBUTING.md` at the repository root (a change to the docs rule and `docs.spec.ts`).
12. **O-12, legal posture** (C.10 V-44, V-52). Needs the owner, and advice he chooses; the plan gives none.
    - Is Sekhemet distributed commercially in the EU? The CRA's reporting duties apply from 11 September 2026 [S83].
    - How LICENSE and NOTICE describe code written by models, given [S82].
13. **O-13, what v1 does not check in the software it builds** (C.10). One DEC listing each item, said in the claims table and the user guide:
    - internationalisation (Sekhemet itself is English only);
    - a complexity or code-smell gate;
    - API-level deprecation beyond the project's own lint;
    - load testing;
    - metrics and crash reporting;
    - deployment and rollback of users' services;
    - similarity search for reproduced code;
    - a dead-control crawl of users' web apps.

    Each is a Phase C proposal in W12, or stays out.
14. **Pending confirmations (K2):**
    - Seshat's 20 scripted conversations;
    - the golden briefs and held-out drafts;
    - W2's hidden capstone suite.

---

## S. Sources

Checked this session unless marked *(unverified)*.

- [S1] Veracode, 2025 GenAI Code Security Report — https://www.veracode.com/blog/genai-code-security-report/ ; summary https://www.helpnetsecurity.com/2025/08/07/create-ai-code-security-risks/
- [S2] Pearce et al., *Asleep at the Keyboard?* — https://arxiv.org/abs/2108.09293
- [S3] Apiiro findings, via The Register, 2025-09-05 — https://www.theregister.com/2025/09/05/ai_code_assistants_security_problems/
- [S4] Perry et al., *Do Users Write More Insecure Code with AI Assistants?* — https://arxiv.org/abs/2211.03622
- [S5] Spracklen et al., package hallucinations (USENIX Security 2025) — https://arxiv.org/abs/2406.10279
- [S6] Socket, *Slopsquatting* — https://socket.dev/blog/slopsquatting-how-ai-hallucinations-are-fueling-a-new-class-of-supply-chain-attacks
- [S7] METR, recent reward hacking — https://metr.org/blog/2025-06-05-recent-reward-hacking/
- [S8] ImpossibleBench — https://arxiv.org/pdf/2510.20270
- [S9] SWE-Bench+ — https://openreview.net/forum?id=R40rS2afQ3 *(figures partly unverified)*
- [S10] Anthropic, Claude 4 system card (test special-casing) — https://www.anthropic.com/claude-4-system-card
- [S11] CodeRabbit, State of AI vs human code generation — https://www.coderabbit.ai/newsroom/state-of-ai-vs-human-code-generation-report
- [S12] GitClear, AI code quality 2025 — https://www.gitclear.com/ai_assistant_code_quality_2025_research
- [S13] MAST, multi-agent failure taxonomy — https://arxiv.org/pdf/2503.13657
- [S14] Chroma, *Context Rot* — https://www.trychroma.com/research/context-rot
- [S15] A11yN (accessibility of generated UIs) — https://arxiv.org/html/2510.13914v1
- [S16] Deque, automated testing covers 57% of issues — https://www.deque.com/blog/automated-testing-study-identifies-57-percent-of-digital-accessibility-issues/
- [S17] Semantic accessibility violations (CHI 2026) — https://dl.acm.org/doi/10.1145/3772363.3799364
- [S18] LiCoEval, licence compliance of generated code — https://arxiv.org/abs/2408.02487
- [S19] DORA 2024, via RedMonk — https://redmonk.com/rstephens/2024/11/26/dora2024/
- [S20] DORA 2025 — https://dora.dev/dora-report-2025/
- [S21] METR, the early-2025 developer RCT — https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/
- [S22] False success in agent benchmarks — https://arxiv.org/html/2606.09863
- [S23] 20,574 real agent sessions — https://arxiv.org/abs/2605.29442
- [S24] Replit database deletion — https://incidentdatabase.ai/cite/1152/
- [S25] Gemini CLI file loss — https://incidentdatabase.ai/cite/1178/
- [S26] PEP 602, Python's release cycle — https://peps.python.org/pep-0602/
- [S27] npm provenance — https://docs.npmjs.com/generating-provenance-statements/ ; https://blog.sigstore.dev/npm-provenance-ga/
- [S28] SLSA v1.0 build levels — https://slsa.dev/spec/v1.0/levels
- [S29] `npm sbom` (CycloneDX, SPDX) — https://docs.npmjs.com/cli/v9/commands/npm-sbom/
- [S30] OpenSSF Scorecard — https://github.com/ossf/scorecard
- [S31] Playwright visual comparisons — https://playwright.dev/docs/test-snapshots
- [S31a] Go telemetry (local-first, opt-in upload) — https://go.dev/doc/telemetry
- [S32] Semantic Versioning 2.0.0 — https://semver.org/
- [S33] Keep a Changelog 1.1.0 — https://keepachangelog.com/en/1.1.0/
- [S34] ISTQB, risk likelihood — https://glossary.istqb.org/en/term/risk-likelihood
- [S35] Meta, Predictive Test Selection — https://arxiv.org/abs/1810.05286 ; Google TAP — https://abseil.io/resources/swe-book/html/ch23.html
- [S36] Google flaky tests (Micco, ICST 2017) — https://www.aster.or.jp/conference/icst2017/program/jmicco-keynote.pdf
- [S37] Vitest `--changed` — https://vitest.dev/guide/cli ; its limits — https://dev.to/kazutaka-dev/why-vitest-changed-misses-some-tests-and-how-runtime-coverage-fixes-it-jjm
- [S38] fast-check — https://fast-check.dev/
- [S39] Pact, consumer-driven contracts — https://docs.pact.io/
- [S40] Stryker, configuration and incremental mode — https://stryker-mutator.io/docs/stryker-js/incremental/ ; Google, mutation testing in practice — https://research.google.com/pubs/archive/46584.pdf
- [S41] Principles of Chaos Engineering — https://principlesofchaos.org/
- [S42] Nielsen, 10 usability heuristics — https://www.nngroup.com/articles/ten-usability-heuristics/
- [S43] NN/g, severity ratings — https://www.nngroup.com/articles/how-to-rate-the-severity-of-usability-problems/
- [S44] NN/g, error-message guidelines — https://www.nngroup.com/articles/error-message-guidelines/ ; rubric — https://www.nngroup.com/articles/error-messages-scoring-rubric/
- [S45] NN/g, cognitive walkthroughs — https://www.nngroup.com/articles/cognitive-walkthroughs/
- [S46] NN/g, test with 5 users — https://www.nngroup.com/articles/why-you-only-need-to-test-with-5-users/
- [S47] MeasuringU, interpreting SUS — https://measuringu.com/interpret-sus-score/
- [S48] web.dev, Core Web Vitals — https://web.dev/articles/vitals
- [S49] NN/g, response-time limits — https://www.nngroup.com/articles/response-times-3-important-limits/
- [S50] UXAgent — https://arxiv.org/abs/2502.12561
- [S51] LLM heuristic evaluation, 21.2% of experts' issues — https://arxiv.org/pdf/2506.16345
- [S52] LLM heuristic evaluation, higher coverage — https://pith.science/paper/2507.02306 *(secondary host)*
- [S53] WCAG 2.2 — https://www.w3.org/TR/WCAG22/ ; what is new — https://w3.org/WAI/standards-guidelines/wcag/new-in-22/
- [S54] Anthropic, *Demystifying evals for AI agents* — https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- [S55] Stack Overflow Developer Survey 2025, AI — https://survey.stackoverflow.co/2025/ai
- [S56] Terminal-Bench 2.0 — https://arxiv.org/abs/2601.11868
- [S57] OpenAI on retiring SWE-bench Verified — https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/ *(page refused the fetch; the details are from a search summary)*
- [S58] Fowler, *Parallel Change* — https://martinfowler.com/bliki/ParallelChange.html *(unverified)*
- [S59] Lima — https://github.com/lima-vm/lima
- [S60] Palmer, statement on CVE-2025-48757 (Lovable, missing row-level security) — https://mattpalmer.io/posts/2025/05/statement-on-CVE-2025-48757/ *(search summary)*
- [S61] Escape, 5,600 vibe-coded apps scanned — https://escape.tech/blog/methodology-how-we-discovered-vulnerabilities-apps-built-with-vibe-coding/
- [S62] Tea app breach, the company's statement — https://simonwillison.net/2025/Jul/26/official-statement-from-tea/ *(search summary; Tea attributes it to legacy data, and the AI link is disputed)*
- [S63] METR, algorithmic against holistic evaluation — https://metr.org/blog/2025-08-12-research-update-towards-reconciling-slowdown-with-time-horizons/
- [S64] Vibe Code Bench — https://arxiv.org/abs/2603.04601 *(search summary)*
- [S65] SaaSBench — https://arxiv.org/abs/2605.17526
- [S66] Osmani, *The 70% problem* — https://addyo.substack.com/p/the-70-problem-hard-truths-about *(search summary)*
- [S67] Anthropic, how AI assistance affects coding-skill formation — https://www.anthropic.com/research/AI-assistance-coding-skills
- [S68] Lee et al., generative AI and critical thinking (CHI 2025) — https://dl.acm.org/doi/full/10.1145/3706598.3713778 *(search summary)*
- [S69] Faros AI, *The AI Productivity Paradox* — https://www.faros.ai/blog/ai-software-engineering *(search summary)*
- [S70] Harness, *The State of AI in Software Engineering* (900 respondents) — https://www.harness.io/the-state-of-ai-in-software-engineering
- [S71] Sonar, *The Coding Personalities of Leading LLMs* — https://www.sonarsource.com/the-coding-personalities-of-leading-llms.pdf *(search summary)*
- [S72] Tambon et al., bugs in LLM-generated code — https://arxiv.org/abs/2403.08937 *(search summary)*
- [S73] HumanEvalComm — https://arxiv.org/abs/2406.00215 ; ClarifyCodeBench — https://arxiv.org/abs/2607.00711 *(search summary)*
- [S74] Misguided tests from buggy code — https://arxiv.org/abs/2607.22883 *(search summary)*
- [S75] EffiBench — https://arxiv.org/abs/2402.02037 *(search summary)*
- [S76] Wang et al., deprecated API use in LLM completion (ICSE 2025) — https://arxiv.org/abs/2406.09834 *(search summary)*
- [S77] GitGuardian, Copilot and leaked secrets — https://blog.gitguardian.com/yes-github-copilot-can-leak-secrets/ *(search summary)*
- [S78] Pillar Security, *Rules File Backdoor* — https://www.pillar.security/blog/new-vulnerability-in-github-copilot-and-cursor-how-hackers-can-weaponize-code-agents *(search summary)*
- [S79] Wiz, the s1ngularity (Nx) supply-chain attack — https://www.wiz.io/blog/s1ngularity-supply-chain-attack *(search summary)*
- [S80] Amazon Q extension wiper prompt — https://awsinsider.net/articles/2025/07/25/formatting-flaw-foils-attempted-prompt-injection-on-amazon-q.aspx *(search summary)*
- [S81] Liu et al., *Lost in the Middle* (TACL 2024) — https://aclanthology.org/2024.tacl-1.9/ *(search summary)*
- [S82] US Copyright Office, *Copyright and AI, Part 2* — https://www.copyright.gov/ai/Copyright-and-Artificial-Intelligence-Part-2-Copyrightability-Report.pdf *(search summary)*
- [S83] European Commission, CRA reporting obligations — https://digital-strategy.ec.europa.eu/en/policies/cra-reporting *(search summary)*
- [S84] MIT NANDA, *The GenAI Divide*, via Virtualization Review — https://virtualizationreview.com/articles/2025/08/19/mit-report-finds-most-ai-business-investments-fail-reveals-genai-divide.aspx *(secondary)*
- [S85] CB Insights, top reasons startups fail — https://s3-us-west-2.amazonaws.com/cbi-content/research-reports/The-20-Reasons-Startups-Fail.pdf *(search summary; before 2024)*
- [S86] Fast Company, *The vibe coding hangover is upon us* — https://www.fastcompany.com/91398622/the-vibe-coding-hangover-is-upon-us *(search summary)*
- [S87] Runaway agent cost anecdotes — https://www.getreadyforagents.com/blog/agent-cost-runaway-detection-token-enforcement-production/ *(unverified; vendor blog)*
- [S88] Boucher and Anderson, *Trojan Source* — https://trojansource.codes/ *(unverified)*
- [S89] pnpm 10 release notes (dependency build scripts off by default) — https://pnpm.io/blog/releases/10.0 *(unverified)*
