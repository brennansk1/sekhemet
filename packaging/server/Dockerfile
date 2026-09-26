# syntax=docker/dockerfile:1
#
# The team server image (surface item 31, NEW-surface-4, SUR-42). One image:
# the harness, installed from the same npm tarball a person installs
# (`scripts/pack_npm.mjs`), serving the dashboard behind an identity-aware
# proxy. The inference engine is NOT in this image: it runs in its own
# container (compose.yaml, service `inference`). docs/reference/INSTALL.md
# is the documentation. Nothing is published: build it where you run it.
#
#   docker build -f packaging/server/Dockerfile -t sekhemet-server .

FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm build \
 && node scripts/pack_npm.mjs --out /pack

FROM node:24-bookworm-slim
# git for worktrees; bubblewrap confines every repository process on Linux
# (security items 4–8; the sandbox refuses to run unconfined).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git bubblewrap ca-certificates \
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
