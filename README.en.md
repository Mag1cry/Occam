# Occam

**中文版**: [README.md](README.md)

> A **local-first personal control plane**: it treats "things I handed to an agent" as first-class
> objects you can actually manage.

The name comes from **Occam's razor** — *do not multiply entities beyond necessity*. The kernel
keeps that promise: four primitives (Task / Executor / Capability / Control Event) and nothing
else; a state change must carry its event, so there is no separate "audit log" to maintain —
**the event chain is the fact.**

It does not train models, schedule clusters, or act as yet another agent framework. It answers a
different set of questions: **how far along is this job, who approved that step, on what grounds,
and what exactly happened at that moment.**

```text
you ──delegate──▶ Task ──▶ executor (an agent, or plain code)
                   │
                   ├── wants a tool? ──▶ policy check ──▶ needs a human? ──▶ pushed to your phone
                   │                                                    (tap approve — it resumes itself)
                   └── every step lands as an event; the chain says exactly what happened
```

## Four claims it is built on

**① Four primitives, everything else is peripheral.** Task (a job), Executor (who runs it),
Capability (what it may touch), Control Event (what happened). The kernel knows only these four,
so there is exactly one place that knows how a job is doing.

**② A state change must carry its event.** The kernel has a single migration channel
(`commit(uow, command, task, *, event)`) — so you *cannot* write code that changes state and forgets
to record it. The event chain isn't a log; it **is** the fact. The UI, the audit trail and every
outbound notification derive from it.

**③ Judgment comes before action.** A tool call isn't "the executor calls whatever it wants": first
the policy decision (who may call it, does a human need to approve), **then it is accounted**, and
only then does it run. That is why "what did it actually do" stays answerable afterwards — including
everything that was refused.

**④ Peripherals are packages; the kernel doesn't grow.** To add a capability you add one
`extensions/<name>/manifest.yaml` (tools / executors / schedules / providers / message channels).
Not a line of kernel code changes; drop the package in and it's live, edit the manifest and it
hot-reloads.

## What it looks like

The UI is a **spatial canvas** with five scenes (overview / task / schedule / archive / configuration)
and focus transitions between them. Every object opens a **command surface** where each command
tells you its **consequence and whether it can be undone** before you press it.

Approvals don't require you to sit in front of the app: when a decision is needed, output is
**pushed to your phone** (Feishu today). Tapping a button on the card **turns that card into
"✅ approved" in place**, and the task resumes by itself — no redirect, no scrolling back through
chat history.

## Running it

Python 3.11+ and Node (only to build the frontend).

```bash
# backend (API on 127.0.0.1:8765)
cd occ-next
uv sync --extra dev --extra agent
uv run python -m src.serve

# frontend (dev shape, hot reload on localhost:5173)
cd occ-command-center
npm ci && npm run dev
```

The release shape is **one process, one port**: run `npm run build`, then start the backend with
`OCC_NEXT_WEB_DIR=../occ-command-center/dist` and both the UI and the API come out of 8765.

- Credentials live in `occ-next/config/.env` (written by you, never committed) and travel **only
  through environment variables**. What the program writes lives in `occ-next/data/` and
  `occ-next/workspace/`.
- You can exercise the whole approval path without a real model: install an extension package and
  use an executor that is plain code.

## Layout

| Directory | What it is |
| --- | --- |
| [`occ-next/`](occ-next/) | Backend: the four-primitive kernel plus the gateway (policy / approval / schedules / executors / output layer). **The brain** |
| [`occ-command-center/`](occ-command-center/) | Frontend: React 19 + Vite + Tailwind spatial canvas |
| [`occ-next/extensions/`](occ-next/extensions/) | Extension packages. `AUTHORING.md` is the tutorial for writing one |
| [`occ-mcp-examples/`](occ-mcp-examples/) | Examples of the MCP wiring |
| [`docs-Next-Version/`](docs-Next-Version/) | Architecture, decisions (ADRs), frontend design, export from the old system |
| [`docs/`](docs/) | Historical archive (describing the **deleted** old system) |

> **Why the directories and variables still say `occ`**: this grew out of OCC
> (Operations Command Center) — `occ-next/`, `OCC_NEXT_*` and friends carry that history.
> Under the new name they stay as they are: `occ` is the first three letters of Occam.

298 backend tests (`cd occ-next && uv run pytest -q`), 293 frontend tests
(`cd occ-command-center && npm test`).

## Status

**A personal project: single machine, local-first.** It runs and gets used daily, but it is not a
product — no multi-tenancy, no cloud deployment, and no design for exposing the control plane to the
public internet (which is precisely why it is built the way it is).

> The previous implementation, `occ-os` / `occ-web`, was deleted on **2026-10-02**. Its code is still
> in git history (`git log -- occ-os`); its configuration and data were exported to
> [`docs-Next-Version/from-occ-os/`](docs-Next-Version/from-occ-os/); the pre-deletion audit is
> [`docs/删除旧版前的审计.md`](docs/删除旧版前的审计.md) (Chinese).

Documentation is mostly in Chinese; this file is the English counterpart of the top-level README.

## Where to go next

1. **How to run it, where credentials go, how it autostarts** → [`docs/运行与结构.md`](docs/运行与结构.md) (Chinese)
2. **Writing an extension package** → [`occ-next/extensions/AUTHORING.md`](occ-next/extensions/AUTHORING.md)
3. **Why it is designed this way** → [`docs-Next-Version/architecture-next/decisions.md`](docs-Next-Version/architecture-next/decisions.md) (Chinese)
4. **How the requirements grew, rework and all** → [`occ-next/docs/requirements.md`](occ-next/docs/requirements.md) (Chinese)
