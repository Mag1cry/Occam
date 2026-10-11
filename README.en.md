# Occam

**中文**: [README.md](README.md)

> A **local-first Agent execution control plane**: make delegated work observable, constrainable,
> traceable, and subject to human control.

Occam is not another Agent framework, and it does not require every Agent to use the same runtime.
It focuses on what happens after work is delegated: **what has happened, which tools were
requested, which policy allowed them, who approved them, and what the run produced.**

```text
managed Agent ──tool request──▶ policy decision ──▶ human approval ──▶ tool execution
       │                                      │
       └──run and result──▶ execution audit   └──▶ events and records

external Agent ──read-only monitor (planned)──▶ normalized observation view
```

## Project principles

- **Integrate different Agents without pretending they are identical.** Extensions map native
  records into a shared execution view while preserving source identity, evidence, and unknowns.
- **Separate control from observation.** A managed executor can use Occam's permission and approval
  channel. A monitor can read an external Agent's records, but that does not give it control over
  that Agent.
- **Judge tool actions before execution.** Executors receive an allowlist; policy can require human
  approval; approval is bound to the specific request and control events preserve the decision.
- **Use run evidence to help people improve workflows.** The goal is to let an analysis Agent
  suggest improvements from cost, latency, approvals, and failures. This analysis is still planned.
- **Keep the kernel local-first and small.** Task, Executor, Capability, and Control Event form the
  control kernel; runtimes, monitoring sources, and peripheral features enter through extensions.

## Agent integration levels

| Integration | Boundary | Status |
| --- | --- | --- |
| Managed execution | Occam starts the executor and routes its tool requests through Occam policy and approval | Worker contract, LangGraph executor, allowlist, and approval pipeline are implemented |
| External execution control | Call a remote Agent service to start, pause, resume, or cancel a run | Planned; depends on the external service API |
| External read-only monitoring | Read conversations, tool activity, and status for an Agent running outside Occam | Monitor contract is planned; a LangGraph external-monitor sample is intended |

The current LangGraph Agent is **managed by Occam**. A future LangGraph monitor sample would observe
a separate Agent started outside Occam. The framework name is shared, but the execution and
integration paths are distinct.

External data sources differ. The planned monitor contract will normalize event shape while
preserving source identity, native references, evidence, and unknown fields. Observed activity will
not be presented as authorized or executed by Occam.

## Repository layout

| Directory | Contents |
| --- | --- |
| [`occ-next/`](occ-next/) | Python backend: control kernel, permission gateway, Workers, extensions, and HTTP API |
| [`occ-command-center/`](occ-command-center/) | React frontend: tasks, events, approvals, and configuration |
| [`occ-mcp-examples/`](occ-mcp-examples/) | External MCP connection examples |

## Run locally

Requires Python 3.11+ and Node.js.

```bash
# backend
cd occ-next
uv sync --extra dev --extra agent
uv run occ-next

# frontend development server
cd occ-command-center
npm ci && npm run dev
```

The backend listens on `127.0.0.1:8765` by default; the frontend dev server uses
`localhost:5173`. For a single-origin release, build the frontend and set
`OCC_NEXT_WEB_DIR=../occ-command-center/dist` before starting the backend.

## Current implementation boundaries

- The project is a single-machine, local-first system, without multi-tenant or public-internet
  product design.
- The current LangGraph Agent runs in an Occam Worker subprocess. Its tool requests go through
  gateway policy and approval. External monitoring is a separate planned integration path.
- Managed Agent audit is read on demand through the executor adapter. Persistent gateway records of
  actual tool results, duration, and complete cost telemetry still need work.
- An independent analysis Agent, the external monitoring event contract, and remote Agent control
  adapters are planned.

See the [backend overview](occ-next/README.md), [extension authoring guide](occ-next/extensions/AUTHORING.md),
[Agent extension integration decision](occ-next/extensions/AGENT_INTEGRATION_DECISION.md), and
[frontend overview](occ-command-center/README.md).
