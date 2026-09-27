# Take-over fixtures (design-stage DS-TO-15)

Five small repositories someone else left, each taken over by the harness in
`apps/harness/tests/takeover_fixtures.spec.ts`. Each folder holds the files of
its first commit under `repo/` and, in `fixture.json`, the later commits (a
secret committed then removed, a fix that closes an issue, a file deleted) and
the tracker issues it inherits. The test builds each as a real git repository
in a temporary directory; nothing here is a git repository itself, and no
secret is stored here: the committed one is generated when the fixture is built.

- `half-built-ts` — a TypeScript app whose suite fails and whose PDF export is a stub.
- `broken-build` — a repository whose build fails on a missing module; its tests pass.
- `python-stubs` — a Python project with a stub that raises `NotImplementedError`.
- `committed-secret` — a fake token committed and later removed from the tree.
- `inherited-issues` — open tracker issues: one done by a commit, a duplicate, a stale one and valid ones.
