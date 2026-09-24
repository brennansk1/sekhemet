# Project Manager and team practices: backend contract

Status: agreed contract between the backend and the dashboard. The backend
implements every endpoint here; the UI builds against these shapes. Change this
file first if a shape must change. Behaviour is specified in
[planner-pm](specs/planner-pm.md), [dashboard](specs/dashboard.md) and
[integrations](specs/integrations.md); this file holds the HTTP shapes only.

## 0. Design v3: shapes that are current, and the target each moves to

The shapes below are what the code serves today. Design v3 changes several;
each moves in the workstream of the change that carries it, and this file is
updated in the same commit.

| Shape (section) | Today | Target | Change |
|---|---|---|---|
| `assignee` (§2) | `"worker" \| "human" \| string` | `owner` (a person), `delegate` (the Worker or a person), `accepter` | NEW-kernel-6 |
| `externalRef.system` (§2) | `"github" \| "forgejo"` | adds `"jira"`, `"linear"` | [integrations](specs/integrations.md) item 8 |
| Mutation guard (§3) | `X-Sekhemet-Action: 1` header | a per-session token | S3c |
| `/api/metrics/flow` `cfd` keys (§3) | `backlog, ready, working, checking, review, done` | the stored states (`in_progress`, `verify`) — *Working* and *Checking* are retired names ([NAMING](NAMING.md)) | NEW-dashboard-2 |
| PM with no runner (§4) | the server loads the manager model directly | through the residency scheduler only | NEW-models-9 |
| Slack webhook URL (§5) | `~/.config/sekhemet/…` | the one user directory, `~/.sekhemet/` | NEW-surface-1 |
| Rule lifecycle (§6) | approval, then helpful/harmful counts on first attempts; proposed for retirement at 3 more harmful than helpful | [DECISIONS](DECISIONS.md) DEC-28: approval, then paired credit on this project's attempt records, with rotation; **retired automatically** only at the fixed looks after 20, 40 and 80 pairs, when a one-sided exact test on the discordant pairs shows harm at 0.05/3 (never below 20 pairs); a person may retire a rule at any time. `LearnedRule` gains the credit and the pairs counted | NEW-context-4 |
| Lessons learned during a run (§6) | none | **Pending owner decision O15** ([OPEN_QUESTIONS](../reference/OPEN_QUESTIONS.md#owner-decisions)). Default until decided: none applies before a person approves it; each is a `candidate` at the run's end, with its evidence. If the owner allows probation: a `LearnedRule` status `probation`, production runs only, never a measurement run | NEW-measurement-3, NEW-context-4 |
| Profile statements (§6) | used by Seshat as soon as they are derived; editable and dismissible | Pending the owner ([planner-pm](specs/planner-pm.md) §8 Q1; not yet in the owner queue). Default until decided: the code's behaviour. If the owner requires approval first: a `ProfileEntry` status `proposed`, and `POST /api/learning/profile/:id/approve` | — (decided by the owner) |
| Card `key` (§2, `GET /api/board`) | absent; cards carry only `card_<uuid8>` ids | `key: string` (`CHR-12`), the project's prefix and a per-project number, never reused ([kernel](specs/kernel.md) rule 5) | P3 |
| Card `kind`, `change`, `split` (§2, `GET /api/board`) | `kind` re-derived from labels, title and keywords | three stored fields: `kind` (seven values), `change` (`feature`, `fix`, `characterize`, `refactor`, `upgrade`), `split` on a split child (`spike`, `path`, `interface`, `data`, `rules`) ([DEC-26](DECISIONS.md#dec-26--one-vocabulary-for-the-kind-of-card-and-the-run); labels in [NAMING](NAMING.md#card-kind-change-and-split)) | NEW-kernel-9 |
| The `awaitingMerge` hold (`GET /api/board`) | none; a card moves to Done when its pull request opens | `hold?: { kind: "awaitingMerge", pr, since }` on a card in `review`, not counted toward ReviewWIP ([kernel](specs/kernel.md) rule 24) | NEW-kernel-3 |
| `PmStatus.model` (§3) | the manager model's id, shown by the chat panel | dropped: the chat panel names no model (owner decision O3); every role's model name is served by `GET /api/config/roles` (§3, Configuration) | NEW-dashboard-6 |
| Configuration endpoints (§3) | none; the Registry view reads `/api/models` and the bake-off matrix | the endpoints under *Configuration* below, including the two-tier benchmark keyed by combination | NEW-dashboard-6, NEW-models-12, NEW-measurement-5 |

## 1. What the user asked for

- Chat with the project manager the way you would with a PM you hired. The
  conversation runs on the **Planner role's model** (on the reference host a
  27B dense Qwen model; the registry decides), not the Worker.
- The board follows the practices real teams use (Kanban Method, Linear,
  Jira, GitHub Projects), so it sits inside an existing company setup.
- GitHub is the first-class integration. Jira and Linear get import/export in
  their native field vocabulary.
- **Preemption:** a message sent while the Worker is running pauses the Worker
  at its next step boundary. The PM loads, replies, and the Worker resumes.
  On the 24 GB reference host only one model is resident at a time; larger
  hosts may co-reside models ([models](specs/models.md)).

## 2. Card fields (kernel `CardRecord`, all optional, back-compatible)

| Field | Type | Meaning | Jira | Linear | GitHub |
|---|---|---|---|---|---|
| `priority` | `0..4` | 0 none, 1 urgent, 2 high, 3 medium, 4 low (Linear's scale). The column already exists; nothing wrote WSJF into it, so no migration is needed. Sort puts 1 first and 0 last. | Priority (Highest..Lowest) | priority | label `priority:*` / Projects field |
| `estimate` | number | Points: 1, 2, 3, 5, 8 | Story points | estimate | Projects number field |
| `labels` | string[] | Free labels | Labels | labels | labels |
| `epicId` | string | Parent epic card id (a card with `tier: "epic"`) | Epic link / parent | project | parent issue / milestone |
| `cycleId` | string | Cycle (sprint) id | Sprint | cycle | iteration field |
| `assignee` | `"worker"` \| `"human"` \| string | Who does it | Assignee | assignee | assignees |
| `dueDate` | ISO date | Target date | Due date | dueDate | Projects date field |
| `externalRef` | existing | `{ system: "github" \| "forgejo", id, url }`; `id` is `owner/repo#n` for GitHub | issue key | identifier | `owner/repo#n` |

Cycles are stored as ledger-backed records:
`{ id, name, startsOn, endsOn, goal?, state: "planned" | "active" | "closed" }`.

## 3. Endpoints

All mutating endpoints require the existing `X-Sekhemet-Action: 1` header
and are refused in read-only mode.

### Chat

- `GET /api/pm/thread?since=<seq>` returns
  `{ messages: PmMessage[], status: PmStatus }`.
- `POST /api/pm/messages` with `{ text, context?: { cardId?, view? } }`
  returns `{ message: PmMessage }` (role `user`, state `queued`).
- Stream: the existing `/api/stream` SSE carries `pm` events:
  `{ kind: "message", message }` and `{ kind: "status", status }`.

```ts
type PmRole = "user" | "pm" | "system";
interface PmMessage {
  id: string; seq: number; role: PmRole; text: string;   // markdown
  createdAt: string;
  state: "queued" | "thinking" | "done" | "error";
  context?: { cardId?: string; view?: string };
  proposals?: PmProposal[];     // changes the PM wants to make
  cites?: { cardId?: string; runId?: string; evidenceId?: string }[];
}
interface PmStatus {
  phase: "idle" | "waiting_for_step" | "loading_pm" | "thinking" | "resuming_worker";
  detail?: string;              // "Pausing the Worker after step 5 · ~40s to load the PM"
  model?: string;               // the manager model's id; target: dropped (§0, owner decision O3)
  workerPaused?: boolean;
  since?: string;               // ISO time this phase started
  step?: number;                // the Worker step it paused after
  etaSeconds?: number;          // expected seconds left in this phase
}
```

### Proposals: the PM proposes, you approve

The PM never mutates the board silently. Every change is a proposal the user
applies or discards, one by one or all together.

```ts
interface PmProposal {
  id: string;
  kind: "create_card" | "update_card" | "split_card" | "reorder" | "move_card"
      | "create_cycle" | "assign_cycle" | "park" | "unpark";
  summary: string;              // "Split 'Ledger' into append + idempotency (2 cards, 3 + 2 pts)"
  cardId?: string;
  patch?: Record<string, unknown>;      // field -> new value
  before?: Record<string, unknown>;     // field -> old value, for the diff
  cards?: Partial<CardRecordLike>[];    // for create_card / split_card
  state: "open" | "applied" | "discarded" | "stale";
}
```

- `POST /api/pm/proposals/:id/apply` returns `{ proposal, cards }`. It is
  written to the ledger with actor `human` and type `pm/proposal_state`,
  payload `{ proposalId, state: "applied", cardIds? }` (a discard writes the same type with `state: "discarded"`).
- `POST /api/pm/proposals/:id/discard`

### Board practices

- `GET /api/board` gains per-card `priority`, `estimate`, `labels`, `epicId`,
  `cycleId`, `assignee`, `dueDate` and `externalRef`, plus top-level
  `epics: { id, title, progress: { done, total, points, pointsDone } }[]` and
  `cycles: Cycle[]`.
- `PATCH /api/cards/:id` with any of the section 2 fields (inline editing).
- `GET /api/cycles`, `POST /api/cycles`, `PATCH /api/cycles/:id`.
- `GET /api/metrics/flow?days=30` returns
  `{ throughput: {date, done}[], cycleTime: {cardId, hours, doneAt?}[],
     cfd: {date, backlog, ready, working, checking, review, done}[],
     wipAge: {cardId, hours}[] }`.

### Integrations

- `GET /api/integrations` returns one entry per integration:
  `{ id, name, tier: "now" | "next" | "later", connected, detail?, lastSyncAt?, via }`.
  The `via` values are `"gh-cli"`, `"csv"`, `"webhook"` and `"api"`.
- `POST /api/integrations/github/sync` with `{ direction: "pull" | "push" | "both" }`
  returns `{ created, updated, skipped, errors }`. It uses the local `gh` CLI
  and the user's own auth; no tokens are stored by Sekhemet.
- `GET /api/export?format=jira-csv|linear-csv|github-json|json` downloads the
  board in that tool's native import format, with
  `Content-Disposition: attachment; filename="sekhemet-<project>-<format>.<csv|json>"`.
- `POST /api/import` with `{ format, content }` returns `{ proposals: PmProposal[], messageId }`
  (the preview is stored as a PM message, `messageId` its id),
  a preview using the same `PmProposal` flow, so import is never silent. Their
  ids work with `/api/pm/proposals/:id/apply` and `/discard`.
- `PUT /api/integrations/github-pr` with `{ enabled: boolean }` returns the entry.
- Integration ids (canonical):
  - now: `github`, `github-pr`, `jira`, `linear`, `slack`
  - next: `jira-sync`, `linear-sync`, `github-actions`, `teams`, `slack-replies`
  - later: `sentry`, `datadog`, `pagerduty`, `notion`, `confluence`

### Configuration (target: NEW-dashboard-6, NEW-models-12, NEW-measurement-5)

The Configuration page's shapes ([dashboard](specs/dashboard.md) §2.16; behaviour of the scan, the recommendations and the download in [models](specs/models.md), of the benchmark in [measurement](specs/measurement.md)). None exists today. Every mutating request here is refused for any actor but a person, needs the Accept permission in company-server mode, and is recorded on the ledger with the principal. Nothing here downloads, loads or benchmarks on its own initiative.

```ts
type Role = "worker" | "planner" | "reviewer" | "researcher";   // Seshat runs on "planner"
interface ModelFolder {
  path: string;
  source: "config" | "flag" | "env";   // config.toml, --models-dir, SEKHEMET_MODELS_DIR
  readable: boolean; error?: string;   // why it could not be read
}
interface FoundModel {
  id: string;                          // stable: the file's SHA-256 once hashed
  name: string; file: string; folder: string;
  family?: string;                     // decides the Reviewer's eligibility
  sizeBytes: number; quantisation: string; contextLength: number;
  fits: "yes" | "swaps" | "no";        // on this machine, against its usable memory
  fitReason: string;                   // "13 GB of 16 GB usable; swaps with the Planner"
  verified?: boolean;                  // matches the registry's published SHA-256
}
interface RoleAssignment {
  role: Role;
  model?: string;                      // the name people read, e.g. Seshat's model under "planner"
  state: "resident" | "swapped_out" | "not_configured";
  qualified: boolean;                  // the adoption rule allows this model in this role on this host (models rule 30a)
  unfilledReason?: string;             // "No model outside the Worker's family is configured"
  recommendation?: {
    model: string; reason: string;     // the reason in plain words, with its evidence
    present: boolean;                  // found in a configured folder
    download?: { source: string; sizeBytes: number; sha256: string };  // only a registered source
  };
}
interface Combination {                // one model per role; a role may be left unfilled
  worker: string; planner: string; reviewer?: string; researcher?: string;
}
interface Score { value: number; low: number; high: number; n: number }   // with its interval
interface RoleScore {
  role: Role; model: string;
  state: "measured" | "partial" | "not_measured";
  score?: Score; measuredAt?: string;  // cached: re-measured only when this role's model changes
}
interface CombinationResult {
  combinationId: string;               // derived from the four model ids and the host
  combination: Combination;
  tier: "quick" | "overnight";
  roles: RoleScore[];
  endToEnd?: { passed: number; total: number };
  score?: Score;
  current: boolean; recommended: boolean; reason?: string;
  indistinguishableFrom: string[];     // combinationIds whose intervals overlap this one
  resolvedAgainst?: { combinationId: string; outcome: "better" | "worse" }[];  // overnight only
  versusBaseline?: "better" | "worse" | "not established";   // against the recorded frozen baseline
  date: string;
}
interface BenchmarkRun {
  runId: string; tier: "quick" | "overnight";
  combinations: string[];              // combinationIds
  state: "queued" | "running" | "stopped" | "done" | "failed";
  schedule?: { window: { start: string; end: string }; fitsTonight: number; nextStart?: string };  // overnight
  progress?: { role?: Role; model?: string; combinationId?: string; done: number; total: number;
               elapsedSeconds: number; etaSeconds?: number };
  partial: boolean;                    // stopped with results kept
}
```

- `GET /api/config/models` returns `{ folders: ModelFolder[], suggestedFolders: string[], models: FoundModel[], scannedAt }`; `suggestedFolders` are the likely locations the models spec names that exist on this machine and are not yet configured.
- `POST /api/config/models/folders` with `{ path }` adds a folder and `DELETE /api/config/models/folders` with `{ path }` removes it; each returns the `GET` shape. A folder is only read, never written, and never outside what the person named.
- `POST /api/config/models/scan` re-scans every configured folder and returns the `GET` shape; progress is streamed as `config` events on `/api/stream`: `{ kind: "scan", folder, found, done }`.
- `GET /api/config/roles` returns `{ roles: RoleAssignment[] }`, one per role in the order Worker, Planner, Reviewer, Researcher.
- `PUT /api/config/roles/:role` with `{ model }` assigns a found model to a role and returns `{ role: RoleAssignment }`. It is refused with 409 `{ error, needs: "benchmark" }` when the adoption rule ([models](specs/models.md) rule 30a) does not yet allow that model in that role on this host, and with 409 `{ error, needs: "other-family" }` when the Reviewer would share the Worker's family.
- `POST /api/config/roles/:role/load` and `/unload` return `{ role: RoleAssignment }`; both go through the residency scheduler, never around the memory guard. A load that does not fit is refused with the reason; an unload of a model a running card uses takes effect at the next step boundary, and the response says so.
- `POST /api/config/downloads` with `{ model }` starts an explicit download of a recommended model from its registered source and returns `{ downloadId, destination, sizeBytes, sha256 }`. Progress is streamed as `config` events: `{ kind: "download", downloadId, bytes, total, state: "running" | "verifying" | "done" | "failed", error? }`. The file is used only after its SHA-256 matches the published one; a mismatched file is deleted and the state is `failed`. Refused when the model has no registered source and hash, or when `[network] mode` does not allow the source host (the refusal names the setting). `DELETE /api/config/downloads/:id` cancels.
- **Start.** `POST /api/config/benchmark` with `{ tier: "quick" | "overnight", combinations: Combination[], schedule?: "tonight" | "next-window" }` returns `{ run: BenchmarkRun, estimateSeconds }`. `quick` takes one combination, measures only the roles whose `RoleScore` is not cached, and starts now; `estimateSeconds` is 0 when everything is cached. `overnight` takes up to 3 combinations (the page's default is the top ones the quick tier could not separate), is queued for the machine's overnight window, and returns the `schedule` with how many fit tonight; it runs only inside the window, stops at the window's end and resumes the next night, and never starts while a card runs or the machine is reserved. A quick run is refused while another run holds the runner, naming it. A combination with a model that does not fit this machine is refused with 409 `{ error, needsGb }`. An estimate without starting: `GET /api/config/benchmark/estimate?tier=&combination=<combinationId>` returns `{ estimateSeconds, toMeasure: { role, model }[] }` (or, for `overnight`, `{ fitsTonight }`).
- **Progress.** `GET /api/config/benchmark/runs/:runId` returns `{ run: BenchmarkRun }`; changes are streamed as `config` events: `{ kind: "benchmark", run }`.
- **Stop.** `POST /api/config/benchmark/runs/:runId/stop` ends a queued or running run, keeps every result already measured (`partial: true`), and returns `{ run }`. A stopped overnight run does not resume.
- **Results, keyed by combination.** `GET /api/config/benchmark` returns `{ runs: BenchmarkRun[], results: CombinationResult[], roleScores: RoleScore[] }`; `GET /api/config/benchmark/:combinationId` returns that combination's results of both tiers over time, its history. `versusBaseline` is `"not established"`, and a pair is absent from `resolvedAgainst`, whenever the difference is smaller than the measurement can resolve ([measurement](specs/measurement.md) NEW-measurement-5). No endpoint here assigns a combination: `PUT /api/config/roles/:role` does, on a person's request.
- `GET /api/config` returns the effective configuration, read-only, as `{ key, value, source }[]` with `source` one of `default`, `user`, `project`, `flag`, `env` (NEW-dashboard-4).
- `PUT /api/config/review` with `{ minutesPerDay }` sets `review_minutes_per_day`; a value of 0 or less is refused with 400 naming the key ([review-git](specs/review-git.md) §2.2.3). It returns `{ minutesPerDay, reviewWip }` (NEW-dashboard-4).

## 4. Preemption protocol (backend only; the UI shows `PmStatus`)

1. The server appends a `pm/message` ledger event (state `queued`).
2. If a `sekhemet queue` process holds the runner lease
   (`.sekhemet/runner.lock`, holding its pid and a heartbeat), the queue
   answers. It checks for queued PM messages after every Worker step. When it
   finds one it writes the `waiting_for_step` then `loading_pm` status, unloads
   the Worker, loads the manager, answers, reloads the Worker and continues the
   card. The paused time is excluded from the card's time budget.
3. If no runner holds the lease, the server answers directly with the manager
   model.
4. The PM's reply is a `pm/reply` ledger event with its proposals. The hash
   chain covers the conversation.

## 5. Integration roadmap (approved by the user, 2026-09-18)

The choice follows what dev teams use most: Stack Overflow 2025 (GitHub 81%,
Jira 46%, GitLab 36%; Slack the top chat tool, Teams the top video tool,
Confluence the top docs tool) and JetBrains 2025 (GitHub Actions 33%, the top
CI). Every integration is off until the user connects it: syncing sends card
content to that service. Sekhemet uses the user's own CLI logins or webhook
URLs and stores no tokens in the repo.

| Tier | Integration | What it does |
|---|---|---|
| **Now** | GitHub Issues + Projects | Two-way card and issue sync via `gh`. Priority, estimate and cycle map to Projects fields. Card and issue are linked via `externalRef`. |
| **Now** | GitHub PR on accept | Optional: Accept pushes the card branch and opens a PR whose body is the evidence (gates, diff stats, transcript link), instead of squash-merging locally. |
| **Now** | Jira import/export | CSV in Jira's own import columns (Summary, Issue Type, Priority, Story Points, Sprint, Epic Link, Labels, Description). Import is previewed as PM proposals. |
| **Now** | Linear import/export | CSV/JSON in Linear's fields (title, priority 0-4, estimate, cycle, project, labels). |
| **Now** | Slack for the PM | An incoming webhook. The PM posts the daily standup, "needs you" alerts (a card waiting on review or a decision) and run reports. Replying from Slack arrives in the next tier. |
| Next | Jira / Linear live sync | REST/GraphQL with the user's token from the OS keychain. |
| Next | GitHub Actions gate mirror | Post the card's gate results as a check run on its PR. |
| Next | Microsoft Teams | The same messages as Slack, via an incoming webhook. |
| Next | Slack replies | Talk to the PM from a Slack thread. |
| Later | Sentry / Datadog / PagerDuty | New errors, regressions and incident follow-ups arrive as PM proposals for bug cards. |
| Later | Notion / Confluence | The PM publishes cycle plans, run reports and decision logs as pages, and reads linked specs as card context. |

Slack endpoints (Now tier):
- `PUT /api/integrations/slack` with `{ webhookUrl }`. The URL is stored in
  the user's config directory (`~/.config/sekhemet/repos/<repo>-<hash>.json`,
  mode 0600), never in the repo: `.sekhemet/` is committed in many projects.
  It is never written to the ledger. It returns the integration entry.
- `POST /api/integrations/slack/test` sends a test message and returns
  `{ ok, error? }`.
- `DELETE /api/integrations/slack` disconnects.
- The PM's scheduled messages are written to the ledger as `pm/notify`, with
  `{ channel: "slack", kind: "standup" | "needs_you" | "run_report", ok }`.

## 6. Learning: self-improvement and the user profile (2026-09-18)

The user asked that both the Worker and Seshat get better over time, grow with the project, and build a profile of what the user wants. The design follows `docs/research/PM_RESEARCH_SYNTHESIS.md`. Everything learned is:
- context, not weights: no fine-tuning;
- extracted from gate results and human actions, never from a model's opinion of itself;
- recorded on the ledger, so it can be audited and rolled back;
- approved by a human before it takes effect — the owner's rule of 2026-09-18, which holds for playbook rules and for lessons learned during a run until owner decision O15 is made; profile statements are used at once today, pending the owner (§0).

Three loops:

1. **Playbook (ACE: Generator, Reflector, Curator).**
   - **Where candidate rules come from:**
     - a failure the Worker fixed only after at least one failed edit (from working memory);
     - a send-back note;
     - Seshat's reflection at the end of a run, when the manager model is loaded.
   - **Scope:** each rule is scoped by card kind, file pattern, and/or an error pattern.
   - **Counters:** when an active rule was in a card's prompt, a passing first attempt counts helpful and a failing one counts harmful.
   - **Value:** decays Erev-Roth style: `v ← (1 − 0.1)·v + reward` each time the rule is used.
   - **Lifecycle (today; target in §0):** a candidate becomes active only after human approval. Today an active rule is proposed for retirement when it has at least 3 more harmful than helpful counts.
2. **Policy tuner (Dream-RSI).** `sekhemet tune` replays recorded trajectories and recommends stopping policies (`.sekhemet/tuning/latest.json`).
3. **User profile.** Statements about what the user wants, each with its evidence and strength:
   - **Categories:** code_style, planning, communication, priorities.
   - **Sources:**
     - send-back notes;
     - which kinds of proposal the user applies or discards;
     - fields the user edits after Seshat changed them.
   - **Refinement:** the manager model turns raw signals into statements at the end of a run.
   - **Use:** Seshat reads the active statements, and the user can edit or dismiss any of them.

Endpoints:
- `GET /api/learning` returns `{ rules: LearnedRule[], profile: ProfileEntry[], tuning?: TuningReport }`.
- `POST /api/learning/rules/:id/(approve|retire)` and `PATCH /api/learning/rules/:id` with `{ text }`.
- `POST /api/learning/profile/:id/dismiss` and `PATCH /api/learning/profile/:id` with `{ statement }`.

```ts
interface LearnedRule {
  id: string; role: "worker" | "manager"; text: string;
  scope: { kind?: string; pathPattern?: string; errorPattern?: string };
  status: "candidate" | "active" | "retired";
  helpful: number; harmful: number; value: number;
  source: "struggle" | "send_back" | "reflection" | "seed";
  evidence: { cardId?: string; note: string }[];
  createdAt: string;
}
interface ProfileEntry {
  id: string; statement: string;
  category: "code_style" | "planning" | "communication" | "priorities";
  strength: number;                       // 0..1, decays without new evidence
  evidence: { note: string; at: string }[];
  status: "active" | "dismissed";
  source: "send_back" | "proposal_choices" | "edits" | "reflection";
}
```
