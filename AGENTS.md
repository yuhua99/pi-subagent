# AGENTS.md

Pi extension (`@yuhua99/pi-subagent`): adds subagent delegation tools and the `/agents` command to the Pi coding agent. TypeScript runs directly — no build step. Entry point: `index.ts` (declared in `package.json` under `pi.extensions`).

## Invariants

- Resume only targets a successfully completed run from the same parent Pi session; it creates a new run ID, preserves lineage, and allows only one concurrent resume per lineage.
- Fork requires a persisted parent session; under `--no-session` it errors clearly with no manual fallback; spawn is unaffected.
- Fork children use the parent system prompt and schema-identical stub subagent tools; per-agent overrides are ignored in fork mode; `usage.cacheRead` diagnoses cache hits, not guarantees them.
- Tests import `.ts` files directly under `node --test` (Node type stripping). Do not use runtime TS syntax (enums, namespaces, parameter properties) and do not introduce a build step.

## Architecture contract

One owner per file. Do not create catch-all modules (`utils.ts`, `helpers.ts`, `common.ts`, `shared.ts`); use domain names.

- `index.ts` — tool registration and event wiring only
- `agents.ts` — agent discovery/parsing; `agents_command.ts` — `/agents` orchestration; `agents_overlay.ts` — shared overlay shell geometry; `agents_list.ts` — list UI/lifecycle; `agents_detail.ts` — detail UI/lifecycle
- `registry.ts` — in-memory run registry and status/stream subscriptions
- `tool_schema.ts` — subagent tool schemas, descriptions, and limits
- `task_summary.ts` — summary config and LLM completion
- `render.ts` — tool-row rendering only; rich detail belongs in `/agents`
- `types.ts` — shared types and small helpers; no I/O, no spawning
- `test/` — `*.test.mjs` suites and fixtures

Keep source files under ~600 LOC; split by ownership before adding more logic.

## Quality gates

```bash
bun install
bun run lint    # oxlint
bun run test    # node --test
```

Manual check: `pi -e .` · Publish check: `bun pm pack --dry-run`

## Commit format

`<type>: <imperative summary>`, sentence case. Types: `feat`, `fix`, `refactor`, `docs`, `chore` (e.g. `feat: add cache-aligned fork mode`). One logical change per commit; no vague messages (`update`, `cleanup`, `wip`).
