# AGENTS.md

Pi extension (`@yuhua99/pi-subagent`): adds subagent delegation tools and the `/agents` command to the Pi coding agent. TypeScript runs directly — no build step. Entry point: `index.ts` (declared in `package.json` under `pi.extensions`).

## Invariants

- Single-level delegation: children run with `PI_SUBAGENT=1` (plus `PI_SUBAGENT_FORK=1` in fork mode). Spawn children must not register any extension tools; fork children must register schema-identical stub tools instead of returning early — omitting them diverges the tool segment and forfeits the parent's prompt cache (see `index.ts`).
- Fork mode must keep the child's system prompt and tool schemas aligned with the parent for cache reuse; `buildPiArgs` in `runner.ts` owns this and ignores per-agent overrides in fork mode.
- Tests import `.ts` files directly under `node --test` (Node type stripping). Do not use runtime TS syntax (enums, namespaces, parameter properties) and do not introduce a build step.

## Architecture contract

One owner per file. Do not create catch-all modules (`utils.ts`, `helpers.ts`, `common.ts`, `shared.ts`); use domain names.

- `index.ts` — entry point: tool registration and event wiring only
- `agents.ts` — agent discovery and Markdown/frontmatter parsing
- `agents_command.ts` — `/agents` command UI (run list + transcript popup)
- `delegation.ts` — delegation mode, child-env markers, fork session snapshots, placeholder results
- `registry.ts` — in-memory run registry and status/stream subscriptions
- `runner.ts` — child process execution: `buildPiArgs`, `runAgent`, concurrency
- `runner-cli.js` — inheriting selected parent CLI flags into children
- `runner-events.js` — Pi JSON-mode event parsing and result summarizing
- `render.ts` — TUI rendering for tool rows; rich detail belongs in `/agents`, not tool rows
- `tool_schema.ts` — TypeBox tool schemas and tool descriptions
- `prompt_injection.ts` — system prompt injection helpers
- `types.ts` — shared types and small helpers only; no I/O, no spawning
- `agents/` — bundled agent definitions (`*.md`)
- `test/` — `node --test` suites (`*.test.mjs`) and fixtures

Keep source files under ~600 LOC; split by ownership before adding more logic.

## Quality gates

```bash
bun install
bun run lint    # oxlint
bun run test    # node --test
```

Manual check as a local extension: `pi -e .`
Publish check: `bun pm pack --dry-run`

## Commit format

`<type>: <imperative summary>`, sentence case. Types: `feat`, `fix`, `refactor`, `docs`, `chore`.

Examples: `feat: add cache-aligned fork mode`, `fix: hide spawn mode badge on subagent tool rows`.

One logical change per commit. No vague messages (`update`, `cleanup`, `wip`).
