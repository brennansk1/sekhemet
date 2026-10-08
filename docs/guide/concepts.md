# Concepts

Sekhemet uses the words professional teams already use. If you have worked with Jira or Linear, most of the board will be familiar; if you have not, this page is the place to start. With **Tips** on, the dashboard explains each column, check and number where you meet it.

## The work

| Sekhemet | What it is | In Jira | In Linear |
| --- | --- | --- | --- |
| **Workspace** | Everything one install or server holds: its people and its projects | Site | Workspace |
| **Project** | One piece of software, with its own git repository and board | Project | Project (or Team) |
| **Brief** | What the project is for and what it must do, written with Seshat before planning | — (often a Confluence page) | Project description or document |
| **Must have · Should have · Could have** | How much each requirement matters (MoSCoW); *Later* is out of this release | Priority, or a label | Priority |
| **Epic** | A larger piece of work that holds issues | Epic | Project, or a parent issue |
| **Issue** | One unit of work: one change, built in its own worktree and checked on its own. Its key looks like `CHR-7` | Issue | Issue |
| **Story · Task · Bug · Spike** | The issue type: new behaviour a person can use · other work · a defect, fixed with a test that reproduces it first · a question answered by research or throwaway code | Issue types of the same names | Labels |
| **Subtask** | Part of an issue | Sub-task | Sub-issue |
| **Acceptance criteria** | What must be true for the issue to be done, each one checkable | Acceptance criteria (a field or the description) | In the description |
| **Acceptance tests** | Tests written from the acceptance criteria before the code, which fail first and pass once the issue is built | — | — |
| **Sprint** | A fixed stretch of time and the issues in it | Sprint | Cycle |
| **Release** | A set of requirements shipped together, with a SemVer version and a changelog | Version (fix version) | Project milestone, or a release |
| **Size limit** | How many issues a release may grow to before someone decides to cut or extend it (Shape Up's *appetite*) | — | — |
| **Story map** | The requirements laid out by the user's journey, with what each release covers | — (a plugin) | — |

## The board

| Column | What is there | In Jira | In Linear |
| --- | --- | --- | --- |
| **Backlog** | Ideas and split-off work, not planned yet | Backlog | Backlog |
| **To do** | Issues ready to start, or being planned | To Do | Todo |
| **In progress** | The Agent is building it, or its checks are running | In Progress | In Progress |
| **In review** | Its checks passed; it waits for a person | In Review (a common custom status) | In Review |
| **Done** | Accepted and merged | Done | Done |
| **On hold** | Put on hold by a person, with a reason | A blocked flag or custom status | — |

An issue a person rejects is marked **Won't do** (Jira's resolution of the same name; Linear's *Canceled*).

## People and AI teammates

| Sekhemet | What it is | In Jira | In Linear |
| --- | --- | --- | --- |
| **Assignee** | The person responsible for the issue | Assignee | Assignee |
| **Delegate** | The AI teammate doing the work on the Assignee's behalf: the Agent | — | Delegate (an agent) |
| **Seshat** | The project manager you talk to: writes the brief and the plan, answers how it is going, suggests changes you apply or dismiss | — | — |
| **Agent** | The AI teammate that builds an issue, using the Coding model | — | An agent |
| **Admin · Member · Stakeholder · Viewer** | Access levels on a Team server ([Solo and Team](solo-and-team.md)) | Roles and permissions | Admin, Member, Guest |

## Checks and decisions

| Sekhemet | What it is | Elsewhere |
| --- | --- | --- |
| **Checks** | Tests, types, lint, security scans and, for web projects, visual and accessibility checks, declared in `.sekhemet/gates.toml`. The model cannot edit them | CI status checks on a pull request |
| **Accept** | A person merges the issue: squash-merged to `main`, and it can be undone (*Revert accept*) | Approving and merging a pull request |
| **Request changes** | A person sends the issue back with a reason | GitHub's *Request changes* review |
| **Put on hold · Take off hold** | Pause an issue, with a reason, and resume it | Flagging, or a *Blocked* status |
| **Definition of done** | The project's checks, its type and its Accept rule together | Definition of Done |
| **Repair ladder** | When a check fails, the Agent repairs it, starts again with fresh context, writes a sketch first, and finally stops and asks a person | — |
| **Worktree** | A separate checkout of the repository on the issue's own branch, so issues never touch your working copy or each other | — |

## Records and measures

| Sekhemet | What it is |
| --- | --- |
| **Activity log** | Every event — plans, commands the model ran, checks, decisions — in one hash-chained log. The board, the audit view and every measure are read from it |
| **Health** | *On track*, *At risk* or *Off track*, set by a person with their name and date |
| **Project update** | A weekly note: status, done, next, risks and asks |
| **Forecast** | When the release may be done, as a range (50% and 85% likely), from the work so far |
| **Burn-up** | Work done against total scope, over time |
| **Cycle time** | How long an issue takes from start to done (Kanban's measure, not a sprint) |
| **Insights** | The project's numbers, such as cycle time and throughput, each explained with Tips on |

## Why it works this way

A few rules hold everywhere, and explain most of the product:

- **Checks decide when work is done, and the model never certifies its own work.** The Coding model cannot edit the checks, and nothing reaches *Done* until they pass and a person accepts it.
- **An issue is the unit of work.** One issue owns one worktree, one branch, one set of files it may change and one budget.
- **People set the pace.** Sekhemet queues work and waits for a person's decision instead of guessing.
- **Everything is recorded.** If it is not in the Activity log, it did not happen.
