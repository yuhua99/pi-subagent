# Pi Subagent

**Delegate tasks to specialized subagents in isolated `pi` processes.**

Originally forked from [mjakl/pi-subagent](https://github.com/mjakl/pi-subagent); this package is a substantial rewrite (async delegation, `/agents` TUI, `subagent_ctl`, single-level nesting).

## Features

- **Isolated task-only context** — each run receives only its task
- **Native session resume** — continue a successfully completed child with `{ "action": "resume", "resume_id": "run-id", "task": "..." }`
- **Async by default** — tool returns as soon as the child starts; results arrive as a follow-up message
- **Parallel runs** — up to 8 tasks, 4 concurrent
- **Single-level only** — children cannot nest further subagents
- **`/agents`** — live status and transcript preview in the TUI
- **`subagent_ctl`** — list, inspect, stop, or steer children
- **Orchestrator file** — main-agent-only delegation policy via `role: orchestrator`

## Install

```bash
pi install git:github.com/yuhua99/pi-subagent
```

## Agent definitions

Markdown + YAML frontmatter:

| Location | Path                                                              |
| -------- | ----------------------------------------------------------------- |
| User     | `~/.pi/agent/agents/*.md` or `$PI_CODING_AGENT_DIR/agents/*.md`   |
| Project  | `.pi/agents/*.md` (walks up from cwd; project wins on name clash) |

```markdown
---
name: writer
description: Expert technical writer and editor
model: anthropic/claude-3-5-sonnet
thinking: medium
tools: read, write
---

You are an expert technical writer. Improve clarity and conciseness.
```

| Field         | Required | Notes                                                                 |
| ------------- | -------- | --------------------------------------------------------------------- |
| `name`        | yes      | Exact id used in tool calls                                           |
| `description` | yes      | Shown to the main agent for routing                                   |
| `role`        | no       | `orchestrator` marks the file as main-agent-only policy; not callable |
| `model`       | no       | Optional `provider/model`; else parent default                        |
| `thinking`    | no       | `off` … `xhigh` (same as `--thinking`)                                |
| `tools`       | no       | Built-ins only; default `read,bash,edit,write`                        |

Body is **appended** to Pi’s system prompt. Built-ins: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.

## Orchestrator

An agent definition with `role: orchestrator` is main-agent-only delegation policy, not a callable subagent. Its body is injected into the main agent’s system prompt; children do not receive it because the extension is disabled in child processes.

```markdown
---
name: delegation-policy
description: Delegation and orchestration rules
role: orchestrator
---

Delegate independent work to the most appropriate specialized agent.
```

- Project orchestrators override user orchestrators; multiple files in one scope use the alphabetically first file, with a warning.
- `name` and `description` remain required. `model`, `tools`, and `thinking` are ignored, with a warning.
- The orchestrator body and subagent catalog are inserted just before `Current working directory:` to keep the stable prompt prefix provider-cache-friendly. The orchestrator and agent catalog are snapshotted at session start; changes require `/reload` or a new session.

## Usage

`subagent`:

```json
{ "action": "run", "agent": "writer", "task": "Document the API" }
{ "action": "run_parallel", "tasks": [{ "agent": "a", "task": "..." }, { "agent": "b", "task": "..." }] }
{ "action": "resume", "resume_id": "completed-run-id", "task": "Continue the previous work" }
```

`subagent_ctl`:

```json
{ "action": "list" }
{ "action": "kill", "id": "running-run-id" }
{ "action": "steer", "id": "running-run-id", "text": "Focus on the failing test." }
{ "action": "inspect", "id": "run-id" }
```

- **Runs** — always receive an isolated `Task: ...` context; put all needed context in `task`.
- **`resume`** — continues a successfully completed child session from this parent session. It creates a new run id and preserves lineage; only one resume per lineage may run at a time.

Single-level delegation is a construction-time capability: child sessions load the parent's extensions except pi-subagent, so they physically lack the subagent tools. The parent sees final text only; tool rows and transcripts live in the TUI / `/agents`.

## Attribution

Upstream idea and early shape: [mjakl/pi-subagent](https://github.com/mjakl/pi-subagent).

## License

MIT
