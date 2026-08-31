# AGENTS.md

Pi extension (`@yuhua99/pi-subagent`): adds subagent delegation tools and the `/agents` command to the Pi coding agent. TypeScript runs directly — no build step. Entry point: `index.ts` (declared in `package.json` under `pi.extensions`).

## Architecture contract

One owner per file. Do not create catch-all modules (`utils.ts`, `helpers.ts`, `common.ts`, `shared.ts`); use domain names.

- `index.ts` — tool registration and event wiring only
- `agents/shell.ts` — shared overlay shell geometry (not a bash shell)
- `tool/render.ts` — tool-row rendering only; rich detail belongs in `/agents`
- `tool/activity_summary.ts` — activity summary config; calls the LLM
- `types.ts` — shared types and small helpers; no I/O, no spawning
- `test/` — `*.test.mjs` suites and fixtures; import `.ts` directly under `node --test` (no build step, no runtime TS syntax: enums, namespaces, parameter properties)

Keep source files under ~600 LOC; split by ownership before adding more logic.

Reach for Pi built-ins first: check `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` exports and docs for an existing component, helper, or type before writing an equivalent.

## Quality gates

```bash
bun install
bun run lint       # oxlint
bun run typecheck  # oxlint --type-aware --type-check via tsgolint
bun run test       # node --test
```

Manual check: `pi -e .` · Publish check: `bun pm pack --dry-run`

## Commit format

`<type>: <imperative summary>`, sentence case. Types: `feat`, `fix`, `refactor`, `docs`, `chore` (e.g. `feat: add run cancellation`). One logical change per commit; no vague messages (`update`, `cleanup`, `wip`).
