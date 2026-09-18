# Project Basalt Canvas

A dense developer dashboard built as pure TypeScript: the Basalt/Sand design
tokens, an immutable board store, card tiles with gate strips, a kanban board
with WIP limits and virtualization, a layered dependency DAG with pan and zoom,
a Cmd+K command palette, and a WCAG 2.1 contrast audit.

There is no DOM library. Every component is a pure function that returns an HTML
or SVG string, or plain layout data, so every visual contract is tested in Node.

This repository is one of Sekhemet's three showcase release gates.

## Contract-first layout

`acceptance/` holds the acceptance tests for every card. They are **staged into
`tests/` one card at a time**, because a card's gate must measure that card:
shipping every suite up front makes card 1 fail on `board.ts`, which is card 4's
work, and no early card could ever go green. `cards.json` lists the eight cards
in dependency order.

An implementing agent must make the staged suite pass without altering any
assertion in it.

Run the gates with `pnpm typecheck`, `pnpm test`, and `pnpm lint`.
