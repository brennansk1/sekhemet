# Project Manager and team practices: backend contract

Status: agreed contract between the backend (lead, Claude) and the dashboard
(UI subagent). The backend implements every endpoint here; the UI builds
against these shapes. Change this file first if a shape must change.

## 1. What the user asked for

- Chat with the project manager the way you would with a PM you hired. The
  conversation runs on the **manager model** (dirk-27b, Qwen 27B dense), not
  the worker.
- The board follows the practices real teams use (Kanban Method, Linear,
  Jira, GitHub Projects), so it sits inside an existing company setup.
- GitHub is the first-class integration. Jira and Linear get import/export in
  their native field vocabulary.
- **Preemption:** a message sent while the Worker is running pauses the Worker
  at its next step boundary. The PM loads, replies, and the Worker resumes.
  Only one model is ever resident (24 GB host).

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
  model?: string;               // "dirk-27b"
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
  written to the ledger with actor `human` and type `pm/proposal_applied`.
- `POST /api/pm/proposals/:id/discard`

### Board practices

- `GET /api/board` gains per-card `priority`, `estimate`, `labels`, `epicId`,
  `cycleId`, `assignee`, `dueDate` and `externalRef`, plus top-level
  `epics: { id, title, progress: { done, total, points } }[]` and
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
- `POST /api/import` with `{ format, content }` returns `{ proposals: PmProposal[] }`,
  a preview using the same `PmProposal` flow, so import is never silent. Their
  ids work with `/api/pm/proposals/:id/apply` and `/discard`.
- `PUT /api/integrations/github-pr` with `{ enabled: boolean }` returns the entry.
- Integration ids (canonical):
  - now: `github`, `github-pr`, `jira`, `linear`, `slack`
  - next: `jira-sync`, `linear-sync`, `github-actions`, `teams`, `slack-replies`
  - later: `sentry`, `datadog`, `pagerduty`, `notion`, `confluence`

## 4. Preemption protocol (backend only; the UI shows `PmStatus`)

1. The server appends a `pm/message` ledger event (state `queued`).
2. If a `sekhemet queue` process holds the runner lease
   (`.sekhemet/runner.lock`, holding its pid and a heartbeat), the queue
   answers. It checks for queued PM messages after every Worker turn. When it
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
