# Security policy

Sekhemet runs a coding model that it treats as untrusted, on your machine or your team's server, so the boundaries around it matter. Thank you for helping keep them sound.

## Supported versions

Security fixes go to the newest release line only.

| Version | Receives security fixes |
| --- | --- |
| `0.9.x` (the public pre-release, the first published version) | Yes |
| `0.1.x` (development builds, installed from source, never published) | No: update to the newest release, or to the newest `main` for a source install |

When 1.0 is released, this table names the lines that receive fixes and for how long.

## Reporting a vulnerability

**Report it privately, never in a public issue, discussion or pull request.**

Use GitHub's private vulnerability reporting: open <https://github.com/brennansk1/sekhemet/security/advisories/new> (the repository's *Security* tab, then *Report a vulnerability*). Only the maintainer sees the report.

Please include:

- the version (`sekhemet --version`) and the platform (macOS or Linux, and which);
- what an attacker can do, and what they need first;
- the steps to reproduce it, or a proof of concept;
- the folder `sekhemet doctor --report` writes, if it helps: it is redacted, but read it before you attach it.

Sekhemet is maintained by one person. You will get an acknowledgement, then a fix or a plan with a date, through the advisory. Please give us a reasonable time to release a fix before you disclose it publicly; the advisory credits you unless you ask otherwise.

## What is in scope

- Escaping the sandbox: a command the Coding model runs writing outside its issue's worktree and scratch folder, reading a masked secret, or reaching the network the policy refuses.
- The network policy: a request leaving the machine that the policy should have refused, or one that is not recorded.
- The dashboard and the Team server: signing in, sessions, access levels, the Accept rule, the setup token, Host and Origin checks.
- The Activity log: a change to it that verification does not detect.
- Secrets: an integration credential or a password reaching the Activity log, a log file, a report or an export.
- Downloads: a model or engine file used without its hash verified.

## What is not

- The quality of code a model writes for your project: that is what your project's checks and a person's acceptance are for.
- A model following instructions planted in a repository, when the sandbox contains what it does. (A way out of the sandbox is in scope.)
- Vulnerabilities in a dependency that Sekhemet does not reach; report those to the dependency.

The security model and its named residual risks are in [the security specification](../docs/design/specs/security.md). What leaves your machine, and how to turn each off: [Privacy and network](../docs/guide/privacy-and-network.md).
