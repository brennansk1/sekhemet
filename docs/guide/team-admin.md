# Team administrator's guide

This page is for the person who runs Sekhemet's server for a team: installing it, the first Admin, members, health checks, backups and updates. The step-by-step commands for each compose profile, with every file to edit, are in [INSTALL](../reference/INSTALL.md) § *For a team*; this page explains the choices and the running of it.

## What you run

One image holds the harness (`packaging/server/Dockerfile`, built from this repository); it starts `sekhemet serve` over the repository mounted at `/work`, with its user directory in a volume. Beside it run the **inference engines**, one llama.cpp container per filled role, reached on loopback inside the harness's network namespace.

The engines keep their models resident, so their memory adds up: about 53 GB of GPU memory for the recommended Coding, Planning and Research models together (system memory on the CPU image, which is slow). [INSTALL](../reference/INSTALL.md) gives each engine's figure and the image for NVIDIA, AMD or Intel GPUs and for the CPU.

The image has not yet been built and run on a Linux host by this project; that check is owed before a release.

## Choose a compose profile

| | `builtin` (`compose.builtin.yaml`) | `proxy` (`compose.yaml`) |
| --- | --- | --- |
| **For** | A team with no identity provider | A team that signs in with its company's provider (OIDC) |
| **Sign-in** | Sekhemet's own accounts: passwords (15 characters or more), passkeys and invites | Your provider, through the identity proxy (oauth2-proxy in the example), which passes each person's email to Sekhemet |
| **TLS** | The reverse proxy you already run (nginx, Caddy, Traefik, a cloud load balancer) terminates TLS and forwards to `127.0.0.1:4040` on the host | The identity proxy terminates TLS with the certificate and key you mount; only its HTTPS port is published |
| **Settings** | `[identity] sources = ["accounts", "passkeys"]` | `[identity] sources = ["proxy"]`, `trusted_proxies` naming the proxy |

Either way the server must be reached over HTTPS: `sekhemet doctor` fails its *Team address* check while `[identity] public_url` is not `https://…`. Sekhemet trusts a forwarded identity header only from the addresses in `trusted_proxies`.

## The first Admin

The first start writes a one-time **setup token** to a file only the server can read, and prints only that file's path, so container logs never hold the token. Read it with `docker compose exec`, open the server's address, and present the token with your name and email (and a password, in the `builtin` profile): you are the first Admin. The token is valid for 24 hours; `sekhemet serve --new-setup-token` writes a new one while no Admin exists. The first Admin is always made by the setup token, never by the first person to sign in.

## Members

Invite people from the **Members** page: each invite names an email address and a level (Admin, Member, Stakeholder or Viewer; [Solo and Team](solo-and-team.md) says what each can do). An Admin changes a level there, and an Admin or a project's lead can override it for one project.

When someone leaves, remove them from Members. Sekhemet first lists what they leave behind: the open issues they are the Assignee of, the projects and releases they lead, each Accept rule that names them, and the Agent work they started, which is paused. An Accept rule left naming no one refuses Accept until a person edits it.

The **audit view** (Admins only) lists who did what, from the Activity log, and exports it.

## Health checks

`GET /healthz` answers without signing in and carries no data: **200** while the Activity log opens and its hash chain's head verifies, **503** otherwise. The image's `HEALTHCHECK` and both compose files use it; point an uptime monitor at the same path.

```bash
curl -fsS https://<your server>/healthz
```

`docker compose ps` shows each container's health, the engines' included.

## Backups

Sekhemet backs the workspace up outside the repository: the Activity log, its blobs and evidence, each project's configuration and the credential store, each set verified before it is kept. A set is written automatically the first time the server or a run starts on a calendar day, and Sekhemet keeps the newest set of each of the last 7 days and 4 weeks (`[backup] enabled`, `keep_daily` and `keep_weekly` in the server's config.toml). Take one now, or list the sets with their schema versions:

```bash
docker compose -f packaging/server/compose.builtin.yaml exec sekhemet sekhemet backup
docker compose -f packaging/server/compose.builtin.yaml exec sekhemet sekhemet backup --list
```

The sets live in the server's user-directory volume, so copy them off the host too (for example `docker compose cp sekhemet:/home/node/.sekhemet/backups ./sekhemet-backups`). A backup set holds the credential store: keep its copies as private as the server.

To restore, stop the server, restore the newest set that verifies (or name one: `restore <set folder>`), and start it again. Restoring re-applies every erasure recorded since the backup.

```bash
docker compose -f packaging/server/compose.builtin.yaml stop sekhemet
docker compose -f packaging/server/compose.builtin.yaml run --rm sekhemet restore --latest
docker compose -f packaging/server/compose.builtin.yaml start sekhemet
```

Use `compose.yaml` instead in each command for the `proxy` profile.

## Updates

Sekhemet never checks for a release on its own. `sekhemet doctor --check-updates` asks the npm registry once, on your yes, and prints the latest version and its release notes. To update, rebuild the image from the new release and restart with `docker compose up -d`; the first start migrates the Activity log forward after backing it up, and refuses a log newer than itself, naming the backup to restore. See [Upgrade and uninstall](upgrade-and-uninstall.md).

## Network

The server makes no request beyond the engines on loopback unless your configuration allows it, and records each request it makes. What can leave, and how to turn each off: [Privacy and network](privacy-and-network.md). `sekhemet egress` and Configuration › Project › *Network activity* list what did.
