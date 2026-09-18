# Project Onyx

A local secret vault and process injector: AES-256-GCM secrets with PBKDF2 key
derivation in a `node:sqlite` WAL database, in-memory injection into child
processes, an entropy and signature scanner for staged diffs, and a small CLI.

This repository is one of Sekhemet's three showcase release gates.

## Contract-first layout

`acceptance/` holds the acceptance tests for every card. They are **staged into
`tests/` one card at a time**, because a card's gate must measure that card:
shipping every suite up front makes card 2 fail on `vault.ts`, which is card 4's
work, and no early card could ever go green. `cards.json` lists the eight cards
in dependency order; `card_onyx_1_types` is gated by `tsc -b` alone.

An implementing agent must make the staged suite pass without altering any
assertion in it.

Run the gates with `pnpm typecheck`, `pnpm test`, and `pnpm lint`.
