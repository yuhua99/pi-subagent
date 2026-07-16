# Pi Subagent

**Delegate tasks to specialized subagents in isolated `pi` processes.**

Originally forked from [mjakl/pi-subagent](https://github.com/mjakl/pi-subagent); this package is a substantial rewrite (async delegation, `/agents` TUI, list/kill tools, single-level nesting).

## Features

- **`spawn` / `fork` context** — fresh task-only context, or a session snapshot plus the task
- **Async by default** — tool returns as soon as the child starts; results arrive as a follow-up message
- **Parallel runs** — up to 8 tasks, 4 concurrent
- **Single-level only** — children cannot nest further subagents
- **`/agents`** — live status and transcript preview in the TUI
- **`subagent_list` / `subagent_kill`** — inspect or stop running children
- **Orchestrator file** — main-agent-only delegation policy via `role: orchestrator`

## Install

```bash
pi install git:github.com/yuhua99/pi-subagent
```

## Agent definitions

Markdown + YAML frontmatter:

| Location | Path |
| -------- | ---- |
| User | `~/.pi/agent/agents/*.md` or `$PI_CODING_AGENT_DIR/agents/*.md` |
| Project | `.pi/agents/*.md` (walks up from cwd; project wins on name clash) |

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

| Field | Required | Notes |
| ----- | -------- | ----- |
| `name` | yes | Exact id used in tool calls |
| `description` | yes | Shown to the main agent for routing |
| `role` | no | `orchestrator` marks the file as main-agent-only policy; not callable |
| `model` | no | Optional `provider/model`; else parent default |
| `thinking` | no | `off` … `xhigh` (same as `--thinking`) |
| `tools` | no | Built-ins only; default `read,bash,edit,write` |

Body is **appended** to Pi’s system prompt. Built-ins: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. Sample: `agents/oracle.md`.

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

```json
{ "agent": "writer", "task": "Document the API", "mode": "spawn" }
{ "agent": "review", "task": "Check this migration", "mode": "fork" }
{ "tasks": [{ "agent": "a", "task": "..." }, { "agent": "b", "task": "..." }], "mode": "spawn" }
```

- **`spawn`** (default) — child gets only `Task: ...`; put all needed context in `task`
- **`fork`** — session branch snapshot + task; better for follow-ups, higher cost / possible leakage. Cache-aligned: the child rebuilds the parent's request prefix (system prompt, tool schemas, history) to hit the provider prompt cache; misalignment only costs a cache miss. Agent `tools`/`thinking` are ignored (persona moves into the task message); `model` is respected.

Each child is a separate `pi` process (`PI_SUBAGENT=1`). The parent sees final text only; tool rows and transcripts live in the TUI / `/agents`.

## Attribution

Upstream idea and early shape: [mjakl/pi-subagent](https://github.com/mjakl/pi-subagent).

## License

MIT
