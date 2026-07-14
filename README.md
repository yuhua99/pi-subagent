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
| `model` | no | Optional `provider/model`; else parent default |
| `thinking` | no | `off` … `xhigh` (same as `--thinking`) |
| `tools` | no | Built-ins only; default `read,bash,edit,write` |

Body is **appended** to Pi’s system prompt. Built-ins: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. Sample: `agents/oracle.md`.

## Usage

```json
{ "agent": "writer", "task": "Document the API", "mode": "spawn" }
{ "agent": "review", "task": "Check this migration", "mode": "fork" }
{ "tasks": [{ "agent": "a", "task": "..." }, { "agent": "b", "task": "..." }], "mode": "spawn" }
```

- **`spawn`** (default) — child gets only `Task: ...`; put all needed context in `task`
- **`fork`** — session branch snapshot + task; better for follow-ups, higher cost / possible leakage

Each child is a separate `pi` process (`PI_SUBAGENT=1`). The parent sees final text only; tool rows and transcripts live in the TUI / `/agents`.

## Attribution

Upstream idea and early shape: [mjakl/pi-subagent](https://github.com/mjakl/pi-subagent).

## License

MIT
