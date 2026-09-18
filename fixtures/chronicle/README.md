# Project Chronicle

A local-first cryptographic event ledger: append-only immutable logging, SHA-256
hash chaining, tamper detection, and an HTTP micro-API.

This repository is Sekhemet's public-release verification gate.

## Contract-first layout

`acceptance/` holds the acceptance tests for every card. They are **staged into
`tests/` one card at a time**, because a card's gate must measure that card:
shipping all six suites up front makes card 1 fail on `hasher.ts`, which is
card 2's work, and no early card could ever go green.

An implementing agent must make the staged suite pass without altering any
assertion in it.

Run the gates with `pnpm typecheck`, `pnpm test`, and `pnpm lint`.
