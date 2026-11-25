import { describe, expect, it, vi } from "vitest";

import type {
  AgentAdapter,
  AgentHealth,
  AgentRunRequest,
  AgentRunResult,
  ProviderName,
  TaskKind
} from "../src/core/contracts.js";
import { classifyTask, Router } from "../src/core/router.js";
import { preferences, registryOf } from "./helpers.js";

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
    const router = new Router(registryOf([healthyCodex, healthyAntigravity]));
    const decision = await router.route({ prompt: "Implemente o endpoint de usuarios" });

    expect(decision.selected).toBe("codex");
  });

  it("prefere Antigravity para pesquisa", async () => {
    const router = new Router(registryOf([healthyCodex, healthyAntigravity]));
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
    const router = new Router(registryOf([unavailableCodex, healthyAntigravity]));
    const decision = await router.route({ prompt: "Implemente uma funcionalidade" });

    expect(decision.selected).toBe("antigravity");
  });

  it("escolhe qualquer um dos tres no Automatico, pela afinidade de cada descritor", async () => {
    const router = new Router(registryOf([healthyCodex, healthyAntigravity, healthy("claude")]));
    expect((await router.route({ prompt: "Implemente o endpoint" })).selected).toBe("codex");
    expect((await router.route({ prompt: "Revise a mudança" })).selected).toBe("claude");
    expect((await router.route({ prompt: "Pesquise alternativas" })).selected).toBe("antigravity");
  });

  it("so escolhe no Automatico quem tem autenticacao confirmada", async () => {
    const unknown = new FakeAdapter("claude", { provider: "claude", available: true, authenticated: null, detail: "indefinido" });
    const denied = new FakeAdapter("codex", { provider: "codex", available: true, authenticated: false, detail: "sem login" });
    const decision = await new Router(registryOf([denied, unknown, healthyAntigravity])).route({ prompt: "Revise a mudança" });
    expect(decision.selected).toBe("antigravity");
    expect(decision.candidates.find((item) => item.provider === "claude")?.reasons).toContain("autenticacao nao confirmada");
    expect((await new Router(registryOf([denied, unknown])).route({ prompt: "Revise a mudança" })).selected).toBeNull();
  });

  it("abre uma sessao para confirmar o login de quem nao o informa, e aceita o que ela disser", async () => {
    const verified = (authenticated: boolean | null) => Object.assign(
      new FakeAdapter("antigravity", { provider: "antigravity", available: true, authenticated: null, detail: "?" }),
      { verify: vi.fn(async () => ({ provider: "antigravity", connected: true, authenticated, detail: "verificado", models: [], defaultModel: null, checkedAt: "2026-01-01T00:00:00.000Z" })) });
    const signedIn = verified(true);
    expect((await new Router(registryOf([signedIn])).route({ prompt: "Pesquise" })).selected).toBe("antigravity");
    expect(signedIn.verify).toHaveBeenCalledTimes(1);
    expect((await new Router(registryOf([verified(false)])).route({ prompt: "Pesquise" })).selected).toBeNull();
    expect((await new Router(registryOf([verified(null)])).route({ prompt: "Pesquise" })).selected).toBeNull();
    // An explicit choice may still try an agent whose login is undecided, never one that denied it.
    expect((await new Router(registryOf([verified(null)])).route({ prompt: "Pesquise", preferredProvider: "antigravity" })).selected).toBe("antigravity");
    expect((await new Router(registryOf([verified(false)])).route({ prompt: "Pesquise", preferredProvider: "antigravity" })).selected).toBeNull();
  });

  it("nunca troca o provedor escolhido por outro", async () => {
    const missing = new FakeAdapter("codex", { provider: "codex", available: false, authenticated: null, detail: "ausente" });
    const other = healthy("antigravity");
    const health = vi.spyOn(other, "health");
    const decision = await new Router(registryOf([missing, other])).route({ prompt: "Implemente", preferredProvider: "codex" });
    expect(decision.selected).toBeNull();
    expect(decision.candidates.map((item) => item.provider)).toEqual(["codex"]);
    expect(health).not.toHaveBeenCalled();
    expect((await new Router(registryOf([other])).route({ prompt: "Revise", preferredProvider: "claude" })).selected).toBeNull();
  });

  it("respeita as capacidades declaradas e as preferencias do operador", async () => {
    const reviewer: AgentAdapter = { ...healthy("claude"), provider: "claude", supportedTasks: new Set(["review", "planning"]),
      health: async () => ({ provider: "claude", available: true, authenticated: true, detail: "ok" }), run: vi.fn<AgentAdapter["run"]>() };
    expect((await new Router(registryOf([reviewer])).route({ prompt: "Implemente a mudança", preferredProvider: "claude" })).selected).toBeNull();
    expect((await new Router(registryOf([reviewer])).route({ prompt: "Revise a mudança", preferredProvider: "claude" })).selected).toBe("claude");

    const adapters = [healthyCodex, healthyAntigravity];
    const manual = new Router(registryOf(adapters, (id) => id === "codex" ? preferences({ automatic: false }) : null));
    expect((await manual.route({ prompt: "Implemente" })).selected).toBe("antigravity");
    expect((await manual.route({ prompt: "Implemente", preferredProvider: "codex" })).selected).toBe("codex");
    const disabled = new Router(registryOf(adapters, (id) => id === "codex" ? preferences({ enabled: false }) : null));
    expect((await disabled.route({ prompt: "Implemente" })).selected).toBe("antigravity");
    const refused = await disabled.route({ prompt: "Implemente", preferredProvider: "codex" });
    expect(refused).toMatchObject({ selected: null, candidates: [{ health: { detail: "Desativado na tela Provedores." } }] });
  });
});

function healthy(provider: ProviderName): FakeAdapter {
  return new FakeAdapter(provider, { provider, available: true, authenticated: true, detail: "ok" });
}
