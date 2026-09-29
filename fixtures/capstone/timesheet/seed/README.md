# Timesheet

The starting repository for the bakery's timesheet app. What to build is in the message you were given: the brief, the owner's answers and the technical notes. This file says only what the repository itself provides. Where the two ever seem to differ, the technical notes decide.

## What is here

- `package.json`, `package-lock.json`: the toolchain, pinned to exact versions.
  - Node.js 26.0.0 (also in `.nvmrc`). `.npmrc` sets `engine-strict=true`, so another Node version refuses to install, and `save-exact=true`, so a package you add is pinned too.
  - TypeScript 5.9.3 and `@types/node` 26.0.1.
  - Tests use Node's built-in test runner (`node:test` and `node:assert`); nothing to install.
- `tsconfig.json`: strict TypeScript, compiling `src/` to `dist/` as ES modules (`"type": "module"`), so a relative import ends in `.js` (`import { x } from "./pay.js"`). The compiler emits only JavaScript: any other file (a page, a stylesheet) is read from where it sits, not from `dist/`.
- `.gitignore`: `node_modules/`, `dist/` and `data/`.

There is no application code and there are no tests.

## The commands

| Command | As seeded |
| --- | --- |
| `npm install` | installs the pinned toolchain |
| `npm run build` | compiles `src/` to `dist/` |
| `npm start` | runs `dist/main.js`, compiled from `src/main.ts` |
| `npm test` | compiles, then runs every `dist/**/*.test.js`; exits 0 when they pass |

You may change these scripts, add npm packages and add any files, as long as the four commands still do what the technical notes say. `npm start` reads `PORT` (default `3000`) and `DATA_DIR` (default `./data`) as the notes describe.
