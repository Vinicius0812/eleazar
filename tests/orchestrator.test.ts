import { describe, expect, it } from "vitest";

import type {
  AgentAdapter,
  AgentHealth,
  AgentRunRequest,
  AgentRunResult,
  ProviderName,
  TaskKind
} from "../src/core/contracts.js";
import { Orchestrator } from "../src/core/orchestrator.js";

class RecordingAdapter implements AgentAdapter {
  readonly supportedTasks = new Set<TaskKind>([
    "implementation",
    "review",
    "planning",
    "research",
    "testing",
    "documentation",
    "unknown"
  ]);
  lastRequest: AgentRunRequest | undefined;

  constructor(readonly provider: ProviderName) {}

  async health(): Promise<AgentHealth> {
    return { provider: this.provider, available: true, authenticated: true, detail: "ok" };
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.lastRequest = request;
    return { provider: this.provider, status: "success", response: "feito", durationMs: 1 };
  }
}

describe("Orchestrator", () => {
  it("delega para o provedor selecionado", async () => {
    const codex = new RecordingAdapter("codex");
    const antigravity = new RecordingAdapter("antigravity");
    const orchestrator = new Orchestrator([codex, antigravity]);

    const execution = await orchestrator.run({
      prompt: "Implemente a tela inicial",
      cwd: process.cwd()
    });

    expect(execution.result.provider).toBe("codex");
    expect(codex.lastRequest?.prompt).toBe("Implemente a tela inicial");
    expect(antigravity.lastRequest).toBeUndefined();
  });
});
