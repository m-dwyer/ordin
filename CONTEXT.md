# ordin

Domain language for ordin, a harness that coordinates structured AI-assisted
software delivery runs across phases, gates, artefacts, runtimes, and clients.

## Language

### Workflow Coordination

**Workflow**:
A reusable YAML definition that declares phase order, orchestration policy, and artefact contracts.
_Avoid_: pipeline, flow, job

**Run**:
One execution of a **Workflow** for a task against a target workspace.
_Avoid_: session, execution, job

**Phase**:
A context-isolated step in a **Workflow** that invokes one **Agent** through one **Runtime**.
_Avoid_: stage, step, task

**Plan Phase**:
The **Phase** that turns a task into a reviewable RFC artefact.
_Avoid_: design phase, planning step

**Build Phase**:
The **Phase** that turns an approved RFC artefact into code changes and build notes.
_Avoid_: implementation phase, coding step

**Review Phase**:
The **Phase** that independently evaluates build output against the approved RFC.
_Avoid_: QA phase, validation phase

**Gate**:
A decision point that approves, rejects, or halts a phase handoff.
_Avoid_: approval prompt, checkpoint

**Gate Prompter**:
A client-side adapter that collects a human **Gate** decision.
_Avoid_: gate UI, reviewer prompt

**Feedback**:
Structured rejection context passed from one **Phase** into a later phase invocation.
_Avoid_: comments, notes, review text

### Artefacts And Context

**Artefact**:
A durable workspace file used as input or output between phases.
_Avoid_: output, document, file

**Artefact Contract**:
A workflow-declared artefact path, label, and description that the harness verifies and threads between phases.
_Avoid_: file schema, output config

**Slug**:
The stable kebab-case identifier used to resolve per-run artefact paths.
_Avoid_: task id, filename stem

**Task**:
The user-provided problem statement a **Run** is executing.
_Avoid_: prompt, ticket

**Tier**:
The size profile for a **Task**, currently S, M, or L.
_Avoid_: priority, complexity

### Agents And Execution

**Agent**:
A markdown-authored role selected by a **Phase** and executed by a **Runtime**.
_Avoid_: bot, worker, persona

**Skill**:
A markdown-authored capability that can be loaded into a phase prompt or runtime-native skill system.
_Avoid_: plugin, tool, prompt snippet

**Runtime**:
An adapter that executes one phase invocation behind the `AgentRuntime` interface.
_Avoid_: provider, backend, engine

**Provider**:
An API endpoint or local gateway a **Runtime** uses to reach models.
_Avoid_: runtime, model host

**Backend / Model**:
The opaque model string selected behind a **Provider**.
_Avoid_: runtime, provider

**Scripted Runtime**:
A deterministic **Runtime** that executes YAML-defined steps instead of calling an LLM.
_Avoid_: mock runtime, test runner

### Orchestration And Clients

**Harness Runtime**:
The stable client-facing seam for starting, previewing, and inspecting runs.
_Avoid_: app service, runtime service

**Run Execution**:
The per-run lifecycle module for broker, audit, sandbox, egress, tracing, worker dispatch, and phase ACLs.
_Avoid_: run helper, infra bundle

**Engine**:
The adapter that compiles and executes workflow topology.
_Avoid_: runtime, orchestrator implementation

**Phase Runner**:
The parent-side driver for one prepared phase invocation.
_Avoid_: phase executor, runtime wrapper

**Run Service**:
The server-friendly layer that turns blocking **Harness Runtime** calls into background runs with subscriptions and deferred gates.
_Avoid_: HTTP service, run manager

**Client Interface**:
A user or host-facing surface over ordin, such as CLI, HTTP, remote CLI, or MCP.
_Avoid_: frontend, transport

**Transport**:
The wire or invocation mechanism a **Client Interface** uses to communicate.
_Avoid_: runtime, client

### Policy, Trust, And Observability

**Broker**:
The trusted parent-side mediation point for tool dispatch policy, local services, egress, and audit.
_Avoid_: proxy, server

**Broker Dispatch**:
The **Broker** module that approves tool intents and records dispatch/result audit envelopes.
_Avoid_: tool service, dispatcher

**Tool Authority**:
The shared contract module that parses `allowed_tools` and derives effective tool policy.
_Avoid_: tool parser, ACL helper

**Allowed Tools**:
Workflow policy entries that control exposed tools and optional broker-enforced input patterns.
_Avoid_: permissions, tool list

**Tool Intent**:
The worker-reported request to use one tool with concrete input in a run phase.
_Avoid_: tool call, command

**Worker**:
The process or trust domain that hosts runtime execution.
_Avoid_: agent, subprocess

**Sandbox**:
The isolation mechanism used to constrain worker execution.
_Avoid_: container, jail

**Egress Approval**:
A persisted user decision allowing an external host and port for a project.
_Avoid_: network permission, allowlist entry

**Audit Chain**:
The tamper-evident per-run log of broker and run observations.
_Avoid_: log, transcript

**Run Event**:
A public event emitted for run lifecycle, phase lifecycle, gates, and agent observations.
_Avoid_: message, notification

**Runtime Event**:
An event emitted by a single runtime invocation before parent-side run/phase tagging.
_Avoid_: run event, stream item

**Fixture Project**:
The registered `fixture` workspace used for deterministic local smoke tests and scripted probes.
_Avoid_: sample app, test repo

## Relationships

- A **Workflow** contains one or more **Phases**.
- A **Run** executes exactly one **Workflow** against one target workspace.
- A **Phase** selects exactly one **Agent** and resolves exactly one **Runtime**.
- A **Phase** may declare many **Artefact Contracts** as inputs and outputs.
- An **Artefact Contract** resolves to one **Artefact** for a **Run** via its **Slug**.
- A **Gate** decides the handoff after a **Phase** invocation.
- **Feedback** is produced by a rejected **Gate** and consumed by a later **Phase** invocation.
- A **Runtime** may call a **Provider** to reach a **Backend / Model**.
- A **Client Interface** calls **Harness Runtime** or **Run Service** to control runs.
- **Run Execution** supplies **Phase Runner** with dispatch behavior for each **Phase**.
- A **Worker** reports a **Tool Intent** to **Broker Dispatch**.
- **Tool Authority** derives the **Allowed Tools** policy registered with **Broker Dispatch**.
- **Broker Dispatch** approves or denies a **Tool Intent** before the worker executes it.
- A **Sandbox** constrains the **Worker**, not the whole domain model.
- A **Run Event** may be promoted from a **Runtime Event** by **Phase Runner**.
- An **Audit Chain** records broker observations and selected run observations for one **Run**.

## Example Dialogue

> **Dev:** "When the **Review Phase** rejects, do we re-use the same **Agent** context for **Build Phase**?"
> **Domain expert:** "No. A rejected **Gate** produces **Feedback**, and the **Build Phase** runs fresh with the approved RFC **Artefact** plus that **Feedback**."
>
> **Dev:** "Can I let Review run `Bash(git diff*)` and still block `npm install`?"
> **Domain expert:** "Yes. **Tool Authority** preserves the pattern, and **Broker Dispatch** checks the **Tool Intent** command before the **Worker** executes it."

## Flagged Ambiguities

- "runtime" can mean **Harness Runtime** or **Runtime**. Use **Harness Runtime** for the client-facing seam and **Runtime** for phase execution adapters.
- "provider" and "model" are often conflated with **Runtime**. Use **Provider** for the API endpoint and **Backend / Model** for the model string.
- "tool call" is ambiguous between model output and broker policy. Use **Tool Intent** for the broker-approved request.
- "file" is too broad for phase handoff. Use **Artefact** for durable phase inputs/outputs and **Run Metadata** only when referring to harness-internal persistence.
- "client" can mean user-facing surface or model provider. Use **Client Interface** for CLI/HTTP/MCP surfaces and **Provider** for model endpoints.
- "worker" should not mean **Agent**. A **Worker** is a process/trust domain; an **Agent** is a markdown-authored role.
