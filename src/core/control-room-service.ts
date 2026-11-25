import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { classifyTask } from "./router.js";
import { providerOutput, summarizeProviderResult } from "./provider-result.js";
import {
  assertSafeTaskActions,
  assertValidTransition,
  type ControlRoomStore,
  type ExecutionDetail,
  type ExecutionFileChange,
  type ExecutionEvent,
  type ExecutionPermission,
  type TaskExecution,
  type ControlRoomTask,
  type DelegationCandidate,
  type DelegationDecision,
  type DispatchAttempt,
  type LocalProject,
  type LocalProjectDirectory,
  type NewProject,
  type NewTask,
  type TaskAction,
  type TaskWorktree,
  type TaskPriority,
  type TaskStatus,
  taskPriorities
} from "./control-room.js";
import { taskKinds, type AgentPermissionRequest, type AgentRunResult, type AgentUpdate, type ProviderName } from "./contracts.js";

export interface WorktreeProvisioner {
  /** One worktree per scope directory, on a branch dedicated to the task. Must be idempotent per task. */
  prepare(project: LocalProject, task: ControlRoomTask, directories: readonly LocalProjectDirectory[]): Promise<TaskWorktree[]>;
  remove?(worktree: TaskWorktree, sourcePath: string): Promise<void>;
}

export interface DispatchRequest {
  selectedProvider: ProviderName | null;
  reason: string;
  candidates: readonly DelegationCandidate[];
  requestedActions: readonly TaskAction[];
  /** Status the task is claimed from. A follow-up turn starts from a finished one. */
  fromStatus?: "queued" | "completed" | "failed";
  /** Follow-up message for this turn; omitted when the turn runs the task's own prompt. */
  prompt?: string;
}

/** When disabled, dispatches run in the selected directory and are protected by its lease. */
export interface ControlRoomDispatchOptions { useWorktrees?: boolean; }

export class ControlRoomService {
  private readonly useWorktrees: boolean;
  private readonly eventListeners = new Map<string, Set<(event: ExecutionEvent) => void>>();

  constructor(
    readonly store: ControlRoomStore,
    private readonly worktrees?: WorktreeProvisioner,
    options: ControlRoomDispatchOptions = {}
  ) { this.useWorktrees = options.useWorktrees ?? true; }

  registerProject(input: NewProject): LocalProject {
    if (!input.name.trim()) throw new Error("O nome do projeto e obrigatorio.");
    const suppliedDirectories = input.directories ?? (input.path ? [{ path: input.path }] : []);
    if (!suppliedDirectories.length) throw new Error("Informe ao menos um diretorio local.");
    const paths = new Set<string>();
    const directories: LocalProjectDirectory[] = suppliedDirectories.map((directory) => {
      if (!isAbsolute(directory.path)) throw new Error("O caminho do diretorio deve ser absoluto.");
      const path = resolve(directory.path);
      if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`O caminho nao existe ou nao e um diretorio: ${path}`);
      const normalized = normalizeDirectoryPath(path);
      if (paths.has(normalized)) throw new Error("Um projeto nao pode conter diretorios duplicados.");
      paths.add(normalized);
      return {
        id: randomUUID(),
        name: directory.name?.trim() || defaultDirectoryName(path),
        path,
        createdAt: now(),
        isGitRepository: isGitRepository(path)
      };
    });
    if (directories.some((directory) => !directory.name)) throw new Error("O rotulo do diretorio e obrigatorio.");
    const project: LocalProject = {
      id: randomUUID(),
      name: input.name.trim(),
      path: directories[0]!.path,
      directories,
      createdAt: now()
    };
    this.store.createProject(project);
    return project;
  }

  createTask(input: NewTask): ControlRoomTask {
    const project = this.requireProject(input.projectId);
    if (!input.title.trim()) throw new Error("O titulo da tarefa e obrigatorio.");
    if (!input.prompt.trim()) throw new Error("O prompt da tarefa e obrigatorio.");
    if (input.priority && !taskPriorities.includes(input.priority)) throw new Error("Prioridade invalida.");
    if (input.kind && !taskKinds.includes(input.kind)) throw new Error("Tipo de tarefa invalido.");
    const targetDirectoryId = input.targetDirectoryId ?? project.directories[0]?.id;
    if (!targetDirectoryId || !project.directories.some((directory) => directory.id === targetDirectoryId)) {
      throw new Error("Selecione um diretorio valido para a tarefa.");
    }
    const requestedDirectoryIds = [...(input.directoryIds ?? [targetDirectoryId])];
    if (!requestedDirectoryIds.includes(targetDirectoryId)) throw new Error("O diretorio-alvo deve fazer parte do escopo da tarefa.");
    if (new Set(requestedDirectoryIds).size !== requestedDirectoryIds.length) throw new Error("O escopo da tarefa nao pode conter diretorios duplicados.");
    if (!requestedDirectoryIds.every((directoryId) => project.directories.some((directory) => directory.id === directoryId))) {
      throw new Error("Todos os diretorios do escopo devem pertencer ao projeto.");
    }
    const directoryIds = [targetDirectoryId, ...requestedDirectoryIds.filter((directoryId) => directoryId !== targetDirectoryId)];
    const createdAt = now();
    const task: ControlRoomTask = {
      id: randomUUID(),
      projectId: input.projectId,
      title: input.title.trim(),
      prompt: input.prompt.trim(),
      priority: input.priority ?? "normal",
      kind: input.kind ?? classifyTask(input.prompt),
      targetDirectoryId,
      directoryIds,
      usesWorktree: false,
      status: directoryIds.length > 1 ? "waiting_approval" : "queued",
      worktreePath: null,
      dispatchLease: null,
      createdAt,
      updatedAt: createdAt
    };
    this.store.createTask(task);
    return task;
  }

  transitionTask(taskId: string, toStatus: TaskStatus, actor = "control-room", reason?: string): ControlRoomTask {
    const task = this.requireTask(taskId);
    if (task.status === "waiting_approval" && task.dispatchLease) throw new Error("Permissao ACP ativa exige resposta pela rota da execucao.");
    assertValidTransition(task.status, toStatus);
    const updated = {
      ...task,
      status: toStatus,
      // A queued task will receive a fresh dispatch lease. Keeping the old
      // worktree here lets a later dispatch without create_worktree reuse an
      // artifact that belongs to the previous attempt.
      worktreePath: toStatus === "queued" ? null : task.worktreePath,
      dispatchLease: retainsLease(toStatus) ? task.dispatchLease : null,
      updatedAt: now()
    };
    const transitioned = this.store.transitionTask(updated, {
      id: randomUUID(), taskId, fromStatus: task.status, fromDispatchLease: task.dispatchLease, toStatus, actor,
      reason: reason?.trim() || null, createdAt: updated.updatedAt
    });
    if (!transitioned) throw new Error("A tarefa mudou de estado; releia antes de transicionar novamente.");
    return transitioned;
  }

  async dispatch(taskId: string, request: DispatchRequest): Promise<ControlRoomTask> {
    assertSafeTaskActions(request.requestedActions);
    if (!this.useWorktrees && request.requestedActions.includes("create_worktree")) {
      throw new Error("O modo sem worktrees nao permite criar worktree.");
    }
    const claimedAt = now();
    const leaseId = randomUUID();
    const execution = { id: randomUUID(), taskId, leaseId, provider: request.selectedProvider, status: "planned" as const, startedAt: null, finishedAt: null, summary: null, prompt: request.prompt?.trim() || null };
    const decision: DelegationDecision = { id: randomUUID(), taskId, selectedProvider: request.selectedProvider, reason: request.reason.trim(), candidates: request.candidates, requestedActions: request.requestedActions, createdAt: claimedAt };
    const attempt: DispatchAttempt = {
      leaseId,
      usesWorktree: this.useWorktrees && request.requestedActions.includes("create_worktree"),
      transition: { id: randomUUID(), taskId, fromStatus: request.fromStatus ?? "queued", fromDispatchLease: null, toStatus: "planning", actor: "dispatcher",
        reason: request.prompt ? "nova mensagem na mesma sessao" : "preparando despacho", createdAt: claimedAt },
      decision,
      execution
    };
    let task = this.store.claimDispatch(taskId, attempt);
    if (!task) throw new Error("A tarefa nao esta pronta para despacho ou ja foi reservada.");

    if (!request.selectedProvider) {
      return this.transitionTask(taskId, "waiting_approval", "dispatcher", "nenhum provedor selecionado");
    }
    try {
      let worktrees: TaskWorktree[] | null = null;
      if (this.useWorktrees && request.requestedActions.includes("create_worktree")) {
        // The worktree belongs to the task, not to the attempt: later turns keep working in it.
        worktrees = this.store.listTaskWorktrees(taskId);
        if (!worktrees.length) {
          if (!this.worktrees) throw new Error("Provisionador de worktree nao configurado.");
          const project = this.requireProject(task.projectId);
          worktrees = await this.worktrees.prepare(project, task, this.scopeDirectories(project, task));
        }
      }
      const completed = this.store.completeDispatchPreparation(taskId, leaseId, worktrees, {
        id: randomUUID(), taskId, fromStatus: "planning", fromDispatchLease: leaseId, toStatus: "running", actor: "dispatcher",
        reason: "despacho preparado; execucao do provedor e externa", createdAt: now()
      }, now());
      return completed ?? this.requireTask(taskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = this.store.failDispatchAttempt(taskId, leaseId, {
        id: randomUUID(), taskId, fromStatus: "planning", fromDispatchLease: leaseId, toStatus: "failed", actor: "dispatcher",
        reason: "falha ao preparar despacho", createdAt: now()
      }, message, { id: randomUUID(), executionId: execution.id, level: "error", message, createdAt: now() });
      return failed ?? this.requireTask(taskId);
    }
  }

  /**
   * True when the task should run in its own branch and worktree: the host supports it,
   * every scope directory is a Git repository and the task did not already run directly.
   * Plain folders always run in place.
   */
  isolatesTask(taskId: string): boolean {
    if (!this.useWorktrees || !this.worktrees) return false;
    const task = this.requireTask(taskId);
    const directories = this.scopeDirectories(this.requireProject(task.projectId), task);
    if (!directories.length || !directories.every((directory) => directory.isGitRepository)) return false;
    if (this.store.listTaskWorktrees(taskId).length) return true;
    return !this.store.listExecutions(taskId).some((execution) => execution.startedAt !== null);
  }

  /** Removes the task's worktrees and keeps its branch. Git refuses when there is uncommitted work. */
  async removeTaskWorktrees(taskId: string): Promise<ControlRoomTask> {
    const task = this.requireTask(taskId);
    if (task.dispatchLease) throw conflict("A tarefa esta em execucao; aguarde ou cancele antes de remover a worktree.");
    const worktrees = this.store.listTaskWorktrees(taskId);
    if (!worktrees.length) throw conflict("Esta tarefa nao possui worktree.");
    if (!this.worktrees?.remove) throw new Error("Provisionador de worktree nao configurado.");
    const project = this.requireProject(task.projectId);
    for (const worktree of worktrees) {
      const source = project.directories.find((directory) => directory.id === worktree.directoryId);
      if (source) await this.worktrees.remove(worktree, source.path);
    }
    this.store.deleteTaskWorktrees(taskId);
    return this.requireTask(taskId);
  }

  private scopeDirectories(project: LocalProject, task: ControlRoomTask): LocalProjectDirectory[] {
    return task.directoryIds.map((id) => project.directories.find((directory) => directory.id === id))
      .filter((directory): directory is LocalProjectDirectory => Boolean(directory));
  }

  listTasks(projectId?: string): ControlRoomTask[] { return this.store.listTasks(projectId); }
  getTask(id: string): ControlRoomTask | null { return this.store.getTask(id); }
  getProject(id: string): LocalProject | null { return this.store.getProject(id); }

  executionDetail(executionId: string): ExecutionDetail | null {
    const execution = this.store.getExecution(executionId);
    if (!execution) return null;
    const task = this.requireTask(execution.taskId);
    const project = this.requireProject(task.projectId);
    return { execution, task, project, logs: this.store.listLogs(execution.id), files: this.store.listExecutionFiles(execution.id), history: this.store.listExecutions(task.id),
      events: this.store.listExecutionEvents(execution.id), permissions: this.store.listExecutionPermissions(execution.id) };
  }

  onExecutionEvent(executionId: string, listener: (event: ExecutionEvent) => void): () => void {
    const listeners = this.eventListeners.get(executionId) ?? new Set();
    listeners.add(listener);
    this.eventListeners.set(executionId, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.eventListeners.delete(executionId); };
  }
  listExecutionEvents(executionId: string, afterSequence = 0): ExecutionEvent[] {
    return this.store.listExecutionEvents(executionId, afterSequence);
  }
  setExecutionMetadata(executionId: string, leaseId: string, transport: "acp" | "legacy", model: string | null, sessionId?: string): boolean {
    return this.store.setExecutionMetadata(executionId, leaseId, transport, model, sessionId);
  }
  recordAgentUpdate(executionId: string, leaseId: string, update: AgentUpdate): void {
    if (update.kind === "session_ready") {
      const options = update.payload.configOptions;
      const model = Array.isArray(options) ? options.find((item: unknown) => item && typeof item === "object" &&
        "id" in item && (item.id === "model" || ("category" in item && item.category === "model"))) as { currentValue?: unknown } | undefined : undefined;
      this.store.setExecutionMetadata(executionId, leaseId, "acp", typeof model?.currentValue === "string" ? model.currentValue : null, update.sessionId);
    }
    const payload = visibleAgentPayload(update);
    if (!payload) return;
    const event = this.store.appendExecutionEvent(executionId, leaseId, update.kind, payload);
    if (event) this.publish(event);
  }
  requestAgentPermission(executionId: string, leaseId: string, request: AgentPermissionRequest): ExecutionPermission | null {
    const permission: ExecutionPermission = { id: randomUUID(), executionId, leaseId, toolCallId: request.toolCallId,
      title: request.title, toolKind: request.toolKind ?? null, toolName: request.toolName ?? null,
      locations: request.locations ?? [], requiresElevation: request.requiresElevation ?? false,
      options: request.options, status: "pending", selectedOptionId: null,
      createdAt: now(), resolvedAt: null };
    const event = this.store.requestExecutionPermission(permission);
    if (!event) return null;
    this.publish(event);
    return permission;
  }
  decideAgentPermission(permissionId: string, optionId: string): ExecutionPermission {
    const requested = this.store.getExecutionPermission(permissionId);
    const selected = requested?.options.find((option) => option.id === optionId);
    if (selected?.kind === "allow_always" || (selected?.kind === "allow_once" && requested?.requiresElevation)) {
      throw conflict("Elevacao de escopo ou permissao persistente nao pode ser aprovada neste fluxo.");
    }
    const decision = this.store.decideExecutionPermission(permissionId, optionId);
    if (!decision) throw conflict("Permissao ausente, opcao invalida ou execucao encerrada.");
    this.publish(decision.event);
    return decision.permission;
  }
  cancelExecution(executionId: string): TaskExecution {
    const result = this.store.cancelActiveExecution(executionId, "Cancelada pelo operador.");
    if (!result) throw conflict("Execucao nao esta ativa para cancelamento.");
    this.publish(result.event);
    return result.execution;
  }

  private publish(event: ExecutionEvent): void {
    for (const listener of this.eventListeners.get(event.executionId) ?? []) listener(event);
  }

  finishProviderRun(taskId: string, leaseId: string, result: AgentRunResult, files: readonly ExecutionFileChange[] = [], warnings: readonly string[] = []): ControlRoomTask {
    const finishedAt = now();
    const succeeded = result.status === "success";
    const status = succeeded ? "completed" as const : "failed" as const;
    const summary = summarizeProviderResult(result);
    const current = this.requireTask(taskId);
    const completed = this.store.finishExecution(taskId, leaseId, result.provider, status, {
      id: randomUUID(),
      taskId,
      fromStatus: current.status,
      fromDispatchLease: leaseId,
      toStatus: status,
      actor: "provider",
      reason: succeeded ? "execucao concluida pelo provedor" : "execucao falhou no provedor",
      createdAt: finishedAt
    }, summary, providerOutput(result), files, {
      id: randomUUID(),
      executionId: this.requireExecutionId(taskId, leaseId),
      level: succeeded ? "info" : "error",
      message: [formatProviderLog(result), ...warnings.map((warning) => `[aviso Git] ${warning}`)].join("\n"),
      createdAt: finishedAt
    }, result.usage);
    if (completed) {
      const event = this.store.listExecutionEvents(this.requireExecutionId(taskId, leaseId)).at(-1);
      if (event && (event.kind === "completed" || event.kind === "failed")) this.publish(event);
    }
    return completed ?? this.requireTask(taskId);
  }

  snapshot(): import("./control-room.js").ControlRoomSnapshot {
    const tasks = this.store.listTasks();
    const executions = tasks.flatMap((task) => this.store.listExecutions(task.id));
    return {
      projects: this.store.listProjects(),
      tasks,
      executions: executions.map(({ output: _output, ...execution }) => execution),
      logs: executions.flatMap((execution) => this.store.listLogs(execution.id)),
      actions: this.store.listOutboundActions(),
      pullRequests: this.store.listTaskPullRequests()
    };
  }

  private requireTask(id: string): ControlRoomTask {
    const task = this.store.getTask(id);
    if (!task) throw new Error("Tarefa nao encontrada.");
    return task;
  }

  private requireProject(id: string): LocalProject {
    const project = this.store.getProject(id);
    if (!project) throw new Error("Projeto local nao encontrado.");
    return project;
  }

  private requireExecutionId(taskId: string, leaseId: string): string {
    const execution = this.store.listExecutions(taskId).find((item) => item.leaseId === leaseId);
    if (!execution) throw new Error("Execucao reservada nao encontrada.");
    return execution.id;
  }

}

function now(): string { return new Date().toISOString(); }
function conflict(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 409 });
}
function visibleAgentPayload(update: AgentUpdate): Record<string, unknown> | null {
  const value = update.payload;
  if (update.kind === "agent_message_chunk" || update.kind === "user_message_chunk") {
    const content = value.content;
    if (content && typeof content === "object" && "type" in content && content.type === "text" && "text" in content && typeof content.text === "string") {
      // The id only tells where one message ends and the next begins.
      return { text: content.text, ...(typeof value.messageId === "string" ? { messageId: value.messageId.slice(0, 200) } : {}) };
    }
    return null;
  }
  if (update.kind === "plan") {
    if (!Array.isArray(value.entries)) return null;
    return { entries: value.entries.slice(0, 50).flatMap((item) => {
      const entry = item as { content?: unknown; status?: unknown } | null;
      return entry && typeof entry.content === "string" && entry.content.trim()
        ? [{ content: entry.content.slice(0, 500), status: typeof entry.status === "string" ? entry.status.slice(0, 40) : "pending" }] : [];
    }) };
  }
  if (update.kind === "tool_call" || update.kind === "tool_call_update") {
    return { toolCallId: typeof value.toolCallId === "string" ? value.toolCallId : "",
      title: typeof value.title === "string" ? value.title : null,
      name: typeof value.name === "string" ? value.name : null,
      toolKind: typeof value.kind === "string" ? value.kind : null,
      status: typeof value.status === "string" ? value.status : null,
      locations: Array.isArray(value.locations) ? value.locations.slice(0, 20)
        .flatMap((item) => item && typeof item === "object" && "path" in item && typeof item.path === "string"
          ? [item.path.slice(0, 500)] : []) : [] };
  }
  if (update.kind === "session_ready") {
    return { sessionId: update.sessionId, protocolVersion: value.protocolVersion,
      agentName: value.agentName, runtimeVersion: value.runtimeVersion };
  }
  if (update.kind === "usage_update") {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "number" && Number.isFinite(item)));
  }
  return null;
}
function retainsLease(status: TaskStatus): boolean { return status === "planning" || status === "running"; }

function formatProviderLog(result: AgentRunResult): string {
  const usage = result.usage?.total ? `; ${result.usage.total} tokens` : "";
  const outcome = result.status === "success" ? "concluiu" : "falhou";
  const detail = result.status === "success" ? "" : ` Motivo: ${summarizeProviderResult(result)}`;
  return `${result.provider} ${outcome} em ${result.durationMs} ms${usage}.${detail}`;
}

function normalizeDirectoryPath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

function defaultDirectoryName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.at(-1) || path;
}

function isGitRepository(path: string): boolean {
  try {
    const metadata = statSync(join(path, ".git"));
    return metadata.isDirectory() || metadata.isFile();
  } catch { return false; }
}

export function isTaskPriority(value: string): value is TaskPriority {
  return value === "low" || value === "normal" || value === "high" || value === "critical";
}
