# Installing Sekhemet

One install path per audience ([surface](../design/specs/surface.md) item 31, NEW-surface-4; owner decision O9 in [DEC-29](../design/DECISIONS.md)). Neither artefact is published yet: each is built from this repository, and where it goes is the owner's decision.

## For one person: the npm package

```bash
pnpm install && pnpm build
node scripts/pack_npm.mjs --out packaging/out     # prints packaging/out/sekhemet-<version>.tgz
npm install --global packaging/out/sekhemet-<version>.tgz
```

The tarball bundles every dependency, so the install needs no registry and no build step (SUR-41). It needs Node.js 22.13 or newer ([surface](../design/specs/surface.md) item 5a). Then, in a repository:

```bash
sekhemet
```

That is the whole setup: the first run checks the machine, says which models it found, derives the gates from the project, asks once, and opens the board — or the Configuration page while no model is set up. `sekhemet --yes` does the same without a prompt and prints the address instead of opening a browser.

## For a team: the server image

`packaging/server/Dockerfile` builds one image holding the harness, installed from the same npm tarball; `packaging/server/compose.yaml` runs it with the two containers it needs beside it (SUR-42):

| Container | What it is |
| --- | --- |
| `identity-proxy` | The **identity-aware proxy** (oauth2-proxy in the example): it terminates TLS with the certificate and key you mount at `/tls` (`tls.crt`, the full chain, and `tls.key`; only its HTTPS listener, on 443, is published), signs people in with your OIDC provider and passes each person's email in `X-Forwarded-Email`. Sekhemet trusts that header only from the addresses listed in `[identity] trusted_proxies` of the server's user configuration ([integrations](../design/specs/integrations.md) item 24, [teams](../design/specs/teams.md) item 13). |
| `inference` | The **inference engine, in its own container** (llama.cpp's server with the Worker's weights). The harness shares its network namespace and reaches it on loopback, as on a laptop; a server whose model or context differs from the Worker's profile is refused. |
| `sekhemet` | The harness: `sekhemet dev serve --host 0.0.0.0` over the repository mounted at `/work`, with its user directory in a volume. |

```bash
docker build -f packaging/server/Dockerfile -t sekhemet-server .
docker compose -f packaging/server/compose.yaml up
```

In the server's user configuration (`/home/node/.sekhemet/config.toml` in the volume):

```toml
[identity]
sources = ["proxy"]
user_header = "x-forwarded-email"
trusted_proxies = ["<the proxy container's address>"]
```

Repository processes run confined by bubblewrap, which needs unprivileged user namespaces inside the container; the compose file relaxes seccomp and AppArmor for that one service. The image has not yet been built and run on a Linux host by this project: that check is owed before a release.

## From source

For developing the harness and for the air-gap kit, the source install of [DEC-21](../design/DECISIONS.md) remains: `pnpm install && pnpm build`, then `node apps/harness/dist/index.js`.
