# Solo and Team

Sekhemet is one product with two setups. The board, the issues, the checks and Accept are the same in both; what changes is who signs in.

| | Solo | Team |
| --- | --- | --- |
| **For** | One person on their own machine | A team sharing one server on its own hardware |
| **Installed from** | The npm package, or from source ([Install](install.md)) | The server image ([Team administrator's guide](team-admin.md)) |
| **The dashboard listens on** | `127.0.0.1:4040`, this computer only | The team's address, behind a proxy that terminates TLS |
| **Sign-in** | None: the person logged in to the computer is the only user and can do everything | Accounts: passwords, passkeys and invites, or your company's sign-in (OIDC) through an identity proxy |
| **Access levels** | — | Admin, Member, Stakeholder, Viewer |
| **Inbox, presence, audit view** | Inbox only | All three |

## Access levels (Team)

Every person has one level for the workspace. An Admin or a project's lead can raise or lower it for a single project.

| Level | Can |
| --- | --- |
| **Admin** | Everything a Member can, plus: manage members, invites and levels; Configuration, models and the queue's limits; the audit view; trust a repository; connect an integration |
| **Member** | Create, edit, move and assign issues; delegate an issue to the Agent, guide it, pause it and take it over; start runs; review; apply Seshat's proposals |
| **Stakeholder** | File issues, comment, talk to Seshat and start a project conversation, answer questions addressed to them. Cannot start the Agent, change scope or priority, or accept |
| **Viewer** | Read everything in the projects they can see, comment, and ask Seshat questions |

## The Accept rule

Each project has an **Accept rule**: who may accept its issues. An Admin or the project's lead edits it on the project's settings. Accept is refused to anyone the rule does not name. When a member leaves and the rule names nobody left, Accept is refused, and the lead and the Admins are told, until a person edits the rule; Sekhemet never picks someone else to accept.

## AI teammates

`@Agent` and `@Seshat` appear on the board as labelled AI teammates. A person is always the issue's **Assignee**, responsible for it; when the Agent works an issue it is the issue's **Delegate**, and it acts on behalf of that person. The AI proposes; people decide.

## Switching

A Solo install switches to Team from Configuration. The Activity log is kept, nothing is rewritten, and the Solo user becomes the first Admin. A Team install never falls back to Solo by accident: once it has a member, `sekhemet serve` refuses to start as Solo until someone runs `sekhemet serve --switch-to-solo`, which is recorded.

## Projects and workspaces

A server is one **workspace**, and each project in it keeps its own git repository. People switch projects and workspaces from the sidebar. A workspace holding many projects is partly built in v1; [STATUS](../reference/STATUS.md) says where it stands.
