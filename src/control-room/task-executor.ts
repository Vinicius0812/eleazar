import type { AgentRunRequest, AgentRunResult, ProviderConfig, ProviderName, RouteDecision } from "../core/contracts.js";
import { CodexAcpClient } from "../adapters/codex-acp.js";
import { ClaudeAcpClient } from "../adapters/claude-acp.js";
import type { AcpClient, AcpSessionInfo } from "../adapters/acp-client.js";
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
  private readonly configCache = new Map<string, { expires: number; value: ProviderConfig }>();
  private readonly acpClients: ReadonlyMap<ProviderName, AcpClient>;
  isActive(executionId: string): boolean { return this.active.has(executionId); }
  constructor(
    private readonly service: ControlRoomService,
    private readonly runner: ControlRoomTaskRunner,
    private readonly changes = new GitChangeCollector(),
    private readonly codexClient = new CodexAcpClient(),
    private readonly claudeClient = new ClaudeAcpClient()
  ) { this.acpClients = new Map<ProviderName, AcpClient>([["codex", codexClient], ["claude", claudeClient]]); }

  async codexConfig(directoryId: string): Promise<ProviderConfig> { return this.providerConfig("codex", directoryId); }

  async providerConfig(provider: "codex" | "claude", directoryId: string): Promise<ProviderConfig> {
    const directory = this.service.store.listProjects().flatMap((project) => project.directories).find((item) => item.id === directoryId);
    if (!directory) throw new Error(`Diretorio nao encontrado para catalogo ${provider}.`);
    const key = `${provider}\0${directory.path}`;
    const cached = this.configCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    const client = this.acpClients.get(provider)!;
    let info: Awaited<ReturnType<typeof client.inspect>>;
    try { info = await client.inspect(directory.path); }
    catch (error) { throw Object.assign(new Error(`Catalogo ${provider} ACP indisponivel: ${error instanceof Error ? error.message : String(error)}`), { statusCode: 503 }); }
    const modelOption = info.configOptions.find((item) => item.type === "select" && (item.category === "model" || item.id === "model"));
    const model = modelOption?.type === "select" ? modelOption : null;
    const value: ProviderConfig = { provider, directoryId, runtime: info.runtime, protocolVersion: info.protocolVersion,
      capabilities: { loadSession: info.capabilities.loadSession === true },
      settings: info.configOptions.filter((item) => provider === "claude" || ["mode", "model", "thought_level", "model_config", "collaboration_mode"].includes(item.category ?? item.id))
        .map((item) => item.type === "select"
          ? { id: item.id, name: item.name, category: item.category ?? null, type: "select" as const,
            currentValue: item.currentValue,
            options: catalogChoices(item).filter((choice) =>
              item.category !== "mode" && item.id !== "mode" ||
              (provider === "claude" ? choice.id === "default" : ["read-only", "workspace-write"].includes(choice.id))) }
          : { id: item.id, name: item.name, category: item.category ?? null, type: "boolean" as const,
            currentValue: item.currentValue, options: [] }),
      models: model ? catalogChoices(model) : [],
      defaultModel: model?.currentValue ?? null };
    this.configCache.set(key, { expires: Date.now() + 30_000, value });
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
    const directory = this.requireTargetDirectory(task);
    const request = makeRunRequest(task, directory);
    const route = await this.runner.router.route({
      prompt: request.prompt,
      taskKind: task.kind,
      ...(preferredProvider ? { preferredProvider } : {})
    });
    if (!route.selected) {
      if (preferredProvider === "claude") {
        throw new Error("Claude Code precisa estar instalado e autenticado. Consulte o status dos provedores ou execute `npm run doctor`.");
      }
      throw new Error("Nenhum provedor autenticado esta disponivel. Execute `npm run doctor` e atualize o login antes de tentar novamente.");
    }
    const isAcp = this.acpClients.has(route.selected);
    if ((model || sessionId) && !isAcp) throw new Error("Modelo e sessao requerem um provedor ACP.");
    if (sessionId && !this.authorizedSession(task, route.selected, sessionId)) throw new Error("Sessao ACP nao pertence ao provedor e escopo desta tarefa.");
    if (model) {
      const config = await this.providerConfig(route.selected as "codex" | "claude", directory.id);
      if (!config.models.some((item) => item.id === model)) throw new Error(`Modelo ${route.selected} nao anunciado: ${model}`);
    }
    if (sessionId && !(await this.providerConfig(route.selected as "codex" | "claude", directory.id)).capabilities?.loadSession) throw new Error("Agente ACP nao anuncia retomada de sessao.");

    const dispatched = await this.service.dispatch(task.id, {
      selectedProvider: route.selected,
      reason: routeReason(route),
      candidates: route.candidates.map(toDelegationCandidate),
      requestedActions: ["read_project"]
    });
    if (dispatched.status !== "running" || !dispatched.dispatchLease) {
      throw new Error("A tarefa nao foi iniciada; releia o estado antes de tentar novamente.");
    }

    const directories = this.requireTaskDirectories(dispatched);
    const execution = this.service.store.listExecutions(task.id).find((item) => item.leaseId === dispatched.dispatchLease);
    if (!execution) throw new Error("Execucao reservada nao encontrada.");
    const controller = new AbortController();
    this.active.set(execution.id, controller);
    this.service.setExecutionMetadata(execution.id, dispatched.dispatchLease, isAcp ? "acp" : "legacy", model ?? null, sessionId);
    const runRequest: AgentRunRequest = { ...request, signal: controller.signal,
      ...(model ? { model } : {}), ...(sessionId ? { sessionId } : {}),
      ...(isAcp ? { additionalDirectories: directories.filter((item) => item.id !== directory.id).map((item) => item.path),
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
  private authorizedSession(task: ControlRoomTask, provider: ProviderName, sessionId: string): boolean {
    return this.service.listTasks(task.projectId).some((previous) =>
      previous.targetDirectoryId === task.targetDirectoryId &&
      previous.directoryIds.join("\0") === task.directoryIds.join("\0") &&
      this.service.store.listExecutions(previous.id).some((execution) => execution.provider === provider &&
        execution.transport === "acp" && execution.sessionId === sessionId &&
        ["completed", "failed"].includes(execution.status)));
  }
}

export type CodexConfig = ProviderConfig;
type SessionOption = AcpSessionInfo["configOptions"][number];
function catalogChoices(option: Extract<SessionOption, { type: "select" }>): Array<{ id: string; name: string }> {
  return option.options.flatMap((item) => "value" in item
    ? [{ id: item.value, name: item.name }]
    : item.options.map((choice) => ({ id: choice.value, name: choice.name })));
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
