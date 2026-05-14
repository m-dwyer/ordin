---
name: probe-agent
description: Deterministic probe agent driven by ScriptedRuntime; LLM never invoked.
---

This agent is driven by `ScriptedRuntime` and never sees an LLM. The body of this file is included as system prompt only for parity with other agents — the scripted runtime ignores it.

The actual behaviour is defined declaratively in `script.yaml` paired with this bundle.
