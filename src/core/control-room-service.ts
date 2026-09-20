import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { classifyTask } from "./router.js";
import {
  assertSafeTaskActions,
  assertValidTransition,
  type ControlRoomStore,
  type ControlRoomTask,
  type DelegationCandidate,
  type DelegationDecision,
  type DispatchAttempt,
  type LocalProject,
  type LocalProjectDirectory,
  type NewProject,
  type NewTask,
  type TaskAction,
  type TaskPriority,
  type TaskStatus,
  taskPriorities
} from "./control-room.js";
import { taskKinds, type ProviderName } from "./contracts.js";

export interface WorktreeProvisioner {
  prepare(project: LocalProject, task: ControlRoomTask): Promise<string>;
}

export interface DispatchRequest {
  selectedProvider: ProviderName | null;
  reason: string;
  candidates: readonly DelegationCandidate[];
  requestedActions: readonly TaskAction[];
}

/** When disabled, dispatches run in the selected directory and are protected by its lease. */
export interface ControlRoomDispatchOptions { useWorktrees?: boolean; }

export class ControlRoomService {
  private readonly useWorktrees: boolean;

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
        isGitRepository: existsSync(join(path, ".git"))
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
    const createdAt = now();
    const task: ControlRoomTask = {
      id: randomUUID(),
      projectId: input.projectId,
      title: input.title.trim(),
      prompt: input.prompt.trim(),
      priority: input.priority ?? "normal",
      kind: input.kind ?? classifyTask(input.prompt),
      targetDirectoryId,
      usesWorktree: false,
      status: "queued",
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
    const execution = { id: randomUUID(), taskId, leaseId, provider: request.selectedProvider, status: "planned" as const, startedAt: null, finishedAt: null, summary: null };
    const decision: DelegationDecision = { id: randomUUID(), taskId, selectedProvider: request.selectedProvider, reason: request.reason.trim(), candidates: request.candidates, requestedActions: request.requestedActions, createdAt: claimedAt };
    const attempt: DispatchAttempt = {
      leaseId,
      usesWorktree: this.useWorktrees && request.requestedActions.includes("create_worktree"),
      transition: { id: randomUUID(), taskId, fromStatus: "queued", fromDispatchLease: null, toStatus: "planning", actor: "dispatcher", reason: "preparando despacho", createdAt: claimedAt },
      decision,
      execution
    };
    let task = this.store.claimDispatch(taskId, attempt);
    if (!task) throw new Error("A tarefa nao esta pronta para despacho ou ja foi reservada.");

    if (!request.selectedProvider) {
      return this.transitionTask(taskId, "waiting_approval", "dispatcher", "nenhum provedor selecionado");
    }
    try {
      let worktreePath: string | null = null;
      if (this.useWorktrees && request.requestedActions.includes("create_worktree")) {
        if (!this.worktrees) throw new Error("Provisionador de worktree nao configurado.");
        worktreePath = await this.worktrees.prepare(this.requireProject(task.projectId), task);
      }
      const completed = this.store.completeDispatchPreparation(taskId, leaseId, worktreePath, {
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

  listTasks(projectId?: string): ControlRoomTask[] { return this.store.listTasks(projectId); }
  getTask(id: string): ControlRoomTask | null { return this.store.getTask(id); }

  snapshot(): import("./control-room.js").ControlRoomSnapshot {
    const tasks = this.store.listTasks();
    const executions = tasks.flatMap((task) => this.store.listExecutions(task.id));
    return {
      projects: this.store.listProjects(),
      tasks,
      executions,
      logs: executions.flatMap((execution) => this.store.listLogs(execution.id))
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

}

function now(): string { return new Date().toISOString(); }
function retainsLease(status: TaskStatus): boolean { return status === "planning" || status === "running"; }

function normalizeDirectoryPath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

function defaultDirectoryName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.at(-1) || path;
}

export function isTaskPriority(value: string): value is TaskPriority {
  return value === "low" || value === "normal" || value === "high" || value === "critical";
}
