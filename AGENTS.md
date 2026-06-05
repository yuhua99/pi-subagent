# AGENTS.md

## Architecture contract

Keep the repository organized by ownership. Do not create catch-all modules.

Source layout:

- `index.ts` — extension entry point and tool registration only
- `agents.ts` — agent discovery and parsing only
- `runner.ts` — subagent process execution only
- `render.ts` — TUI rendering for tool calls and results only
- `types.ts` — shared types and small helpers only
- `README.md` — user-facing docs

Boundary rules:

- `index.ts` should not contain discovery logic, process execution, or rendering.
- `agents.ts` should not spawn processes or render output.
- `runner.ts` should not parse agent definitions or format TUI output.
- `render.ts` should not know about agent discovery, process execution, or business logic.
- `types.ts` should not perform I/O, spawn processes, or contain large logic blocks.

## No junk drawers

Do not create generic dumping grounds.

Avoid names like:

- `utils.ts`
- `helpers.ts`
- `common.ts`
- `misc.ts`
- `shared.ts`

Prefer domain names that encode ownership:

- `delegation.ts`
- `depth_guard.ts`
- `agent_resolution.ts`
- `tool_schema.ts`

## File size

- Source files should target under ~600 LOC.
- If a file approaches ~600 LOC, split by ownership before adding more logic.

## Repository setup

- Requirements: Bun
- Install dependencies:

```bash
bun install
```

- Check what would be published:

```bash
bun pm pack --dry-run
npm publish --dry-run --access public
```

## Local validation

- This package is a Pi extension (entry point: `index.ts`).
- Quick manual check with local package:

```bash
pi -e .
```

## Commit format

Use `<type>: <imperative summary>`, sentence case.

Allowed types: `feat`, `fix`, `refactor`, `docs`, `chore`.

Examples:

- `feat: add depth-limited subagent delegation`
- `fix: preserve agent context on fork mode`
- `refactor: move process execution to runner`
- `docs: document tool registration contract`
- `chore: scope npm package name`

Keep commits focused. One logical change per commit. Avoid vague messages like `update`, `cleanup`, or `wip`.

## Release

- Package name: `@mjakl/pi-subagent`
- For doc/code changes on npm, publish a new version (`npm version patch|minor|major`), then publish.
