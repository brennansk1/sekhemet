<!--
Pull requests from outside the project cannot be accepted until a contributor
licence agreement exists (see .github/CONTRIBUTING.md). Please open an issue or
a discussion describing the change instead.
-->

## What and why

<!-- The evidence that triggered this change: a failing issue, a replay, a measurement or a review finding. -->

## Checklist

- [ ] Tests first: the new test failed before the change, and passes after it
- [ ] The specification in `docs/design/specs/` is updated in the same change (behaviour, status, contract)
- [ ] No check loosened, no test weakened, the frozen suite untouched
- [ ] Generated docs regenerated if a command, a `doctor` check, a host or an editor snippet changed (`node scripts/gen_docs.mjs`)
- [ ] `pnpm gate` passes on this exact tree
- [ ] An independent review of the change
- [ ] Commit trailers: `Card`, `Agent-Model`, `Agent-Harness`, `Agent-Role`, `GateStatus`
