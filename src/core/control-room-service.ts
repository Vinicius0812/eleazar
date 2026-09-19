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
  type DispatchAttempt,
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
    const updated = { ...task, status: toStatus, dispatchLease: retainsLease(toStatus) ? task.dispatchLease : null, updatedAt: now() };
    const transitioned = this.store.transitionTask(updated, {
      id: randomUUID(), taskId, fromStatus: task.status, fromDispatchLease: task.dispatchLease, toStatus, actor,
      reason: reason?.trim() || null, createdAt: updated.updatedAt
    });
    if (!transitioned) throw new Error("A tarefa mudou de estado; releia antes de transicionar novamente.");
    return transitioned;
  }

  async dispatch(taskId: string, request: DispatchRequest): Promise<ControlRoomTask> {
    assertSafeTaskActions(request.requestedActions);
    const claimedAt = now();
    const leaseId = randomUUID();
    const execution = { id: randomUUID(), taskId, leaseId, provider: request.selectedProvider, status: "planned" as const, startedAt: null, finishedAt: null, summary: null };
    const decision: DelegationDecision = { id: randomUUID(), taskId, selectedProvider: request.selectedProvider, reason: request.reason.trim(), candidates: request.candidates, requestedActions: request.requestedActions, createdAt: claimedAt };
    const attempt: DispatchAttempt = {
      leaseId,
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
      if (request.requestedActions.includes("create_worktree")) {
        if (!this.worktrees) throw new Error("Provisionador de worktree nao configurado.");
        const project = this.requireProject(task.projectId);
        worktreePath = await this.worktrees.prepare(project, task);
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

export function isTaskPriority(value: string): value is TaskPriority {
  return value === "low" || value === "normal" || value === "high" || value === "critical";
}
