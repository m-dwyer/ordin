---
name: probe-agent
runtime: scripted
description: Deterministic probe agent for sandbox validation. Runs a fixed plan from scripts/sandbox-validation.yaml.
---

This agent is driven by `ScriptedRuntime` and never sees an LLM. The body of this file is included as system prompt only for parity with other agents — the scripted runtime ignores it.

The actual behaviour is defined declaratively in `scripts/sandbox-validation.yaml` alongside the workflow.
