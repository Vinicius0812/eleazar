import type {
  AgentAdapter,
  AgentRunRequest,
  AgentRunResult,
  ProviderName,
  RouteDecision
} from "./contracts.js";
import { Router } from "./router.js";

export interface OrchestratorRun {
  route: RouteDecision;
  result: AgentRunResult;
}

export class Orchestrator {
  readonly #adapters: ReadonlyMap<ProviderName, AgentAdapter>;
  readonly #router: Router;

  constructor(adapters: readonly AgentAdapter[]) {
    this.#adapters = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
    this.#router = new Router(adapters);
  }

  get router(): Router {
    return this.#router;
  }

  /** Read-only provider diagnostics for local operator interfaces. */
  async health(): Promise<import("./contracts.js").AgentHealth[]> {
    return await Promise.all([...this.#adapters.values()].map((adapter) => adapter.health()));
  }

  async run(request: AgentRunRequest, preferredProvider?: ProviderName): Promise<OrchestratorRun> {
    const route = await this.#router.route({
      prompt: request.prompt,
      ...(preferredProvider ? { preferredProvider } : {}),
      ...(request.taskKind ? { taskKind: request.taskKind } : {})
    });

    if (!route.selected) {
      throw new Error("Nenhum provedor esta instalado e autenticado. Execute `eleazar doctor`.");
    }

    const adapter = this.#adapters.get(route.selected);
    if (!adapter) {
      throw new Error(`Adaptador nao registrado: ${route.selected}`);
    }

    return {
      route,
      result: await adapter.run(request)
    };
  }
}
