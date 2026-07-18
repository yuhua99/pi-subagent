# AGENTS.md

Pi extension (`@yuhua99/pi-subagent`): adds subagent delegation tools and the `/agents` command to the Pi coding agent. TypeScript runs directly — no build step. Entry point: `index.ts` (declared in `package.json` under `pi.extensions`).

## Invariants

- Single-level delegation: children run with `PI_SUBAGENT=1` (plus `PI_SUBAGENT_FORK=1` in fork mode). Spawn children register no extension tools; fork children must register schema-identical stub tools instead of returning early, or the parent's prompt cache is forfeited.
- Fork mode keeps the child's system prompt and tool schemas byte-aligned with the parent for cache reuse; `buildPiArgs` in `runner.ts` owns this and ignores per-agent overrides.
- Tests import `.ts` files directly under `node --test` (Node type stripping). Do not use runtime TS syntax (enums, namespaces, parameter properties) and do not introduce a build step.

## Architecture contract

One owner per file. Do not create catch-all modules (`utils.ts`, `helpers.ts`, `common.ts`, `shared.ts`); use domain names.

- `index.ts` — tool registration and event wiring only
- `agents.ts` — agent discovery/parsing; `agents_command.ts` — `/agents` UI
- `delegation.ts` — delegation mode, child-env markers, fork snapshots, placeholders
- `subagent_execution.ts` — subagent invocation orchestration, lifecycle, retention, and background delivery
- `session_files.ts` — managed child session JSONL creation, resume copies, existence checks, and cleanup
- `registry.ts` — in-memory run registry and status/stream subscriptions
- `runner.ts` — child process execution and CLI argument construction, without managed session state; `runner-cli.js` — parent CLI flag inheritance; `runner-events.js` — JSON-event parsing and result summaries
- `tool_schema.ts` — subagent tool schemas, descriptions, and limits
- `prompt_injection.ts` — system-prompt insertion and prompt path normalization
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
