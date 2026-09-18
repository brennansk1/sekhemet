# Project Chronicle

A local-first cryptographic event ledger: append-only immutable logging, SHA-256
hash chaining, tamper detection, and an HTTP micro-API.

This repository is Sekhemet's public-release verification gate. The acceptance
tests are authored first and fail until the corresponding card is implemented;
an implementing agent must make them pass without altering any assertion.

Run the gates with `pnpm typecheck`, `pnpm test`, and `pnpm lint`.
