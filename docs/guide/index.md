# The Sekhemet user guide

Sekhemet is a coding harness for professional teams. You describe what you want to Seshat, the project manager; Sekhemet writes a brief, plans it as a backlog on a board, builds each issue with a local model in its own sandboxed git worktree against checks the model cannot edit, and a person accepts the result. Everything runs on your own machine, or on your team's own server.

This guide is for people using Sekhemet. How it is built is in the [design](../design/SPINE.md); where the project stands is in [STATUS](../reference/STATUS.md).

## Start here

| If you are… | Read |
| --- | --- |
| A developer trying it on your own machine | [Install](install.md), then [First run](first-run.md) |
| New to professional practice, or to boards like Jira and Linear | [Concepts](concepts.md), then [First run](first-run.md) |
| Not a developer, and want something built | [First run](first-run.md) § *Talking to Seshat*, and [What Sekhemet does not do](what-sekhemet-does-not-do.md) |
| Setting up a server for your team | [Solo and Team](solo-and-team.md), then the [Team administrator's guide](team-admin.md) |
| Checking what leaves your machine | [Privacy and network](privacy-and-network.md) |

## Every page

| Page | What it covers |
| --- | --- |
| [Install](install.md) | Requirements, macOS and Ubuntu, what you download and how big it is |
| [First run](first-run.md) | What the first `sekhemet` does, your first issue, review and Accept |
| [Models](models.md) | The four roles, the recommended models, the inference engine, verifying a model |
| [Solo and Team](solo-and-team.md) | The two setups, access levels, the Accept rule, switching |
| [Team administrator's guide](team-admin.md) | The server image, both compose profiles, `/healthz`, members, backups and updates |
| [Concepts](concepts.md) | Sekhemet's words, mapped to Jira's and Linear's |
| [Editors](editors.md) | Connecting VS Code, Cursor and Zed |
| [Upgrade and uninstall](upgrade-and-uninstall.md) | Upgrading, rolling back, removing everything an install wrote |
| [Troubleshooting](troubleshooting.md) | Every check `sekhemet doctor` runs, and what to do when one fails |
| [Privacy and network](privacy-and-network.md) | Every host Sekhemet can contact, what is sent, and how to turn it off |
| [CLI reference](cli-reference.md) | Every command, its synopsis and an example |
| [What Sekhemet does not do](what-sekhemet-does-not-do.md) | The limits, stated plainly |
| [FAQ](faq.md) | Common questions, including using Sekhemet at work under its licence |

The CLI reference, the troubleshooting checks, the privacy hosts and the editor snippets are generated from the product's own tables, and the build fails when one of them drifts.

## Getting help

Questions go to GitHub Discussions and bugs to GitHub Issues, with the folder `sekhemet doctor --report` writes; [SUPPORT](../../.github/SUPPORT.md) says how. Report a vulnerability privately, as [SECURITY](../../.github/SECURITY.md) says, never in a public issue.
