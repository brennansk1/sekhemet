# FAQ

## The licence

### Is Sekhemet open source?

No. Sekhemet is **source-available**, under the Functional Source License, version 1.1, with Apache-2.0 as the future licence (FSL-1.1-ALv2), a *Fair Source* licence. You can read, run, change and redistribute the code for any purpose except a *Competing Use*: offering it to others in a commercial product or service that substitutes for Sekhemet or does substantially the same thing. Two years after each version is released, that version is also available under Apache-2.0.

### Can I use Sekhemet at work?

Yes. The licence expressly permits internal use: your company may install Sekhemet and use it to build its own software, including software it sells. Non-commercial education and research are expressly permitted, and so is consulting: using Sekhemet in professional services for a client who is a licensee. What it does not permit is offering Sekhemet, or something substantially like it, to others as a commercial product or service. If your use is near that line, read the [LICENSE](../../LICENSE) and ask your own lawyer; this answer is not legal advice.

### Who owns the code Sekhemet writes for me?

You do. Sekhemet claims no rights to it, and the FSL's terms cover Sekhemet itself, not what you build with it. Whether AI-written code can be protected by copyright varies by country; every commit records which model wrote it ([What Sekhemet does not do](what-sekhemet-does-not-do.md)).

### Why can I not install it with Homebrew or apt?

Homebrew's core formulae and the Linux distributions' repositories take only licences approved by the OSI or meeting Debian's Free Software Guidelines, and FSL is neither. Sekhemet is distributed two ways: the npm package (from 0.9.0) and the source. You can still install llama.cpp with Homebrew.

### Why this licence?

It keeps the code open to read, change and use for nearly anything, while the author keeps the right to offer a paid hosted edition one day; each version becomes Apache-2.0 after two years. The reasoning is in [DEC-48](../design/DECISIONS.md#dec-48--the-licence-is-fsl-11-alv2).

## Privacy

### Does my code leave my machine?

Not unless you allow it. The network is off by default, Sekhemet sends no telemetry, and every model runs locally. What can leave, when, and the setting that turns it off is on [Privacy and network](privacy-and-network.md); `sekhemet egress` lists what did.

### Does Sekhemet phone home for updates?

No. It never checks for a release on its own; `sekhemet doctor --check-updates` asks once, on your yes ([Upgrade and uninstall](upgrade-and-uninstall.md)).

## Using it

### How long does an issue take?

On this project's own 30-issue suite, a full run took 3.6 to 4.5 hours on the 24 GB reference Mac: about 7 to 9 minutes an issue on average, more for a hard one. Queue work, and come back to review it.

### Why 24 GB of memory?

The Coding model alone is about 14 GB, and Sekhemet swaps models between roles. v1 is tested only at 24 GB and above, and does not promise a 16 GB tier.

### Can I use my own models?

Yes: register any GGUF file with `sekhemet models add <path-to.gguf>`, assign it to a role, and verify it on your machine ([Models](models.md)).

### Can I use a cloud model, such as Claude?

Not in v1: every role runs locally. A cloud model per role is planned after v1, as an option, never a dependency.

### Why is there no AI review?

No local model has yet caught enough of a seeded set of defects to be trusted with the Review role, so it ships unfilled and each issue says it had no AI review. The checks still run, and a person still accepts.

### Does it work with my existing repository?

Yes: run `sekhemet` in it. To adopt an unfinished project, with its own history and gaps, `sekhemet take-over` reads it first and proposes a plan.

### Does it replace Jira or Linear?

It has its own board, in their words ([Concepts](concepts.md)). GitHub issues, pull requests and the Projects board sync both ways; Jira and Linear boards move by export and import.

### Can I use it from my editor?

Yes, through MCP in VS Code and Cursor, and through ACP and MCP in Zed ([Editors](editors.md)).

## Getting help

### Where do I ask a question or report a bug?

Questions in GitHub Discussions, bugs in GitHub Issues with the folder `sekhemet doctor --report` writes, and vulnerabilities privately ([SUPPORT](../../.github/SUPPORT.md), [SECURITY](../../.github/SECURITY.md)).

### Can I contribute code?

Not yet. Issues, ideas and discussions are welcome from 0.9.0; code from outside the project waits for a contributor licence agreement ([CONTRIBUTING](../../.github/CONTRIBUTING.md)).
