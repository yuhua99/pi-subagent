# Pi Subagent

**Delegate tasks to specialized subagents, each running as a real `pi` TUI in its own [herdr](https://herdr.dev) tab.**

Originally forked from [mjakl/pi-subagent](https://github.com/mjakl/pi-subagent); this package is a substantial rewrite (async delegation, `/agents` TUI, `subagent_ctl`, single-level nesting).

## Features

- **Real TUI per child** — each run opens a herdr tab with an interactive `pi`; you can watch it or type into it, but anything that ends its agent loop (e.g. Esc) completes the run and closes the tab
- **Isolated task-only context** — each run receives only its task
- **Native session resume** — continue a successfully completed child session
- **Async by default** — tool returns as soon as the child starts; results arrive as a follow-up message
- **Parallel runs** — up to 5 concurrent requests
- **Single-level only** — children cannot nest further subagents
- **`/agents`** — run list; enter focuses a live child's tab or reopens a finished child's session in a new tab
- **`subagent_ctl`** — list, stop, or steer children
- **Orchestrator file** — main-agent-only delegation policy via `role: orchestrator`

## Install

```bash
pi install git:github.com/yuhua99/pi-subagent
```

Requires running `pi` inside herdr (`HERDR_ENV=1`); delegation fails otherwise.

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

Use `subagent` to create or continue work. A single call can include up to five requests.

Use `subagent_ctl` to list, stop, or steer children.

- **New work** — each work item receives isolated context; include all needed context in its instructions.
- **Continued work** — resumes a successfully completed child session from the same parent session with `pi --session`, appending to that session file. It creates a new run id and preserves lineage; all runs in a lineage share one session file, and only one continuation per lineage may run at a time.

Each run opens a background herdr tab and starts `pi` there with `herdr agent start`. The task is submitted with `herdr agent prompt`; steers are accepted once the child starts working on it, and the run completes when herdr reports the child idle (herdr's pi integration maps this to `agent_settled`, after automatic retries and compaction). The tab then closes and the transcript is read from the child's session file. Steers are sent with `herdr agent prompt`, like typed input. Closing the tab or quitting its pi earlier kills the run; Esc in the tab aborts it. The child pi gets the environment of a fresh herdr shell, not the parent pi's process environment. Each fresh run gets its own session dir under `$TMPDIR/subagent-sessions`; nothing there is deleted. While a lineage is resuming, `/agents` on its earlier runs focuses the running tab instead of opening a second writer.

Requires herdr's pi integration (`herdr integration install pi`) for reliable idle detection.

Set `PI_SUBAGENT_DISABLED=1` to turn the extension off entirely for a pi process: no tools, no `/agents`, no prompt injection, and no way to re-enable it from inside. Single-level delegation uses the same switch: children run with `PI_SUBAGENT_DISABLED=1`, so they lack the subagent tools. Children cannot ask the main agent questions; answer them yourself in the child's tab. The parent sees final text only.

## Attribution

Upstream idea and early shape: [mjakl/pi-subagent](https://github.com/mjakl/pi-subagent).

## License

MIT
