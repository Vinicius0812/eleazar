import type { AgentRunRequest, AgentRunResult, ProviderName, RouteDecision } from "../core/contracts.js";
import { CodexAcpClient } from "../adapters/codex-acp.js";
import { claudeTextTaskKinds } from "../core/contracts.js";
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
  private readonly active = new Map<string, AbortController>();
  private readonly pendingPermissions = new Map<string, { executionId: string; resolve: (optionId: string | null) => void }>();
  private readonly configCache = new Map<string, { expires: number; value: CodexConfig }>();
  isActive(executionId: string): boolean { return this.active.has(executionId); }
  constructor(
    private readonly service: ControlRoomService,
    private readonly runner: ControlRoomTaskRunner,
    private readonly changes = new GitChangeCollector(),
    private readonly codexClient = new CodexAcpClient()
  ) {}

  async codexConfig(directoryId: string): Promise<CodexConfig> {
    const directory = this.service.store.listProjects().flatMap((project) => project.directories).find((item) => item.id === directoryId);
    if (!directory) throw new Error("Diretorio nao encontrado para catalogo Codex.");
    const cached = this.configCache.get(directory.path);
    if (cached && cached.expires > Date.now()) return cached.value;
    let info: Awaited<ReturnType<CodexAcpClient["inspect"]>>;
    try { info = await this.codexClient.inspect(directory.path); }
    catch (error) { throw Object.assign(new Error(`Catalogo Codex ACP indisponivel: ${error instanceof Error ? error.message : String(error)}`), { statusCode: 503 }); }
    const value: CodexConfig = { directoryId, runtime: info.runtime, protocolVersion: info.protocolVersion,
      settings: info.configOptions.filter((item) => ["mode", "model", "thought_level", "model_config", "collaboration_mode"].includes(item.category ?? item.id))
        .map((item) => item.type === "select"
          ? { id: item.id, name: item.name, category: item.category ?? null, type: "select" as const,
            currentValue: item.currentValue, options: item.options.flatMap((option) => "value" in option
              ? [{ id: option.value, name: option.name }] : option.options.map((choice) => ({ id: choice.value, name: choice.name })))
              .filter((option) => item.category !== "mode" && item.id !== "mode" || ["read-only", "workspace-write"].includes(option.id)) }
          : { id: item.id, name: item.name, category: item.category ?? null, type: "boolean" as const,
            currentValue: item.currentValue, options: [] }),
      models: info.configOptions.filter((item) => item.type === "select" && (item.category === "model" || item.id === "model"))
        .flatMap((item) => item.type === "select" ? item.options.flatMap((option) => "value" in option ? [{ id: option.value, name: option.name }] : option.options.map((choice) => ({ id: choice.value, name: choice.name }))) : []),
      defaultModel: info.configOptions.find((item) => item.type === "select" && (item.category === "model" || item.id === "model"))?.type === "select"
        ? (info.configOptions.find((item) => item.type === "select" && (item.category === "model" || item.id === "model")) as { currentValue: string }).currentValue : null };
    this.configCache.set(directory.path, { expires: Date.now() + 30_000, value });
    return value;
  }

  cancel(executionId: string): void {
    this.service.cancelExecution(executionId);
    this.active.get(executionId)?.abort();
    this.releasePermissions(executionId);
  }

  respondPermission(executionId: string, permissionId: string, optionId: string): void {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending || pending.executionId !== executionId) {
      const permission = this.service.store.getExecutionPermission(permissionId);
      const execution = this.service.store.getExecution(executionId);
      const task = execution ? this.service.getTask(execution.taskId) : null;
      if (permission?.executionId === executionId && permission.status === "selected" && permission.selectedOptionId === optionId
        && execution?.status === "running" && task?.dispatchLease === permission.leaseId) return;
      throw conflict("Permissao nao esta ativa nesta execucao.");
    }
    this.service.decideAgentPermission(permissionId, optionId);
    this.pendingPermissions.delete(permissionId);
    pending.resolve(optionId);
  }

  async start(taskId: string, preferredProvider?: ProviderName, model?: string, sessionId?: string): Promise<ControlRoomTask> {
    const task = this.requireQueuedTask(taskId);
    const usesClaude = preferredProvider === "claude";
    if (usesClaude && !claudeTextTaskKinds.has(task.kind)) {
      throw new Error("Claude Code aceita apenas tarefas de revisão ou planejamento por texto.");
    }
    const directory = this.requireTargetDirectory(task);
    const request = usesClaude
      ? { cwd: directory.path, taskKind: task.kind, prompt: `${task.title}\n\n${task.prompt}` }
      : makeRunRequest(task, directory);
    const route = await this.runner.router.route({
      prompt: request.prompt,
      taskKind: task.kind,
      ...(preferredProvider ? { preferredProvider } : {})
    });
    if (!route.selected) {
      if (usesClaude) {
        throw new Error("Claude Code precisa estar instalado e autenticado. Consulte o status dos provedores ou execute `npm run doctor`.");
      }
      throw new Error("Nenhum provedor autenticado esta disponivel. Execute `npm run doctor` e atualize o login antes de tentar novamente.");
    }
    if ((model || sessionId) && route.selected !== "codex") throw new Error("Modelo e sessao ACP requerem Codex.");
    if (sessionId && !this.authorizedSession(task, sessionId)) throw new Error("Sessao ACP nao pertence ao escopo desta tarefa.");
    if (model) {
      const config = await this.codexConfig(directory.id);
      if (!config.models.some((item) => item.id === model)) throw new Error(`Modelo Codex nao anunciado: ${model}`);
    }

    const dispatched = await this.service.dispatch(task.id, {
      selectedProvider: route.selected,
      reason: routeReason(route),
      candidates: route.candidates.map(toDelegationCandidate),
      requestedActions: usesClaude ? [] : ["read_project"]
    });
    if (dispatched.status !== "running" || !dispatched.dispatchLease) {
      throw new Error("A tarefa nao foi iniciada; releia o estado antes de tentar novamente.");
    }

    const directories = usesClaude ? null : this.requireTaskDirectories(dispatched);
    const execution = this.service.store.listExecutions(task.id).find((item) => item.leaseId === dispatched.dispatchLease);
    if (!execution) throw new Error("Execucao reservada nao encontrada.");
    const controller = new AbortController();
    this.active.set(execution.id, controller);
    this.service.setExecutionMetadata(execution.id, dispatched.dispatchLease, route.selected === "codex" ? "acp" : "legacy", model ?? null, sessionId);
    const runRequest: AgentRunRequest = { ...request, signal: controller.signal,
      ...(model ? { model } : {}), ...(sessionId ? { sessionId } : {}),
      ...(route.selected === "codex" ? { additionalDirectories: (directories ?? []).filter((item) => item.id !== directory.id).map((item) => item.path),
        onUpdate: (update) => this.service.recordAgentUpdate(execution.id, dispatched.dispatchLease!, update),
        onPermission: async (permissionRequest) => {
          const permission = this.service.requestAgentPermission(execution.id, dispatched.dispatchLease!, permissionRequest);
          if (!permission) return null;
          return new Promise<string | null>((resolve) => this.pendingPermissions.set(permission.id, { executionId: execution.id, resolve }));
        } } : {}) };
    void this.runAndPersist(dispatched, runRequest, route.selected, directories, execution.id);
    return dispatched;
  }

  private async runAndPersist(task: ControlRoomTask, request: AgentRunRequest, selectedProvider: ProviderName, directories: LocalProjectDirectory[] | null, executionId: string): Promise<void> {
    const startedAt = Date.now();
    const execution = this.service.store.listExecutions(task.id).find((item) => item.leaseId === task.dispatchLease);
    let snapshot: Awaited<ReturnType<GitChangeCollector["capture"]>> | null = null;
    const collect = () => {
      if (!snapshot) return { files: [], warnings: [] };
      return execution ? snapshot.collect(execution.id) : { files: [], warnings: ["Execucao nao encontrada para registrar os arquivos afetados."] };
    };
    try {
      snapshot = directories ? await this.changes.capture(directories) : null;
      const outcome = await this.runner.run(request, selectedProvider);
      const collected = await collect();
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
      const collected = await collect();
      this.service.finishProviderRun(task.id, task.dispatchLease!, failed, collected.files, collected.warnings);
    } finally {
      this.active.delete(executionId);
      this.releasePermissions(executionId);
    }
  }

  private releasePermissions(executionId: string): void {
    for (const [id, pending] of this.pendingPermissions) {
      if (pending.executionId === executionId) { this.pendingPermissions.delete(id); pending.resolve(null); }
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
  private authorizedSession(task: ControlRoomTask, sessionId: string): boolean {
    return this.service.listTasks(task.projectId).some((previous) =>
      previous.targetDirectoryId === task.targetDirectoryId &&
      previous.directoryIds.join("\0") === task.directoryIds.join("\0") &&
      this.service.store.listExecutions(previous.id).some((execution) => execution.provider === "codex" &&
        execution.transport === "acp" && execution.sessionId === sessionId &&
        ["completed", "failed"].includes(execution.status)));
  }
}

export interface CodexConfig {
  directoryId: string;
  runtime: { path: string; version: string; source: string };
  protocolVersion: number;
  settings: Array<{ id: string; name: string; category: string | null; type: "select" | "boolean";
    currentValue: string | boolean; options: Array<{ id: string; name: string }> }>;
  models: Array<{ id: string; name: string }>;
  defaultModel: string | null;
}
function conflict(message: string): Error { return Object.assign(new Error(message), { statusCode: 409 }); }

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
