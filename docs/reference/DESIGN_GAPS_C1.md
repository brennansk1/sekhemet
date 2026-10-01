# C1 design-gap register

The gaps in the design itself: what a professional team, a stranger installing Sekhemet, or a long unattended run needs and the specs do not yet say. This register merges the six design-completeness lenses of workstream C1 (FINISH_LINE_PLAN §E, consolidation note) into one list. It removes duplicates and checks each entry against [FINDINGS_C1.md](FINDINGS_C1.md).

- **Tree:** `claude/harness-definition-done-4d9161` at 23fb026, with the C1 spec-truth agents' uncommitted spec edits. Date: 2026-10-01.
- **Lenses:** design-harness-parity (HP, 9), design-team-process (TP, 12), design-journeys (J, 16), design-release-readiness (RR, 16), design-robustness (ROB, 13), design-system (DS, 20). That is 86 raw items. Every one of them is already a finding in FINDINGS_C1, where they merge into **77** findings.
- **Gap or defect.** A *defect* is a built page or command that breaks a spec, a mockup or a claim already written. It is tracked in FINDINGS_C1 and listed here only in the appendix. A *gap* is a need the design does not cover yet. Each entry names its FINDINGS id, so C2 to C7 work from one id.
- **Severity** follows FINDINGS: 4 blocks release, 3 major, 2 minor, 1 cosmetic.
- **Priority:**
  - **P0:** severity 4.
  - **P1:** marked *v1-must* by a lens, required by §G as written, or needed before the irreversible first publication.
  - **P2:** severity 3.
  - **P3:** severity 2 or lower, for v1.
  - **P4:** Later.
- **Size:** S, M or L, from the lenses.
- **Order:** inside each section, by priority, then by size.
- **Change ids:** the drafts in (b) use the next free `NEW-<spec>-<n>` in each spec as of this tree. Their criteria are numbered `<prefix>-N<n>-<i>`. Re-check both numbers when applying, because the spec-truth agents are editing the same specs.
- **Spec edits:** none by this register. Every spec addition below is a draft, ready to apply. The one narrowing assigned to spec truth now (c3, PRC-06) was applied by C1's spec truth in teams.md §2.2 item 5.

---

## (a) Already planned

The gap is real, and a workflow in the plan already owns closing it. These need no new design, only the owner workflow's attention to the detail named.

| # | FINDINGS | Lenses | Sev | Pri | Size | Gap | Where the plan owns it, and what it must not miss |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| a1 | INS-05 | RR-6 | 3 | P2 | S | Nothing budgets or measures how long a stranger takes from install to a first accepted issue (about 40 GB of models, verification of each role, the first issue) | W10 and R9 clean-machine walks (C5, §G 8). The walk logs must record wall time per step. The Install page must state the total and the download size. §A must gain a *policy* threshold, set by the lead under DEC-47. DoD §6.7 ("reference machine") must be aligned with §G 8 (clean macOS and Ubuntu) |
| a2 | INS-11 | RR-15 | 2 | P3 | S | The channels the FSL licence closes (homebrew-core, distribution repositories) are unstated, and the README badge says Linux while B1 on Linux fails | W3 G4 "platforms stated" (C5). Badge reads *Linux (preview)* until B1 passes (DEC-47 O-2); one FAQ entry "Using Sekhemet at work under FSL" |
| a3 | REL-17 | ROB-9 | 2 | P3 | S | `doctor --report` has no specification of what it holds, never holds, or shows before writing | W8 (C4), §F. W8 writes it into runtime §2 *Retention and logs* in the same commit. It holds versions, OS, doctor output, schema, chain verdict, the last 500 log lines (redacted), masked config and the last 20 stop reasons. It never holds source, diffs or prompts unless `--include-card` is given. It prints the file list first and sends nothing |
| a4 | REL-18 | ROB-12 | 2 | P3 | S | After a rollback the "newer database" refusal names neither the pre-migration backup nor the restore line | W8 (downgrade refused, C-18) and W15 (release notes, C.10 V-37). The refusal must print the exact `restore <path>`. `sekhemet backups` must list each backup's seq, schema and release |
| a5 | REL-22 | RR-13 | 2 | P3 | S | The Node floor 22.13 is never exercised, and on 22 `node:sqlite` warns on every command | B-5 / W3 G4 (install check) and the Lima gate run (C4). One release-gate run on 22.13, suppressing only that warning, or raise the floor to what is tested |
| a6 | PRC-17 | TP-12 | 2 | P3 | S | Watcher and reset email waits for nodemailer, and there is no per-project *no access* level | B-14: W0 (email, O-3) and W4 (scope). Unchanged |
| a7 | INS-10 | RR-14 | 2 | P3 | M | The planned user guide lacks a Team administrator's guide, concepts for juniors mapped to Jira and Linear terms, and an FAQ | W3 G1 (C5). Add those pages plus *Upgrade and uninstall* (b8) and *Privacy and network* (b17) to the page list, with commands checked by the docs test |
| a8 | INS-13 | RR-16 | 1 | P4 | S | No accessibility conformance statement | Evidence comes from W6 and D.4 (C2). The statement follows in 1.x; record it in the deferral DEC (c14) |
| a9 | PRC-19 | J-16 | 1 | P4 | M | A stakeholder cannot try a release without a terminal | Out of v1 by DEC-47 O-13 (deployment). Already decided; say it on the *What Sekhemet does not do* page (W3 G1) |

---

## (b) Within the approved scope: the design, drafted

Each entry belongs to a capability the specs, a DEC, the plan's §A or C.9 lists, or the approved dashboard-v3 mockups already include. What is missing is the rule. The drafts are written in the specs' style, ready to paste into the named section and into §5 (*Changes for v1*). None loosens a gate or a check. Where FINDINGS tags an entry *owner decision*, the note says what the lead records under DEC-47's delegation and what K3 confirms.

### b1 · NEW-models-15: the Team server's engines, one per role
**FINDINGS INS-01** (RR-1, J-6) · severity 4 · **P0** · M · models §2 *Roles and the registry*, surface §2 *Installing* (NEW-surface-4) · route **C5** packaging pass, with C3

*Justification:* the Team image starts an engine for the Coding model only. It has no llama-server for Planning, Review or Research, so Seshat, the PM everyone talks to, has no model. It also lacks socat (DEC-50), and its compose arguments differ from the Worker profile, which MD-M4-1 refuses. The topology for several roles is undesigned. The lead records the topology as a DEC: one engine service per filled role. This keeps the harness image small and lets the registry point each role at its service.
- **MD-N15-1** WHEN the Team image is built THE SYSTEM SHALL contain every program the harness spawns on Linux (git, bubblewrap and socat, DEC-50), and a static test over the Dockerfile SHALL fail when one is missing.
- **MD-N15-2** WHEN the compose file defines an engine service for a role THE SYSTEM SHALL start it with arguments equal to that role's profile `launchArgs()`, and a static test SHALL fail on any difference.
- **MD-N15-3** WHEN the Team server starts THE SYSTEM SHALL check that each filled role's engine answers and matches its profile (MD-M4-1). It SHALL name any role with no engine, or a refused engine, on Configuration › Models and in `doctor`.
- **MD-N15-4** WHEN the compose file names a third-party image THE SYSTEM SHALL pin it by digest. INSTALL SHALL name the GPU variant and the memory each role's service needs.

### b2 · NEW-runtime-11: backups that survive the repository
**FINDINGS REL-01** (ROB-1, J-9, SC-P3) · severity 4 · **P0** · M · runtime §2 *Backup, restore, export and upgrades* (new item 35a) · route **C4** (W8); C5 documents moving a project

*Justification:* backups happen only on `dev backup`, and they copy only the ledger. Every automatic copy sits in the git-ignored `.sekhemet/`, so one `git clean -xdf` loses the board and every copy of it. That breaks the spine's "the event log is the only durable channel". The capability is in scope (runtime items 35–38, C.9 item 6); what is missing is the schedule, the coverage and the location. The lead records the default (on) as a DEC; FINDINGS asks for that yes.
- **RUN-N11-1** WHEN the first `queue`, `overnight` or `serve` of a calendar day starts, or an `overnight` ends, and `[backup] enabled` is not `false` THE SYSTEM SHALL write a verified backup to `<user dir>/backups/<project id>/<date>/`, outside the repository. The backup SHALL contain the ledger, the blobs and evidence the ledger names, the project's `config.toml` and the erasure register. THE SYSTEM SHALL record `ledger/backed_up` with the path, seq and schema version.
- **RUN-N11-2** WHEN a backup is written THE SYSTEM SHALL keep the newest 7 daily and 4 weekly backups per project (*policy*: `[backup] keep_daily`, `keep_weekly`), and SHALL delete only older backups this install wrote.
- **RUN-N11-3** WHEN `sekhemet restore --latest` runs THE SYSTEM SHALL restore the newest backup whose chain and blob hashes verify, re-apply erasures as RUN-40 says, and name the backup it chose. `sekhemet backup` and `sekhemet restore` SHALL be front-door commands, and `dev backup|restore` remain aliases.
- **RUN-N11-4** WHEN `sekhemet` starts in a repository with no ledger while a backup exists for that repository's path THE SYSTEM SHALL offer to restore it before creating an empty ledger.
- **RUN-N11-5** WHEN `doctor` runs THE SYSTEM SHALL show the age of the newest verified backup, and warn when it is over 48 hours old while events were recorded since.
- **RUN-N11-6** (docs) The user guide SHALL describe moving a project to another machine as backup, copy and restore, and an end-to-end test SHALL follow that page.

### b3 · NEW-runtime-12: the machine stays awake while it works
**FINDINGS REL-04** (ROB-5) · severity 3 · **P1** (v1-must) · S · runtime §2 *Unattended hours* (new item 17b) · route **C4**

*Justification:* nothing stops a laptop sleeping during `queue` or `overnight`, so on a MacBook's defaults the night does no work. Sleep time also counts against `power_budget_kwh_day` and can trip the breaker falsely. The fix uses the operating system's own tools, with no library. FINDINGS asks the owner's yes; the lead records it under DEC-47.
- **RUN-N12-1** WHILE a runner holds the lease THE SYSTEM SHALL hold the operating system's sleep assertion (`caffeinate -i -w <pid>` on macOS, `systemd-inhibit --what=idle:sleep` on Linux where present) and SHALL release it with the lease.
- **RUN-N12-2** WHEN no such tool is available THE SYSTEM SHALL say so once in the run report and in `doctor`.
- **RUN-N12-3** WHEN a round's wall-clock time exceeds its monotonic time by more than 60 s THE SYSTEM SHALL record "the machine slept N min" in the run report, and SHALL charge only the monotonic time to the energy budget.
- **RUN-N12-4** WHEN `doctor` runs on a machine on battery power with an overnight window set THE SYSTEM SHALL warn that a closed lid or battery sleep stops the night.

### b4 · NEW-dashboard-10: intake, where Stakeholders file and Members triage
**FINDINGS PRC-01** (J-2, TP-2) · severity 3 · **P1** (v1-must) · S · dashboard §2.4 item 11 (built-in views), teams §2.2 · route **C2**

*Justification:* teams.md grants Stakeholders "file issues", but New issue checks `issue.create` (Member). That part is the defect. Separately, issues filed by Stakeholders, integrations or imports land in Backlog with no triage step, which Linear and Jira teams expect. No new state and no new permission are needed.
- **DB-N10-1** WHEN a Stakeholder chooses *New issue* or presses `c` THE SYSTEM SHALL open the same form and file the issue through `issue.file`, with the project lead as owner.
- **DB-N10-2** WHERE a Backlog issue was filed by a person below Member, by an integration or by an import, and no Member has triaged it, THE SYSTEM SHALL list it in a built-in *Triage* view.
- **DB-N10-3** WHEN a Member chooses *Accept*, *Decline* (Won't do, with a reason), *Duplicate of* or *Snooze* on a Triage row (keys `1`–`3` and `H`) THE SYSTEM SHALL record `issue/triaged {decision}` and remove the row. Seshat's existing triage suggestions SHALL show beside each row as proposals.
- **DB-N10-4** WHEN Triage holds rows THE SYSTEM SHALL show their count in the project lead's Inbox under *Needs you*. In Solo, where one person files everything, the view SHALL be hidden.

### b5 · NEW-models-16: the first hour, with the engine found and both floors stated
**FINDINGS CFG-01** (RR-3, J-11, without the download) and **CFG-06** (RR-4) · severity 3 · **P1** (RR-3 v1-must) · S · models §2 *Getting the weights*, surface §2 *The first run* · route **C3** (W11), with C5's Install page

*Justification:* first run requires llama.cpp, but on Linux its fix points to `docs/design/HARNESS_DESIGN.md`, which does not exist. No build floor is stated for the shipped models, and `doctor` never checks llama-server. A 16 GB machine gets the 24 GB recommendation, although DEC-47 O-5 says 16 GB is not supported. Downloading the engine is a new feature: see c7.
- **MD-N16-1** WHEN first run or `doctor` runs THE SYSTEM SHALL find llama-server, read its build number, and compare it with the `minLlamaBuild` that every shipped roster entry records (at least the tested build). Below the floor it SHALL say "llama-server bNNNN found; bMMMM or later needed".
- **MD-N16-2** WHEN llama-server is missing THE SYSTEM SHALL name this platform's fix: Homebrew on macOS, and on Linux the user guide's Install section (CUDA, Vulkan and ROCm builds). A test SHALL fail when any fix names a file or page that does not exist.
- **MD-N16-3** WHEN the machine has less than 24 GB of memory THE SYSTEM SHALL say, in first run and in `doctor`, that v1 supports 24 GB and above (DEC-47 O-5). It SHALL let the person continue at their own risk, and SHALL NOT present the 24 GB set as fitting.
- **MD-N16-4** WHEN `doctor` passes on an Ollama endpoint THE SYSTEM SHALL say which roles that serves under v1's support statement, consistent with the README.

### b6 · NEW-dashboard-11: the sprint lifecycle
**FINDINGS PRC-02** (TP-1) · severity 3 · **P1** (v1-must) · M · dashboard §2.4 item 13 (sprint header), planner-pm §2.7 · route **C2**

*Justification:* sprints exist, but the product has no Start or Complete sprint. Unfinished issues are not carried over, and there is no sprint report. With no sprint, the toast tells a person to "create one with POST /api/cycles". planner-pm §2.7 cites carry-over history that nothing records. Jira and Linear teams use this every two weeks.
- **DB-N11-1** WHEN a Member chooses *Start sprint* on a planned sprint THE SYSTEM SHALL record the start with the committed issues (and points, when points are on), and SHALL allow one active sprint per project.
- **DB-N11-2** WHEN a Member chooses *Complete sprint* THE SYSTEM SHALL list done and not-done issues and ask where the not-done ones go: the next planned sprint, a new sprint, or Backlog. It SHALL apply the moves and the close as one recorded group.
- **DB-N11-3** WHEN a sprint completes THE SYSTEM SHALL show a sprint report computed from the ledger: committed at start, added, removed, completed and carried over.
- **DB-N11-4** WHEN Seshat judges a sprint due to close THE SYSTEM SHALL offer a `close_cycle` proposal that a person applies. Seshat never closes a sprint itself (DEC-36).
- **DB-N11-5** WHEN an action needs a sprint and none exists THE SYSTEM SHALL offer *New sprint* and *Plan a sprint with Seshat*, and SHALL never show an API path.

### b7 · NEW-runtime-13: a full disk is a named stop
**FINDINGS REL-05** (ROB-6) · severity 3 · P2 · S · runtime §2 *Retention and logs* (beside NEW-runtime-4, bounded disk) and the worker-loop stop-reason table · route **C4** (W8's full-disk fault)
- **RUN-N13-1** WHEN a card or a backup is about to start and the repository's volume has less free space than the floor (*policy*: 5 GB, or twice the last worktree if larger) THE SYSTEM SHALL start no card and end the round with the environment stop `disk_low`. The stop SHALL name the volume and the largest `.sekhemet` consumers.
- **RUN-N13-2** WHEN any write fails with ENOSPC THE SYSTEM SHALL record the same stop with the path and leave the ledger consistent. `resume` SHALL continue once space is freed.
- **RUN-N13-3** WHEN `doctor` runs THE SYSTEM SHALL show the free space on the repository's volume and on the models' volume.

### b8 · NEW-surface-7: upgrade and uninstall
**FINDINGS INS-03** (HP-7, RR-11, SC-P2) · severity 3 · P2 · S · surface §2 *Installing* · route **C5**

*Justification:* C.9 items 6 and 8 expect it, and no spec describes it. An install writes to the user directory, the Crawl4AI venv, the install.sh link, each repository's `.sekhemet` and worktrees, keychain items, and possibly a SearXNG container.
- **SUR-N7-1** WHEN `sekhemet uninstall --dry-run` runs THE SYSTEM SHALL list every path, keychain item and container this install created, with sizes, including each repository recorded in the user directory, and SHALL change nothing.
- **SUR-N7-2** WHEN `sekhemet uninstall --yes` runs THE SYSTEM SHALL remove them, but SHALL keep project ledgers and backups unless `--include-ledgers` names them.
- **SUR-N7-3** (docs) The user guide's *Upgrade and uninstall* page SHALL give the upgrade, rollback (from the pre-migration backup) and uninstall lines, and the docs test SHALL check them against the command table.

### b9 · NEW-teams-12: a Team install with no identity provider
**FINDINGS INS-07** (J-7) · severity 3 · P2 · S · teams §2.3 *Accounts and sign-in*, surface §2 *Installing* · route **C5**

*Justification:* DEC-38's built-in accounts and DEC-47 O-10 put Team in v1, but the only packaged path needs OIDC and the admin's own certificate. A small team with no identity provider has no supported install. Caddy is not proposed: the profile uses whatever reverse proxy the admin runs.
- **TEAM-N12-1** WHEN the admin starts the compose profile `builtin` THE SYSTEM SHALL serve sign-in with built-in accounts (passwords, passkeys, invites; DEC-38) and `[identity] sources = local`, with no OIDC proxy.
- **TEAM-N12-2** WHEN `doctor` runs on a Team server whose public address is not `https` THE SYSTEM SHALL fail the check and name the documented TLS front.
- **TEAM-N12-3** (docs) INSTALL SHALL document both profiles side by side, each with the commands to reach a first sign-in.

### b10 · NEW-models-17: two projects on one machine
**FINDINGS REL-07** (ROB-10) · severity 3 · P2 · M · models §2 *Memory safety* and *Scheduling*, surface §2 *The command surface* · route **C4**

*Justification:* each repository has its own lease and its own in-process residency lock, so two projects can load weights at the same moment on a 24 GB host. A second `serve` fails raw on port 4040.
- **MD-N17-1** WHEN any process is about to load or unload weights THE SYSTEM SHALL hold a machine-wide model lease at `<user dir>/model.lock`, using the runner lease's exclusive-open, pid and process-start-time pattern.
- **MD-N17-2** WHEN another process holds that lease THE SYSTEM SHALL attach to the engine already serving a matching profile, or else wait and say which project holds which model.
- **MD-N17-3** WHEN `serve` finds its port in use THE SYSTEM SHALL take the next free port and print the address. `daemon status --all` SHALL list each project's server and port.
- **MD-N17-4** C.6 SHALL gain the fault "two projects, one machine".

### b11 · NEW-surface-8: doctor's checks, each with its next step
**FINDINGS CLI-02** (HC-05, RR-5, ROB-8) · severity 3 · P2 · M · surface §2 *The first run* and the command table · route **C4** (W8), with the model and engine rows in C3

*Justification:* the misleading verdict ("All critical checks passed" with no model) is the defect in FINDINGS. The gap is that no spec lists doctor's checks or gives each one a next step. Plan §F generates the troubleshooting page from those checks.
- **SUR-N8-1** WHEN `doctor` runs THE SYSTEM SHALL end with one verdict: *Ready to run an issue*, or *Not ready* naming the first missing step. It SHALL exit 1 while not ready.
- **SUR-N8-2** WHEN a check is not a pass THE SYSTEM SHALL print its next step as "Do: …".
- **SUR-N8-3** THE SYSTEM SHALL check that the ledger chain verifies, the schema version, free disk (b7), the age of the newest backup (b2), stale runner or accept locks, crashed attempts awaiting the sweep, the engine (b5), and each role's verified model.
- **SUR-N8-4** WHEN the project's package manager is not pnpm THE SYSTEM SHALL NOT fail on pnpm. WHEN the folder has no `.sekhemet` yet THE SYSTEM SHALL NOT warn about skills.
- **SUR-N8-5** The troubleshooting page SHALL be generated from this check catalogue, and a test SHALL fail when a check has no page entry.

### b12 · NEW-teams-13: when a member leaves
**FINDINGS PRC-09** (J-10) · severity 3 · P2 · M · teams §2.2 *Workspace, projects and access* · route **C2**, after the lead's DEC

*Justification:* removing a member revokes credentials only. The Agent work they started runs on their permissions (DEC-36), and an Accept rule that names only them leaves no one able to accept. There is no automatic reassignment, as in Linear's member removal.
- **TEAM-N13-1** WHEN an Admin opens *Remove* for a person THE SYSTEM SHALL list what that person owns and leads, their seats in Accept rules, and the Agent work they started.
- **TEAM-N13-2** WHEN the removal is confirmed THE SYSTEM SHALL pause the Agent work they started at its next step boundary (owner unchanged), keep their attribution, and refuse new assignment to them.
- **TEAM-N13-3** WHEN an Accept rule is left with no one able to accept THE SYSTEM SHALL keep the issues it covers in Review, refuse Accept on them with a sentence naming the rule, and post a notice to the project lead's Inbox and every Admin's that the rule needs a person, until someone with the right edits the rule. It SHALL NOT give accept authority to anyone the rule does not name (DEC-35's per-project Accept rule; the spine's *the human is the rate limiter*).
- **TEAM-N13-4** THE SYSTEM SHALL record each of these on the ledger.

*Corrected after the C1 review:* an earlier draft let the system fall back to the project lead, else an Admin. That hands accept authority to people the rule never named, which changes DEC-35 and touches the spine, so it is not within the approved scope: it is decision **c15** in (c).

### b13 · NEW-planner-pm-11: the retrospective, as a report for people
**FINDINGS PRC-03** (TP-3) · severity 3 · P2 · M · planner-pm §2.7 item 4 and the sessions table, §4 · route **C2**, or a DEC deferring the build (the §4 rows are added either way)

*Justification:* the sessions table designs a Retrospective (planner-pm:100), but the queue only prints "Ceremony due". The designed content covers gate failures only, nothing of the team's process. It stays a report for people (DEC-05) whose actions are proposals (DEC-36).
- **PM-N11-1** WHEN a sprint completes, or `retroEveryCards` issues have been accepted in a Kanban project, THE SYSTEM SHALL have Seshat draft a retrospective from the ledger. It covers what went well (first-try passes, cycle time against the service level), what slowed the team (review wait, send-back reasons, blocked time, scope added), and proposed actions.
- **PM-N11-2** WHEN the retrospective proposes an action (a playbook rule, a change to review capacity, a new issue) THE SYSTEM SHALL offer it as a proposal a person applies, and SHALL change nothing without that person.
- **PM-N11-3** WHEN a person edits and posts the retrospective THE SYSTEM SHALL record it on the ledger and link it from Status.
- **PM-N11-4** planner-pm §4 SHALL gain rows for the Intake, Retrospective and Release sessions.

### b14 · NEW-dashboard-12: full-text search
**FINDINGS PRC-04** (TP-4) · severity 3 · P2 · M · dashboard §2.4 item 12 (query language) and §2.3 (palette) · route **C2**; no library (node:sqlite FTS5 when the bundled build has it, else a scan)
- **DB-N12-1** WHEN a person types free words in the palette or the query box THE SYSTEM SHALL match title, key, description, acceptance criteria and comment text. Matches SHALL include Done and Won't do issues, across every project the person can see (`GET /api/search?q=`).
- **DB-N12-2** THE SYSTEM SHALL respect visibility and levels, and SHALL never return erased text.
- **DB-N12-3** WHEN the W9 seeded board holds 10,000 issues THE SYSTEM SHALL answer within the §A interaction budget (p75 ≤ 200 ms).

### b15 · NEW-dashboard-13: lessons for the practice a person performs
**FINDINGS PRC-05** (TP-9) · severity 3 · P2 · M · dashboard §2.9 *The Learn layer* (P4) · route **C2**. The Learn sheet itself (§2.9.3) is FINDINGS' decision (specs-product proposes 1.x).

*Justification:* "juniors learn the real practice" (owner's direction). Today Tips teach board terms and flow metrics, not the practices a person performs.
- **DB-N13-1** WHERE Tips are on THE SYSTEM SHALL offer lessons on reviewing a change, sending back with a useful note, approving acceptance criteria (at the criteria-approval hold), priority and MoSCoW, blocked work and dependencies, the Definition of done, triage, sprint planning and the retrospective.
- **DB-N13-2** Each lesson SHALL carry one line from the project's own numbers and one canonical link (Scrum Guide, Atlassian or Linear docs), in DEC-31 words.
- **DB-N13-3** WHEN a lesson's subject first appears on screen for a learner THE SYSTEM SHALL offer the lesson once, and SHALL never block the action.

### b16 · NEW-kernel-11: the power-loss window, stated and tested
**FINDINGS REL-16** (ROB-4) · severity 2 · P3 · S · kernel §2 *Storage* (rule 38) · route **C4** (W9 measures, W8 tests)
- **K-N11-1** THE SYSTEM SHALL use `synchronous = FULL`, with `checkpoint_fullfsync` on darwin, when W9 measures a p95 append cost increase within a *policy* bound. Otherwise kernel rule 38 SHALL state that a power cut can roll back the most recent committed events.
- **K-N11-2** WHEN the database reopens after its WAL was truncated at a random frame (W8's power-cut fault) THE SYSTEM SHALL verify the chain to the last intact event, corrupt no event, and run the start-up sweep (REL-02's Accept reconciliation included).

### b17 · NEW-security-11: what leaves the machine, listed and shown
**FINDINGS INS-08** (RR-12, ROB-11) · severity 2 · P3 · S · security §2 *Egress (S3)*, dashboard §2.16 · route **C5** (the page) and **C2** (the view)

*Justification:* professional security reviews ask for every outbound connection. Egress is already recorded (security item 33) but never shown. The view reads existing events and records nothing new. FINDINGS asks the owner's yes for it; the lead records it.
- **SEC-N11-1** The user guide's *Privacy and network* page SHALL be generated from the network policy's host list, naming for each host its purpose, what is sent and the setting that turns it off. A test SHALL fail when code can reach a host the page does not list.
- **SEC-N11-2** WHEN a person opens Configuration › Privacy › *Network activity*, or runs `sekhemet egress [--since]`, THE SYSTEM SHALL list the recorded `harness/egress`, `card/egress` and `model/downloaded` events: host, purpose, allowed or refused, size, and the issue or person that caused each.
- **SEC-N11-3** WHEN no event is recorded THE SYSTEM SHALL say "Nothing has left this machine".

### b18 · NEW-runtime-14: a health route for the Team server
**FINDINGS INS-12** (J-8) · severity 2 · P3 · S · runtime §2 *The HTTP API and the live stream* · route **C5** packaging pass
- **RUN-N14-1** WHEN `GET /healthz` arrives THE SYSTEM SHALL answer without authentication and with no data: 200 when the ledger opens and its head verifies, otherwise 503.
- **RUN-N14-2** The Dockerfile and the compose file SHALL carry a `HEALTHCHECK` that uses it.

### b19 · NEW-dashboard-14: the Definition of done and readiness, readable
**FINDINGS PRC-12** (TP-6) · severity 2 · P3 · S · dashboard §2.16 (Configuration › Project) and §2.6 (the issue page) · route **C2**
- **DB-N14-1** WHEN a person opens Configuration › Project THE SYSTEM SHALL show a read-only *Definition of done* in plain words, built from `gates.toml`, the depth profile and the Accept rule.
- **DB-N14-2** WHEN an issue is in Backlog or Planning THE SYSTEM SHALL show *Ready to start* on its page, listing each kernel entry condition as met or not met, with the reason.
- **DB-N14-3** THE SYSTEM SHALL enforce nothing new and loosen no check.

### b20 · NEW-dashboard-15: New issue by type, with a Bug's reproduction
**FINDINGS BRD-05** (HA-20, J-3, TP-7) · severity 2 · P3 · S · dashboard §2.4 item 7 (quick create), planner-pm §2.16 · route **C2**

*Justification:* a fix card needs "a defect with a reproduction" (planner-pm:221). Quick create asks only for a title and a description. FINDINGS asks the owner's yes for the Bug fields. Reading `.github/ISSUE_TEMPLATE` forms is optional: drop DB-N15-3 if it is not wanted.
- **DB-N15-1** WHEN a person chooses *New issue* THE SYSTEM SHALL offer type, priority, labels, sprint and assignee as property pills, in DEC-31 type words.
- **DB-N15-2** WHEN the type is Bug THE SYSTEM SHALL ask for *What happened*, *What you expected*, *Steps* and *Release* (the tagged releases), each optional. The planner SHALL use them as the fix card's reproduction input. WHEN a person tells Seshat that something is broken, Seshat SHALL ask for the same fields.
- **DB-N15-3** WHERE the repository has `.github/ISSUE_TEMPLATE` issue forms THE SYSTEM SHALL use their fields for the matching type.

### b21 · NEW-dashboard-16: undo for field and bulk edits
**FINDINGS BRD-07** (TP-8, UH-10) · severity 2 · P3 · S · dashboard §2.4 item 16 (bulk bar) and §2.3 (keyboard) · route **C2**
- **DB-N16-1** WHEN an inline or bulk field edit, a move, a park or a reject is applied THE SYSTEM SHALL show a result toast offering *Undo* (`z`) for 10 s.
- **DB-N16-2** WHEN *Undo* is chosen THE SYSTEM SHALL append compensating events that restore the previous values (the log stays append-only) and say what it restored. A field another person changed since SHALL be left as it is, and named.
- **DB-N16-3** Accept SHALL keep its own grace period and revert (review-git S5) and SHALL NOT use this undo.

### b22 · NEW-dashboard-17: accepting an issue without reading a diff
**FINDINGS REV-10** (J-13) · severity 2 · P3 · S · dashboard §2.8 item 4 (*Needs you*), review-git §2.1 · route **C2**
- **DB-N17-1** WHEN a person whose first-run route is *I manage the work* chooses *Review it* THE SYSTEM SHALL open the issue's criteria view. The view shows each acceptance criterion in plain words with its check state, the AI review's summary and the visual check's screenshots, with *Accept* and *Send back*, and the diff one tab away.
- **DB-N17-2** THE SYSTEM SHALL record the same Accept event, under the same gates and Accept rule, as Review does.

### b23 · NEW-models-18: downloads that resume and fit
**FINDINGS CFG-18** (RR-7) · severity 2 · P3 · S · models §2 *Getting the weights* (NEW-models-7, -12) · route **C3** (W11)
- **MD-N18-1** WHEN a download is interrupted THE SYSTEM SHALL keep the `.part` file and resume with an HTTP Range request, re-hashing the bytes it kept.
- **MD-N18-2** WHEN a download needs more space than the destination volume has free THE SYSTEM SHALL refuse before starting and name both sizes.
- **MD-N18-3** WHEN a person is about to fetch the recommended set THE SYSTEM SHALL show the total size and each model's licence before asking for the yes.

### b24 · NEW-dashboard-18: Status as a grid at wide widths
**FINDINGS STA-08** (DS-8) · severity 2 · P3 · S · dashboard §2.8 · route **C2**, after K3 confirms the mockup

*Justification:* §2.8 fixes the order of Status, not its layout. The approved Status mockup is a dashboard grid, and the build is one 960 px column.
- **DB-N18-1** WHERE the main area is 1280 px or wider THE SYSTEM SHALL lay Status out as the mockup's grid. The key-number strip comes first. The burn-up (two thirds) sits beside *Needs you* and *Waiting on others* (one third). A three-column band (Requirements, Risks, Who's working) follows, above Flow. §2.8's reading order is kept.
- **DB-N18-2** WHERE the main area is narrower than 768 px THE SYSTEM SHALL keep one column (§2.8.13).

### b25 · NEW-design-stage-7: starting a project as a page with a live draft
**FINDINGS PM-05** (DS-18, WT-25) · severity 2 · P3 · M · design-stage §2, dashboard §2.7 (the starter) · route **C2**, after K3 confirms the Start and StartPlan mockups

*Justification:* the approved Start and StartPlan mockups show the conversation beside a live Brief, Requirements and Plan. The build prefills a message in the side panel, and at 400 px its only entry is at the bottom of Status. The draft must stay proportional, with no forced stages (the owner's PM-feel direction).
- **DS-N7-1** WHEN a person chooses *New project* THE SYSTEM SHALL open a start page with the conversation beside a live draft that shows only the parts Seshat has recorded: Brief, Requirements and Plan, as far as they exist. The page SHALL offer *Review plan* once a plan exists.
- **DS-N7-2** WHERE the viewport is narrower than 768 px THE SYSTEM SHALL show the draft as a tab beside the conversation, and *New project* SHALL be reachable from the top of Projects and Status.
- **DS-N7-3** The panel's starter (§2.7.6) SHALL remain for asking within an existing project.

---

## (c) Needs the owner's yes

These are new capabilities or publication choices that no spec, DEC or plan item includes. Each entry has a yes and a no, and a no is recorded as a DEC (Later) so §G 14 has no *missing* parity item without one.

| # | Decision (FINDINGS) | Why a professional team needs it | Smallest proposal | Size | Cost of not doing it |
| --- | --- | --- | --- | --- | --- |
| c1 | **Provenance without CI** (INS-04, RR-2) · P1 | §G 11 requires npm provenance, which only a cloud CI runner can produce, while DEC-47 defers CI. Companies' supply-chain policies check provenance or checksums | Either one tag-triggered GitHub Actions *release* job (build, pack, `npm publish --provenance`, CycloneDX SBOM, SHA256SUMS, GHCR push; the gate still runs locally and in Lima), or a DEC that drops provenance from §G 11 and ships SHA256SUMS plus the SBOM | S | §G 11 cannot be met as written, so the release cannot be called published without a recorded exception |
| c2 | **What goes public, and contribution terms** (INS-06 RR-8, INS-09 RR-9) · P1 | Strangers judge a repository by its hygiene. Contributors need terms under FSL, where the owner keeps commercial rights | A W15 pre-publication checklist: gitleaks over the full history (approved, DEC-43); untrack `.claude/launch.json`; move machine operations out of CLAUDE.md; parameterise the two `/Volumes/My Passport` paths. **The owner decides:** whether DEV_LOG and the internal reviews stay public, whether to rewrite the author email on 11 commits, and DCO or CLA. Then CONTRIBUTING, `.github/` CODE_OF_CONDUCT, SUPPORT, issue and PR templates | S | The first public push is irreversible. Personal data and machine paths published stay published. With no contribution terms, outside patches cannot be accepted safely |
| c3 | **Many projects per server** (PRC-06, J-1) · P1 | A team lead runs several repositories. teams.md promised "any number of projects", but the build refuses a second | **Now, without a yes:** spec truth narrows (teams.md §2.2 item 5 now says one project per server in v1, applied in C1; the Projects page, New project's copy and the guide follow in C2 and C5) teams.md, the Projects page and the guide to "one project per server in v1", and New project says how to start another server. **With a yes:** a projects folder where New project creates a folder, runs `git init` and opens its own ledger | M | Without the narrowing, a false claim in the spec and the UI. Without the build, a team runs one server per repository |
| c4 | **A local notification when work waits** (PRC-11, HP-2) · P2 | "The human is the rate limiter": a Solo person with no ntfy, Gotify, Slack or SMTP never learns that an issue waits in Review | A browser notification from the open dashboard (permission asked once, in Configuration › Notifications), with no library. An OS notification through `osascript` or `notify-send` only if the dashboard is closed | S | Work sits in Review unseen, and the measured flow understates what the product can do |
| c5 | **Learn that a release or security fix exists** (INS-02, HP-3, RR-10, J-15) · P2 | Plan line 5 promises "a fix reaches them as a versioned release", but an offline product never hears of one | SECURITY.md states supported versions and the advisory route. `sekhemet doctor --check-updates` asks first, then reads the latest tag through the network policy, never automatically. A *What's new* note after an upgrade is read from the bundled CHANGELOG | S | Users keep running versions with known vulnerabilities and never learn of them |
| c6 | **Push accepted work and tags to the remote** (PRC-08, J-5) · P2 | planner-pm says "the tag is what the team's CD reacts to", but tags and the integration branch never leave the server. Only GitHub PR-on-accept pushes, and only card branches | An opt-in project setting, *Push to remote after Accept and on release*, using plain git with the server's credentials, through the network policy, recorded on the ledger. It works for any host | S | Teams copy work out by hand, and CD never fires. Otherwise narrow the claim |
| c7 | **Download the inference engine from Configuration** (CFG-01 download part, J-11) · P2 | A non-developer or junior cannot run `brew install llama.cpp`. The product can download weights but not the engine | *Get the inference engine*: a pinned llama.cpp release for this platform, hash-verified, downloaded on a click as the weights are (DEC-29 O2 path), recorded in PROVENANCE | M | The non-developer audience needs a terminal and Homebrew before the first screen works |
| c8 | **Maintenance releases after the last slice** (PRC-07, J-4) · P2 | A product lives on after its first release. Fixes and dependency upgrades need versions, changelogs and notes | An open *Next release* that collects accepted issues outside any slice. *Propose release* computes the version (a patch for fix-only work), the changelog and the notes, tagged on confirmation through the existing `release/proposed` and `release/tagged` events. No maintenance branches in v1 | M | After the first release, work ships untagged and with no notes, which breaks the teaching claim on releases |
| c9 | **Test services and environment for gates** (PRC-10, HP-1) · P2 | Most real projects test against a database or a cache. gates.md rule 10 promises "the gate host provides it", but no caller sets it, so such gates are always *unavailable* | A `[gates.services]` table: named local services the person starts or that are started in the confinement (ports through DEC-50's relays), plus non-secret `env` keys, filling `HostCapabilities.provides`. Alternatively, record the limitation and say it in the claims table | M | Projects with service-backed tests never get those checks. The claims table must say so |
| c15 | **An automatic Accept fallback when a member leaves** (PRC-09's fallback part, split from b12 after the C1 review) · P2 | A team should not stall because the only person on an Accept rule left; Linear and Jira reassign on removal | **With a yes:** when an Accept rule is left with no one able to accept, the project lead, else an Admin, may accept, recorded on the ledger as a fallback naming the departed person. This amends DEC-35's per-project Accept rule and touches the spine's *the human is the rate limiter*, so only the owner can approve it. **With a no (the default, b12 TEAM-N13-3):** Accept is refused and the lead and Admins are notified until a person edits the rule | S | Without the fallback, issues wait in Review until someone edits the rule; with it unapproved, a person the rule never named could accept |
| c10 | **Start the dashboard at login** (REL-14, J-12, ROB-13) · P3 | After a reboot, a non-developer must open a terminal and `cd` into the folder before seeing the board | `sekhemet daemon start --at-login`, which writes a LaunchAgent (macOS) or a `systemd --user` unit (Linux), with no library, and prints a fixed address to bookmark. `--at-login` on `daemon stop` removes it. runtime §7's proposal | S | The non-developer path needs a terminal on every restart |
| c11 | **Structured output for scripts** (CLI-09, HP-4) · P3 | CI jobs and scripts need results, not prose (`claude -p --output-format json` is the parity reference) | `--json` on the front-door commands that report a result (`run`, `status`, `doctor`, `accept`), from one result type, with a schema test | S | Scripting relies on parsing English, which breaks on every copy change |
| c12 | **Nested AGENTS.md and the visible rule set** (PRC-13, HP-5) · P3 | Monorepos keep per-package AGENTS.md (the agents.md convention: the nearest file wins). Nobody can see which rules reached the model | Read the nearest AGENTS.md for the card's files and show *Rules used* on the issue page. It is model-facing, so it needs its A/B (PROMPT_STANDARD) before it ships, and surface:379's evidence (context files did not raise success) argues for measuring first | S | Package rules are ignored without a word, and people cannot audit what the model was told |
| c13 | **Signed commits** (PRC-14, HP-6) · P3 | Repositories that require signed commits refuse the card branch and its PR | Sign the squash on Accept with the person's own key, outside the sandbox (the Worker's commits stay unsigned inside it), or state the limitation in INSTALL | M | Sekhemet is unusable on protected branches that require signing |
| c14 | **One DEC: these stay Later** (BRD-08 TP-5, CLI-10 HP-9, PRC-15 J-14, PRC-16 TP-11, PRC-18 TP-10, PRC-20 HP-8) · P4 | Shared saved views, shell completion, a recurring dependency check, a GitLab merge request on Accept, a timeline, and *Open in editor* are parity items teams use, but none is on v1's path | Record them as Later in one DEC, and add each to its spec's §7 and the C.9 parity checklist as *out of scope by DEC* | S | Without the DEC, §G 14 counts each as a *missing* parity item and blocks the release |

---

## (d) Release blockers

**What the release-readiness lens marks as blocking a public v1:**

| Gap | FINDINGS | Smallest fix | Owner workflow |
| --- | --- | --- | --- |
| RR-1: the Team image and compose cannot run the product (no socat, no engines for Planning, Review and Research, refused compose arguments, floating tags) | INS-01 (sev 4) | b1: add socat. One engine service per role, with compose arguments generated from `launchArgs()` and a static test. Pin images by digest. Have doctor check each role's engine | **C5** packaging pass (with B-5), before R9 and W7 build the image |
| RR-3: a newcomer cannot get the engine right (dead Linux link, no build floor, doctor blind to llama-server) | CFG-01 (sev 3, v1-must) | b5: fix the Linux pointer, add `minLlamaBuild` on every shipped model, add a doctor engine check | **C3** (W11), with C5's Install page |

**Also blocking, by another lens or by §G as written** (listed so C7 sees one list):

| Gap | FINDINGS | Why it blocks | Smallest fix | Owner workflow |
| --- | --- | --- | --- | --- |
| Backups live inside the repository and are manual (ROB-1, J-9) | REL-01 (sev 4) | One `git clean -xdf` loses the board and every copy of it | b2 | **C4** (W8) |
| No sprint Start, Complete or carry-over (TP-1) | PRC-02 (v1-must) | Fails the product direction (Jira and Linear practice) at the core cadence, and the UI points people to a raw API | b6 | **C2** |
| A Stakeholder cannot file an issue, and nothing triages intake (J-2, TP-2) | PRC-01 (v1-must) | teams.md grants filing, so the non-developer path breaks | b4 | **C2** |
| A laptop sleeps through the night's run (ROB-5) | REL-04 (v1-must) | The overnight promise (runtime 17) fails on the commonest hardware | b3 | **C4** |
| One project per server, while teams.md says any number (J-1) | PRC-06 (v1-must) | A false claim fails §G 9 | c3 narrowing by spec truth now (applied in C1: teams.md §2.2 item 5); the build only with a yes | **C1/W4** spec truth (done), then C2 New project's copy and C5 docs |
| §G 11 provenance needs CI, which DEC-47 defers (RR-2) | INS-04 | §G 11 cannot be met as written | c1 | **C7** (W15), after the decision |
| No pre-publication hygiene (RR-8) | INS-06 | The first public push is irreversible | c2 checklist | **C7** (W15) |

Outside this register, FINDINGS_C1 holds three more severity-4 **defects**: BRD-01 (pinned columns cover the board), CLI-01 (the CLI cannot accept an issue that has AI review findings) and TST-01 (404 of 537 built criteria are unit-only, against §G 14).

---

## Appendix: defects, not gaps

These design-lens items are breaks of an existing spec, mockup or claim. They are tracked and routed in FINDINGS_C1 and are not repeated above.

| FINDINGS | Lens | What it breaks |
| --- | --- | --- |
| BRD-01 (sev 4) | DS-4 | dashboard §2.4.2: Done hidden under the pinned On hold column |
| BRD-02 | DS-1 | §2.4.4: tile status broken one letter per line |
| ISS-01 | DS-5 | §2.6 header and the Issue mockup: no properties rail |
| REV-01 | DS-14 | §2.5.2–2.5.4: skipped checks drawn as failures |
| REV-02 | DS-6 | §2.5.1 and §2.15.3: the phone's Review bar overprints |
| STA-03 | DS-7 | §2.13.4: browser list indents and wrong number sizes |
| SHL-01 | DS-2 | §2.2.1: the absolute path where the project switcher belongs |
| SHL-02 | DS-3 | §2.2.6 and §A "Nothing raw": the principal id shown as a name |
| TEAM-02 | DS-17 (part) | §2.2.6: the Notifications page is not built (deferral is FINDINGS' owner decision) |
| BRD-09, BRD-10 | DS-10, DS-16 | §2.13 and the Main mockup: no primary action; first column clipped, boxes in boxes |
| STA-06 | DS-9 | §A States: an empty burn-up plot |
| SHL-08, SHL-09 | DS-17, DS-20 | §2.2.6 and §2.2.2: account-menu items; the phone top-bar gutter |
| CFG-07, VIS-05 | DS-13 | D.5: components built twice (tabs, underlined button links) |
| VIS-01 | DS-15 | §A: 211 off-scale spacing literals |
| VIS-02 | DS-12 | §2.13.6 and the Logo mockup: the sun disc in the wrong place |
| VIS-04 | DS-19 | §2.15.5: mockups not renderable offline (support.js missing) |
| SPEC-07 | DS-11 | dashboard.md contradicts itself on the primary button (spec truth) |
| SPEC-02 | ROB-2 | runtime item 37 claims blob and projection export, which is not built |
| REL-02 | ROB-3 | runtime item 10: a crash between Accept's merge and its record |
| REL-06 | ROB-7 | surface item 21: a malformed config dropped silently |

---

## Counts

| | Entries | FINDINGS ids | Raw lens items |
| --- | ---: | ---: | ---: |
| (a) Already planned | 9 | 9 | 9 |
| (b) Within scope, drafted | 25 changes (85 criteria) | 26 | 34 |
| (c) Needs the owner's yes | 15 decisions | 19 (+ CFG-01's download part, + PRC-09's fallback part, c15) | 22 |
| Appendix: defects, not gaps | 23 ids | 23 | 21 |
| **All** | | **77** (every design finding in FINDINGS_C1) | **86** |

- **By priority:**
  - (b): P0 2, P1 4, P2 9, P3 10.
  - (c): P1 3, P2 7, P3 4, P4 1 (c15 is split from b12, so the gap count below is unchanged).
  - (a): P2 1, P3 6, P4 2.
- **By severity, over the 54 gaps in (a), (b) and (c):** 2 at severity 4, 23 at severity 3, 24 at severity 2, 5 at severity 1.
- **New libraries proposed:** none. Every drafted rule uses node:sqlite, the operating system's own tools (`caffeinate`, `systemd-inhibit`, launchd, systemd) or tools already approved (gitleaks, DEC-43; CycloneDX, DEC-47). c1's GitHub Actions job and c7's engine download are the only new external dependencies, and both are decisions in (c).
- **Release blockers (d):**
  - 2 marked by the release-readiness lens;
  - 7 more, from the other lenses or from §G as written;
  - 3 more severity-4 defects in FINDINGS.

## Is this a complete, robust professional harness ready for strangers?

**Not yet.** The core is real and professional in shape: gates that decide completion, a hash-chained ledger, Review with an Accept rule, and a Jira- and Linear-shaped board with queries, bulk edit, an Inbox, an audit trail and imports. The lenses found the design mostly complete for one person on one machine who already knows the tools. What stands between it and strangers relying on it comes down to a few things:

1. **A stranger cannot get it running.** Nothing is published. The engine is a manual Homebrew step behind a dead Linux link (b5, c7). The Team image cannot start Seshat's model (b1). No clean-machine walk has been timed (a1).
2. **Their work is not safe from ordinary accidents.** Backups sit inside the repository a `git clean` removes (b2). The night stops when a laptop sleeps (b3). A full disk or a second project fails blind (b7, b10).
3. **The team cadence is incomplete.** There is no sprint completion or carry-over, no triage of intake, and no retrospective (b6, b4, b13). The issue page has no properties, and three severity-4 defects remain (BRD-01, CLI-01, TST-01).
4. **Publication is not ready.** Provenance cannot be produced without CI (c1), and the repository needs its pre-publication pass (c2).

Close (d) and the P0 and P1 rows of (b), and take the (c) decisions. The remaining items are polish a beta can carry.
