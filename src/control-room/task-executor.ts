import type { AgentRunRequest, AgentRunResult, ProviderName, RouteDecision } from "../core/contracts.js";
import type { Orchestrator, OrchestratorRun } from "../core/orchestrator.js";
import { ControlRoomService } from "../core/control-room-service.js";
import type { ControlRoomTask, DelegationCandidate, LocalProjectDirectory } from "../core/control-room.js";
import { GitChangeCollector } from "./git-change-collector.js";

/** Minimal boundary for the live provider runner; tests can use a deterministic substitute. */
export interface ControlRoomTaskRunner {
  readonly router: Pick<Orchestrator["router"], "route">;
  run(request: AgentRunRequest, preferredProvider?: ProviderName): Promise<OrchestratorRun>;
}

/** Starts only user-requested tasks and persists their final provider outcome. */
export class ControlRoomTaskExecutor {
  constructor(
    private readonly service: ControlRoomService,
    private readonly runner: ControlRoomTaskRunner,
    private readonly changes = new GitChangeCollector()
  ) {}

  async start(taskId: string, preferredProvider?: ProviderName): Promise<ControlRoomTask> {
    const task = this.requireQueuedTask(taskId);
    const directory = this.requireTargetDirectory(task);
    const request = makeRunRequest(task, directory);
    const route = await this.runner.router.route({
      prompt: request.prompt,
      taskKind: task.kind,
      ...(preferredProvider ? { preferredProvider } : {})
    });
    if (!route.selected) {
      throw new Error("Nenhum provedor autenticado esta disponivel. Execute `npm run doctor` e atualize o login antes de tentar novamente.");
    }

    const dispatched = await this.service.dispatch(task.id, {
      selectedProvider: route.selected,
      reason: routeReason(route),
      candidates: route.candidates.map(toDelegationCandidate),
      requestedActions: ["read_project"]
    });
    if (dispatched.status !== "running" || !dispatched.dispatchLease) {
      throw new Error("A tarefa nao foi iniciada; releia o estado antes de tentar novamente.");
    }

    void this.runAndPersist(dispatched, request, preferredProvider, route.selected, this.requireTaskDirectories(dispatched));
    return dispatched;
  }

  private async runAndPersist(task: ControlRoomTask, request: AgentRunRequest, preferredProvider: ProviderName | undefined, selectedProvider: ProviderName, directories: LocalProjectDirectory[]): Promise<void> {
    const startedAt = Date.now();
    const execution = this.service.store.listExecutions(task.id).find((item) => item.leaseId === task.dispatchLease);
    const snapshot = await this.changes.capture(directories);
    try {
      const outcome = await this.runner.run(request, preferredProvider);
      const collected = execution ? await snapshot.collect(execution.id) : { files: [], warnings: ["Execucao nao encontrada para registrar os arquivos afetados."] };
      this.service.finishProviderRun(task.id, task.dispatchLease!, outcome.result, collected.files, collected.warnings);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const failed: AgentRunResult = {
        provider: selectedProvider,
        status: "error",
        response: "",
        error: detail,
        durationMs: Date.now() - startedAt
      };
      const collected = execution ? await snapshot.collect(execution.id) : { files: [], warnings: ["Execucao nao encontrada para registrar os arquivos afetados."] };
      this.service.finishProviderRun(task.id, task.dispatchLease!, failed, collected.files, collected.warnings);
    }
  }

  private requireQueuedTask(taskId: string): ControlRoomTask {
    const task = this.service.getTask(taskId);
    if (!task) throw new Error("Tarefa nao encontrada.");
    if (task.status === "waiting_approval") throw new Error("Esta tarefa precisa ser aprovada antes de ser executada.");
    if (task.status !== "queued") throw new Error("Apenas tarefas na fila podem ser executadas.");
    return task;
  }

  private requireTargetDirectory(task: ControlRoomTask): LocalProjectDirectory {
    const project = this.service.getProject(task.projectId);
    if (!project) throw new Error("Projeto local nao encontrado.");
    const directory = project.directories.find((item) => item.id === task.targetDirectoryId);
    if (!directory) throw new Error("Diretorio-alvo da tarefa nao encontrado.");
    return directory;
  }

  private requireTaskDirectories(task: ControlRoomTask): LocalProjectDirectory[] {
    const project = this.service.getProject(task.projectId);
    if (!project) throw new Error("Projeto local nao encontrado.");
    return task.directoryIds.map((id) => project.directories.find((directory) => directory.id === id)).filter((directory): directory is LocalProjectDirectory => Boolean(directory));
  }
}

function makeRunRequest(task: ControlRoomTask, directory: LocalProjectDirectory): AgentRunRequest {
  return {
    cwd: directory.path,
    taskKind: task.kind,
    prompt: [
      `Tarefa Eleazar: ${task.title}`,
      `Diretorio autorizado: ${directory.path}`,
      "Execute somente o pedido abaixo no diretorio autorizado. Nao faca push, merge, deploy, publicacao, login, logout ou leitura de credenciais. Relate de forma objetiva o resultado e os testes executados.",
      "",
      task.prompt
    ].join("\n")
  };
}

function toDelegationCandidate(candidate: RouteDecision["candidates"][number]): DelegationCandidate {
  return { provider: candidate.provider, score: candidate.score, reasons: candidate.reasons };
}

function routeReason(route: RouteDecision): string {
  const selected = route.candidates.find((candidate) => candidate.provider === route.selected);
  return selected ? selected.reasons.join("; ") : "provedor selecionado pelo roteador";
}
