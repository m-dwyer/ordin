import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { type Mock, vi } from "vitest";
import type { PhaseDispatchRequest } from "../../src/orchestrator/engine";
import {
  invokeWithRuntime,
  PhaseInvocation,
  type PhaseInvocationResult,
} from "../../src/orchestrator/phase-invocation";
import type {
  AgentRuntime,
  InvokeRequest,
  InvokeResult,
  RuntimeCapabilities,
} from "../../src/worker/runtimes/types";

/**
 * Stand-in agent runtime used across Harness / RunService /
 * HTTP tests. Records invocations and materialises any output paths
 * the prompt declares — mimics a real agent calling `Write` so the
 * engine's post-phase artefact verification is satisfied without
 * spinning up a real model.
 */
export class FakeRuntime implements AgentRuntime {
  readonly name = "fake";
  readonly capabilities: RuntimeCapabilities = {
    nativeSkillDiscovery: false,
    streaming: false,
    mcpSupport: false,
    maxContextTokens: 200_000,
  };
  readonly invocations: InvokeRequest[] = [];

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    this.invocations.push(req);
    await materializeDeclaredOutputs(req.prompt.userPrompt, req.prompt.cwd);
    return {
      status: "ok",
      exitCode: 0,
      transcriptPath: "/tmp/transcript.jsonl",
      tokens: { input: 1, output: 2, cacheReadInput: 0, cacheCreationInput: 0, totalInput: 1 },
      durationMs: 5,
    };
  }
}

export type StubRuntime = AgentRuntime & {
  readonly invoke: Mock<(req: InvokeRequest) => Promise<InvokeResult>>;
};

/**
 * Stub `AgentRuntime` whose `invoke` is a `vi.fn`. Used by tests that
 * exercise harness/use-case error paths (missing declared outputs,
 * missing inputs) where the runtime should appear silent and the test
 * asserts on call count or args directly via the mock.
 */
export function makeStubRuntime(): StubRuntime {
  return {
    name: "fake",
    capabilities: {
      nativeSkillDiscovery: false,
      streaming: false,
      mcpSupport: false,
      maxContextTokens: 200_000,
    },
    invoke: vi.fn(async () => ({
      status: "ok",
      exitCode: 0,
      transcriptPath: "/tmp/transcript.jsonl",
      tokens: { input: 0, output: 0, cacheReadInput: 0, cacheCreationInput: 0, totalInput: 0 },
      durationMs: 0,
    })),
  };
}

/**
 * Wraps an `AgentRuntime` as a `dispatchPhase` callback. Tests pass
 * this as `HarnessOptions.dispatchPhase` to short-circuit the
 * worker spawn — the runtime's `invoke` is called directly in-process
 * via the parent-side `PhaseInvocation`, which emits the same lifecycle
 * events the production sandboxed path emits.
 */
export function dispatchFromRuntime(
  runtime: AgentRuntime,
): (req: PhaseDispatchRequest) => Promise<PhaseInvocationResult> {
  const runner = new PhaseInvocation();
  return (req) =>
    runner.run({
      preview: req.preview,
      runtimeName: runtime.name,
      invoke: invokeWithRuntime(runtime),
      context: { runId: req.runId, runDir: req.runDir, iteration: req.iteration },
      emit: req.emit,
      ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
    });
}

export async function materializeDeclaredOutputs(userPrompt: string, cwd: string): Promise<void> {
  const section = /## Produce these artefacts\n([\s\S]*?)(?=\n## |\nWorking directory:|$)/.exec(
    userPrompt,
  );
  if (!section?.[1]) return;
  const paths = [...section[1].matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "").filter(Boolean);
  for (const rel of paths) {
    const abs = resolvePath(cwd, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, "", "utf8");
  }
}
