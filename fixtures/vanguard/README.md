# Project Vanguard

A zero-dependency local webhook inspector and replay daemon: an HTTP ingestion
server that captures webhooks byte for byte, timing-safe HMAC verification for
Stripe and GitHub signatures, a `node:sqlite` WAL event store, a Server-Sent
Events stream of new events, and deterministic replay to a local URL.

This repository is one of Sekhemet's three showcase release gates. Every test
binds `127.0.0.1` on port 0; nothing touches the network.

## Contract-first layout

`acceptance/` holds the acceptance tests for every card. They are **staged into
`tests/` one card at a time**, because a card's gate must measure that card:
shipping every suite up front makes card 2 fail on `store.ts`, which is card 3's
work, and no early card could ever go green. `cards.json` lists the eight cards
in dependency order; `card_vang_1_types` is gated by `tsc -b` alone.

An implementing agent must make the staged suite pass without altering any
assertion in it.

Run the gates with `pnpm typecheck`, `pnpm test`, and `pnpm lint`.
