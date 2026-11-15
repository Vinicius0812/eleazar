import { existsSync } from "node:fs";

import type { ControlRoomStore, PullRequestInspector, TaskPullRequest } from "./control-room.js";

export interface PullRequestRefresh {
  pullRequests: TaskPullRequest[];
  /** Why some directories could not be read (forge CLI missing, not authenticated, offline). */
  warnings: string[];
}

/**
 * Keeps the last known pull request of each task branch. It only reads: opening a pull
 * request goes through the outbound-action approval layer, and merging stays with the operator.
 */
export class PullRequestService {
  private refreshing: Promise<PullRequestRefresh> | null = null;
  constructor(private readonly store: ControlRoomStore, private readonly inspector: PullRequestInspector) {}

  list(taskId: string): TaskPullRequest[] { return this.store.listTaskPullRequests(taskId); }

  async refresh(taskId: string): Promise<PullRequestRefresh> {
    const task = this.store.getTask(taskId);
    if (!task) throw Object.assign(new Error("Tarefa nao encontrada."), { statusCode: 404 });
    const project = this.store.getProject(task.projectId);
    const known = this.store.listTaskPullRequests(taskId);
    // A removed worktree keeps its branch, so a known pull request is still followed from the source repository.
    const targets = new Map<string, { path: string; branch: string }>();
    for (const pullRequest of known) {
      const source = project?.directories.find((directory) => directory.id === pullRequest.directoryId);
      if (source) targets.set(pullRequest.directoryId, { path: source.path, branch: pullRequest.headBranch });
    }
    for (const worktree of this.store.listTaskWorktrees(taskId)) {
      if (existsSync(worktree.path)) targets.set(worktree.directoryId, { path: worktree.path, branch: worktree.branch });
    }
    const warnings: string[] = [];
    for (const [directoryId, target] of targets) {
      try {
        const state = await this.inspector.find(target.path, target.branch);
        if (state) this.store.upsertTaskPullRequest({ ...state, taskId, directoryId, headBranch: target.branch, fetchedAt: new Date().toISOString() });
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }
    return { pullRequests: this.store.listTaskPullRequests(taskId), warnings: [...new Set(warnings)] };
  }

  /** Re-reads every task that owns a branch or an unfinished pull request. Concurrent calls share one pass. */
  refreshAll(): Promise<PullRequestRefresh> {
    this.refreshing ??= this.refreshEvery().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async refreshEvery(): Promise<PullRequestRefresh> {
    const finished = new Map<string, boolean>();
    for (const pullRequest of this.store.listTaskPullRequests()) {
      finished.set(pullRequest.taskId, (finished.get(pullRequest.taskId) ?? true) && pullRequest.state !== "open");
    }
    const warnings: string[] = [];
    for (const task of this.store.listTasks()) {
      const settled = finished.get(task.id);
      // Merged or closed pull requests no longer change; branches never pushed have nothing to read.
      if (settled === true || (settled === undefined && !this.pushed(task.id))) continue;
      warnings.push(...(await this.refresh(task.id)).warnings);
      // Without a working forge CLI every other task would fail the same way.
      if (warnings.length) break;
    }
    return { pullRequests: this.store.listTaskPullRequests(), warnings: [...new Set(warnings)] };
  }

  private pushed(taskId: string): boolean {
    return this.store.listOutboundActions(taskId).some((action) => action.status === "completed" && action.kind !== "commit");
  }
}
