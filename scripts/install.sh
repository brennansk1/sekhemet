#!/usr/bin/env bash
# Sekhemet installer (H25). Works offline once the repository and its pnpm
# store are present: `pnpm install --offline` resolves from the local store.
# It checks the toolchain, installs workspace dependencies, builds, and links
# the `sekhemet` command. It never downloads a model: models are the user's
# choice (see `sekhemet init` for the recommended roster).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1. $2" >&2; exit 1; }; }
need node "Install Node.js 22.13 or newer."
# The built-in node:sqlite without a flag needs 22.13 (surface item 5a), as
# the npm package's `engines` says.
version="$(node -p 'process.versions.node')"
major="${version%%.*}"
minor="${version#*.}"
minor="${minor%%.*}"
if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 13 ]; }; then
  echo "Node $version found; Sekhemet needs 22.13 or newer." >&2
  exit 1
fi
need git "Install git."
command -v pnpm >/dev/null 2>&1 || corepack enable pnpm

if [ "${1:-}" = "--offline" ]; then
  pnpm install --offline --frozen-lockfile
else
  pnpm install --frozen-lockfile
fi
pnpm exec tsc -b
chmod +x apps/harness/dist/index.js
mkdir -p "$HOME/.local/bin"
ln -sf "$here/apps/harness/dist/index.js" "$HOME/.local/bin/sekhemet"
echo "Installed: $HOME/.local/bin/sekhemet"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "Add ~/.local/bin to your PATH." ;; esac
echo "Next, in your project: sekhemet init"
