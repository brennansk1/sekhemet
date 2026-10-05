# syntax=docker/dockerfile:1
#
# The team server image (surface item 31, NEW-surface-4, SUR-42). One image:
# the harness, installed from the same npm tarball a person installs
# (`scripts/pack_npm.mjs`), serving the dashboard behind an identity-aware
# proxy. The inference engines are NOT in this image: each filled role's
# engine runs in its own container (compose.yaml, the `engine-*` services;
# models rule 26a). docs/reference/INSTALL.md is the documentation. Nothing
# is published: build it where you run it. Base images are pinned by digest
# (MD-N15-4).
#
#   docker build -f packaging/server/Dockerfile -t sekhemet-server .

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm build \
 && node scripts/pack_npm.mjs --out /pack

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
# Every program the harness spawns on Linux (MD-N15-1, DEC-50): git for
# worktrees; bubblewrap confines every repository process (security items
# 4–8; the sandbox refuses to run unconfined); socat relays a card's named
# ports and the proxy route into the confinement.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git bubblewrap socat ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /pack/ /tmp/pack/
RUN npm install --global --offline --no-audit --no-fund /tmp/pack/sekhemet-*.tgz \
 && rm -rf /tmp/pack
USER node
# One user directory (surface item 22): config, trust records, the registry.
ENV SEKHEMET_CONFIG_DIR=/home/node/.sekhemet
WORKDIR /work
VOLUME ["/work", "/home/node/.sekhemet"]
EXPOSE 4040
ENTRYPOINT ["sekhemet"]
# Team setup (runtime item 26): bound beyond loopback only behind the proxy
# named in [identity] trusted_proxies.
CMD ["dev", "serve", "--repo", "/work", "--host", "0.0.0.0"]
