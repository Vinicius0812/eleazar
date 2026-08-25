import { describe, expect, it } from "vitest";

import type {
  AgentAdapter,
  AgentHealth,
  AgentRunRequest,
  AgentRunResult,
  ProviderName,
  TaskKind
} from "../src/core/contracts.js";
import { classifyTask, Router } from "../src/core/router.js";

class FakeAdapter implements AgentAdapter {
  readonly supportedTasks = new Set<TaskKind>([
    "implementation",
    "review",
    "planning",
    "research",
    "testing",
    "documentation",
    "unknown"
  ]);

  constructor(
    readonly provider: ProviderName,
    readonly state: AgentHealth
  ) {}

  async health(): Promise<AgentHealth> {
    return this.state;
  }

  async run(_request: AgentRunRequest): Promise<AgentRunResult> {
    return { provider: this.provider, status: "success", response: "ok", durationMs: 1 };
  }
}

const healthyCodex = new FakeAdapter("codex", {
  provider: "codex",
  available: true,
  authenticated: true,
  detail: "ok"
});
const healthyAntigravity = new FakeAdapter("antigravity", {
  provider: "antigravity",
  available: true,
  authenticated: true,
  detail: "ok"
});

describe("classifyTask", () => {
  it("classifica implementacao em portugues", () => {
    expect(classifyTask("Implemente autenticação JWT na API")).toBe("implementation");
  });

  it("prioriza revisao quando o prompt tambem menciona codigo", () => {
    expect(classifyTask("Revise este codigo antes do merge")).toBe("review");
  });

  it("classifica pesquisa no imperativo", () => {
    expect(classifyTask("Pesquise alternativas de fila para o projeto")).toBe("research");
  });
});

describe("Router", () => {
  it("prefere Codex para implementacao", async () => {
    const router = new Router([healthyCodex, healthyAntigravity]);
    const decision = await router.route({ prompt: "Implemente o endpoint de usuarios" });

    expect(decision.selected).toBe("codex");
  });

  it("prefere Antigravity para pesquisa", async () => {
    const router = new Router([healthyCodex, healthyAntigravity]);
    const decision = await router.route({ prompt: "Pesquise alternativas para a arquitetura" });

    expect(decision.selected).toBe("antigravity");
  });

  it("ignora um provedor indisponivel", async () => {
    const unavailableCodex = new FakeAdapter("codex", {
      provider: "codex",
      available: false,
      authenticated: null,
      detail: "ausente"
    });
    const router = new Router([unavailableCodex, healthyAntigravity]);
    const decision = await router.route({ prompt: "Implemente uma funcionalidade" });

    expect(decision.selected).toBe("antigravity");
  });
});
