import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import { classifyTask } from "./router.js";
import {
  assertSafeTaskActions,
  assertValidTransition,
  type ControlRoomStore,
  type ControlRoomTask,
  type DelegationCandidate,
  type DelegationDecision,
  type LocalProject,
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

export class ControlRoomService {
  constructor(
    readonly store: ControlRoomStore,
    private readonly worktrees?: WorktreeProvisioner
  ) {}

  registerProject(input: NewProject): LocalProject {
    if (!input.name.trim()) throw new Error("O nome do projeto e obrigatorio.");
    if (!isAbsolute(input.path)) throw new Error("O caminho do projeto deve ser absoluto.");
    const project: LocalProject = {
      id: randomUUID(),
      name: input.name.trim(),
      path: resolve(input.path),
      createdAt: now()
    };
    this.store.createProject(project);
    return project;
  }

  createTask(input: NewTask): ControlRoomTask {
    if (!this.store.getProject(input.projectId)) throw new Error("Projeto local nao encontrado.");
    if (!input.title.trim()) throw new Error("O titulo da tarefa e obrigatorio.");
    if (!input.prompt.trim()) throw new Error("O prompt da tarefa e obrigatorio.");
    if (input.priority && !taskPriorities.includes(input.priority)) throw new Error("Prioridade invalida.");
    if (input.kind && !taskKinds.includes(input.kind)) throw new Error("Tipo de tarefa invalido.");
    const createdAt = now();
    const task: ControlRoomTask = {
      id: randomUUID(),
      projectId: input.projectId,
      title: input.title.trim(),
      prompt: input.prompt.trim(),
      priority: input.priority ?? "normal",
      kind: input.kind ?? classifyTask(input.prompt),
      status: "queued",
      worktreePath: null,
      createdAt,
      updatedAt: createdAt
    };
    this.store.createTask(task);
    return task;
  }

  transitionTask(taskId: string, toStatus: TaskStatus, actor = "control-room", reason?: string): ControlRoomTask {
    const task = this.requireTask(taskId);
    assertValidTransition(task.status, toStatus);
    const updated = { ...task, status: toStatus, updatedAt: now() };
    this.store.updateTask(updated);
    this.store.recordTransition({
      id: randomUUID(), taskId, fromStatus: task.status, toStatus, actor,
      reason: reason?.trim() || null, createdAt: updated.updatedAt
    });
    return updated;
  }

  async dispatch(taskId: string, request: DispatchRequest): Promise<ControlRoomTask> {
    let task = this.requireTask(taskId);
    if (task.status !== "queued" && task.status !== "planning") {
      throw new Error(`A tarefa ${task.id} nao esta pronta para despacho.`);
    }
    assertSafeTaskActions(request.requestedActions);
    if (task.status === "queued") task = this.transitionTask(task.id, "planning", "dispatcher", "preparando despacho");

    const decision: DelegationDecision = {
      id: randomUUID(), taskId, selectedProvider: request.selectedProvider, reason: request.reason.trim(),
      candidates: request.candidates, requestedActions: request.requestedActions, createdAt: now()
    };
    this.store.recordDelegation(decision);

    if (!request.selectedProvider) {
      return this.transitionTask(taskId, "waiting_approval", "dispatcher", "nenhum provedor selecionado");
    }

    const execution = {
      id: randomUUID(), taskId, provider: request.selectedProvider, status: "planned" as const,
      startedAt: null, finishedAt: null, summary: null
    };
    this.store.createExecution(execution);
    try {
      if (task.kind === "implementation") {
        if (!this.worktrees) throw new Error("Provisionador de worktree nao configurado.");
        const project = this.requireProject(task.projectId);
        const worktreePath = await this.worktrees.prepare(project, task);
        task = { ...task, worktreePath, updatedAt: now() };
        this.store.updateTask(task);
      }
      this.store.updateExecution({ ...execution, status: "running", startedAt: now() });
      return this.transitionTask(taskId, "running", "dispatcher", "despacho preparado; execucao do provedor e externa");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.updateExecution({ ...execution, status: "failed", finishedAt: now(), summary: message });
      this.store.appendLog({ id: randomUUID(), executionId: execution.id, level: "error", message, createdAt: now() });
      return this.transitionTask(taskId, "failed", "dispatcher", "falha ao preparar despacho");
    }
  }

  listTasks(projectId?: string): ControlRoomTask[] { return this.store.listTasks(projectId); }
  getTask(id: string): ControlRoomTask | null { return this.store.getTask(id); }

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

export function isTaskPriority(value: string): value is TaskPriority {
  return value === "low" || value === "normal" || value === "high" || value === "critical";
}
