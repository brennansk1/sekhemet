# First run

## Set up: `sekhemet`

In your project's folder (a git repository), run:

```bash
sekhemet
```

The first time, with no `.sekhemet/config.toml` yet, it:

1. checks the machine: memory, Node.js, git, the sandbox and the inference engine;
2. says which models it found and which role each would fill;
3. derives the project's checks from the project itself (its package manager, test runner, type checker and linter) into `.sekhemet/gates.toml`;
4. asks you once, showing what it will write;
5. opens the board in your browser at `http://127.0.0.1:4040`.

While no model is set up it opens the **Configuration page** instead, where you point Sekhemet at the folder holding your models, or download the recommended ones on your yes ([Models](models.md)). Nothing is downloaded before that choice, and the first run makes no network request: Sekhemet is offline by default.

`sekhemet --yes` does the same without asking and prints the address instead of opening a browser. Later runs of `sekhemet` open the board. You do not have to write any configuration before your first issue.

**Trust.** Sekhemet never runs code the repository chose — its hooks, its MCP servers, another agent's configuration — before a person trusts the repository: `sekhemet trust`.

## Your first issue

Describe what you want, in a sentence or a paragraph:

```bash
sekhemet "add a CSV export to the reports page"
```

Seshat, the project manager, asks only what the request needs, writes a brief with *Must*, *Should* and *Could* requirements, and plans it as issues on the board: epics and thin stories, each with acceptance criteria and acceptance tests written before the code. Each issue waits in **Planning** until you approve its acceptance criteria: nothing is built from criteria no person has read. Open an issue on the board and approve it there, or approve the whole plan with the line the command prints:

```bash
sekhemet approve <epic>
sekhemet run
```

Then the Coding model builds each approved issue in its own git worktree, inside the sandbox, until the issue's checks pass or it stops and says why.

Expect it to take a while: a local model is slower than a cloud one. On this project's own 30-issue suite, a full run took 3.6 to 4.5 hours on the 24 GB reference Mac. Sekhemet is built for work you queue and come back to.

To follow along: the board shows each issue's column; `sekhemet ask "how is the CSV export going?"` answers from the terminal; `sekhemet status` prints the board for a script.

## Review and Accept

When an issue's checks pass, it moves to **In review**. Run:

```bash
sekhemet review
```

It shows the next issue waiting on you: what changed, the checks' results and, once a Review model is admitted, the AI review's findings, one per acceptance criterion. In v1 the Review role is not yet filled, and each issue says it had no AI review ([What Sekhemet does not do](what-sekhemet-does-not-do.md)).

Then decide:

| You want to… | Command | On the board |
| --- | --- | --- |
| Merge it | `sekhemet accept <issue>` | Accept: squash-merged to `main` without touching your working copy; it can be undone with `sekhemet revert <issue>` |
| Send it back | `sekhemet request-changes <issue> "<what to change>"` | Request changes: back to the Coding model with your reason |
| Pause it | `sekhemet park <issue> "<reason>"` | Put on hold; `sekhemet unpark <issue>` takes it off hold |
| Drop it | `sekhemet reject <issue> "<reason>"` | Won't do |

Nothing is done until its checks pass and a person accepts it. The model never certifies its own work.

## Talking to Seshat

You do not need to be a developer to use Sekhemet. On the board, open Seshat's panel and say what you want, in your own words; Seshat asks what it needs, shows you the plan before anything is built, and tells you how it is going when you ask. Starting a whole new project by conversation is in preview in v1 ([What Sekhemet does not do](what-sekhemet-does-not-do.md)).

## Everything is recorded

Every step — each plan, each command the model ran, each check, each decision a person made — is an event in one hash-chained log, the **Activity log**. The board, the audit trail and every measurement are read from it. `sekhemet log` shows its newest entries and whether its chain verifies, and `sekhemet egress` lists everything that left the machine.

## Next

- [Concepts](concepts.md): the words on the board, mapped to Jira and Linear.
- [Models](models.md): changing a role's model.
- [Solo and Team](solo-and-team.md): sharing Sekhemet with a team.
