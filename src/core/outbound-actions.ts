import { randomUUID } from "node:crypto";

import {
  outboundActionKinds,
  type ControlRoomStore,
  type OutboundActionKind,
  type OutboundActionTarget,
  type RepositoryPublisher,
  type TaskOutboundAction,
  type TaskWorktree
} from "./control-room.js";

export interface OutboundActionInput {
  kind: OutboundActionKind;
  title?: string;
  body?: string;
}

/**
 * Explicit approval layer for anything that leaves the task's worktree: commit, push and
 * pull request. A request only records what would happen; nothing runs until the operator
 * approves that exact record. Merge and deploy are not offered at all.
 */
export class OutboundActionService {
  constructor(private readonly store: ControlRoomStore, private readonly publisher: RepositoryPublisher) {}

  list(taskId: string): TaskOutboundAction[] { return this.store.listOutboundActions(taskId); }

  async request(taskId: string, input: OutboundActionInput, requestedBy = "local-operator"): Promise<TaskOutboundAction> {
    if (!outboundActionKinds.includes(input.kind)) throw new Error("Acao de saida invalida.");
    const title = input.title?.trim() || null;
    const body = input.body?.trim() || null;
    if (input.kind !== "push" && !title) throw new Error(input.kind === "commit" ? "Informe a mensagem do commit." : "Informe o titulo do pull request.");
    const worktrees = this.idleWorktrees(taskId);
    if (this.store.listOutboundActions(taskId).some((action) => action.status === "pending" || action.status === "running")) {
      throw conflict("Ja existe uma acao aguardando decisao nesta tarefa.");
    }
    const names = this.directoryNames(taskId);
    const inspected: OutboundActionTarget[] = [];
    for (const worktree of worktrees) {
      const state = await this.publisher.inspect(worktree);
      inspected.push({ directoryId: worktree.directoryId, directoryName: names.get(worktree.directoryId) ?? worktree.directoryId, branch: worktree.branch, ...state });
    }
    const targets = inspected.filter((target) => input.kind === "commit" ? target.changedFiles > 0 : target.commitsAhead > 0 && target.remote !== null);
    if (!targets.length) throw conflict(emptyReason(input.kind, inspected));
    const action: TaskOutboundAction = { id: randomUUID(), taskId, kind: input.kind, status: "pending", title, body, targets,
      result: null, requestedBy, createdAt: now(), decidedAt: null, finishedAt: null };
    this.store.createOutboundAction(action);
    return action;
  }

  async decide(actionId: string, decision: "approve" | "reject"): Promise<TaskOutboundAction> {
    const action = this.store.getOutboundAction(actionId);
    if (!action) throw Object.assign(new Error("Acao nao encontrada."), { statusCode: 404 });
    if (decision === "reject") {
      const rejected = this.store.updateOutboundAction(actionId, "pending", { status: "rejected", decidedAt: now(), finishedAt: now() });
      if (!rejected) throw conflict("A acao ja foi decidida.");
      return rejected;
    }
    const worktrees = this.idleWorktrees(action.taskId);
    const running = this.store.updateOutboundAction(actionId, "pending", { status: "running", decidedAt: now() });
    if (!running) throw conflict("A acao ja foi decidida.");
    const lines: string[] = [];
    try {
      for (const target of action.targets) {
        const worktree = worktrees.find((item) => item.directoryId === target.directoryId);
        if (!worktree) throw new Error(`Worktree de ${target.directoryName} nao existe mais.`);
        lines.push(`${target.directoryName}: ${await this.run(action, worktree)}`);
      }
      return this.store.updateOutboundAction(actionId, "running", { status: "completed", result: lines.join("\n"), finishedAt: now() }) ?? running;
    } catch (error) {
      lines.push(`Falhou: ${error instanceof Error ? error.message : String(error)}`);
      return this.store.updateOutboundAction(actionId, "running", { status: "failed", result: lines.join("\n"), finishedAt: now() }) ?? running;
    }
  }

  /** Marks actions left running by a previous host process as failed; their real outcome is unknown. */
  recoverInterrupted(): number {
    const interrupted = this.store.listOutboundActions().filter((action) => action.status === "running");
    for (const action of interrupted) {
      this.store.updateOutboundAction(action.id, "running", { status: "failed", finishedAt: now(),
        result: "Host local reiniciado durante a acao; confira o estado do repositorio antes de repetir." });
    }
    return interrupted.length;
  }

  private run(action: TaskOutboundAction, worktree: TaskWorktree): Promise<string> {
    if (action.kind === "commit") return this.publisher.commit(worktree, [action.title, action.body].filter(Boolean).join("\n\n"));
    if (action.kind === "push") return this.publisher.push(worktree);
    return this.publisher.openPullRequest(worktree, action.title ?? worktree.branch, action.body ?? "");
  }

  private idleWorktrees(taskId: string): TaskWorktree[] {
    const task = this.store.getTask(taskId);
    if (!task) throw Object.assign(new Error("Tarefa nao encontrada."), { statusCode: 404 });
    if (task.dispatchLease) throw conflict("A tarefa esta em execucao; aguarde o agente terminar o turno.");
    const worktrees = this.store.listTaskWorktrees(taskId);
    if (!worktrees.length) throw conflict("Esta tarefa roda direto na pasta, sem branch propria. Commit, push e pull request exigem um repositorio Git isolado em worktree.");
    return worktrees;
  }

  private directoryNames(taskId: string): Map<string, string> {
    const task = this.store.getTask(taskId);
    const project = task ? this.store.getProject(task.projectId) : null;
    return new Map((project?.directories ?? []).map((directory) => [directory.id, directory.name]));
  }
}

function emptyReason(kind: OutboundActionKind, inspected: readonly OutboundActionTarget[]): string {
  if (kind === "commit") return "Nao ha alteracoes para commit.";
  if (inspected.every((target) => target.remote === null)) return "O repositorio nao tem o remoto origin configurado.";
  return "Nao ha commits novos na branch da tarefa; faca o commit primeiro.";
}
function now(): string { return new Date().toISOString(); }
function conflict(message: string): Error { return Object.assign(new Error(message), { statusCode: 409 }); }
