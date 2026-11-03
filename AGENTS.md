# AGENTS.md

Pi extension, TypeScript run directly by pi and `node --test`: use only erasable TS syntax (no enums, namespaces, parameter properties).

## Architecture contract
- One owner per file, named by domain (no `utils.ts`/`helpers.ts`/`common.ts`/`shared.ts`).
- `index.ts`: tool registration and event wiring only.
- `execution/<backend>.ts` (herdr, rex): that multiplexer's CLI calls only; selection lives in `execution/multiplexer.ts`.
- `types.ts`: types and pure helpers; no I/O.
- Files stay under ~600 LOC; split by ownership first.
- Before writing a component/helper/type, check `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` exports.

## Checks
`package.json` scripts (lint, typecheck, test). Manual: `pi -e .` · Publish: `bun pm pack --dry-run`

## Commits
`<type>: <imperative summary>`, sentence case, one logical change each (types: feat, fix, refactor, perf, docs, chore).
