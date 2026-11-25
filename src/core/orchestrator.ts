import type { AgentHealth, AgentRunRequest, AgentRunResult, ProviderName, RouteDecision } from "./contracts.js";
import type { ProviderRegistry } from "./provider-registry.js";
import { Router } from "./router.js";

export interface OrchestratorRun {
  route: RouteDecision;
  result: AgentRunResult;
}

export class Orchestrator {
  readonly #router: Router;

  constructor(readonly registry: ProviderRegistry) {
    this.#router = new Router(registry);
  }

  get router(): Router {
    return this.#router;
  }

  /** Read-only provider diagnostics for local operator interfaces. */
  async health(): Promise<AgentHealth[]> {
    return await Promise.all(this.registry.list().map(({ adapter }) => adapter.health()));
  }

  async run(request: AgentRunRequest, preferredProvider?: ProviderName): Promise<OrchestratorRun> {
    const route = await this.#router.route({
      prompt: request.prompt,
      ...(preferredProvider ? { preferredProvider } : {}),
      ...(request.taskKind ? { taskKind: request.taskKind } : {})
    });

    if (!route.selected) {
      throw new Error("Nenhum provedor apto para esta tarefa. Consulte `eleazar doctor` e `eleazar plan`.");
    }

    return {
      route,
      result: await this.registry.get(route.selected)!.adapter.run({ ...request, taskKind: route.taskKind })
    };
  }
}
