# Design research: mixed teams, erasable ledgers, change and release, project documents, review ergonomics

*Research for the last major design stage, 2026-09-22. Scope: five topics named by the lead driver, landing in [kernel](../design/specs/kernel.md), [security](../design/specs/security.md), [runtime](../design/specs/runtime.md), [review-git](../design/specs/review-git.md), [integrations](../design/specs/integrations.md), [dashboard](../design/specs/dashboard.md), [planner-pm](../design/specs/planner-pm.md), [design-stage](../design/specs/design-stage.md) and [gates](../design/specs/gates.md). Written against [SPINE.md](../design/SPINE.md), [DECISIONS.md](../design/DECISIONS.md) and the specs as they stand on this date.*

**How to read the sources.** Every claim links its source. **[search]** means the claim comes from a search-engine summary and I did not open the primary page; **uncertain** means I could not verify it at all. Everything else was read on the primary page (official docs, the paper's abstract page, the PDF, or the repository through the GitHub API) on 2026-09-22. Licences and release dates were read from the GitHub API and the licence files on that date. Nothing here is added to the product without the owner's yes: every library or tool is a **proposal**.

**The main finding.** Three of the kernel changes already planned for v1 have not been built yet: hash chain v3 (NEW-kernel-1), the `principal` column (NEW-kernel-2) and the payload schema registry (K-S7-4). Together they fix the event envelope for the product's whole life. If they land as currently written, then:

- people's email addresses and message text go into an unsalted SHA-256 chain that can never be purged;
- the card's `assignee` stays a free string that mixes up "worker", "human" and a person's name;
- nothing records whether the Worker or a person built an attempt.

Each of these is cheap to change now and a migration of every row later. The table below lists them first.

---

## 1. What the design must decide now

| # | Decision | Recommendation | Evidence | Lands in | What breaks later if not decided |
|---|---|---|---|---|---|
| 1 | **Who is on a card** | Replace `assignee?: string` ("worker", "human", or a name) with three typed roles: **`owner`** (a principal id; the responsible person), **`delegate`** (`{kind: "worker" \| "person", id}`; who builds it), and **`accepter`** (a principal id, empty until the card is accepted). The board's Assignee filter reads the owner. `assignee:worker` becomes `delegate:worker`. | Linear: "The assignee remains responsible for the work, while the agent contributes on their behalf" ([Linear docs](https://linear.app/docs/assigning-issues)); delegating to an app "sets it as the `delegate`, not the `assignee`" ([Linear developers](https://linear.app/developers/agents)). Jira lets you put an agent in the assignee picker, but only the person who added it can drive it ([Atlassian](https://support.atlassian.com/jira-software-cloud/docs/collaborate-on-work-items-with-ai-agents/)). Code today: `assignee?: string` "worker, human, or a person's name" (`packages/kernel/src/types.ts:194`). | kernel (CardRecord, `card/created`, `card/updated`), integrations item 6, dashboard 2.4 | Every export mapping, the query language, sync with Linear, Jira and GitHub (their assignees are people), and every measurement that filters "Worker-built" would have to parse a free string, and history would stay ambiguous for good |
| 2 | **Who built each attempt** | Each attempt, and each checkpoint commit, records `builtBy: {kind: "worker" \| "person", id}`. A person-built card passes the **same** entry conditions (the `review` entry condition does not depend on who wrote the diff). Person-built attempts are **excluded** from the Worker's pass rate, competence model and playbook signals. | Kernel rule 21 already states the entry conditions without reference to the actor. review-git §7 already plans `card/human_edit` and `passed_with_human_edit`. GitHub lets a person "push commits directly to the branch" of an agent's PR ([GitHub docs](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/review-copilot-output)), so mixed authorship inside one change is normal. | kernel (AttemptRecord), gates (evidence bundle), measurement | Once people build cards, the Worker's measured record mixes human and model work with no way to separate it, and the frozen-suite comparison with live use loses its meaning |
| 3 | **Independent acceptance** | In company-server mode, the person who **built** a card may not accept it. Whether the **owner who delegated to the Worker** may accept is a project setting, `require_independent_accept`. It is off on a single machine; the default on a server is **the owner's choice**. | GitHub: "your approval of a Copilot pull request won't count toward the required number. Another reviewer must approve" ([GitHub docs](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/review-copilot-output)). Copilot cannot mark its PR ready, approve it or merge it (same source, and [search] for the last two). Since 2026-09-01 Copilot code review can approve, but only opt-in and limited to chosen paths ([GitHub changelog](https://github.blog/changelog/2026-09-01-copilot-code-review-can-now-approve-pull-requests/)). | review-git §2.4–2.5, integrations item 26 | Adding the rule after teams depend on self-accept is a change in permissions, and the `card/accepted` history cannot show whether earlier accepts were independent |
| 4 | **Review routing** | Each card gets **suggested accepters**, computed from the repository's `CODEOWNERS` matched against the card's declared scope, with the last matching pattern winning. A project may make a code owner's accept **required**. `review/opened` and `review/decided` carry the principal (already planned) so that review capacity can later be measured per person. | CODEOWNERS: "the last matching pattern takes the most precedence"; owners are requested automatically; "an approval from *any* of the owners is sufficient" ([GitHub docs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)). | review-git §2.2 and §2.4, integrations | The Review queue cannot route work in a team of more than one; a later per-person ReviewWIP needs the principal on every past review event |
| 5 | **The principal is an opaque id, not an email** | The `principal` column (NEW-kernel-2) stores a random, stable subject id (`p_…`). Name, email and avatar live in a `person/*` record whose personal fields can be erased (decision 6). Git trailers (`Accepted-by`) keep the name, as git authorship already does, and the privacy notice says so. | EDPB Guidelines 02/2025 v2.0 (adopted 2026-07-07): an unsalted or unkeyed hash "should, in general, not be considered sufficient"; the hash is itself personal data; a store whose integrity rests on a chain should keep personal data **off** it ([EDPB PDF](https://www.edpb.europa.eu/system/files/2026-07/edpb_guidelines_202502_blockchain_v2_en.pdf) ¶52, ¶103–104, ¶109). | kernel NEW-kernel-2 (not built) | K-N2-3 puts the principal inside the chain hash. If it is an email, erasing a person later means either rewriting the chain or keeping a guessable hash of their email for ever |
| 6 | **An erasable ledger: chain v3 commits to a salted "private" part** | Split each event into **`payload`** (structural fields; never personal; hashed as today) and **`private`** (personal data, free text, anything the secret scanner may miss). `private` is stored in a separate table `event_private(event_id, salt, body)`. The chain hash covers `commitment = SHA-256(salt ‖ canonical(private))`, with a 32-byte random salt per event. **Erasure** deletes the row and appends `ledger/erased {event_ids, fields, reason: "erasure" \| "secret" \| "retention", principal}`. Verification still passes. Payload-against-hash checks report "erased at seq N" instead of "corrupt". Projections read erased fields as a fixed marker. | The EDPB describes this exact pattern: "the unhashed data itself, as well as the secret key or the long random salt used, are stored confidentially off the chain … after deletion of the secret key or salt, the hash should not be linkable to the original data" (¶52); a perfectly hiding commitment "once the original data and its witness are deleted … is useless" (¶53). Event-sourcing practice calls it *Forgettable Payloads* ([Verraes, 2019-05-13](https://verraes.net/2019/05/eventsourcing-patterns-forgettable-payloads/)). The chain already hashes `payloadHash` rather than the payload (`log.ts:84-106`), so the change is small. | kernel NEW-kernel-1 (hash v3, not built), K-S7-4 | security item 34 says "the hash-chained ledger cannot be purged, so a secret must never reach it". A scanner false negative, or a person's name in a Seshat message, then becomes permanent. A **v4** formula would be needed, and every row written under v3 would stay unerasable |
| 7 | **The payload schema declares data classes** | The payload registry (K-S7-4) marks each field as `structural`, `personal`, `free_text` or `secret_bearing`. A write that puts a `personal` or `free_text` field into `payload` instead of `private` is refused. | Follows from 6. EDPB ¶102: erasure "must be complied with by design". | kernel K-S7-4 | Without the classes the split in 6 is a convention, and the first careless event type breaks it |
| 8 | **Spine wording for erasure** | Amend "anything a model saw can be reconstructed from it" to add: *except content erased by a recorded `ledger/erased` event; replay names each gap.* **Owner decision (spine).** | The two rules cannot both hold once erasure exists. The ICO expects erasure from live systems, with backups put "beyond use" ([ICO](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-erasure/)). | SPINE, kernel, runtime (replay) | Replay and `verifyProjections` would treat every erasure as corruption |
| 9 | **Backups and restore that respect erasure** | `sekhemet backup` uses the SQLite online backup API (`node:sqlite` `backup()`, built in). Set `PRAGMA secure_delete` before erasures. `sekhemet restore` re-applies every erasure recorded after the backup was taken, from an **erasure register** (event ids and reasons only, no personal data) kept beside the backups. Litestream is an optional proposal for continuous replication on a company server. | `backup(sourceDb, path)`: "Added in v23.8.0, v22.16.0" ([Node docs](https://nodejs.org/api/sqlite.html)). `secure_delete` "overwrites deleted content with zeros"; the `fast` setting leaves "forensic traces on freelist pages" ([SQLite pragma docs](https://www.sqlite.org/pragma.html)). Litestream: Apache-2.0, v0.5.17 (2026-08-31) ([GitHub](https://github.com/benbjohnson/litestream)). | runtime §Retention, security | Restoring an old backup silently brings back erased data and leaked secrets |
| 10 | **Export with no lock-in** | `sekhemet export --ledger` writes NDJSON: one event per line with `seq`, `hash`, `prevHash`, the commitment, and `private` unless `--no-private`. A standalone verifier script checks the chain offline. Each field is mapped to a CloudEvents 1.0 attribute (`id`, `source`, `type`, `time`, `subject`) so other tools can read the file. Projections and blobs are exported beside it. | GDPR Art. 20 portability expects a "structured, commonly used and machine-readable format" (the Regulation's wording; I did not re-fetch it). CloudEvents: a CNCF graduated project, spec licensed Apache-2.0 ([GitHub](https://github.com/cloudevents/spec)). | runtime, integrations | A team leaving Sekhemet keeps a SQLite file whose meaning lives only in our code |
| 11 | **Requirements are versioned; trace links carry the version** | Requirement ids are stable and never reused, like card keys. `requirement/revised` bumps a version. Each card→requirement and test→requirement link records the requirement **version** it was made against. A revision marks downstream links **suspect**: open cards pause, done cards and tests make the slice *unproven* until a person re-confirms or a change card is accepted. | Doorstop's links store "the parent item UID and the fingerprint of the parent"; a changed fingerprint makes the link *suspect* ([Doorstop docs](https://doorstop.readthedocs.io/en/latest/cli/validation.html), [search]). Developers with trace links did maintenance tasks faster and more correctly (Mäder & Egyed, EMSE 2015; 71 subjects, "24% better … 50% more correct" [search]). Traceability fails in practice on maintenance ([Ruiz et al., RE 2023](https://link.springer.com/article/10.1007/s00766-023-00408-9), [search]). | planner-pm §2.15 and P13 | P13 stores requirements as events but gives links no version, so impact analysis after a change is impossible for every link written before the fix |
| 12 | **Gate results name their source** | `GateResultRecord.source: "local" \| "external"`, with `externalRef {system, checkName, runUrl, headSha}`. This works now, so external CI can later be a gate source without a schema change. External results never replace a local blocking gate unless the project declares it. | DEC-23: "not a CI system". GitHub's combined status is "failure if any of the contexts report as error or failure … success if the latest status for all contexts is success" ([GitHub REST](https://docs.github.com/en/rest/commits/statuses)). integrations §7 lists "CI as a gate source" as later. | gates, integrations | Evidence bundles already on the ledger cannot say where a result came from, so the day CI results arrive they are either indistinguishable from local runs or need a migration |
| 13 | **A release is a ledger object tied to a slice** | `release/proposed {slice, version, changelog, notes}` and `release/tagged {tag, sha, principal}`. The version comes from the Conventional-Commit squashes: `0.y.z` bumps minor on a breaking change until the owner declares 1.0. The changelog uses Keep a Changelog categories. Release notes are written from the **requirements proven in the slice**, not from commits. The tag is what the team's CD reacts to; Sekhemet never deploys. | SemVer: "Major version zero (0.y.z) is for initial development. Anything MAY change at any time" ([semver.org](https://semver.org/spec/v2.0.0.html)). Conventional Commits: fix → PATCH, feat → MINOR, BREAKING CHANGE → MAJOR ([spec](https://www.conventionalcommits.org/en/v1.0.0/)). "Changelogs are *for humans*, not machines" ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/)). Code today: `nextVersion` bumps 0.y.z to 1.0.0 on a breaking change (`packages/sync/src/repo_tools.ts:44-50`). | planner-pm §2.15, review-git, integrations §7 | "A slice is done" and "a version is released" stay two unrelated facts, and release notes can only list commits |
| 14 | **Project documents live in the repository, generated from the ledger** | The ledger stays canonical (spine rule 2). On every accepted change to them, Sekhemet **exports** the brief, the requirements and the decision records as Markdown with YAML front matter into `docs/project/` (configurable): `brief.md`, `requirements.md` (EARS, one heading per id), `decisions/NNNN-title.md` (MADR 4.0). The files are committed through the Accept path. Edits people make to those files come **back as proposals** (as import does for Jira CSV) and are never applied silently. | Kiro writes `requirements.md`, `design.md` and `tasks.md` under `.kiro/specs/` ([Kiro docs](https://kiro.dev/docs/specs/); path [search]). Spec Kit keeps `spec.md`, `plan.md` and `tasks.md` in the repo (MIT; [GitHub](https://github.com/github/spec-kit)). Backlog.md: "every task is a plain `.md` file in your repo" (MIT; [GitHub](https://github.com/MrLesk/Backlog.md)). MADR 4.0: `docs/decisions/NNNN-title-with-dashes.md` with `status`, `date` and `decision-makers` front matter, MIT OR CC0 ([MADR](https://adr.github.io/madr/)). | design-stage §2.3, planner-pm | `.sekhemet/brief.md` today is written once, "never written over", and has no link to the requirement graph. A team cannot review requirements in a PR, and leaving Sekhemet loses the project's reasoning |
| 15 | **Nothing personal or secret is committable by accident** | `init`'s `.gitignore` block also covers `.sekhemet/evidence/`, `transcripts/`, `artifacts/`, `research/`, `observations/`, `traces*`, `live/`, `tuning/` and `queue_report.json`. Only `config.toml`, `gates.toml` and the exported documents are meant to be tracked. | `init.ts:348-355` ignores only `worktrees/`, `*.db`, `*.db-*`, `daemon.*` and `observations/`. Evidence bundles and transcripts, which can hold names, prompts and redaction misses, are left committable. Git history cannot be cleaned without rewriting every later hash, and forks keep the data ([GitHub docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)). | security S3c, runtime | One `git add -A` by a person publishes transcripts into history, which no erasure mechanism in the ledger can reach |
| 16 | **Review screen: evidence that forces a look without anchoring** | Order the Implementation files by risk (failures, then Reviewer-unmet hunks, then size), not alphabetically. Show the Reviewer's coverage (files it did not read) and an explicit list of lines no finding covers. Accept stays disabled until every *unmet* or *unclear* finding has been acknowledged and every Implementation file has been shown. Record reviewed lines and minutes per review. Details in §2.5. | Files shown last had "64% lower odds" of their defect being found ([Fregnan et al., ESEC/FSE 2022](https://arxiv.org/abs/2208.04259)). LLM-assisted reviewers "focus on the code locations indicated by the LLM rather than searching for additional issues" and did not find more high-severity issues ([arXiv 2411.11401](https://arxiv.org/abs/2411.11401)). Cognitive forcing "significantly reduced overreliance", but people rated those designs least favourably ([Buçinca et al., CSCW 2021](https://www.eecs.harvard.edu/~kgajos/papers/2021/bucinca2021trust.shtml)). | dashboard §2.5, review-git §2.1 | `review/opened` and `review/decided` are being specified now. Without per-file coverage in them, the measured review time behind ReviewWIP cannot tell a read from a rubber stamp |
| 17 | **Review rate as a recorded signal** | Record lines changed ÷ review minutes for every human decision. Flag, but never block, reviews faster than 500 lines an hour in Insights and in the ReviewWIP derivation. Keep the ≤200-line card as the review-size budget. | SmartBear's Cisco study: "no more than 200 to 400 lines of code (LOC) at a time", "under 500 LOC per hour" ([SmartBear](https://smartbear.com/learn/code-review/best-practices-for-peer-code-review/); vendor source). Usefulness of comments falls as the files in a change increase ([Bosu, Greiler & Bird, MSR 2015](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/bosu2015useful.pdf)). | review-git §2.2, measurement | ReviewWIP is computed from review minutes. If rubber-stamp minutes count the same as real reviews, back-pressure measures clicking, not reading |

**The owner must choose:** 3 (the self-accept default on a server), 8 (the spine wording), 14 (the export directory and whether exported docs are committed on the integration branch or on a docs branch), and the friction level in 16.

---

## 2. Findings by topic

### 2.1 Mixed human and AI teams

**How the platforms model a human owner plus an agent**

- **Linear.** An issue has a human **assignee** and a separate **delegate** (the agent). "Delegate an issue to an agent while keeping a human teammate as the assignee … The assignee remains responsible for the work" ([Linear docs](https://linear.app/docs/assigning-issues), undated, read 2026-09-22). Views can filter by *Assignee* or by *Agent*.
  - Implication: owner and delegate are two typed fields, both filterable. Our `assignee` string must become two fields (decision 1).
- **Linear agent sessions.** Sessions have six visible states: `pending`, `active`, `error`, `awaitingInput`, `complete`, `stale`. There are five activity types: `thought`, `action`, `elicitation`, `response`, `error`. An `elicitation` hands control to a person and moves the session to `awaitingInput` ([Linear developers](https://linear.app/developers/agent-interaction)).
  - Implication: a model-to-human handoff is a typed state, not a comment. Sekhemet already has the equivalents: the Worker's `ask` and a decision request (a question), and a parked card with a reason. The board should show *awaiting you* as the typed hold (NEW-kernel-3), not as free text.
- **Jira.** Agents are chosen from the assignee picker, by @mention, or triggered by a workflow transition or a board column. "Only the person who adds the agent as an assignee, or transitions a work item that triggers an agent, can interact with the agent directly." The output stays private in an *Agents* section until that person shares it ([Atlassian support](https://support.atlassian.com/jira-software-cloud/docs/collaborate-on-work-items-with-ai-agents/)). General availability for Cloud Standard, Premium and Enterprise came in May 2026 ([search]).
  - Implication: Jira puts the agent in the assignee slot but keeps a controlling person. When we export to Jira, the owner goes in Assignee and the delegate goes in a label or custom field; it is never "worker" as a user.
- **GitHub Copilot coding agent.** A person assigns an issue and Copilot opens a draft PR. The requester's own approval "won't count toward the required number. Another reviewer must approve." Workflows run only after "Approve and run workflows". You can iterate by `@copilot` comments or by pushing commits directly to the branch ([GitHub docs](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/review-copilot-output)). Copilot cannot mark its PR ready, approve or merge it ([search], same doc family). Since 2026-09-01 Copilot *code review* may approve, but only opt-in, path-limited, and dismissed on a new push like a human approval ([changelog](https://github.blog/changelog/2026-09-01-copilot-code-review-can-now-approve-pull-requests/)).
  - Implication: the market leader's rule is that **the requester of agent work is not an independent approver**. Sekhemet's "a person accepts" is weaker in a team if the owner who delegated may also accept (decision 3). The approval that is dismissed on a new push is our "what merges is what was reviewed" check (review-git §2.5.1), which is already right.
- **Devin.** It is started from Linear by assignment, by playbook labels (`!plan`, `!implement`) or by @mention. It posts live activity and syncs its to-do list to Linear's plan UI. Linked accounts let it "attribute sessions to the correct user" ([Devin docs](https://docs.devin.ai/integrations/linear)).
  - Implication: attribution to the triggering person is table stakes. The principal on machine-caused events (K-N2-5) covers it.

**Review routing and code owners**

- CODEOWNERS is read from `.github/`, then the root, then `docs/`. It uses gitignore syntax, and "the last matching pattern takes the most precedence". Owners are requested automatically (but not on drafts). Branch protection can require an owner's approval, and "an approval from *any* of the owners is sufficient" ([GitHub docs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)).
  - Implication: each card's declared scope is a file list, so suggested accepters can be computed before the card runs and shown on the tile. Reading the team's existing file costs nothing, and it is the rule their PRs already follow (decision 4).

**Handoff in both directions**

- Model to person, today: a decision request, a parked card with a reason, `rebase_conflict` outside scope (review-git §2.6.4), or the retry ladder exhausted. Person to model: send-back with a note, which goes into the dossier.
  - Implication: nothing new is needed for the model→person direction. The **person→model** direction for a card a person started (they wrote half, then delegate) needs `delegate` to change during the card's life. That is a `card/delegated {from, to}` event. The attempt that follows is `builtBy: worker` on a branch that already has human commits.
- The *person builds it* direction is new. A person takes a card, commits on its branch (in their own checkout or the card's worktree), and asks for Verify.
  - Implication: the gates, the Reviewer and the `review` entry condition run unchanged. The runner does not drive a Worker. The difference is only who is recorded as the builder (decision 2).

**The same gates on human work**

- Kernel rule 21 states the entry conditions with no reference to who wrote the diff, and DEC-02's "gates decide completion" is general.
  - Implication: human work gets no bypass except the recorded `override:` that already exists (rule 22). The design should say this explicitly, because the first team member to hit a flaky gate will ask.
- The frozen suite and the competence model measure the Worker.
  - Implication: human-built attempts must be excluded from `CompetenceEntry` and from pass-rate-by-model; otherwise routing (models spec) learns from people's work.

**WIP limits and flow metrics with mixed capacity**

- The Kanban Guide (May 2025) requires four flow metrics: WIP, Throughput, Work Item Age, Cycle Time ([Kanban Guide](https://kanbanguides.org/the-kanban-guide/), [search] for the exact wording). It does not split them by type of worker.
  - Implication: keep one WIP and one cycle time per column. Show a split by `delegate.kind` as a view, not as separate limits. In Review, human-built and Worker-built cards consume the same review minutes, so both count against ReviewWIP.
- **Agents produce more changes, and the review queue is the constraint.** AIDev covers 456,000+ agent PRs over 61,000 repositories. Agents outpace humans in submission speed ("one developer submitted as many PRs in three days as they had in three years"), but their PRs "are accepted less frequently" ([Li, Zhang & Hassan, arXiv 2507.15003, 2025-07-20](https://arxiv.org/abs/2507.15003)). A follow-up on 40,214 PRs (MSR '26) finds lower merge rates for agentic PRs and "contrasting effects" of review features between the two groups ([arXiv 2601.18749](https://arxiv.org/abs/2601.18749)). A 46.41% rejection rate for agent-made fixes is reported in [arXiv 2606.13468](https://arxiv.org/html/2606.13468) ([search]).
  - Implication: this directly supports spine rule 4. In a mixed team the per-project ReviewWIP must count **all** cards waiting on a person, and the notification budget (integrations 23a) must not multiply with agents.
- DORA 2025 (nearly 5,000 respondents): AI adoption now correlates with higher throughput **and** higher instability. Working in small batches and strong version control are among seven capabilities that amplify the benefit ([DORA 2025](https://dora.dev/dora-report-2025/), [search]).
  - Implication: this is independent support for the ≤200-line card and gate-first flow. Keep it as the product's argument to teams.

**What the board must store now (schema)**

- Card: `owner: PrincipalId`, `delegate: {kind, id} | null`, `suggestedAccepters: PrincipalId[]` (derived; can be a projection), `requiredAccepter?: PrincipalId | codeowner-rule`.
- Attempt and checkpoint: `builtBy: {kind: "worker" \| "person", id}`.
- Events: `card/delegated`, `card/owner_changed`. `review/opened` gets `{principal, filesShown[]}`; `review/decided` gets `{principal, decision, linesReviewed, minutes}`. `card/accepted` gets `{principal, independent: boolean}`.
- Implication: all of these are additive, and all are cheap before NEW-kernel-2 and P3 land; after that, they are migrations of every card row and every export format.

### 2.2 Erasure and governance of an append-only, hash-chained log

**What the code does today** (read 2026-09-22):

- `EventLog.computeHash` joins `prevHash, seq, actor, type, cardId, attemptId, stepId, payloadHash, id` (`packages/kernel/src/log.ts:84-106`). `payloadHash` is SHA-256 over the canonical JSON of the payload, **unsalted**.
- The chain covers the payload's hash, not its bytes. That is the property erasure needs, but an unsalted hash of a short payload (`{"name":"Jane Doe"}`) can be confirmed by guessing.
- Planned but not built: `created_at` and `principal` in the hash (NEW-kernel-1, NEW-kernel-2), triggers refusing `UPDATE`/`DELETE` (K-N1-2), and a payload schema registry (K-S7-4).
- Personal data that will be written: people's names and emails (principal), Seshat conversation text (`pm/message`), send-back notes, decision answers, issue bodies synced from GitHub, park reasons, and redaction misses in transcripts.

**The regulator's view**

- The EDPB guidelines on blockchain (v2.0, adopted 2026-07-07) apply to any store whose value is chain integrity ([PDF](https://www.edpb.europa.eu/system/files/2026-07/edpb_guidelines_202502_blockchain_v2_en.pdf)):
  - ¶51: "encrypted personal data is still personal data", and encryption "will be overtaken by time" if the chain is kept for ever.
  - ¶52: store only a **salted or keyed** hash on the chain, and keep the data and the salt off it. After the salt is deleted "the hash should not be linkable to the original data". "Unsalted or unkeyed hashes should, in general, not be considered sufficient."
  - ¶53: with a perfectly hiding commitment, once data and witness are deleted the commitment "is useless".
  - ¶102–104: erasure "must be complied with by design", and "it is therefore not advisable to register personal data in those forms [clear, encrypted or hashed] on a blockchain".
  - ¶50: "technical impossibility cannot be invoked to justify non-compliance with GDPR requirements" (citing the ChatGPT Taskforce report in its footnote 24).
  - Implication: the design for decision 6 is the regulator's own recommended pattern. Crypto-shredding alone (encrypt, then delete the key) is weaker in their reading.
- ICO: "you will have to take steps to ensure erasure from backup systems as well as live systems". Backups may be put "beyond use" until overwritten on a schedule. Exceptions include a legal obligation and "the establishment, exercise or defence of legal claims" ([ICO](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-erasure/)).
  - Implication: an **accept record** (who accepted which change) may plausibly be kept under an audit or legal basis while the person's messages are erased. The opaque principal id (decision 5) makes that split possible. We still make **no compliance claim** (SPINE): the product offers the mechanism, and the deploying company decides the basis.

**Event-sourcing practice**

- *Crypto-shredding*: per-subject keys, deleted to erase ([Verraes, 2019-05-13](https://verraes.net/2019/05/eventsourcing-patterns-throw-away-the-key/)). Its own caveats: "today's unbreakable encryption could be tomorrow's infosec disaster", backups keep ciphertext, and GDPR still treats ciphertext as personal data.
  - Implication: useful where the ciphertext is already spread (backups, exports). As the only mechanism it fails the EDPB reading.
- *Forgettable Payloads*: sensitive data sits in a separate store referenced by the event, and is deleted there ([Verraes](https://verraes.net/2019/05/eventsourcing-patterns-forgettable-payloads/)). The caveats are that it "breaks the concept of an Event Store" as the only source of truth, and that consumers' local copies are not reached.
  - Implication: in Sekhemet the separate store is a table in the same database and file, covered by the chain through its commitment. The ledger stays the one durable channel, and the only mutable part is deletion of `event_private` rows, recorded by an event. Consumers' copies are our own blobs, exports and git, which decisions 9, 10 and 15 cover.
- *Rewriting history* (git filter-repo style) changes every later hash. GitHub's own guidance is to "revoke and/or rotate that secret" first, and warns that forks and old clones keep the data ([GitHub docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)).
  - Implication: reject chain rewriting. It would also invalidate every `Ledger-Head` trailer already in git (kernel rule 11).

**Secrets that reach the log**

- security item 34 redacts before persisting, but a scanner has false negatives.
  - Implication: the response to a leak has three steps: **(1)** tell the person to rotate the secret (the only real fix; GitHub's rule); **(2)** erase the `private` part of the affected events with `reason: "secret"`; **(3)** remove the blobs (context packs, transcripts) that contain it. Blobs are content-addressed and already deletable (kernel rule 15). The evidence bundle's retained diff and gate excerpts are the hard case: evidence is "never pruned" (runtime item 33), so bundles need the same public/private split or a redact-and-rehash with a recorded mapping.

**Physical deletion in SQLite**

- `PRAGMA secure_delete` "overwrites deleted content with zeros". It is normally off by default, `fast` leaves traces on freelist pages, and FTS shadow tables can keep traces ([SQLite](https://www.sqlite.org/pragma.html)).
  - Implication: an erasure must run with `secure_delete=ON`, then checkpoint the WAL (`wal_checkpoint(TRUNCATE)`), and must say that old WAL frames and the OS's own copies are outside its reach.

**Backups and point-in-time restore**

- `node:sqlite` has `backup(sourceDb, path[, options])` (added in v23.8.0 and v22.16.0; the module is *release candidate* as of v25.7.0) ([Node docs](https://nodejs.org/api/sqlite.html)). It needs no dependency.
  - Implication: `sekhemet backup` and the air-gap kit can use it now.
- Litestream is Apache-2.0, 14.4k stars, last push 2026-09-21, v0.5.17 released 2026-08-31, three releases in six weeks. It streams WAL changes to a file or S3 target and restores to a point in time. It adds a `_litestream_lock` table to the source database ([GitHub](https://github.com/benbjohnson/litestream)).
  - Implication: a good **optional** company-server companion (proposal). It is a separate Go binary run beside the server, not a library. It keeps old WAL segments, so its retention setting **is** the backup-erasure window, and the privacy notice must name it.
- Restore versus erasure: restoring to a point before an erasure brings the data back.
  - Implication: the erasure register (decision 9) must be outside the backup set and re-applied on restore. It holds only event ids and reasons. It is a copy of ledger facts, not a second source of truth. This is a spine-adjacent point for the owner.

**Export and portability**

- CloudEvents 1.0.2 is the stable spec (2022-02-05), CNCF graduated on 2024-01-25 ([search] for both dates), and the spec repository is Apache-2.0 ([GitHub API](https://github.com/cloudevents/spec)).
  - Implication: map our envelope to CloudEvents attributes in the NDJSON export. No SDK is needed; it is a documented field mapping.

**Retention**

- runtime item 33 prunes context packs, masked observations and transcripts 30 days after close. It keeps the ledger and evidence for ever.
  - Implication: "for ever" should be **per data class**. Keep `structural` fields and commitments indefinitely. Give `private` fields a project retention (default: kept, because the team is the controller; configurable, e.g. 24 months), enforced by `ledger/erased {reason: "retention"}` events.

### 2.3 Change and release

**Traceability and impact analysis**

- Doorstop links store the parent's UID and fingerprint. A changed parent makes the link *suspect* until someone reviews it (`doorstop clear`) ([Doorstop docs](https://doorstop.readthedocs.io/en/latest/cli/validation.html), [search]). Doorstop is LGPL-3.0 and Python.
  - Implication: adopt the **pattern**, not the tool. Our links are ledger events, so a "fingerprint" is the requirement's version number.
- Controlled experiment: developers with maintained trace links performed maintenance tasks "24% better" and with "50% more correct solutions" (Mäder & Egyed, EMSE 2015, 71 subjects; [Springer](https://link.springer.com/article/10.1007/s10664-014-9314-z); numbers via [arXiv 2108.02133](https://arxiv.org/pdf/2108.02133) [search]).
  - Implication: impact analysis is the benefit, and it needs links that are **maintained**, which is exactly what the suspect mechanism enforces.
- Why teams do not trace: collaboration across tool boundaries, conveying the benefit, and **maintenance** ([Ruiz, Hu & Dalpiaz, RE 2023](https://link.springer.com/article/10.1007/s00766-023-00408-9), [search]). An industrial report found requirement-to-test links simply missing ([arXiv 2206.04462](https://arxiv.org/abs/2206.04462)).
  - Implication: links must be created by the machine as a side effect (the planner writes card→requirement; red-first staging writes test→requirement) and never by a person filling a matrix.
- Impact analysis over requirement → card → test:
  - WHEN a requirement changes, its open cards pause (as an external scope edit does today, INT-33).
  - Its done cards and tests become suspect, and the slice becomes *unproven* (P13 already has "mark it unproven again" for a failing test).
  - Seshat proposes change cards for the suspect done work.
  - Implication: the graph needs versioned requirements and stable **test ids** (file plus test name) in the evidence bundle.

**Semantic versioning and changelogs**

- SemVer 2.0.0: "MUST declare a public API"; "Major version zero (0.y.z) is for initial development. Anything MAY change at any time"; major increments for backward-incompatible changes to the public API. The spec is CC BY 3.0 ([semver.org](https://semver.org/spec/v2.0.0.html)).
  - Implication: Sekhemet's squash commits are already Conventional Commits (review-git §2.5.4), so the bump is computable. The code's `nextVersion` jumps `0.y.z` to `1.0.0` on a breaking change, which contradicts rule 4's intent. release-please offers a `bump-minor-pre-major` option for this ([search]). 1.0 should be a person's decision.
- Conventional Commits 1.0.0 (CC BY 3.0): fix → PATCH, feat → MINOR, BREAKING CHANGE → MAJOR ([spec](https://www.conventionalcommits.org/en/v1.0.0/)).
- Keep a Changelog 1.1.0 (MIT): "Changelogs are for humans, not machines". It uses the categories Added, Changed, Deprecated, Removed, Fixed and Security, keeps an *Unreleased* section at the top, and argues against dumping git logs ([keepachangelog.com](https://keepachangelog.com/en/1.1.0/)).
  - Implication: generate the **changelog** from commits grouped into Keep a Changelog categories. Write the **release notes** for people from the slice's proven requirements, in the brief's words: "You can now … ". These are two different documents.
- Tools (all checked 2026-09-22):
  - git-cliff: MIT OR Apache-2.0, v2.14.2 (2026-09-18). Local and offline, template-driven. **Already used optionally** by `planRelease` when installed.
  - release-please: Apache-2.0, v17.11.2 (2026-08-24). Keeps a release PR updated and creates GitHub Releases; it "primarily runs as a GitHub Action", with a CLI that still talks to the GitHub API ([README](https://github.com/googleapis/release-please)).
  - changesets: MIT, active (2026-09-14). Each contributor writes an intent file with a bump type, and it is monorepo-focused ([README](https://github.com/changesets/changesets)).
  - semantic-release: MIT, active. It publishes from CI.
  - Implication: keep the built-in grouping plus optional git-cliff (no new dependency). Reject release-please and semantic-release as dependencies (GitHub- or CI-bound, against offline by default), but interoperate with them: if a team already runs release-please, Sekhemet's Conventional-Commit squashes feed it unchanged. Changesets' intent file is conceptually what our card already is. Reject it as a second source of intent.

**Handing off to the team's CI/CD**

- DEC-23 says "not a CI system". GitHub's combined commit status is the simple read of a ref's CI verdict ([REST docs](https://docs.github.com/en/rest/commits/statuses)), and check runs are the richer API that integrations already writes (item 14).
  - Implication: the handoff is by artefact. Sekhemet produces the merge or PR, the Conventional-Commit message, the tag and the release notes; the team's CI tests and deploys. Reading CI back as evidence is later, but the gate-result `source` field is needed now (decision 12). An external result is **advisory** unless the project names it a blocking gate, and it must name the exact `headSha` it ran on (the "what merges is what was reviewed" rule).
- `act` (MIT) runs GitHub workflows locally and is already referenced by `sekhemet dev ci` (integrations §7).

### 2.4 Where project documents live

- **Kiro** writes `requirements.md` (EARS), `design.md` and `tasks.md` per spec, with task status tracked in `tasks.md` ([Kiro docs, updated 2026-08-27](https://kiro.dev/docs/specs/)). Its folder is `.kiro/specs/` and can be committed ([search]).
- **Spec Kit** (MIT, 138k stars, pushed 2026-09-23) keeps a constitution plus `spec.md`, `plan.md` and `tasks.md` per feature in the repository ([GitHub](https://github.com/github/spec-kit)).
- **Backlog.md** (MIT) keeps one Markdown file per task with IDs such as `TASK-1`, "a permanent record … legible to you, your team, and the next agent" ([GitHub](https://github.com/MrLesk/Backlog.md)).
- **MADR 4.0.0** (2024-09-17; MIT OR CC0) keeps decisions in `docs/decisions/NNNN-title-with-dashes.md`. Its sections are Context and Problem Statement, Decision Drivers, Considered Options, Decision Outcome, Consequences and Confirmation, with front matter `status` (proposed, accepted, deprecated, superseded by …), `date` and `decision-makers` ([MADR](https://adr.github.io/madr/)). `adr-tools` is **GPL-3.0** (read from its LICENSE.txt), so use the format and do not bundle the tool.
  - Implication, all four: the category has converged on **Markdown in the repo, reviewed in PRs**. A team adopting Sekhemet expects to see its brief and requirements in git, and to keep them if it leaves.
- **The spine constraint.** The ledger is the only durable channel, so files cannot be a second source of truth.
  - Implication: the **sync direction is ledger → files** (generated, with a header line *Generated by Sekhemet from ledger seq N; edit through Seshat or by PR*). **Files → ledger is by proposal**: an edited `requirements.md` in a merged PR is parsed and diffed against the ledger's requirements, and each difference becomes a PM proposal (the same path as Jira import, integrations item 18). An accepted proposal emits `requirement/revised`, which triggers impact analysis (2.3). The drift is visible and nothing is silent.
- Formats:
  - `requirements.md`: one `### REQ-7 — title` heading per requirement. The front-matter-like line under it carries `version`, `kano`, `must`, `slice` and `dependsOn`, then its EARS criteria, then the test ids that prove it (generated). EARS is already the project's criterion style and Kiro's.
  - `decisions/NNNN-*.md`: MADR 4.0, with `status` and `date` from the ledger's decision records, and `decision-makers` as display names **resolved at export time**. That keeps personal names out of the ledger's structural part (decision 5), but puts them in git; the export should allow `--no-names`.
  - `brief.md`: the sections of design-stage §2.3, unchanged.
- Where: `docs/project/` by default (configurable), **not** `.sekhemet/` (tooling state, partly ignored). Today `.sekhemet/brief.md` is committable but written once ("never written over an existing one").
  - Implication: the brief becomes a generated view that is updated on every accepted change.

### 2.5 Review ergonomics for AI-written code

**Automation bias and over-trust**

- Complacency and automation bias appear in naive and expert users, "cannot be overcome with simple practice", and are driven by attention under multi-task load (Parasuraman & Manzey, *Human Factors* 52(3), 2010; [SAGE](https://journals.sagepub.com/doi/10.1177/0018720810376055), [search]).
  - Implication: a person reviewing the fifth card of the day while doing other work is exactly the condition. Design for it; do not rely on training.
- AI-assistant users wrote less secure code and were **more** likely to believe it was secure (Perry et al., CCS 2023; [arXiv 2211.03622](https://arxiv.org/abs/2211.03622), [search]). METR's 2025 RCT: 16 experienced developers were 19% slower with AI tools while believing they were 20% faster ([METR, 2025-07-10](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/), [search]).
  - Implication: self-reported confidence is not evidence. The Review screen shows gate results and criteria verdicts, and never a model's statement of confidence. This matches DEC-11's "reasoning is not evidence".
- LLM-assisted code review (29 professionals, 72 reviews): reviewers "consider valid most of the issues automatically identified". They "focus on the code locations indicated by the LLM rather than searching for additional issues", and found more low-severity but **not** more high-severity issues, with no time saved and no gain in confidence ([arXiv 2411.11401](https://arxiv.org/abs/2411.11401), 2024-11).
  - Implication: the Reviewer's findings, shown first (review-git §2.1), will **narrow** where the person looks. Two responses: show the Reviewer's *coverage* (files and hunks it did not read, and lines no finding touches), and order files by risk so the person's pass covers what the Reviewer did not.
- Existing review comments do **not** bias reviewers negatively. A comment about an unusual bug type made reviewers more likely to find another of that type: comments act as "positive reminders" ([Spadini, Çalikli & Bacchelli, ICSE 2020](https://research.tudelft.nl/en/publications/primers-or-reminders-the-effects-of-existing-review-comments-on-c/), [search]; 85 developers).
  - Implication: this goes against the previous finding. Showing findings is fine, **provided** they name the bug *class* and the person is still led through the rest. Keep the findings first, but make them reminders ("criterion 2 unmet: no test exercises the empty-input case"), not verdicts.
- Explanations: in a 34-person within-subjects study, detailed explanations raised perceived trust (3.99 of 5), moderate ones gave the highest agreement with the AI (89.22%), and review time did not change ([arXiv 2607.24601](https://arxiv.org/abs/2607.24601), 2026-07). Buçinca et al.: "Adding explanations … does not appear to reduce the overreliance and some studies suggest that it might even increase it". **Cognitive forcing** reduced over-reliance significantly, but "people assigned the least favorable subjective ratings to the designs that reduced the overreliance the most" ([CSCW 2021](https://www.eecs.harvard.edu/~kgajos/papers/2021/bucinca2021trust.shtml)).
  - Implication: higher agreement is not higher accuracy. More prose from the Reviewer will raise trust without raising correctness. Keep `ReviewFinding.note` to one sentence (as specified) and add a **light forcing function**: acknowledging each unmet or unclear finding, and each Implementation file shown once. People will dislike it a little, which is why it is the owner's call (decision 16).

**Review speed, size and defect detection**

- SmartBear's Cisco study: review no more than 200 to 400 lines at a time, inspect at under 500 lines an hour, and keep sessions to about 60 minutes; SmartBear claims 70–90% defect discovery under those conditions ([SmartBear](https://smartbear.com/learn/code-review/best-practices-for-peer-code-review/)). This is a vendor page; the underlying numbers are 2006-era and industrial (**uncertain** beyond the page).
  - Implication: the ≤200-line card is inside the band. The 500 LOC/hour rate gives a principled "too fast" flag (decision 17).
- Microsoft (Bosu, Greiler & Bird, MSR 2015): "as number of files in the change increases, the proportion of comments that are useful drops … reviewers may opt for cursory review of large changesets" ([PDF, read](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/bosu2015useful.pdf)).
  - Implication: the 1–3 file limit is justified independently of the Worker's context budget.
- Google (Sadowski et al., ICSE-SEIP 2018): most changes are small with one reviewer, and 70% are committed within 24 hours of being sent for review ([ACM](https://dl.acm.org/doi/10.1145/3183519.3183525), [search]).
  - Implication: small changes and quick turnaround are the norm teams already know. The amber "waiting 2h" badge (dashboard 2.4) is in line with it.
- File order matters: files shown first get more comments, and in an experiment (106 participants) a defect in the last file had "64% lower odds" of being found ([Fregnan et al., ESEC/FSE 2022](https://arxiv.org/abs/2208.04259)).
  - Implication: never order files alphabetically. Put the files that contain failures, Reviewer-unmet hunks and the largest in-scope change first. Keep *Acceptance tests* collapsed but put a one-line summary of what they assert above the implementation.
- Test-driven review (reading tests first) found the same share of production defects and more test defects, at the cost of fewer maintainability remarks (Spadini et al., ICSE 2019, 93 developers; [search]).
  - Implication: Sekhemet's acceptance tests are staged by the harness, not the Worker, so reviewing them first adds little. Keep them collapsed, as the dashboard spec says.

**Checklists**

- Checklist-based and guided-checklist review were tested against ad hoc review (70 developers). Effectiveness was low under every treatment, and no strong improvement was shown (Gonçalves et al., EMSE 2022; [search]; [Springer](https://link.springer.com/article/10.1007/s10664-022-10123-8)). SmartBear recommends checklists of the team's recurring mistakes (vendor).
  - Implication: do not add a generic checklist to Accept. The useful "checklist" is **card-specific**: the card's acceptance criteria with the Reviewer's verdicts (already specified), plus the project's approved playbook rules as reminders. That is a checklist generated from the team's own send-backs, which is what SmartBear's advice amounts to.

**What the Review screen and Accept must do** (the recommendation behind decisions 16 and 17)

1. Findings first, as reminders tied to a criterion and a `file:line`, with a **coverage line**: *Reviewer read 3 of 3 files; 41 of 58 changed lines are cited by no finding.*
2. Files ordered by risk, never alphabetically. Each Implementation file shows a *seen* mark once it has been on screen.
3. Accept is enabled only when:
   - every blocking gate passed (as today);
   - every `unmet` or `unclear` finding is acknowledged (one key each);
   - every Implementation file has been shown.

   The disabled reason is written beside the button (as today).
4. Send-back quick notes come from the failures and the unmet findings (as today).
5. Record `review/opened {filesShown}` and `review/decided {linesReviewed, minutes, acknowledgedFindings}`.
6. Insights shows review rate. Decisions faster than 500 changed lines an hour are marked *fast review* and reported separately in the ReviewWIP derivation. They are never blocked.
7. Never show a model's confidence or a model's claim that the change is complete.
8. For a person-built card, the same screen shows *Built by Jane (person)*, and self-accept is refused when independent accept is required.

---

## 3. Proposed requirements (EARS), by spec

### kernel.md

- **K-T1** WHEN a card is created THE SYSTEM SHALL record an `owner` principal id and a `delegate` of kind `worker`, `person` or none, and SHALL refuse a `delegate.kind` outside that set.
- **K-T2** WHEN a card's delegate changes THE SYSTEM SHALL append `card/delegated {from, to}` naming the principal who made the change.
- **K-T3** WHEN an attempt or checkpoint is recorded THE SYSTEM SHALL record `builtBy {kind, id}`; WHEN `builtBy.kind` is `person` THE SYSTEM SHALL exclude that attempt from `CompetenceEntry` and from pass rate by model.
- **K-T4** WHEN a person-built card requests entry to `review` THE SYSTEM SHALL apply the same entry conditions as for a Worker-built card, and a failing blocking gate SHALL refuse the move without an `override:` reason.
- **K-E1** WHEN an event is appended to a principal THE SYSTEM SHALL store an opaque principal id, and SHALL NOT store an email address or name in the `principal` column or in any `structural` payload field.
- **K-E2** WHEN an event type's payload schema marks a field `personal`, `free_text` or `secret_bearing` THE SYSTEM SHALL store that field only in the event's `private` part, and SHALL refuse a write that places it in `payload`.
- **K-E3** WHEN an event with a `private` part is appended THE SYSTEM SHALL draw a fresh 32-byte random salt, store the salt and the private body in `event_private`, and include `SHA-256(salt ‖ canonical(private))` in the chain hash (hash v3).
- **K-E4** WHEN a person holding the Accept permission erases events for a subject or a secret THE SYSTEM SHALL delete their `event_private` rows with `secure_delete` on, append `ledger/erased {eventIds, fields, reason, principal}` in the same transaction, and checkpoint the WAL.
- **K-E5** WHEN the chain is verified after an erasure THE SYSTEM SHALL report `valid: true`, and SHALL list each erased event as "erased at seq N by `ledger/erased` seq M" rather than as corrupt.
- **K-E6** WHEN projections are rebuilt after an erasure THE SYSTEM SHALL produce projections identical to those maintained live, with each erased field shown as the erased marker.
- **K-E7** WHEN a `private` row is altered but not deleted THE SYSTEM SHALL report the chain invalid at that event's `seq`.
- **K-R1** WHEN a requirement is revised THE SYSTEM SHALL append `requirement/revised {id, version}` and SHALL mark every card→requirement and test→requirement link made against an earlier version as suspect.
- **K-R2** WHEN a link is suspect THE SYSTEM SHALL keep it suspect until a principal re-confirms it (`trace/confirmed`) or the linked card is superseded, and SHALL NOT reuse a requirement id.

### security.md

- **SEC-T1** WHEN `sekhemet init` writes `.gitignore` THE SYSTEM SHALL ignore `.sekhemet/evidence/`, `transcripts/`, `artifacts/`, `research/`, `observations/`, `live/`, `tuning/`, `traces*` and `queue_report.json`.
- **SEC-T2** WHEN a secret is found in the ledger after the fact THE SYSTEM SHALL tell the person to rotate it first, then erase the affected `private` fields with `reason: "secret"` and delete every blob that contains it.
- **SEC-T3** WHEN an evidence bundle is stored THE SYSTEM SHALL keep gate excerpts and command lines in an erasable part whose commitment the bundle id covers, so that a secret in an excerpt can be erased without changing the bundle's identity.

### runtime.md

- **RUN-T1** WHEN `sekhemet backup <path>` runs THE SYSTEM SHALL write a consistent copy of the ledger with the SQLite online backup API while writers continue, and record `ledger/backed_up {path, seq}`.
- **RUN-T2** WHEN a backup is restored THE SYSTEM SHALL re-apply every erasure in the erasure register newer than the backup's `seq` before the server accepts requests, and SHALL refuse to start if the register is missing and erasures are known to exist.
- **RUN-T3** WHEN a project's retention for `private` fields elapses for closed cards THE SYSTEM SHALL erase them with `reason: "retention"`, and SHALL keep structural fields and commitments.
- **RUN-T4** WHEN `sekhemet export --ledger` runs THE SYSTEM SHALL write NDJSON with every event's `seq`, `hash`, `prevHash`, commitment and CloudEvents-mapped attributes, and a verifier run on that file alone SHALL reproduce the chain verdict.
- **RUN-T5** WHEN `--no-private` is given THE SYSTEM SHALL omit every `private` part, and the exported chain SHALL still verify.

### review-git.md

- **RG-T1** WHEN independent accept is required and the principal accepting built the card (or, where the setting says so, owns the card that was delegated to the Worker) THE SYSTEM SHALL refuse with a message naming who may accept.
- **RG-T2** WHEN a card is created with a declared scope and the repository has a `CODEOWNERS` file THE SYSTEM SHALL compute suggested accepters from the last matching pattern for each file in scope.
- **RG-T3** WHEN a project requires code-owner acceptance THE SYSTEM SHALL refuse an accept by a principal who owns none of the card's files.
- **RG-T4** WHEN a person opens a card in Review THE SYSTEM SHALL record `review/opened` with the files shown; WHEN they decide THE SYSTEM SHALL record lines reviewed, minutes and acknowledged findings.
- **RG-T5** WHEN ReviewWIP is computed THE SYSTEM SHALL count Worker-built and person-built cards alike, and SHALL report decisions faster than 500 changed lines an hour separately.
- **RG-T6** WHEN a release is proposed for a slice THE SYSTEM SHALL compute the version from the Conventional-Commit squashes since the last tag, bumping minor (not major) for a breaking change while the version is `0.y.z`, and SHALL tag only on a person's confirmation.

### dashboard.md

- **DB-T1** WHEN a tile is shown THE SYSTEM SHALL show the owner's avatar and, while a delegate is set, the delegate's badge (W for Worker, initials for a person).
- **DB-T2** WHEN the query `delegate:worker` or `owner:@me` is entered THE SYSTEM SHALL filter by those fields; `assignee:` SHALL mean the owner.
- **DB-T3** WHEN a card's diff is shown in Review THE SYSTEM SHALL order Implementation files by failures, then Reviewer-unmet hunks, then changed lines, and SHALL NOT order them alphabetically.
- **DB-T4** WHEN Reviewer findings are shown THE SYSTEM SHALL show the Reviewer's coverage: files not read, and changed lines cited by no finding.
- **DB-T5** WHEN any `unmet` or `unclear` finding is unacknowledged, or any Implementation file has not been shown, THE SYSTEM SHALL keep Accept disabled and write which remain beside the button.
- **DB-T6** WHEN a card is person-built THE SYSTEM SHALL say so in the outcome line and in Facts.

### integrations.md

- **INT-T1** WHEN a card is exported to or synced with Jira, Linear or GitHub THE SYSTEM SHALL map `owner` to the assignee and the delegate to the tool's agent field, or to a label where none exists, and SHALL never write "worker" as a user.
- **INT-T2** WHEN a gate result comes from an external CI check THE SYSTEM SHALL record `source: external` with the check name, run URL and head sha, and SHALL treat it as advisory unless the project declares it blocking.
- **INT-T3** WHEN an external result's head sha differs from the card branch head THE SYSTEM SHALL NOT count it as evidence for that card.

### planner-pm.md

- **PM-T1** WHEN a requirement is revised THE SYSTEM SHALL pause the open cards that trace to it, mark its slice unproven if any done card or test link is now suspect, and have Seshat propose a change card for each suspect done card.
- **PM-T2** WHEN a slice is accepted THE SYSTEM SHALL propose a release whose notes list the slice's proven requirements in the brief's words, and whose changelog groups the squashes into Added, Changed, Deprecated, Removed, Fixed and Security.
- **PM-T3** WHEN a model's message asserts that a release is ready while a must-have requirement is unproven THE SYSTEM SHALL not propose the release.

### design-stage.md

- **DS-T1** WHEN the brief, a requirement or a decision record is accepted or revised THE SYSTEM SHALL regenerate `docs/project/brief.md`, `requirements.md` and `decisions/NNNN-*.md` (MADR 4.0), each headed with the ledger `seq` it was generated from, and commit them through the Accept path.
- **DS-T2** WHEN a merged commit changes a generated project document THE SYSTEM SHALL parse it, diff it against the ledger, and create one PM proposal per difference; it SHALL NOT change the ledger until a person applies a proposal.
- **DS-T3** WHEN documents are exported with `--no-names` THE SYSTEM SHALL write role labels instead of people's names.

---

## 4. Proposals (libraries and tools), with licences

All were checked 2026-09-22 through the GitHub API and the licence files. **None may be added without the owner's yes.**

| Tool | Licence (verified) | Maintenance | What it adds or replaces | Recommendation |
|---|---|---|---|---|
| Litestream | Apache-2.0 | v0.5.17 on 2026-08-31, three releases in six weeks; 14.4k stars; pushed 2026-09-21 | Continuous WAL replication and point-in-time restore for the company server; a separate Go binary, not an npm dependency | **Proposal**, optional for the company server. Single machine: `node:sqlite` `backup()` (built in) is enough. Its retention setting must be the declared backup-erasure window |
| git-cliff | MIT OR Apache-2.0 | v2.14.2 on 2026-09-18 | Template changelog from Conventional Commits, offline | Already used optionally when installed (`repo_tools.ts:92`). Keep as optional; no change |
| release-please | Apache-2.0 | v17.11.2 on 2026-08-24 | Release PRs and GitHub Releases | **Not proposed** as a dependency (GitHub-bound). Interoperate: our squashes feed it unchanged |
| changesets | MIT | active, 2026-09-14 | Per-change intent files, monorepo versioning | **Not proposed**: a second source of intent beside the card |
| semantic-release | MIT | active | Publishes from CI | **Not proposed**: it publishes; Sekhemet never deploys |
| MADR 4.0.0 (template) | MIT OR CC0-1.0 | 4.0.0 on 2024-09-17; repo pushed 2026-08-28 | The decision-record file format | **Proposal**: adopt the format (text only, no code) |
| adr-tools | GPL-3.0 | last push 2024-04-25 | CLI for ADRs | **Reject**: copyleft and dormant; the format needs no tool |
| CloudEvents spec | Apache-2.0 | active, graduated CNCF | Envelope vocabulary for the NDJSON export | **Proposal**: a field mapping only, no SDK |
| Doorstop | LGPL-3.0 (Python) | active | Requirements as YAML files with suspect links | Pattern only; do not add |
| StrictDoc | Apache-2.0 (Python) | active | Requirements documents and traceability | Pattern only; do not add |
| OpenFastTrace | GPL-3.0 (Java) | active | Tracing requirements to code and tests | **Reject** (copyleft, Java) |
| sphinx-needs | MIT (Sphinx) | active | Requirements in Sphinx docs | Not relevant to a TypeScript toolchain |
| Spec Kit, Backlog.md | MIT | very active | Specs and tasks as Markdown in the repo | Format references only |
| nektos/act | MIT | pushed 2026-08-09 | Runs GitHub workflows locally | Already referenced (`sekhemet dev ci`); no change |
| CODEOWNERS matching | — | — | gitignore-syntax matching for decision 4 | Hand-written with tests against GitHub's documented rules. I did not verify a maintained npm matcher's licence, so none is proposed |

---

## 5. Later, with reasons

- **Per-person ReviewWIP and review assignment by load.** v1 computes ReviewWIP per project (S6). Per-person capacity needs the principal on `review/*` events, which decision 4 records now, so it can be derived later without migration.
- **Crypto-shredding of backups and exports.** Deleting the `private` rows plus a declared backup window (the ICO's "beyond use") covers v1. Per-subject keys add a key-management system the product does not otherwise need, and the EDPB treats ciphertext as still personal data. Reopen if a customer needs exports that can be revoked after they leave the machine.
- **External timestamping or signing of the chain head.** The kernel already defers this to compliance use, which is not v1.
- **Reading CI results as blocking gates.** The schema field is needed now (decision 12); the behaviour (webhooks for `check_suite`, mapping of required checks) comes with the integrations workstream after v1.
- **Publishing GitHub Releases and release notes to Slack or Notion.** A tag plus notes in the repository is the v1 handoff.
- **Two-way live editing of project documents.** v1 is export plus proposals on merge (DS-T1, DS-T2). A live editor would make files a second writer, against spine rule 2.
- **Partial accept and human edits inside a Worker card** (review-git §7). Decision 2's `builtBy` per checkpoint is the schema that makes them measurable later.
- **A calibrated friction level for Accept** (for example, requiring a scroll through every hunk). Decision 16 starts light because Buçinca et al. found the strongest forcing designs the least liked. Measure the send-back rate on accepted-then-reverted cards before tightening it.
- **Uncertainty highlighting in diffs** (marking tokens the model was unsure of). It is promising in the HCI literature but **uncertain** here: a local model's token probabilities are not logged today, and I did not verify a code-review study of it.

---

## Sources not opened (search only), collected

These back numbers in this document and should be re-read before any of them is quoted in a spec:

- Mäder & Egyed 24% / 50% / 71 subjects
- Ruiz et al. 2023
- DORA 2025
- The Kanban Guide wording
- Jira GA date
- The 46.41% rejection figure (arXiv 2606.13468)
- Parasuraman & Manzey
- Perry et al.
- METR
- Sadowski et al. 70% within 24 h
- Spadini ICSE 2019 and 2020
- Gonçalves et al. EMSE 2022
- Kiro's `.kiro/specs/` path
- Doorstop suspect links
- CloudEvents dates
- release-please `bump-minor-pre-major`
