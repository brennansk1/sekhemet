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
| Lessons learned during a run (§6) | none | **Pending owner decision O15** ([OPEN_QUESTIONS](../reference/OPEN_QUESTIONS.md#owner-decisions)). Default until decided: none applies before a person approves it; each is a `candidate` at the run's end, with its evidence. If the owner allows probation: a `LearnedRule` status `probation`, production runs only, never a measurement run | T8 (MS-T8-15), NEW-context-4 |
| Profile statements (§6) | used by Seshat as soon as they are derived; editable and dismissible | Pending the owner ([OPEN_QUESTIONS](../reference/OPEN_QUESTIONS.md#owner-decisions) O24). Default until decided: the code's behaviour. If the owner requires approval first: a `ProfileEntry` status `proposed`, and `POST /api/learning/profile/:id/approve` | — (decided by the owner) |
| Decision `deliveredAt` (`GET /api/decisions`) | absent: a decision record says when it was answered, not when the answer reached the card that asked | `deliveredAt?: string` (ISO time) on an answered decision, from the kernel's `decision/delivered` ([planner-pm](specs/planner-pm.md) PM-P2-7); the record is built (B4.4), the delivery call sites are not yet | P2 |
| Take over a project (§3, *Take over a project*) | none: the take-over ran only from `sekhemet dev take-over`, and stopped at the inventory | `POST /api/takeover`, `GET /api/takeover`, `POST /api/takeover/approve`, `POST /api/takeover/reconciliation/apply` and `/dismiss` — built (B4.4) | NEW-design-stage-6, NEW-integrations-4 |
| Card `key` (§2, `GET /api/board`) | absent; cards carry only `card_<uuid8>` ids | `key: string` (`CHR-12`), the project's prefix and a per-project number, never reused ([kernel](specs/kernel.md) rule 5) | P3 |
| Card `kind`, `change`, `split` (§2, `GET /api/board`) | `kind` re-derived from labels, title and keywords | three stored fields: `kind` (seven values), `change` (`feature`, `fix`, `characterize`, `refactor`, `upgrade`), `split` on a split child (`spike`, `path`, `interface`, `data`, `rules`) ([DEC-26](DECISIONS.md#dec-26--one-vocabulary-for-the-kind-of-card-and-the-run); labels in [NAMING](NAMING.md#card-kind-change-and-split)) | NEW-kernel-9 |
| The `awaitingMerge` hold (`GET /api/board`) | none; a card moves to Done when its pull request opens | `hold?: { kind: "awaitingMerge", pr, since }` on a card in `review`, not counted toward ReviewWIP ([kernel](specs/kernel.md) rule 24) | NEW-kernel-3 |
| `PmStatus.model` (§3) | the manager model's id, shown by the chat panel | dropped: the chat panel names no model (owner decision O3); every role's model name is served by `GET /api/config/roles` (§3, Configuration) | NEW-dashboard-6 |
| Configuration endpoints (§3) | none; the Registry view reads `/api/models` and the bake-off matrix | the endpoints under *Configuration* below, including the two-tier benchmark keyed by combination | NEW-dashboard-6, NEW-models-12, NEW-measurement-5 |
| Reply citations (§3, `PmMessage.cites`) | served with `url` and `label` (`apps/harness/src/pm/types.ts:38-45`; rendered as Sources by `packages/ui/src/pm.ts:1306`), but this file listed only `cardId`, `runId`, `evidenceId` | `cites[]` carries `url?` and `label?` for a research source, rendered in the Sources list, http and https only ([dashboard](specs/dashboard.md) §2.7.4) — now in §3 | — (built; this file lagged) |
| Integration id `research-web` (§3, Integrations) | served, with `PUT /api/integrations/research-web` `{ enabled }` (`apps/harness/src/integrations.ts:92,664`), but missing from the canonical ids | a *now* id, its `detail` naming the search provider ([design-stage](specs/design-stage.md) §3) — now in §3 | — (built; this file lagged) |
| What leaves the machine (§5, roadmap) | stated per integration on the Integrations page (`packages/ui/web/integrations.js`, *Leaves this machine* / *Would send*), but the roadmap table had no column for it | the roadmap's **What leaves the machine** column — now in §5 | — (built; this file lagged) |
| `reach` on rule approval (§6) | `POST /api/learning/rules/:id/approve` reads `{ reach: "project" \| "global" }` (`apps/harness/src/pm_api.ts:320-331`); this file said approve takes no body | `{ reach? }`, default `project`, and `LearnedRule.reach` (`apps/harness/src/learning/store.ts:28`) — now in §6 | — (built; this file lagged) |

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
- `POST /api/pm/focus` (no body) says the dashboard is visible and focused
  for the person; the client sends it on focus and once a minute while
  focused. It records `pm/board_focus {principal}` at most once a minute a
  person and returns `{ ok: true }`. For five minutes after, the notifier
  puts Seshat's unsolicited items in the panel — a reply by `notifier` —
  instead of a notification (`pm/notice_shown`; planner-pm PM-P6-10).
- `POST /api/pm/create-card` with `{ title, description?, epicId?,
  projectId? }` (quick create from the board, dashboard DB-P3-12; `projectId`
  the project the board is scoped to) appends a reply to the person carrying
  one `create_card` proposal (`cards: [{ title, spec?, epicId? | projectId? }]`;
  `epicId` only when it names an epic, and then the card is in the epic's
  project; else `projectId` when given) and returns
  `{ messageId, proposal: PmProposal }`. Nothing is created until the
  proposal is applied, which goes through the planner pipeline (PM-P1-1).
  `400 { error }` for an empty or multi-line title, or one over 300
  characters (the dashboard's own `quickCreateRequest`). In the Team setup it
  needs `issue.create` on the project the card would land in: the epic's
  when `epicId` is given, else `projectId`'s, else the workspace's.
- Stream: the existing `/api/stream` SSE carries `pm` events:
  `{ kind: "message", message }` and `{ kind: "status", status }`. In the
  Team setup the stream reaches everyone, so it carries no message: it sends
  `{ kind: "refresh" }` and the client reloads `GET /api/pm/thread`.
- In the Team setup (planner-pm PM-N9-8) `GET /api/pm/thread` returns the
  person's own part of the thread: their messages and the replies to them,
  and a reply to no one (a planner's post) only when they can see every
  project. Each person's messages are answered apart, from the projects and
  issues they can see; a Viewer's reply carries no proposal.

```ts
type PmRole = "user" | "pm" | "system";
interface PmMessage {
  id: string; seq: number; role: PmRole; text: string;   // markdown
  createdAt: string;
  state: "queued" | "thinking" | "done" | "error";
  context?: { cardId?: string; view?: string };
  principal?: string;           // who wrote a user message; for a reply, who it answers (Team setup)
  proposals?: PmProposal[];     // changes the PM wants to make
  cites?: { cardId?: string; runId?: string; evidenceId?: string; url?: string; label?: string;
             goalId?: string; assumptionId?: string; findingId?: string }[];   // url + label: a research source, rendered in the Sources list (http/https only); goalId, assumptionId, findingId (an AI review's dossier entry) and evidenceId: what a reply answered from (planner-pm PM-P6-1, -2, -6)
  skillVersion?: string;        // a reply's: the senior-PM skill it was written under, on every reply (PM-P6-4)
  model?: string;               // a reply's author: the Planning model's id, "ledger" (a standup from the ledger) or "notifier" (a notice shown in the panel, PM-P6-10), which the panel renders as the product's notice, not in Seshat's voice (PM-N9-6)
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
      | "create_cycle" | "assign_cycle" | "park" | "unpark"
      | "start_project";                // patch.brief: the person's sentence; patch.group: the new
                                        // project's ProjectGroup (below), when Seshat drafted one
  summary: string;              // "Suggested: split Ledger into 2 cards (5 pts). Why: the Worker looped on it."
  why?: string;                 // the reason; every Seshat proposal has one (PM-N9-4)
  suggestionId?: string;        // the suggestion on the issue this is (PM-N9-1): applying either
                                // applies both; discarding it dismisses the suggestion
  forOwner?: string;            // Team setup: the issue's owner, who alone applies it (PM-N9-9)
  cardId?: string;
  patch?: Record<string, unknown>;      // field -> new value
  before?: Record<string, unknown>;     // field -> old value, for the diff
  cards?: Partial<CardRecordLike>[];    // for create_card / split_card
  origin?: "import";                    // an import's proposal: applying it records card/imported,
                                        // and the card's text reaches the Worker tagged untrusted
  state: "open" | "applied" | "discarded" | "stale";
}
```

- `POST /api/pm/proposals/:id/apply` returns `{ proposal, cards }`. It is
  written to the ledger with actor `human` and type `pm/proposal_state`,
  payload `{ proposalId, state: "applied", cardIds? }` (a discard writes the same type with `state: "discarded"`).
- `POST /api/pm/proposals/:id/discard`
- A `start_project` proposal with `patch.group` is a new project's whole plan
  (planner-pm §2.9, PM-P2-1; design-stage §2.9, DS-P2-6, -7), drafted
  without writing anything: `ProjectGroup { version: 1, sentence, buildSpec,
  brief { problem, outcome, users, notInScope, constraints, priorArt,
  riskiest, doneMeans }: string[] each, type { profile, reason }, stack
  { language, name, stated }, generator, epics [{ title, mechanism? }],
  cards [{ title, criteria, points }], requirements [{ key, title, mustHave }],
  candidates [{ key, title, priority: "must" | "should" | "could", source:
  "request" | "walkthrough", accepted }], releaseLine, releases [{ name,
  candidates, cards, forecast?: { p50Days, p85Days, samples } }] (no forecast:
  *Not enough history yet*), questions [{ question, default, answers }] (at
  most two), assumptions, settled [{ question, answer, source, ref }],
  cardZero, cardOne, creates { project, epics, issues, brief, cardZero } }`.
  Its apply takes an optional body `{ choices: { accept?: string[], remove?:
  string[], releaseLine?: number, type?: string, answers?: { [question
  index]: answer index } } }` — Review plan's *Create project* — and creates,
  with the person as actor, the project, the Type, the brief's releases as
  slices with the kept candidates, the first release's cards through the
  planner, card zero (`labels: ["card-zero"]`, Ready) and card one
  (`["card-one"]`, after card zero), every planned card after card one; the
  answered questions as decisions, the unanswered as assumptions (PM-P2-2).
  `choices` of any other shape — an unknown key, `accept`/`remove` not an
  array of strings, `releaseLine` not a whole number, `type` not one of the
  depth profiles (never replaced silently by the proposed one), `answers`
  keyed other than by a question index or valued other than by a whole
  number — is refused with **400** and nothing is applied; absent, the
  proposed plan is applied as drafted. The Type chosen is recorded even where
  a profile was recorded before. A new project's group is applied only in a
  folder that holds no project yet: a repository whose tracked files hold
  code, or whose project already has an accepted brief or a card, is refused
  with **409** and nothing is written (plan there with `/plan`, or take it
  over). In the Team setup applying it also needs `project.create` and
  `brief.accept` — an Admin, since a new project has no lead — so a Member's
  apply is a **403** naming `brief.accept` (teams item 6). TEAM-20 is
  partial: *Send for approval* is not built, and in the Team setup Review
  plan's button says what it does — *Create project and accept its
  brief* — and beforehand who may press it (*Create project* in Solo). A
  ledger holding a card or an accepted brief that no project claims is
  refused like a folder's project. Card one's test is the Worker's to
  write, in its scope, never a staged acceptance test (design-stage
  DS-P2-3). The dashboard opens Review plan for such a proposal in
  place of Apply, and *Apply all* never applies it.
  A `start_project` with only `patch.brief` is planned as `sekhemet plan`
  plans it, with the person as actor and principal (PM-P2-2).
- A `create_card`, `split_card` or `start_project` proposal is applied
  through the one planner (planner-pm PM-P1-1): INVEST, the criterion lint,
  the scope bound and a staged test. A card the checks hold is created in
  Planning with the reason; a refusal is a 409 naming it. A split gives each
  part only its own criteria and tests and moves the original to Rejected,
  "Split into N cards: <ids>" (PM-P1-7). An import's rows and a revision's
  change cards (`traces`) keep their recorded path.
- A proposal with `forOwner`, applied by anyone else, is a 403 naming the
  owner.
- Applying a proposal is not an approval of the planned cards' criteria: the
  proposal shows each card's title, not the criteria the planner wrote, so
  every card it plans keeps its approval hold until a person approves it
  (below).

### Approving a plan's criteria (planner-pm PM-N7-5)

Every planned card waits in Planning until a person approves its criteria
(and, by the depth profile, its example tables or staged test files). The
dashboard does what `sekhemet approve <card|epic>` does.

- `GET /api/cards/:id/approval` (a card or an epic) returns
  `{ id, profile, sha256, cards: { id, title, status, approved, blockedReason?,
  criteria: { id, text }[], examples: string[], tests: { path, what: "examples"
  | "file", approved, sha256 }[] }[] }`: the card and its descendants that
  have criteria and have not started, and one SHA-256 of everything shown.
  404 for an unknown card.
- `POST /api/cards/:id/approve` with `{ sha256 }`, the hash the person was
  shown, returns `{ ok, profile, approved: string[], released: string[],
  held: { id, reason }[] }`: `criteria/approved` (and `test/approved` where the
  profile asks) with the person's principal, and each card with no other
  hold moves out of Planning. 409 `{ reason: "stale", current }` when the
  plan changed since, with nothing recorded; 400 without `sha256`; a
  Member's `issue.edit` (a Viewer or Stakeholder gets 403) and the
  dashboard's write header, like every write.

### What Accept will ask, before it is pressed (dashboard NEW-dashboard-5)

Review writes beside Accept what Accept itself would refuse (review-git
§2.4.1–3), from the same functions Accept runs (`accept.ts`
`accepterVerdict`, `implementationFiles`, `filesShownSinceEvidence`).

- `GET /api/cards/:id/review` returns `{ findings: { id, verdict?, text,
  filesRead?, modelId? }[], implementationFiles: string[], filesShown: string[], accept,
  builtBy?, testApprovals, review, escalation?, suggestedAccepters }`
  (`review`, `escalation` and `suggestedAccepters` are the route's earlier
  fields, kept: the review brief P12, a stopped card's diagnosis P14 and
  the CODEOWNERS suggestion RG-N5-3, `wave2_server.ts` `reviewBrief`): every AI review entry of the card's dossier
  recorded since its latest evidence (`card/review`, review-git P8; `id` is what Accept's `acknowledgedFindings` names,
  `filesRead` the entry's `sources`, `modelId` the Review model that wrote it;
  `verdict` is `met`, `unmet` or `unclear` for a finding, `coverage` for the
  review's coverage line, and `not_reviewed` for why no AI review ran —
  the Review role unfilled or the review failed, its `text` the reason; older
  entries may carry Seshat's `consider` or `likely_send_back`); the files Accept requires shown (what
  the latest evidence changed, less tests) and those a `review/opened`
  recorded since that evidence; `accept` for the viewer — `{ may: true }`,
  `{ may: false, code: "not_permitted", who }`, `{ may: false, code:
  "not_independent", because: "built" | "delegated", who }` or, where
  `[review] require_code_owner_accept` is on and the viewer owns none of the
  files, `{ may: false, code: "not_code_owner", who }` (review-git RG-N5-4,
  `codeOwnerVerdict`, the check Accept runs), `who` being
  `{ principal, name? }[]`, the people who may accept instead; `builtBy`
  `{ kind: "person", id, name? }` when a person built the work under review
  (the latest attempt's builder; a person delegate only while no attempt is
  recorded — a Worker-built attempt delegated later stays the Worker's); and
  `testApprovals` `{ path, approved, approvedSha256?, what?, by? }[]`, the
  staged tests the depth profile requires a person to approve,
  `approvedSha256` without `approved` being an approval voided by a change.
  Read-only; 404 for an unknown card, and in the Team setup for a card whose
  project the person cannot see (PM-N9-8).
- `POST /api/cards/:id/accept` with `{ acknowledgedFindings: string[] }`: the
  findings the person acknowledged (`x` in Review), recorded on
  `review/decided`.

### Suggestions on an issue and the weekly update (planner-pm NEW-planner-pm-9)

A change Seshat would make to an issue's assignee, labels, priority or
duplicate link, or a split, is a suggestion on the issue, and nothing
changes until a person applies it (teams TEAM-18, TEAM-19) — unless an Admin
turned on auto-apply for that property on the issue's project
(`PATCH /api/projects/:id/settings` with `{ auto_apply: { label | priority |
duplicate | split: boolean } }`, an Admin's; never the assignee or health):
then it is applied at once with that Admin as principal and can be undone in
one action (planner-pm PM-N9-2, teams TEAM-41).

- `GET /api/cards/:id/suggestions` returns
  `{ suggestions: { id, cardId, kind, value, why?, suggested, state, rule? }[] }`:
  first those an Admin's rule applied that no one has undone (`state:
  "applied"`, `rule` the Admin's principal, `suggested` "Applied by Ada's
  rule: priority Urgent for Search."), then the open ones (`state: "open"`,
  `suggested` "Suggested: priority Urgent for Search."). `kind` is
  `assignee`, `label`, `priority`, `duplicate`, `split`, or the planner's
  `hold` and `remove` on an issue someone else owns. 404 for an issue the
  person cannot see.
- `POST /api/suggestions/:id/apply` returns `{ suggestion, cards }`: the
  change is made under the person's principal, then `suggestion/applied`.
  `duplicate` moves the issue to Rejected ("Duplicate of X"); `split` plans
  the parts through the planner; `hold` moves it to Planning with the reason
  (waiting on a named decision); `remove` moves it to Rejected with the
  re-plan's reason. 403 when, in the Team setup, the issue is someone else's
  or its project's level is below Member; 409 when the suggestion is no
  longer open. The project resolves from the suggestion's own card.
- `POST /api/suggestions/:id/dismiss` returns `{ suggestion: { id, state:
  "dismissed" } }`; the same change is not proposed again on that issue.
  Checked the same way, at the suggestion's own card's project.
- `POST /api/suggestions/:id/undo` returns `{ suggestion: { …, state:
  "undone" }, cards }` for one an Admin's rule applied: the issue goes back as
  `suggestion/applied` recorded it (its labels, its priority; a duplicate back
  from Won't do to its column; a split's parts moved to Won't do and the issue
  restored), then `suggestion/undone { id, kind }` under the person; the same
  change is not proposed again. Checked as Apply (`proposal.apply`, the
  suggestion's own card's project), and in the Team setup the issue's owner
  or the Admin whose rule it was; 409 when it was not applied by a rule, was
  already undone, or a split's part has started.
- `GET /api/pm/update-draft?project=` returns `{ draft: { project?, parts:
  { status, done, next, risks, asks }, text } }`: Seshat's weekly update,
  with no health word. It writes nothing.
- `POST /api/projects/:id/update` with `{ text }` posts the update a person
  edited: `project/update_posted { project }`, the text private, the person
  as principal. In the Team setup only the project's lead or an Admin
  (`project.update`, checked centrally in `team/access.ts` before the route's
  own inline check ever runs; 403 otherwise); 400 without text.

### Status (dashboard §2.8, NEW-dashboard-9; DEC-37)

The page reads the board, `/api/story-map`, `/api/standup`,
`/api/signals?project=`, `/api/queue/standing` and the project's
`/api/metrics/burnup?scope=project&project=` (never a sprint's: the forecast
band drawn on it is the project's) from their own routes, and
builds every word with `statusModel` (`packages/ui/src/status.ts`). What only
the server knows is one read:

- `GET /api/status?project=` returns `{ facts: { setup: "solo" | "team",
     project: { id, name } | null, isLead, canSetHealth, healthWritable,
     health: { value: "on_track" | "at_risk" | "off_track", by, at } | null,
     update: { text, by, at } | null, updateMissing, canPostUpdate, canUnpark,
     forecast: { remaining, p50Days?, p85Days?, historyDays, finished, minimum },
     acceptedThisWeek: { title, by, at }[],
     flow: { days, cycleHours: number[], finished, sentBack,
       firstTime: { passed, total } } } }` (`status_api.ts` `statusFacts`).
  Scoped to the named project, or to the one project the person can see
  when none is named; a project the person cannot see reads as none, and
  only issues they can see count (PM-N9-8). `update` is the latest
  `project/update_posted` of the project with its private text; `by` is the
  person's name ("you" for the asker). `updateMissing` is true only in the
  Team setup, for the project's lead, 7 days after the last update (or the
  project's creation, when none was posted; teams TEAM-29). `canPostUpdate`
  mirrors `POST /api/projects/:id/update`'s rule; `canUnpark` mirrors
  `POST /api/cards/:id/unpark`'s (`review`, a Member's; always in Solo). The
  forecast resamples
  the project's own finished issues per day, from its first issue and at
  most 60 days back (Monte Carlo, `monteCarloForecast`), and omits the two
  dates below `minimum` (5) days of history or with none finished: a range
  or nothing, never one date; each issue counts once, at its last move to
  Done (an issue reverted and accepted again is one issue finished). The
  forecast has no target: a release's target is not recorded yet, and a
  sprint's end is not the project's. `flow` covers the last 30 days: each finished
  issue's cycle time, the issues finished (each once), those sent back (a return), and
  the issues whose first model attempt passed its checks. Health is not
  recorded yet (teams NEW-teams-11): `healthWritable` is false and `health`
  null until that route exists. Read-only; `501` on a read-only server.
- `GET /api/signals?project=` returns `{ signals: { id, value, threshold?,
     triggered, detail, epicId?, response: { action, mode, targets } }[] }`
  (`status_api.ts` `projectSignals` over planner `computeSignals`): the live
  signals of the named project's issues only, and of their events (moves,
  check results, assumptions logged on them); a project the person cannot
  see reads as no project, and with none named every project they can see
  (PM-N9-8). The review-backlog signal's limit is the board's own In review
  limit for that project (`reviewLimitFacts`, DB-P3-9), never a fixed number.
  Status turns the fired ones into its risks (DB-N9-6).
- `POST /api/cards/:id/unpark` (the dashboard's own, `x-sekhemet-action`)
  returns `{ ok: true, status }`: the parked issue goes back where it was
  parked from, or to Ready (`triage.ts` `unpark`, as `sekhemet unpark`);
  `409 { error }` when it is not parked. In the Team setup it needs
  `review`, like park (`team/access.ts`).

### Projects (dashboard §2.11, DB-N9-9, DB-N9-21; teams item 5)

The page builds every word with `projectsModel` (`packages/ui/src/projects.ts`)
from one read:

- `GET /api/projects/overview` returns `{ overview: { setup: "solo" | "team",
     projects: { id, name, state: "active" | "idle" | "done" | "paused",
       lead: string | null, health: { value, by, at } | null, updateMissing,
       release: { name, done, total } | null,
       forecast: { remaining, p50Days?, p85Days?, historyDays, finished, minimum },
       target: string | null, waitingOnYou,
       agent: { working: string[], queued } }[],
     waiting: { projectId, project, cardId, title, kind: "review" | "decision" | "parked" | "plan",
       question?, since }[],
     shippedThisMonth, agentSecondsToday,
     models: { roles: { role, model?, state }[],
       slots: { inUse, capacity }, queue,
       memory: { usedBytes, totalBytes } | null } } }`
  (`projects_api.ts` `projectsOverview`). Only the projects the person can
  see, never an archived one, and every total over those only (PM-N9-8).
  Each project's `lead`, `updateMissing` and `forecast` are Status's
  (`statusFacts`, above); `lead` is "you" for the asker and, in Solo, always
  "you"; `release` is the story map's current release (Status's
  `currentRelease`: the first not done), requirements done of those not cut;
  `target` is null: a release's target date is not recorded yet, and a
  sprint's end is not a project's target (DEC-37). `waiting` holds what waits on
  the person — an issue in review, a pending decision on an issue, a parked
  issue, a plan waiting for approval of its criteria (as Status's *Needs you*) — theirs, or unowned where they lead (in Solo, all), with when it
  began waiting. `shippedThisMonth` counts issues moved to Done in the
  current calendar month (UTC); `agentSecondsToday` sums the Agent's attempts
  finished today (a person's take-over is not the Agent's). `models` is the
  roster (`/api/models`' roles), the Coding model's qualified slots (RUN-35)
  with the issues In progress, the Ready issues waiting (`/api/queue/standing`)
  and the machine's memory. `health` stays null until teams NEW-teams-11
  records it. Read-only; `501` on a read-only server.

### Board practices

- `GET /api/board` gains per-card `priority`, `estimate`, `labels`, `epicId`,
  `cycleId`, `assignee`, `dueDate` and `externalRef`, plus top-level
  `epics: { id, title, progress: { done, total, points, pointsDone } }[]` and
  `cycles: Cycle[]`, and `estimation: "off" | "points"` — the project's
  Preferences → Estimation (DEC-31, dashboard DB-N7-2), present only when the
  board is one project's (`?project=`, or the install's only project).
- `GET /api/projects/:id/settings` returns `{ project, settings }`;
  `PATCH /api/projects/:id/settings` with `{ estimation: "off" | "points" }`
  (beside TEAM-32's `accept_rule`, `require_resolved_threads`, `lead`,
  `auto_apply`) records `project/settings_changed` with only the changed
  fields and returns `{ changed, settings }`; it needs `project.settings`
  (the project's lead or an Admin; Solo's person is Admin), and any other
  value is a 400 (`estimation is off or points`).
- `PATCH /api/cards/:id` with any of the section 2 fields (inline editing).
- `GET /api/cycles`, `POST /api/cycles`, `PATCH /api/cycles/:id`. A `PATCH`
  that moves a sprint to `closed` also records Seshat's measures for it once
  (`pm/sprint_measured`, planner-pm PM-P6-12).
- `GET /api/metrics/pm` returns Seshat's measured quality
  `{ proposals: {applied, discarded, open, acceptanceRate?},
     plannedCards: {cards, passedFirstTry}, profileCorrections, forecast?,
     sprints: SprintMeasures[] }` — `sprints` each closed sprint's record,
  oldest first: `{ cycleId, forecast: {state: "held" | "missed" |
  "undecided" | "no_forecast", p85Date?}, calibration: {held, decided},
  proposals: {applied, discarded, acceptanceRate?}, planned: {issues,
  passedFirstTry, rate?}, editedAfterSeshat }`.
- `GET /api/metrics/flow?days=30` returns
  `{ throughput: {date, done}[], cycleTime: {cardId, hours, doneAt?}[],
     cfd: {date, backlog, ready, working, checking, review, done}[],
     wipAge: {cardId, hours}[] }`.
- `GET /api/metrics/burnup?cycle=<id>` (a cycle's) or `?scope=project` (the
  project's; also with no query), with `&project=<id>` to count only that
  project's cards (the board scoped to it) and `&unit=issues` to count each
  issue as one (a project whose estimation is off, DB-N7-2) — in the Team
  setup only the cards of projects the person can see are counted (PM-N9-8) —
  returns `{ scope: "cycle" | "project", unit: "points" | "issues", cycleId?,
     name?, startsOn?, endsOn?, days: { date, done, scope }[], unestimated }`
  (dashboard DB-P3-14): done
  points and total scope at the end of each day, replayed from the card
  events — a cycle's from its start to today (none before it starts), the
  project's from the first card's day. Epics and initiatives are not
  counted, a rejected card leaves the scope, and an unestimated card counts
  as 1 point (`unestimated` says how many). `404 { error }` for no such cycle.

### Story map and releases (planner-pm P13)

When a project is done is computed from its requirements and closed by a
person ([planner-pm §2.15](specs/planner-pm.md#215-when-a-project-is-done--computed-never-claimed)).
Every `POST` is the dashboard's own (`x-sekhemet-action`), recorded under the
request's principal; a refusal is `409 { error }` naming what is unproven.

- `GET /api/story-map[/:projectId]` (the latest accepted brief's project when
  omitted; `404` without one) returns
  `{ projectId, baseline?, main?: { sha, branch, gatesPassed, at, stale },
     slices: { id, projectId, title?, appetite: { cards?, hours? },
       appetiteReached, extensions, accepted,
       state: "unproven" | "proven" | "done",
       mustHaves: { proven, total }, provenLine, unplanned: string[],
       blockers: string[],
       requirements: { id, version, title?, sliceId?, kano?, mustHave,
         dependsOn: string[],
         state: "cut" | "suspect" | "unplanned" | "planned" | "failing"
              | "passing_strength_unmet" | "proven",
         why, cards: { id, status?, suspect }[],
         tests: { ref, suspect, result?, strength? }[] }[] }[],
     unplanned: { id, title?, sliceId? }[], mustHaves: { proven, total },
     provenLine, projectDone }`. `provenLine` reads "9 of 11 requirements
  done" (DEC-31's words for the must-haves proven; "1 of 1 requirement done");
  `projectDone` is true only after a person accepted the last slice.
- `GET /api/slices/:id/report` returns
  `{ sliceId, baseline?, proven: {id, title?}[], cut: {id, title?}[],
     remaining: {id, title?, state}[], text }` (the release report, compared
  with the brief's baseline).
- `POST /api/brief/accept` with
  `{ projectId?, baseline, slices: { title, appetite: { cards?, hours? },
     requirements: { key?, id?, title, kano?, mustHave?,
       criteria?: {id, text}[], dependsOn?: string[] }[] }[] }`
  returns `{ sliceIds, requirementIds }`. `dependsOn` names another
  requirement of the brief by its `key`, or an accepted requirement's id.
  In the Team setup, the project named by `projectId` (checked to exist)
  needs its Admin or lead (`brief.accept`, teams item 6, like its settings);
  404 for a `projectId` that names no project (`team/access.ts`,
  `team_access.spec.ts`).
- `POST /api/slices/:id/accept` (a proven slice only) returns
  `{ completesProject, release?: { version, notes, changelog },
     releaseRefused?, report }`. The slice's own project resolves from the
  slice, and its Accept rule decides (`accept`, like accepting a card).
  `changelog` is the Keep a Changelog section (`## [x.y.z] - date`, then
  `### Added` …) proposed for the top of `CHANGELOG.md`; it and
  `docs/product/releases/<version>.md` are committed when the release is
  confirmed, before the tag (design-stage DS-N3-8).
- `POST /api/brief/accept` and `POST /api/requirements/:id/revise` keep
  their response shapes; after the act, the project documents are
  regenerated from the ledger and committed onto the integration branch
  (design-stage DS-N3-1), and a failure to do so is said in Seshat's thread,
  never as the route's error.
- `POST /api/slices/:id/extend` with `{ cards?, hours? }` (each above the
  current budget) returns `{ extended }`; refused (409) unless every
  remaining card has a red test and no requirement of the slice is
  unplanned — PM-P13-9's own condition for offering it, enforced again here
  so the route is never looser than the ask that led to it. A Team
  Member's `scope.change`, at the slice's own project's level.
- `POST /api/requirements/:id/cut` with `{ reason? }` (a nice-to-have only)
  returns `{ cut }`. A Team Member's `scope.change`, at the requirement's
  own project's level.
- `POST /api/requirements/:id/revise` with any of `{ title, criteria,
  dependsOn, kano, mustHave, sliceId }` returns
  `{ version, held: string[], running: string[], changeCards: { cardId,
     requirementId, version, title, spec }[] }`; Seshat posts one
  `create_card` proposal per change card, whose card carries
  `traces: [{ requirementId, changeFor }]`. A Team Member's `scope.change`,
  at the requirement's own project's level.
- `POST /api/requirements/:id/confirm` with `{ from: "card" | "test", ref }`
  re-confirms a suspect link against the current version. A Team project's
  Accept rule (`accept`), at the requirement's own project.

### Integrations

- `GET /api/integrations` returns one entry per integration:
  `{ id, name, tier: "now" | "next" | "later", connected, detail?, lastSyncAt?, via }`.
  The `via` values are `"gh-cli"`, `"csv"`, `"webhook"` and `"api"`.
- `POST /api/integrations/github/sync` with `{ direction: "pull" | "push" | "both" }`
  returns `{ created, updated, skipped, clamped, errors, budget? }`. `pull` takes the
  tracker's changes and sends nothing; `push` sends the board's changes and
  changes nothing on the board; `both` does both. `clamped` lists
  `{ id, ancestor }` for cards nested deeper than the tracker allows, which
  are not written. `budget` is `{ rest, graphql }`, the two rate budgets
  GitHub reported, kept apart (INT-11c). It uses the GitHub App when configured, else the token of
  the user's own `gh` login; no tokens are stored by Sekhemet. Every request
  goes through the network policy: offline (the default) it is refused, and
  the error names `[network] mode`.
- An integration's `detail` in `GET /api/integrations` says "blocked by
  network mode" when the network policy cannot reach it.
- `GET /api/export?format=jira-csv|linear-csv|github-json|json` downloads the
  board in that tool's native import format, with
  `Content-Disposition: attachment; filename="sekhemet-<project>-<format>.<csv|json>"`.
- `POST /api/import` with `{ format, content }` returns `{ proposals: PmProposal[], messageId }`
  (the preview is stored as a PM message, `messageId` its id),
  a preview using the same `PmProposal` flow, so import is never silent. Their
  ids work with `/api/pm/proposals/:id/apply` and `/discard`.
  A row that is already a card is an `update_card` proposal (with
  `patch.externalRef {system: "jira" | "linear", id, url}` for a Jira or Linear
  row); when every row is a card and nothing changed it returns
  `{ proposals: [], unchanged: true }`. An import never replaces a card's
  `github` or `forgejo` link, and its proposals carry `origin: "import"`. A CSV with an unterminated quote
  answers 400 with an `error` naming the line (integrations INT-27, INT-28).
- `PUT /api/integrations/github-pr` with `{ enabled: boolean }` returns the entry.
- `PUT /api/integrations/research-web` with `{ enabled }` returns the entry; the server's `detail` names the search provider or says how to configure one ([design-stage](specs/design-stage.md) §3).
- Integration ids (canonical):
  - now: `github`, `github-pr`, `jira`, `linear`, `slack`, `research-web`
  - next: `jira-sync`, `linear-sync`, `github-actions`, `teams`, `slack-replies`
  - later: `sentry`, `datadog`, `pagerduty`, `notion`, `confluence`

### Take over a project (design-stage §2.10, NEW-design-stage-6; integrations NEW-integrations-4)

Served by `apps/harness/src/integrations.ts`; every write carries the mutation
guard, and the acting person is the request's principal.

- `POST /api/takeover` `{}` — the empty board's **Take over a project**
  (DS-TO-16): takes over the server's repository (`runTakeover`): steps 1–3
  always; once the repository is trusted, the brief as found, the inherited
  issues' reconciliation, one batch of questions and the backlog proposal
  (steps 4–6). Seshat posts a reply saying what was found, with counts and
  ids only, never repository text. Returns `{ trusted, wouldRun: string[] }`
  and the `GET` shape below. `409` while another take-over runs.
- `GET /api/takeover` returns `{ inventory: { seq, baselineSeq, findings:
  [{ id, kind, path?, line?, commit? }] } | null, brief: { seq, inventorySeq,
  claims: [{ id, label: "proven" | "claimed_unproven" | "contradicted",
  citations: string[], results?: [{ kind: "test" | "build", ref, baselineSeq }],
  text?, linkState?: "proposed" }] } | null, questions: [{ decisionId, rank,
  defaultCites, question, options, status, answer? }], backlog: { proposalId,
  inventorySeq, approved: boolean, cards: [{ ref, bucket: "stabilise" |
  "finish" | "defer", title, links: string[], change?, assignee: "worker" |
  "person", forFinding?, redCheck?, secret?: { commit, path }, characterizes?,
  needsCharacterize? }] } | null, reconciliations: [{ id, state, issues:
  [{ issue: { system, id }, verdict: "done" | "duplicate" | "stale" | "valid",
  evidence: [{ kind: "test" | "commit" | "file_line" | "issue", ref, run? }],
  cardId?, newCard, why? }] }] }` — the person's view, repository text
  included. Each question is also an ordinary pending decision (`GET
  /api/decisions`), answered there. Only a person who can see every project
  reads it (PM-N9-8, as Seshat's snapshot); anyone else gets **404**.
- `POST /api/takeover/approve` `{ proposalId, projectId? }` — the person
  approves the plan (DS-TO-11, DS-TO-14), a `plan.approve` (a Member; the
  project's, when `projectId` is given) recorded with the request's
  principal: each question still unanswered takes its default, the
  requirement graph is seeded, and each card is planned through the one
  planning pipeline, its evidence as its spec (criteria with ids; Planning
  until the person approves them). `POST /api/takeover` is a
  `project.create`, and a reconciliation's apply or dismiss a
  `proposal.apply` (`team/access.ts`). The CLI's equivalent is
  `sekhemet dev take-over --approve TOP-<n> [--project <id>]`.
  Returns `{ defaultsApplied: string[], requirementIds: string[],
  candidateIds: string[], cards: string[] }`. `409` with an `error` naming
  the new proposal when an answer given since changed the plan (approve that
  one), or when the proposal was superseded.
- `POST /api/takeover/reconciliation/apply` `{ id }` — a person applies a
  reconciliation (INT-43): written through the connected tracker's one
  adapter (done and duplicate closed with a comment, stale labelled `stale`
  with a comment, valid left as it is), then recorded with their principal.
  Returns `{ id, state: "applied" | "open", applied: boolean, written:
  string[], errors: string[] }`: a write that failed leaves it `open` for the
  person to retry (an issue already closed is not written again); an issue
  no longer open is named in `errors` and does not hold it open. `409` when
  no tracker is connected, when the issues were read from another tracker
  than the one connected (nothing is written), or it was already applied or
  dismissed.
- `POST /api/takeover/reconciliation/dismiss` `{ id }` — returns `{ id,
  state: "dismissed" }`; nothing is written, and its issues may be proposed
  again.

### Configuration (target: NEW-dashboard-6, NEW-models-12, NEW-measurement-5)

The Configuration page's shapes ([dashboard](specs/dashboard.md) §2.16; behaviour of the scan, the recommendations and the download in [models](specs/models.md), of the benchmark in [measurement](specs/measurement.md)). None exists today. Every mutating request here is refused for any actor but a person, needs the Admin level in the Team setup (Review capacity: an Admin or a person the project's Accept rule names; [dashboard](specs/dashboard.md) §2.16), and is recorded on the ledger with the principal. Nothing here downloads, loads or benchmarks on its own initiative.

```ts
type Role = "worker" | "planner" | "reviewer" | "researcher" | "vision";   // Seshat runs on "planner"; "vision" describes images on cards
interface ModelFolder {
  path: string;
  source: "config" | "flag" | "env";   // config.toml, --models-dir, SEKHEMET_MODELS_DIR
  includeSubfolders: boolean;          // scanned to the depth and file-count limits (models MD-N13-1)
  readable: boolean; error?: string;   // why it could not be read
  modelCount?: number;                 // how many models it held at the last scan
}
interface FoundModel {
  id: string;                          // stable: the file's SHA-256 once hashed
  name: string; file: string; folder: string;
  family?: string;                     // decides the Reviewer's eligibility
  sizeBytes: number; quantisation: string; contextLength: number;
  fits: Partial<Record<Role, "yes" | "swaps" | "no">>;   // per role: the KV cache depends on each role's context (models 4b)
  fitReason: Partial<Record<Role, string>>;               // e.g. worker: "13 GB of 16 GB usable; swaps with the Planner"
  verified?: boolean;                  // matches the registry's published SHA-256
}
interface RoleAssignment {
  role: Role;
  model?: string;                      // the name people read, e.g. Seshat's model under "planner"
  state: "resident" | "swapped_out" | "not_configured";
  qualified: boolean;                  // passed qualification for this role on this host (models rule 27a)
  unfilledReason?: string;             // "No model outside the Worker's family is configured"
  recommendation?: {
    model: string; reason: string;     // the reason in plain words, with its evidence
    present: boolean;                  // found in a configured folder
    download?: { source: string; sizeBytes: number; sha256: string };  // only a registered source
  };
  previous?: string;                   // the assignment Restore previous brings back (models MD-N10-2)
}
interface Combination {                // one model per role; a role may be left unfilled
  worker: string; planner: string; reviewer?: string; researcher?: string;
}
interface Score { value: number; n: number; low?: number; high?: number; kind: "rate" | "graded" }   // a rate carries its exact interval; a graded quick-tier mean carries its item range in low/high
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
  indistinguishableFrom: string[];     // candidates the paired sign test on the same items cannot separate from this one (measurement rule 10)
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

- `GET /api/config/models` returns `{ folders: ModelFolder[], suggestedFolders: string[], models: FoundModel[], scannedAt }`; each folder also carries `writable` (there and writable now; an unplugged drive's folder is not); `suggestedFolders` are the likely locations the models spec names that exist on this machine and are not yet configured.
- `POST /api/config/models/folders` with `{ path, includeSubfolders? }` adds a folder (kept in the user configuration's `[models] folders`; subfolders off unless set) and `DELETE /api/config/models/folders` with `{ path }` removes it; each returns the `GET` shape. The scan only reads a folder, never outside what the person named; only a confirmed download writes into one.
- `POST /api/config/models/scan` re-scans every configured folder and returns the `GET` shape; progress is streamed as `config` events on `/api/stream`: `{ kind: "scan", folder, found, done }`. The `GET` shape also carries `skipped` (each file not listed, with its reason, models MD-N13-1) and `truncated` (the file limit stopped the scan). Hashing follows the listing in the background (MD-N12-2) and is streamed as `{ kind: "hash", id, file, hash, verified? }`; the id then becomes the SHA-256, and the earlier id still opens the model.
- `GET /api/config/roles` returns `{ roles: RoleAssignment[] }`, one per role in the order Worker, Planner, Reviewer, Researcher. Each also carries `screen: "built" | "not_measured"` (DB-N6-18), the Planner's `note` (*Seshat, the project manager, runs on this model.*), and, on a recommendation's `download`, `blockedBy` naming the `[network]` setting when the policy refuses its host (DB-N6-7).
- `PUT /api/config/roles/:role` with `{ model }` assigns a found model to a role and returns `{ role: RoleAssignment }`. It is refused with 409 `{ error, needs: "qualification" }` when the model has not passed qualification for that role on this host ([models](specs/models.md) rule 27a; any qualified model may be assigned, with or without a benchmark, rule 30a), and with 409 `{ error, needs: "other-family" }` when the Reviewer would share the Worker's family.
- `POST /api/config/roles/:role/load` and `POST /api/config/roles/:role/unload` return `{ role: RoleAssignment }`; both go through the residency scheduler, never around the memory guard. A load that does not fit is refused with the reason; an unload of a model a running card uses takes effect at the next step boundary, and the response says so.
- `POST /api/config/downloads` with `{ model, folder, fileName? }` starts an explicit download of a recommended model from its registered source into `folder` — the folder the confirmation showed, which must be a configured folder that is there and writable now (otherwise 409 `{ error, needs: "folder" }`; a missing folder is never created, since it is an unmounted drive) — and returns `{ downloadId, destination, sizeBytes, sha256 }`. Progress is streamed as `config` events: `{ kind: "download", downloadId, bytes, total, state: "running" | "verifying" | "done" | "failed", error? }`. The file is used only after its SHA-256 matches the published one; a mismatched file is deleted and the state is `failed`. Refused when the model has no registered source and hash, or when `[network] mode` does not allow the source host (the refusal names the setting). A file of the same name already in the folder is never replaced: 409 `{ error, needs: "fileName", fileName }`, and the person gives another name as `fileName`. `DELETE /api/config/downloads/:id` cancels.
- `POST /api/config/roles/:role/qualify` with `{ model }` runs **Qualify to assign** ([dashboard](specs/dashboard.md) DB-N6-5): rule 27a's check of a few minutes for that role on this host, through the residency scheduler, and assigns the model when it passes; it returns `{ role: RoleAssignment, qualified, reason? }` and never sends the person to Benchmark. `POST /api/config/roles/:role/restore` brings back the previous assignment ([models](specs/models.md) MD-N10-2) and returns `{ role: RoleAssignment }`.
- **Use the recommended models** ([dashboard](specs/dashboard.md) DB-N6-16). `GET /api/config/recommended` returns what it would do, with no request made: `{ combination: { worker?, planner?, reviewer?, researcher? }, downloads: { model, roles, url, host, sizeBytes, sha256, blockedBy? }[], folder?, unfilled: { role, reason }[], last? }` — every download with its source, size and published hash, and the folder they are written to, for the one confirmation; `last` is the previous run's state. `POST /api/config/recommended` with `{ confirm: true, folder, downloads: { model, sha256 }[] }` names back what the person confirmed; the server recomputes the plan and refuses with 409 `{ error, needs: "confirmation", downloads, folder }` when the named downloads differ from it (or none are named when it has some), and with 409 `{ error, needs: "folder" }` when the folder is not a configured one that is there and writable; no request is made on a refusal. It returns 202 and runs: each download, verified by its hash; the quick benchmark of the recommended combination (`POST /api/config/benchmark`'s quick tier, with the person's principal); then each role whose model is qualified on this host is assigned as `PUT /api/config/roles/:role` assigns it (`models/assigned` with the principal). Progress and the end are `config` events `{ kind: "recommended", state: "downloading" | "benchmarking" | "assigning" | "done", combination, downloads, benchmark?, assigned: { role, model }[], notAssigned: { role, model?, reason }[] }`.
- **Model details, combinations and placement** ([dashboard](specs/dashboard.md) §2.16 item 1a, DB-NM14-1–9; [models](specs/models.md) MD-N14-41–42; built in B4.1). Every number is served with its grade, `{ value, grade: "measured" | "file" | "estimated" | "design", low?, high? }`, and none is sent without one (DB-NM14-1); `file` is a value read from the model's file itself (its size, its header), shown *From the file*, never *Measured*.
  - `GET /api/config/models/:id?role=&context=&kvType=` returns the model's details: identity (family, total and active parameters, quantisation, engine, size, maximum context, licence, source, hash), the memory breakdown per role (weights, KV, compute buffer, prompt cache) against the live headroom, recomputed for the what-if's `context` and `kvType` without loading anything (DB-NM14-2), the speeds per engine with a llama-bench result shown as measured only when accepted (DB-NM14-3), qualification per role for the full combination, and the warnings in words (DB-NM14-4). The last *Measure speed* on this host adds to the llama.cpp row `measuredDecodeTokensPerSecond` and `measuredPrefillTokensPerSecond` (only when accepted; otherwise `benchNotAccepted` with the reason) and `ttft: { withoutCacheMs, withCacheMs }`, each `measured`.
  - `POST /api/config/models/:id/speed` with `{ role, confirm: true, model, memoryBytes }` — sent only when a person presses **Measure speed** in its confirmation, which names the model and the memory it loads — runs llama-bench (one warm-up and five runs at the role's depth, half its context) and times the first token without and with the prefix cache, under the runner lease and inside one benchmark run of the residency scheduler (no other role loads meanwhile; only what it loaded is unloaded). Without a matching confirmation it answers 409 `{ error, needs: "confirmation", model, name, memoryBytes }` and loads nothing. It returns 202 `{ model, role, depth }`; progress is streamed as `config` events `{ kind: "speed", model, role, state: "running" | "done" | "failed", benchError?, ttftError?, error? }`, and the result is recorded as `model/speed_measured` with the principal (DB-NM14-3).
  - `GET /api/config/downloads/estimate?model=` returns the memory and speed estimated from a remote GGUF's metadata alone, graded `estimated`, with no weights fetched (DB-NM14-5); it goes through the research network policy like any lookup, each range answered with a 206 and the bytes read capped, and never through gguf-parser-go (its `--url` would bypass the policy).
  - `GET /api/config/combinations` returns the combinations ordered by every role's quality floor, then time per card including swaps, then footprint, each excluded one with its reason, and per combination its peak memory, co-residence, C_pair per role pair, predicted wait p50 and p90 per class, time per card and accepted cards per night; no combined score (DB-NM14-6, MD-N14-42).
  - `GET /api/config/placement` returns, per model on a slower volume, the loading time saved per day, the suggested copies (a knapsack keeping at least 20 GB of internal space free) and why any other is not suggested, each gain `measured` only from at least three recorded cold loads per volume (DB-NM14-7, MD-N14-41, [measurement](specs/measurement.md) MS-NM14-4).
  - `POST /api/config/placement/copies` with `{ model }` — sent only when a person presses **Copy** in the confirmation — copies the weights to internal storage and returns `{ copyId, destination, sizeBytes, sha256, freeAfterBytes }`; progress is streamed as `config` events `{ kind: "copy", copyId, bytes, total, state: "running" | "verifying" | "done" | "failed", error? }`. The registry points at the copy only after its SHA-256 matches; a copy whose hash differs is deleted and the registry is unchanged; the original is kept; the copy is recorded as `model/copied` with the principal (DB-NM14-8).
  - `GET /api/config/residency?hours=24` returns the residency timeline from the recorded `model/loaded` and `model/unloaded` events, with the realised θ per hour (DB-NM14-9).
- **Start.** `POST /api/config/benchmark` with `{ tier: "quick" | "overnight", combinations: Combination[], schedule?: "tonight" | "next-window" }` returns `{ run: BenchmarkRun, estimateSeconds }`. `quick` takes one combination, measures only the roles whose `RoleScore` is not cached, and starts now; `estimateSeconds` is 0 when everything is cached. `overnight` takes up to 3 combinations (the page's default is the top ones the quick tier could not separate), is queued for the machine's overnight window, and returns the `schedule` with how many fit tonight; it runs only inside the window, stops at the window's end and resumes the next night, and never starts while a card runs or the machine is reserved. A quick run is refused while another run holds the runner, naming it. A combination with a model that does not fit this machine is refused with 409 `{ error, needsGb }`. An estimate without starting: `GET /api/config/benchmark/estimate?tier=&combination=<combinationId>` returns `{ estimateSeconds, toMeasure: { role, model }[] }` (or, for `overnight`, `{ fitsTonight }`).
- **Progress.** `GET /api/config/benchmark/runs/:runId` returns `{ run: BenchmarkRun }`; changes are streamed as `config` events: `{ kind: "benchmark", run }`.
- **Stop.** `POST /api/config/benchmark/runs/:runId/stop` ends a queued or running run, keeps every result already measured (`partial: true`), and returns `{ run }`. A stopped overnight run does not resume.
- **Results, keyed by combination.** `GET /api/config/benchmark` returns `{ runs: BenchmarkRun[], results: CombinationResult[], roleScores: RoleScore[] }`; `GET /api/config/benchmark/:combinationId` returns that combination's results of both tiers over time, its history. `versusBaseline` is `"not established"`, and a pair is absent from `resolvedAgainst`, whenever the difference is smaller than the measurement can resolve ([measurement](specs/measurement.md) NEW-measurement-5). No endpoint here assigns a combination: `PUT /api/config/roles/:role` does, on a person's request.
- `GET /api/config` (and `GET /api/config?project=`) returns the effective configuration, read-only: `{ config, layers, problems, sources, reviewCapacity? }` — `sources` maps each dotted key a file sets (`network.mode`) to the layer it came from, one of `user`, `project`, `card`, `cli`; a key absent from it is the default's, and so is a refused value (its problem is in `problems`). `reviewCapacity` `{ project, minutesPerDay, reviewWip?, allowed, reason? }` is the named project's (or the only active one's): its minutes, the In review limit they give now, and whether this person may change them (`review.capacity`), with the reason when not (DB-N4-1, -2). *(Built C5, 2026-09-27; this line said `{ key, value, source }[]` with `default`, `flag` and `env` sources, which no code served: the configuration has no environment layer.)*
- `PUT /api/config/review` with `{ minutesPerDay, project? }` sets `review_minutes_per_day` for the project (the only active one when none is named; recorded as `project/review_hours`); a value of 0 or less (or not a number) is refused with 400 `{ error: "Review minutes per day must be more than 0.", key: "review_minutes_per_day" }` and nothing is recorded ([review-git](specs/review-git.md) §2.2.3, DB-N4-3); a person without `review.capacity` on the project gets 403 with the reason. The event carries the person's principal. It returns `{ project, minutesPerDay, reviewWip }`, `reviewWip` that project's In review limit recomputed from its own minutes; other projects' limits are unchanged (NEW-dashboard-4).

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
4. The PM's reply is a `pm/reply` ledger event with its proposals and the
   senior-PM skill's version (`skillVersion`, planner-pm PM-P6-4) — on every
   reply, a model's or one answered from the ledger. The hash chain covers
   the conversation.

## 5. Integration roadmap (approved by the user, 2026-09-18)

The choice follows what dev teams use most: Stack Overflow 2025 (GitHub 81%,
Jira 46%, GitLab 36%; Slack the top chat tool, Teams the top video tool,
Confluence the top docs tool) and JetBrains 2025 (GitHub Actions 33%, the top
CI). Every integration is off until the user connects it: syncing sends card
content to that service. Sekhemet uses the user's own CLI logins or webhook
URLs and stores no tokens in the repo.

| Tier | Integration | What it does | What leaves the machine |
|---|---|---|---|
| **Now** | GitHub Issues + Projects | Two-way card and issue sync via `gh`. Priority, estimate and cycle map to Projects fields. Card and issue are linked via `externalRef`. | Card fields, to the chosen repository |
| **Now** | GitHub PR on accept | Optional: Accept pushes the card branch and opens a PR whose body is the evidence (gates, diff stats, transcript link), instead of squash-merging locally. | Branch, diff, gate results |
| **Now** | Jira import/export | CSV in Jira's own import columns (Summary, Issue Type, Priority, Story Points, Sprint, Epic Link, Labels, Description). Import is previewed as PM proposals. | Nothing (you upload the file) |
| **Now** | Linear import/export | CSV/JSON in Linear's fields (title, priority 0-4, estimate, cycle, project, labels). | Nothing (you upload the file) |
| **Now** | Slack for the PM | An incoming webhook. The PM posts the daily standup, "needs you" alerts (a card waiting on review or a decision) and run reports. Replying from Slack arrives in the next tier. | Those messages |
| Next | Jira / Linear live sync | REST/GraphQL with the user's token from the OS keychain. | Card fields |
| Next | GitHub Actions gate mirror | Post the card's gate results as a check run on its PR. | Gate results |
| Next | Microsoft Teams | The same messages as Slack, via an incoming webhook. | Those messages |
| Next | Slack replies | Talk to the PM from a Slack thread. | The conversation |
| Later | Sentry / Datadog / PagerDuty | New errors, regressions and incident follow-ups arrive as PM proposals for bug cards. | Nothing (data comes in) |
| Later | Notion / Confluence | The PM publishes cycle plans, run reports and decision logs as pages, and reads linked specs as card context. | Those pages |

Slack endpoints (Now tier):
- `PUT /api/integrations/slack` with `{ webhookUrl }`. The URL is stored in
  the user's config directory (`~/.config/sekhemet/repos/<repo>-<hash>.json`,
  mode 0600), never in the repo: `.sekhemet/` is committed in many projects.
  It is never written to the ledger. It returns the integration entry.
- `POST /api/integrations/slack/test` sends a test message and returns
  `{ ok, error? }`.
- `DELETE /api/integrations/slack` disconnects.
- Slack is a channel of the one notifier: every message it sends is written
  to the ledger as `pm/notify`, with `{ channel: "slack", kind: "review" |
  "parked" | "budget" | "question" | "decision" | "standup" | "needs_you" |
  "run_report" | "test", ok, to?, notice?, day? }`; a notice past the day's
  budget is `pm/notice_held` and goes out in the next standup (integrations
  INT-17 to INT-20a).

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
- `POST /api/learning/rules/:id/approve` with `{ reach?: "project" | "global" }` (default `project`; `global` stores the rule in the user directory and applies it in every repository on this machine), `POST /api/learning/rules/:id/retire`, and `PATCH /api/learning/rules/:id` with `{ text }`.
- `POST /api/learning/profile/:id/dismiss` and `PATCH /api/learning/profile/:id` with `{ statement }`.

```ts
interface LearnedRule {
  id: string; role: "worker" | "manager"; text: string;
  scope: { kind?: string; pathPattern?: string; errorPattern?: string };
  reach: "project" | "global";            // chosen by the person at approval
  status: "candidate" | "active" | "retired";
  helpful: number; harmful: number; value: number;
  source: "struggle" | "send_back" | "reflection" | "seed";
  evidence: { cardId?: string; note: string }[];
  createdAt: string;
}
interface ProfileEntry {
  id: string; statement: string;
  category: "code_style" | "planning" | "communication" | "priorities";
  strength: number;                       // 0..1, decays without new evidence: as read, the recorded
                                          // strength × (1 − scope.decayPerWeek) per week since the latest
                                          // evidence; below 0.2 it is not used (planner-pm PM-P6-15)
  recordedStrength?: number;              // as read: the strength recorded at the latest evidence
  scope?: { reach: "project" | "all"; repository?: string; kind?: string;
            decayPerWeek: number };       // default { reach: "project", decayPerWeek: 0.1 }
  evidence: { note: string; at: string }[];
  status: "active" | "dismissed";
  source: "send_back" | "proposal_choices" | "edits" | "reflection";
}
```
