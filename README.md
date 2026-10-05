# Pi Subagent

**Delegate tasks to specialized subagents, each running as a real `pi` TUI in its own [herdr](https://herdr.dev) tab.**

## Features

- **Real TUI per child** — watch a run in its herdr tab or type into it
- **Isolated context** — each run receives only its task
- **Resume** — continue a successfully completed run
- **Async and parallel** — up to 5 requests per call; results arrive as a follow-up message
- **Single-level** — children cannot spawn subagents
- **`/agents`** — list runs; enter opens a run's tab or reopens a finished run's session
- **`subagent_ctl`** — list, kill, or steer running children
- **Orchestrator file** — main-agent-only delegation policy via `role: orchestrator`

## Install

The herdr version lives on the `herdr` branch:

```bash
pi install git:github.com/yuhua99/pi-subagent@herdr
```

Requires running `pi` inside herdr, with herdr's pi integration installed (`herdr integration install pi`).

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

Body is **appended** to Pi’s system prompt. Built-ins: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `codemode`.

## Orchestrator

An agent definition with `role: orchestrator` is main-agent-only delegation policy, not a callable subagent. Its body is added to the main agent’s system prompt; children do not receive it.

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
- Changes to agent files take effect after `/reload` or a new session.

## Usage

- **New work** — include all needed context in the task; the child sees nothing else.
- **Continued work** — resume a successfully completed run from the same parent session. Only one resume per run chain may run at a time.
- Closing a child's tab kills the run; Esc in it aborts the run. On completion the tab closes.
- `/reload` and `/resume` kill running children; earlier runs stay in `/agents` and remain resumable.
- Children get the environment of a new herdr shell, not the parent pi's environment.
- `PI_SUBAGENT_DISABLED=1` turns the extension off for that pi process.

## Attribution

Forked from [mjakl/pi-subagent](https://github.com/mjakl/pi-subagent).

## License

MIT
