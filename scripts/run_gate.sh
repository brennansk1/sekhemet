#!/usr/bin/env bash
# Run a release-gate fixture end to end from a clean scratch repository.
#
#   scripts/run_gate.sh <fixture> [--worker <model>] [--manager <model>]
#
# Each run copies the fixture into a fresh git repo, links the workspace's
# node_modules, seeds the cards, and runs `sekhemet queue --auto-accept`, so two
# runs differ only in the models and harness under test.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="${1:?usage: run_gate.sh <fixture> [queue args]}"; shift
SRC="$ROOT/fixtures/$FIXTURE"
[ -d "$SRC" ] || { echo "no such fixture: $SRC" >&2; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
RUN="${GATE_RUN_DIR:-/tmp/claude-501/gate-runs}/$FIXTURE-$STAMP"
mkdir -p "$RUN"
cp -R "$SRC/." "$RUN/"
ln -s "$ROOT/node_modules" "$RUN/node_modules"
(
  cd "$RUN"
  git init -q -b main
  git config user.email gate@sekhemet.local
  git config user.name "Sekhemet Gate"
  git add -A
  git commit -q -m "seed: $FIXTURE scaffold with staged acceptance tests"
)

if [ -f "$SRC/cards.json" ]; then
  node "$ROOT/scripts/seed_project.mjs" "$SRC" "$RUN"
else
  node "$ROOT/scripts/seed_chronicle.mjs" "$RUN"
fi

echo "gate run: $RUN"
node "$ROOT/apps/harness/dist/index.js" queue --auto-accept --repo "$RUN" "$@"
