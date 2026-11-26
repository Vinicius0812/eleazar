import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import type {
  ControlRoomStore,
  ControlRoomTask,
  DelegationDecision,
  ExecutionLog,
  ExecutionFileChange,
  ExecutionEvent,
  ExecutionPermission,
  LocalProject,
  LocalProjectDirectory,
  TaskExecution,
  TaskOutboundAction,
  TaskPullRequest,
  TaskWorktree,
  TaskTransition
} from "../core/control-room.js";
import type { ProviderPreferences } from "../core/contracts.js";

/** Operator choices of an existing database, read without migrating or writing to it. */
export function readProviderPreferences(databasePath: string): Map<string, ProviderPreferences> {
  const db = new Database(databasePath, { readonly: true });
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_settings'").get();
    const rows = exists ? db.prepare("SELECT * FROM provider_settings").all() as Row[] : [];
    return new Map(rows.map((row) => [stringValue(row, "provider_id"), mapPreferences(row)]));
  } finally { db.close(); }
}

/** SQLite persistence for the local Control Room. Database paths normally live under .eleazar/. */
export class SqliteControlRoomStore implements ControlRoomStore {
  readonly #db: Database.Database;
  #closed = false;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.#db = new Database(databasePath);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("foreign_keys = ON");
    this.#migrate();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  createProject(project: LocalProject): void {
    this.#db.transaction(() => {
      this.#db.prepare("INSERT INTO projects (id, name, path, isolation, created_at) VALUES (@id, @name, @path, @isolation, @createdAt)")
        .run({ id: project.id, name: project.name, path: project.path, isolation: project.isolation, createdAt: project.createdAt });
      const insertDirectory = this.#db.prepare(`INSERT INTO project_directories (id, project_id, name, path, position, is_git_repository, created_at)
        VALUES (@id, @projectId, @name, @path, @position, @isGitRepository, @createdAt)`);
      project.directories.forEach((directory, position) => insertDirectory.run({ ...directory, projectId: project.id, position, isGitRepository: directory.isGitRepository ? 1 : 0 }));
    })();
  }
  getProject(id: string): LocalProject | null {
    const row = this.#db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    return mapProject(row, row ? this.#directoriesFor(id) : []);
  }
  listProjects(): LocalProject[] {
    return this.#db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all().map((row) => {
      const item = row as Row;
      return mapProject(row, this.#directoriesFor(stringValue(item, "id")));
    }).filter(isPresent);
  }
  setProjectIsolation(id: string, isolation: LocalProject["isolation"]): LocalProject | null {
    this.#db.prepare("UPDATE projects SET isolation = ? WHERE id = ?").run(isolation, id);
    return this.getProject(id);
  }
  hasActiveDispatchForDirectories(directoryIds: readonly string[], excludingTaskId?: string): boolean {
    if (!directoryIds.length) return false;
    const placeholders = directoryIds.map(() => "?").join(", ");
    const exclusion = excludingTaskId ? "AND t.id <> ?" : "";
    const row = this.#db.prepare(`SELECT 1 FROM tasks t JOIN task_directory_scopes scope ON scope.task_id = t.id
      WHERE scope.directory_id IN (${placeholders}) AND t.uses_worktree = 0
      AND (t.status IN ('planning', 'running') OR (t.status = 'waiting_approval' AND t.dispatch_lease IS NOT NULL)) ${exclusion} LIMIT 1`)
      .get(...directoryIds, ...(excludingTaskId ? [excludingTaskId] : []));
    return Boolean(row);
  }
  createTask(task: ControlRoomTask): void {
    this.#db.transaction(() => {
      this.#db.prepare(`INSERT INTO tasks (id, project_id, target_directory_id, uses_worktree, title, prompt, priority, status, kind, worktree_path, dispatch_lease, comparison_id, created_at, updated_at)
        VALUES (@id, @projectId, @targetDirectoryId, @usesWorktree, @title, @prompt, @priority, @status, @kind, @worktreePath, @dispatchLease, @comparisonId, @createdAt, @updatedAt)`).run({ ...task, comparisonId: task.comparisonId ?? null, usesWorktree: task.usesWorktree ? 1 : 0 });
      this.#replaceTaskDirectoryScope(task.id, task.directoryIds);
    })();
  }
  getTask(id: string): ControlRoomTask | null {
    const row = this.#db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return mapTask(row, row ? this.#taskDirectoryIds(id) : [], row ? this.#taskBranch(id) : null);
  }
  listTasks(projectId?: string): ControlRoomTask[] {
    const rows = projectId
      ? this.#db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC").all(projectId)
      : this.#db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all();
    return rows.map((row) => mapTask(row, this.#taskDirectoryIds(stringValue(row as Row, "id")), this.#taskBranch(stringValue(row as Row, "id")))).filter(isPresent);
  }
  updateTask(task: ControlRoomTask): void {
    this.#db.transaction(() => {
      const result = this.#db.prepare(`UPDATE tasks SET target_directory_id = @targetDirectoryId, uses_worktree = @usesWorktree, title = @title, prompt = @prompt, priority = @priority, status = @status,
        kind = @kind, worktree_path = @worktreePath, dispatch_lease = @dispatchLease, updated_at = @updatedAt WHERE id = @id`).run({ ...task, usesWorktree: task.usesWorktree ? 1 : 0 });
      if (result.changes !== 1) throw new Error("Tarefa nao encontrada para atualizacao.");
      this.#replaceTaskDirectoryScope(task.id, task.directoryIds);
    })();
  }
  transitionTask(task: ControlRoomTask, transition: TaskTransition): ControlRoomTask | null {
    return this.#db.transaction(() => {
      const previous = this.getTask(task.id);
      if (!previous) return null;
      const fromDispatchLease = transition.fromDispatchLease;
      const result = this.#db.prepare(`UPDATE tasks SET target_directory_id = @targetDirectoryId, uses_worktree = @usesWorktree, title = @title, prompt = @prompt, priority = @priority, status = @status,
        kind = @kind, worktree_path = @worktreePath, dispatch_lease = @dispatchLease, updated_at = @updatedAt
        WHERE id = @id AND status = @fromStatus
          AND ((@fromDispatchLease IS NULL AND dispatch_lease IS NULL) OR dispatch_lease = @fromDispatchLease)`).run({
        ...task, usesWorktree: task.usesWorktree ? 1 : 0, fromStatus: transition.fromStatus, fromDispatchLease
      });
      if (result.changes !== 1) return null;
      this.recordTransition(transition);
      if (previous.dispatchLease && previous.dispatchLease !== task.dispatchLease) {
        this.#db.prepare(`UPDATE executions SET status = 'cancelled', finished_at = @finishedAt, summary = 'tentativa substituida'
          WHERE task_id = @taskId AND lease_id = @leaseId AND status = 'planned'`).run({ taskId: task.id, leaseId: previous.dispatchLease, finishedAt: transition.createdAt });
      }
      return task;
    })();
  }
  claimDispatch(taskId: string, attempt: import("../core/control-room.js").DispatchAttempt): ControlRoomTask | null {
    return this.#db.transaction(() => {
      const current = this.getTask(taskId);
      // A new turn starts from the queue or, for a follow-up message, from a finished turn.
      const fromStatus = attempt.transition.fromStatus;
      if (!current || current.status !== fromStatus || !["queued", "completed", "failed"].includes(fromStatus)) return null;
      if (!attempt.usesWorktree && this.hasActiveDispatchForDirectories(current.directoryIds, taskId)) return null;
      const claimed = { ...current, status: "planning" as const, usesWorktree: attempt.usesWorktree, dispatchLease: attempt.leaseId, updatedAt: attempt.transition.createdAt };
      const result = this.#db.prepare(`UPDATE tasks SET status = @status, uses_worktree = @usesWorktree, dispatch_lease = @dispatchLease, updated_at = @updatedAt
        WHERE id = @id AND status = @fromStatus AND dispatch_lease IS NULL`).run({ ...claimed, fromStatus, usesWorktree: claimed.usesWorktree ? 1 : 0 });
      if (result.changes !== 1) return null;
      this.recordTransition(attempt.transition);
      this.recordDelegation(attempt.decision);
      this.createExecution(attempt.execution);
      return claimed;
    })();
  }
  completeDispatchPreparation(taskId: string, leaseId: string, worktrees: readonly TaskWorktree[] | null, transition: TaskTransition, startedAt: string): ControlRoomTask | null {
    return this.#db.transaction(() => {
      const current = this.getTask(taskId);
      if (!current || current.status !== "planning" || current.dispatchLease !== leaseId) return null;
      if (worktrees?.length) {
        const insert = this.#db.prepare(`INSERT OR REPLACE INTO task_worktrees (task_id, directory_id, path, branch, base_commit, created_at)
          VALUES (@taskId, @directoryId, @path, @branch, @baseCommit, @createdAt)`);
        for (const worktree of worktrees) insert.run(worktree);
      }
      const target = worktrees?.find((item) => item.directoryId === current.targetDirectoryId) ?? worktrees?.[0];
      const completed = { ...current, status: "running" as const, worktreePath: target?.path ?? current.worktreePath, branch: target?.branch ?? current.branch ?? null, updatedAt: transition.createdAt };
      const task = this.#db.prepare(`UPDATE tasks SET status = @status, worktree_path = @worktreePath, updated_at = @updatedAt
        WHERE id = @id AND status = 'planning' AND dispatch_lease = @leaseId`).run({ ...completed, leaseId });
      if (task.changes !== 1) return null;
      const execution = this.#db.prepare(`UPDATE executions SET status = 'running', started_at = @startedAt
        WHERE task_id = @taskId AND lease_id = @leaseId AND status = 'planned'`).run({ taskId, leaseId, startedAt });
      if (execution.changes !== 1) throw new Error("Execucao reservada nao encontrada.");
      this.recordTransition(transition);
      this.#insertEvent(this.#executionIdFor(taskId, leaseId), "started", {});
      return completed;
    })();
  }
  failDispatchAttempt(taskId: string, leaseId: string, transition: TaskTransition, executionSummary: string, log: ExecutionLog): ControlRoomTask | null {
    return this.#db.transaction(() => {
      const current = this.getTask(taskId);
      if (!current || current.status !== "planning" || current.dispatchLease !== leaseId) return null;
      const failed = { ...current, status: "failed" as const, dispatchLease: null, updatedAt: transition.createdAt };
      const task = this.#db.prepare(`UPDATE tasks SET status = @status, dispatch_lease = NULL, updated_at = @updatedAt
        WHERE id = @id AND status = 'planning' AND dispatch_lease = @leaseId`).run({ ...failed, leaseId });
      if (task.changes !== 1) return null;
      const execution = this.#db.prepare(`UPDATE executions SET status = 'failed', finished_at = @finishedAt, summary = @summary
        WHERE task_id = @taskId AND lease_id = @leaseId AND status = 'planned'`).run({ taskId, leaseId, finishedAt: transition.createdAt, summary: executionSummary });
      if (execution.changes !== 1) throw new Error("Execucao reservada nao encontrada.");
      this.recordTransition(transition);
      this.appendLog(log);
      this.#insertEvent(this.#executionIdFor(taskId, leaseId), "failed", { summary: executionSummary });
      return failed;
    })();
  }
  createExecution(execution: TaskExecution): void {
    this.#db.prepare(`INSERT INTO executions (id, task_id, lease_id, provider, status, started_at, finished_at, summary, output, usage_json, prompt)
      VALUES (@id, @taskId, @leaseId, @provider, @status, @startedAt, @finishedAt, @summary, @output, @usageJson, @prompt)`).run({ ...execution, output: execution.output ?? null, usageJson: execution.usage ? JSON.stringify(execution.usage) : null, prompt: execution.prompt ?? null });
  }
  getExecution(id: string): TaskExecution | null { return mapExecution(this.#db.prepare("SELECT * FROM executions WHERE id = ?").get(id)); }
  updateExecution(execution: TaskExecution): void {
    const result = this.#db.prepare(`UPDATE executions SET lease_id = @leaseId, provider = @provider, status = @status, started_at = @startedAt,
      finished_at = @finishedAt, summary = @summary, output = @output, usage_json = @usageJson WHERE id = @id`).run({ ...execution, output: execution.output ?? null, usageJson: execution.usage ? JSON.stringify(execution.usage) : null });
    if (result.changes !== 1) throw new Error("Execucao nao encontrada para atualizacao.");
  }
  listExecutions(taskId: string): TaskExecution[] {
    return this.#db.prepare("SELECT * FROM executions WHERE task_id = ? ORDER BY rowid DESC").all(taskId).map(mapExecution).filter(isPresent);
  }
  listExecutionFiles(executionId: string): ExecutionFileChange[] {
    return this.#db.prepare("SELECT * FROM execution_file_changes WHERE execution_id = ? ORDER BY directory_id, path")
      .all(executionId).map(mapExecutionFileChange).filter(isPresent);
  }
  appendLog(log: ExecutionLog): void {
    this.#db.prepare("INSERT INTO execution_logs (id, execution_id, level, message, created_at) VALUES (@id, @executionId, @level, @message, @createdAt)").run(log);
  }
  listLogs(executionId: string): ExecutionLog[] {
    return this.#db.prepare("SELECT * FROM execution_logs WHERE execution_id = ? ORDER BY rowid").all(executionId).map(mapLog).filter(isPresent);
  }
  recordDelegation(decision: DelegationDecision): void {
    this.#db.prepare(`INSERT INTO delegation_decisions (id, task_id, selected_provider, reason, candidates_json, actions_json, created_at)
      VALUES (@id, @taskId, @selectedProvider, @reason, @candidatesJson, @actionsJson, @createdAt)`).run({
      ...decision, candidatesJson: JSON.stringify(decision.candidates), actionsJson: JSON.stringify(decision.requestedActions)
    });
  }
  listDelegations(taskId: string): DelegationDecision[] {
    return this.#db.prepare("SELECT * FROM delegation_decisions WHERE task_id = ? ORDER BY rowid").all(taskId).map(mapDelegation).filter(isPresent);
  }
  recordTransition(transition: TaskTransition): void {
    this.#db.prepare(`INSERT INTO task_transitions (id, task_id, from_status, from_lease, to_status, actor, reason, created_at)
      VALUES (@id, @taskId, @fromStatus, @fromDispatchLease, @toStatus, @actor, @reason, @createdAt)`).run(transition);
  }
  listTransitions(taskId: string): TaskTransition[] {
    return this.#db.prepare("SELECT * FROM task_transitions WHERE task_id = ? ORDER BY rowid").all(taskId).map(mapTransition).filter(isPresent);
  }

  setExecutionMetadata(executionId: string, leaseId: string, transport: TaskExecution["transport"], model: string | null, sessionId: string | null = null): boolean {
    const result = this.#db.prepare(`UPDATE executions SET transport = @transport, model = COALESCE(@model, model),
      session_id = COALESCE(@sessionId, session_id) WHERE id = @executionId AND lease_id = @leaseId
      AND status IN ('planned', 'running')`).run({ executionId, leaseId, transport: transport ?? null, model, sessionId });
    return result.changes === 1;
  }
  appendExecutionEvent(executionId: string, leaseId: string, kind: string, payload: Record<string, unknown>): ExecutionEvent | null {
    return this.#db.transaction(() => {
      const active = this.#db.prepare(`SELECT 1 FROM executions e JOIN tasks t ON t.id = e.task_id
        WHERE e.id = ? AND e.lease_id = ? AND t.dispatch_lease = ? AND e.status = 'running'
        AND t.status IN ('running', 'waiting_approval')`).get(executionId, leaseId, leaseId);
      return active ? this.#insertEvent(executionId, kind, payload) : null;
    })();
  }
  listExecutionEvents(executionId: string, afterSequence = 0): ExecutionEvent[] {
    return this.#db.prepare("SELECT * FROM execution_events WHERE execution_id = ? AND sequence > ? ORDER BY sequence")
      .all(executionId, afterSequence).map(mapEvent).filter(isPresent);
  }
  requestExecutionPermission(permission: ExecutionPermission): ExecutionEvent | null {
    return this.#db.transaction(() => {
      const row = this.#db.prepare(`SELECT e.task_id, t.status FROM executions e JOIN tasks t ON t.id = e.task_id
        WHERE e.id = ? AND e.lease_id = ? AND e.status = 'running' AND t.dispatch_lease = ?
        AND t.status IN ('running', 'waiting_approval')`).get(permission.executionId, permission.leaseId, permission.leaseId) as { task_id: string; status: string } | undefined;
      if (!row) return null;
      this.#db.prepare(`INSERT INTO execution_permissions (id, execution_id, lease_id, tool_call_id, title, tool_kind, tool_name, locations_json, requires_elevation, options_json, status, selected_option_id, created_at, resolved_at)
        VALUES (@id, @executionId, @leaseId, @toolCallId, @title, @toolKind, @toolName, @locationsJson, @requiresElevation, @optionsJson, 'pending', NULL, @createdAt, NULL)`)
        .run({ ...permission, locationsJson: JSON.stringify(permission.locations), requiresElevation: permission.requiresElevation ? 1 : 0,
          optionsJson: JSON.stringify(permission.options) });
      this.#db.prepare("UPDATE tasks SET status = 'waiting_approval', updated_at = ? WHERE id = ? AND dispatch_lease = ?")
        .run(permission.createdAt, row.task_id, permission.leaseId);
      if (row.status === "running") this.recordTransition({ id: randomUUID(), taskId: row.task_id, fromStatus: "running", fromDispatchLease: permission.leaseId,
        toStatus: "waiting_approval", actor: "acp-permission", reason: "aguardando decisao de ferramenta", createdAt: permission.createdAt });
      return this.#insertEvent(permission.executionId, "permission_requested", { permissionId: permission.id, toolCallId: permission.toolCallId,
        title: permission.title, toolKind: permission.toolKind, toolName: permission.toolName,
        locations: permission.locations, requiresElevation: permission.requiresElevation, options: permission.options });
    })();
  }
  getExecutionPermission(permissionId: string): ExecutionPermission | null {
    return mapPermission(this.#db.prepare("SELECT * FROM execution_permissions WHERE id = ?").get(permissionId));
  }
  listExecutionPermissions(executionId: string): ExecutionPermission[] {
    return this.#db.prepare("SELECT * FROM execution_permissions WHERE execution_id = ? ORDER BY rowid")
      .all(executionId).map(mapPermission).filter(isPresent);
  }
  decideExecutionPermission(permissionId: string, optionId: string): { permission: ExecutionPermission; event: ExecutionEvent } | null {
    return this.#db.transaction(() => {
      const permission = this.getExecutionPermission(permissionId);
      if (!permission || permission.status !== "pending" || !permission.options.some((item) => item.id === optionId)) return null;
      const row = this.#db.prepare(`SELECT e.task_id FROM executions e JOIN tasks t ON t.id = e.task_id
        WHERE e.id = ? AND e.lease_id = ? AND e.status = 'running' AND t.dispatch_lease = ? AND t.status = 'waiting_approval'`)
        .get(permission.executionId, permission.leaseId, permission.leaseId) as { task_id: string } | undefined;
      if (!row) return null;
      const resolvedAt = new Date().toISOString();
      const changed = this.#db.prepare(`UPDATE execution_permissions SET status = 'selected', selected_option_id = ?, resolved_at = ?
        WHERE id = ? AND status = 'pending'`).run(optionId, resolvedAt, permissionId);
      if (changed.changes !== 1) return null;
      const remaining = this.#db.prepare("SELECT 1 FROM execution_permissions WHERE execution_id = ? AND status = 'pending' LIMIT 1")
        .get(permission.executionId);
      if (!remaining) {
        this.#db.prepare("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ? AND dispatch_lease = ?")
          .run(resolvedAt, row.task_id, permission.leaseId);
        this.recordTransition({ id: randomUUID(), taskId: row.task_id, fromStatus: "waiting_approval", fromDispatchLease: permission.leaseId,
          toStatus: "running", actor: "local-operator", reason: "permissao ACP respondida", createdAt: resolvedAt });
      }
      const event = this.#insertEvent(permission.executionId, "permission_resolved", { permissionId, optionId });
      return { permission: { ...permission, status: "selected" as const, selectedOptionId: optionId, resolvedAt }, event };
    })();
  }
  cancelActiveExecution(executionId: string, reason: string): { execution: TaskExecution; event: ExecutionEvent } | null {
    return this.#db.transaction(() => {
      const execution = this.getExecution(executionId);
      if (!execution || !execution.leaseId || !["planned", "running"].includes(execution.status)) return null;
      const task = this.getTask(execution.taskId);
      if (!task || task.dispatchLease !== execution.leaseId || !["planning", "running", "waiting_approval"].includes(task.status)) return null;
      const at = new Date().toISOString();
      this.#db.prepare("UPDATE tasks SET status = 'cancelled', dispatch_lease = NULL, updated_at = ? WHERE id = ? AND dispatch_lease = ?")
        .run(at, task.id, execution.leaseId);
      this.#db.prepare("UPDATE executions SET status = 'cancelled', finished_at = ?, summary = ? WHERE id = ? AND lease_id = ?")
        .run(at, reason, executionId, execution.leaseId);
      this.#db.prepare("UPDATE execution_permissions SET status = 'cancelled', resolved_at = ? WHERE execution_id = ? AND status = 'pending'")
        .run(at, executionId);
      this.recordTransition({ id: randomUUID(), taskId: task.id, fromStatus: task.status, fromDispatchLease: execution.leaseId,
        toStatus: "cancelled", actor: "local-operator", reason, createdAt: at });
      const event = this.#insertEvent(executionId, "cancelled", { reason });
      return { execution: { ...execution, status: "cancelled" as const, finishedAt: at, summary: reason }, event };
    })();
  }
  recoverInterruptedExecutions(reason: string): number {
    return this.#db.transaction(() => {
      const active = this.#db.prepare("SELECT * FROM executions WHERE status IN ('planned', 'running')").all().map(mapExecution).filter(isPresent);
      const at = new Date().toISOString();
      for (const execution of active) {
        this.#db.prepare("UPDATE executions SET status = 'failed', finished_at = ?, summary = ? WHERE id = ?")
          .run(at, reason, execution.id);
        const task = this.getTask(execution.taskId);
        const changed = this.#db.prepare(`UPDATE tasks SET status = 'failed', dispatch_lease = NULL, updated_at = ?
          WHERE id = ? AND (dispatch_lease = ? OR (dispatch_lease IS NULL AND ? IS NULL))
          AND status IN ('planning', 'running', 'waiting_approval')`)
          .run(at, execution.taskId, execution.leaseId, execution.leaseId);
        if (task && changed.changes) this.recordTransition({ id: randomUUID(), taskId: task.id, fromStatus: task.status,
          fromDispatchLease: execution.leaseId, toStatus: "failed", actor: "startup", reason, createdAt: at });
        this.#db.prepare("UPDATE execution_permissions SET status = 'cancelled', resolved_at = ? WHERE execution_id = ? AND status = 'pending'")
          .run(at, execution.id);
        this.#insertEvent(execution.id, "interrupted", { reason });
      }
      return active.length;
    })();
  }

  listTaskWorktrees(taskId: string): TaskWorktree[] {
    return (this.#db.prepare(`SELECT w.* FROM task_worktrees w LEFT JOIN task_directory_scopes scope
      ON scope.task_id = w.task_id AND scope.directory_id = w.directory_id WHERE w.task_id = ? ORDER BY scope.position`).all(taskId) as Row[])
      .map((item) => ({ taskId: stringValue(item, "task_id"), directoryId: stringValue(item, "directory_id"), path: stringValue(item, "path"),
        branch: stringValue(item, "branch"), baseCommit: nullableString(item, "base_commit"), createdAt: stringValue(item, "created_at") }));
  }
  deleteTaskWorktrees(taskId: string): void {
    this.#db.transaction(() => {
      this.#db.prepare("DELETE FROM task_worktrees WHERE task_id = ?").run(taskId);
      this.#db.prepare("UPDATE tasks SET worktree_path = NULL, uses_worktree = 0 WHERE id = ? AND dispatch_lease IS NULL").run(taskId);
    })();
  }
  upsertTaskPullRequest(pullRequest: TaskPullRequest): void {
    this.#db.prepare(`INSERT OR REPLACE INTO task_pull_requests (task_id, directory_id, head_branch, number, url, title, state, is_draft,
      review_decision, mergeable, checks_json, fetched_at) VALUES (@taskId, @directoryId, @headBranch, @number, @url, @title, @state, @isDraft,
      @reviewDecision, @mergeable, @checksJson, @fetchedAt)`).run({ ...pullRequest, isDraft: pullRequest.isDraft ? 1 : 0, checksJson: JSON.stringify(pullRequest.checks) });
  }
  listTaskPullRequests(taskId?: string): TaskPullRequest[] {
    const rows = (taskId
      ? this.#db.prepare("SELECT * FROM task_pull_requests WHERE task_id = ? ORDER BY rowid").all(taskId)
      : this.#db.prepare("SELECT * FROM task_pull_requests ORDER BY rowid").all()) as Row[];
    return rows.map((item) => ({ taskId: stringValue(item, "task_id"), directoryId: stringValue(item, "directory_id"), headBranch: stringValue(item, "head_branch"),
      number: Number(item.number), url: stringValue(item, "url"), title: stringValue(item, "title"), state: stringValue(item, "state") as TaskPullRequest["state"],
      isDraft: Boolean(item.is_draft), reviewDecision: nullableString(item, "review_decision") as TaskPullRequest["reviewDecision"],
      mergeable: stringValue(item, "mergeable") as TaskPullRequest["mergeable"], checks: JSON.parse(stringValue(item, "checks_json")) as TaskPullRequest["checks"],
      fetchedAt: stringValue(item, "fetched_at") }));
  }
  getProviderPreferences(providerId: string): ProviderPreferences | null {
    const row = this.#db.prepare("SELECT * FROM provider_settings WHERE provider_id = ?").get(providerId) as Row | undefined;
    return row ? mapPreferences(row) : null;
  }
  saveProviderPreferences(providerId: string, preferences: ProviderPreferences, updatedAt: string): void {
    this.#db.prepare(`INSERT INTO provider_settings (provider_id, enabled, automatic, executable_path, default_model, daily_token_budget, updated_at)
      VALUES (@providerId, @enabled, @automatic, @executablePath, @defaultModel, @dailyTokenBudget, @updatedAt)
      ON CONFLICT(provider_id) DO UPDATE SET enabled = excluded.enabled, automatic = excluded.automatic,
        executable_path = excluded.executable_path, default_model = excluded.default_model, daily_token_budget = excluded.daily_token_budget, updated_at = excluded.updated_at`)
      .run({ ...preferences, dailyTokenBudget: preferences.dailyTokenBudget ?? null, enabled: preferences.enabled ? 1 : 0, automatic: preferences.automatic ? 1 : 0, providerId, updatedAt });
  }
  createOutboundAction(action: TaskOutboundAction): void {
    this.#db.prepare(`INSERT INTO task_outbound_actions (id, task_id, kind, status, title, body, targets_json, result, requested_by, created_at, decided_at, finished_at)
      VALUES (@id, @taskId, @kind, @status, @title, @body, @targetsJson, @result, @requestedBy, @createdAt, @decidedAt, @finishedAt)`)
      .run({ ...action, targetsJson: JSON.stringify(action.targets) });
  }
  getOutboundAction(id: string): TaskOutboundAction | null {
    return mapOutboundAction(this.#db.prepare("SELECT * FROM task_outbound_actions WHERE id = ?").get(id));
  }
  listOutboundActions(taskId?: string): TaskOutboundAction[] {
    const rows = taskId
      ? this.#db.prepare("SELECT * FROM task_outbound_actions WHERE task_id = ? ORDER BY rowid DESC").all(taskId)
      : this.#db.prepare("SELECT * FROM task_outbound_actions ORDER BY rowid DESC").all();
    return rows.map(mapOutboundAction).filter(isPresent);
  }
  updateOutboundAction(id: string, fromStatus: TaskOutboundAction["status"], patch: Pick<TaskOutboundAction, "status"> & Partial<Pick<TaskOutboundAction, "result" | "decidedAt" | "finishedAt">>): TaskOutboundAction | null {
    const result = this.#db.prepare(`UPDATE task_outbound_actions SET status = @status, result = COALESCE(@result, result),
      decided_at = COALESCE(@decidedAt, decided_at), finished_at = COALESCE(@finishedAt, finished_at) WHERE id = @id AND status = @fromStatus`)
      .run({ id, fromStatus, status: patch.status, result: patch.result ?? null, decidedAt: patch.decidedAt ?? null, finishedAt: patch.finishedAt ?? null });
    return result.changes === 1 ? this.getOutboundAction(id) : null;
  }

  #executionIdFor(taskId: string, leaseId: string): string {
    return stringValue(this.#db.prepare("SELECT id FROM executions WHERE task_id = ? AND lease_id = ?").get(taskId, leaseId) as Row, "id");
  }

  #insertEvent(executionId: string, kind: string, payload: Record<string, unknown>): ExecutionEvent {
    const sequence = (this.#db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM execution_events WHERE execution_id = ?")
      .get(executionId) as { next: number }).next;
    const event: ExecutionEvent = { executionId, sequence, id: `${executionId}:${sequence}`, kind, payload, createdAt: new Date().toISOString() };
    this.#db.prepare(`INSERT INTO execution_events (execution_id, sequence, kind, payload_json, created_at)
      VALUES (@executionId, @sequence, @kind, @payloadJson, @createdAt)`)
      .run({ ...event, payloadJson: JSON.stringify(payload) });
    return event;
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_directories (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
        path TEXT NOT NULL, position INTEGER NOT NULL, is_git_repository INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
        UNIQUE(project_id, path), UNIQUE(project_id, position));
      CREATE TABLE IF NOT EXISTS task_directory_scopes (task_id TEXT NOT NULL REFERENCES tasks(id), directory_id TEXT NOT NULL REFERENCES project_directories(id),
        position INTEGER NOT NULL, PRIMARY KEY(task_id, directory_id), UNIQUE(task_id, position));
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
        prompt TEXT NOT NULL, priority TEXT NOT NULL, status TEXT NOT NULL, kind TEXT NOT NULL, worktree_path TEXT, dispatch_lease TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), lease_id TEXT, provider TEXT,
        status TEXT NOT NULL, started_at TEXT, finished_at TEXT, summary TEXT, output TEXT, usage_json TEXT);
      CREATE TABLE IF NOT EXISTS execution_logs (id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES executions(id),
        level TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_events (execution_id TEXT NOT NULL REFERENCES executions(id), sequence INTEGER NOT NULL,
        kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(execution_id, sequence));
      CREATE TABLE IF NOT EXISTS execution_permissions (id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES executions(id),
        lease_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, title TEXT NOT NULL, tool_kind TEXT, tool_name TEXT,
        locations_json TEXT NOT NULL DEFAULT '[]', requires_elevation INTEGER NOT NULL DEFAULT 0, options_json TEXT NOT NULL,
        status TEXT NOT NULL, selected_option_id TEXT, created_at TEXT NOT NULL, resolved_at TEXT);
      CREATE TABLE IF NOT EXISTS execution_file_changes (id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES executions(id),
        directory_id TEXT NOT NULL REFERENCES project_directories(id), path TEXT NOT NULL, kind TEXT NOT NULL,
        additions INTEGER, deletions INTEGER, UNIQUE(execution_id, directory_id, path));
      CREATE TABLE IF NOT EXISTS delegation_decisions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), selected_provider TEXT,
        reason TEXT NOT NULL, candidates_json TEXT NOT NULL, actions_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_transitions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), from_status TEXT NOT NULL, from_lease TEXT,
        to_status TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_worktrees (task_id TEXT NOT NULL REFERENCES tasks(id), directory_id TEXT NOT NULL REFERENCES project_directories(id),
        path TEXT NOT NULL, branch TEXT NOT NULL, base_commit TEXT, created_at TEXT NOT NULL, PRIMARY KEY(task_id, directory_id));
      CREATE TABLE IF NOT EXISTS task_pull_requests (task_id TEXT NOT NULL REFERENCES tasks(id), directory_id TEXT NOT NULL REFERENCES project_directories(id),
        head_branch TEXT NOT NULL, number INTEGER NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, is_draft INTEGER NOT NULL DEFAULT 0,
        review_decision TEXT, mergeable TEXT NOT NULL, checks_json TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY(task_id, directory_id));
      CREATE TABLE IF NOT EXISTS task_outbound_actions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL,
        status TEXT NOT NULL, title TEXT, body TEXT, targets_json TEXT NOT NULL, result TEXT, requested_by TEXT NOT NULL,
        created_at TEXT NOT NULL, decided_at TEXT, finished_at TEXT);
      CREATE TABLE IF NOT EXISTS provider_settings (provider_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, automatic INTEGER NOT NULL,
        executable_path TEXT, default_model TEXT, updated_at TEXT NOT NULL);
    `);
    this.#addColumnIfMissing("projects", "isolation", "TEXT NOT NULL DEFAULT 'worktree'");
    this.#addColumnIfMissing("provider_settings", "daily_token_budget", "INTEGER");
    this.#addColumnIfMissing("executions", "prompt", "TEXT");
    this.#addColumnIfMissing("tasks", "dispatch_lease", "TEXT");
    this.#addColumnIfMissing("tasks", "target_directory_id", "TEXT");
    this.#addColumnIfMissing("tasks", "uses_worktree", "INTEGER NOT NULL DEFAULT 0");
    this.#addColumnIfMissing("tasks", "comparison_id", "TEXT");
    this.#addColumnIfMissing("executions", "lease_id", "TEXT");
    this.#addColumnIfMissing("executions", "output", "TEXT");
    this.#addColumnIfMissing("executions", "usage_json", "TEXT");
    this.#addColumnIfMissing("executions", "transport", "TEXT");
    this.#addColumnIfMissing("executions", "model", "TEXT");
    this.#addColumnIfMissing("executions", "session_id", "TEXT");
    this.#db.exec("UPDATE executions SET transport = 'legacy' WHERE transport IS NULL AND provider IS NOT NULL");
    this.#addColumnIfMissing("task_transitions", "from_lease", "TEXT");
    this.#migrateLegacyProjectDirectories();
    this.#db.exec(`UPDATE tasks SET target_directory_id = (
      SELECT id FROM project_directories WHERE project_id = tasks.project_id ORDER BY position LIMIT 1
    ) WHERE target_directory_id IS NULL`);
    this.#migrateLegacyTaskDirectoryScopes();
  }
  finishExecution(taskId: string, leaseId: string, provider: import("../core/contracts.js").ProviderName, status: "completed" | "failed", transition: TaskTransition, summary: string, output: string, files: readonly ExecutionFileChange[], log: ExecutionLog, usage: import("../core/contracts.js").TokenUsage | undefined = undefined): ControlRoomTask | null {
    return this.#db.transaction(() => {
      const current = this.getTask(taskId);
      if (!current || !["running", "waiting_approval"].includes(current.status) || current.dispatchLease !== leaseId) return null;
      const finished = { ...current, status, dispatchLease: null, updatedAt: transition.createdAt };
      const task = this.#db.prepare(`UPDATE tasks SET status = @status, dispatch_lease = NULL, updated_at = @updatedAt
        WHERE id = @id AND status IN ('running', 'waiting_approval') AND dispatch_lease = @leaseId`).run({ ...finished, leaseId });
      if (task.changes !== 1) return null;
      const execution = this.#db.prepare(`UPDATE executions SET provider = @provider, status = @status, finished_at = @finishedAt, summary = @summary, output = @output, usage_json = @usageJson
        WHERE task_id = @taskId AND lease_id = @leaseId AND status = 'running'`).run({ taskId, leaseId, provider, status, finishedAt: transition.createdAt, summary, output, usageJson: usage ? JSON.stringify(usage) : null });
      if (execution.changes !== 1) throw new Error("Execucao em andamento nao encontrada.");
      const executionId = this.#executionIdFor(taskId, leaseId);
      const insertFile = this.#db.prepare(`INSERT OR REPLACE INTO execution_file_changes
        (id, execution_id, directory_id, path, kind, additions, deletions)
        VALUES (@id, @executionId, @directoryId, @path, @kind, @additions, @deletions)`);
      for (const file of files) insertFile.run({ ...file, executionId });
      this.recordTransition(transition);
      this.appendLog(log);
      this.#db.prepare("UPDATE execution_permissions SET status = 'cancelled', resolved_at = ? WHERE execution_id = ? AND status = 'pending'")
        .run(transition.createdAt, executionId);
      this.#insertEvent(executionId, status, { summary });
      return finished;
    })();
  }

  #directoriesFor(projectId: string): LocalProjectDirectory[] {
    return this.#db.prepare("SELECT * FROM project_directories WHERE project_id = ? ORDER BY position").all(projectId).map(mapDirectory).filter(isPresent);
  }

  #taskBranch(taskId: string): string | null {
    const row = this.#db.prepare("SELECT branch FROM task_worktrees WHERE task_id = ? LIMIT 1").get(taskId) as { branch: string } | undefined;
    return row?.branch ?? null;
  }

  #taskDirectoryIds(taskId: string): string[] {
    return (this.#db.prepare("SELECT directory_id FROM task_directory_scopes WHERE task_id = ? ORDER BY position").all(taskId) as Array<{ directory_id: string }>)
      .map((scope) => scope.directory_id);
  }

  #replaceTaskDirectoryScope(taskId: string, directoryIds: readonly string[]): void {
    this.#db.prepare("DELETE FROM task_directory_scopes WHERE task_id = ?").run(taskId);
    const insert = this.#db.prepare("INSERT INTO task_directory_scopes (task_id, directory_id, position) VALUES (?, ?, ?)");
    directoryIds.forEach((directoryId, position) => insert.run(taskId, directoryId, position));
  }

  #migrateLegacyProjectDirectories(): void {
    const legacyProjects = this.#db.prepare(`SELECT p.* FROM projects p WHERE NOT EXISTS (
      SELECT 1 FROM project_directories d WHERE d.project_id = p.id
    )`).all() as Row[];
    const insert = this.#db.prepare(`INSERT INTO project_directories (id, project_id, name, path, position, is_git_repository, created_at)
      VALUES (@id, @projectId, @name, @path, 0, 0, @createdAt)`);
    for (const project of legacyProjects) {
      insert.run({ id: `legacy-${stringValue(project, "id")}`, projectId: stringValue(project, "id"), name: stringValue(project, "name"), path: stringValue(project, "path"), createdAt: stringValue(project, "created_at") });
    }
  }

  #migrateLegacyTaskDirectoryScopes(): void {
    this.#db.exec(`INSERT INTO task_directory_scopes (task_id, directory_id, position)
      SELECT tasks.id, tasks.target_directory_id, 0 FROM tasks
      WHERE tasks.target_directory_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM task_directory_scopes scope WHERE scope.task_id = tasks.id)`);
  }

  #addColumnIfMissing(table: "projects" | "tasks" | "executions" | "task_transitions" | "provider_settings", column: string, definition: string): void {
    const columns = this.#db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

type Row = Record<string, unknown>;
const isPresent = <T>(value: T | null): value is T => value !== null;
const stringValue = (row: Row, key: string): string => String(row[key]);
const nullableString = (row: Row, key: string): string | null => row[key] === null ? null : String(row[key]);

function mapProject(row: unknown, directories: LocalProjectDirectory[]): LocalProject | null {
  if (!row) return null; const item = row as Row;
  return { id: stringValue(item, "id"), name: stringValue(item, "name"), path: stringValue(item, "path"), directories, isolation: item.isolation === "direct" ? "direct" : "worktree", createdAt: stringValue(item, "created_at") };
}
function mapDirectory(row: unknown): LocalProjectDirectory | null {
  if (!row) return null; const item = row as Row;
  return { id: stringValue(item, "id"), name: stringValue(item, "name"), path: stringValue(item, "path"), createdAt: stringValue(item, "created_at"), isGitRepository: Boolean(item.is_git_repository) };
}
function mapTask(row: unknown, directoryIds: string[], branch: string | null): ControlRoomTask | null {
  if (!row) return null; const item = row as Row;
  return { id: stringValue(item, "id"), projectId: stringValue(item, "project_id"), targetDirectoryId: nullableString(item, "target_directory_id"), directoryIds, usesWorktree: Boolean(item.uses_worktree), title: stringValue(item, "title"), prompt: stringValue(item, "prompt"),
    priority: stringValue(item, "priority") as ControlRoomTask["priority"], status: stringValue(item, "status") as ControlRoomTask["status"],
    kind: stringValue(item, "kind") as ControlRoomTask["kind"], worktreePath: nullableString(item, "worktree_path"), branch, dispatchLease: nullableString(item, "dispatch_lease"),
    ...(item.comparison_id ? { comparisonId: stringValue(item, "comparison_id") } : {}), createdAt: stringValue(item, "created_at"), updatedAt: stringValue(item, "updated_at") };
}
function mapExecution(row: unknown): TaskExecution | null {
  if (!row) return null; const item = row as Row;
  return { id: stringValue(item, "id"), taskId: stringValue(item, "task_id"), leaseId: nullableString(item, "lease_id"), provider: nullableString(item, "provider") as TaskExecution["provider"],
    status: stringValue(item, "status") as TaskExecution["status"], startedAt: nullableString(item, "started_at"), finishedAt: nullableString(item, "finished_at"), summary: nullableString(item, "summary"), prompt: nullableString(item, "prompt"), output: nullableString(item, "output"), usage: parseUsage(nullableString(item, "usage_json")),
    transport: nullableString(item, "transport") as "acp" | "legacy" | null, model: nullableString(item, "model"), sessionId: nullableString(item, "session_id") };
}
function mapEvent(row: unknown): ExecutionEvent | null {
  if (!row) return null; const item = row as Row;
  return { executionId: stringValue(item, "execution_id"), sequence: Number(item.sequence), id: `${stringValue(item, "execution_id")}:${Number(item.sequence)}`,
    kind: stringValue(item, "kind"), payload: JSON.parse(stringValue(item, "payload_json")) as Record<string, unknown>, createdAt: stringValue(item, "created_at") };
}
function mapPermission(row: unknown): ExecutionPermission | null {
  if (!row) return null; const item = row as Row;
  return { id: stringValue(item, "id"), executionId: stringValue(item, "execution_id"), leaseId: stringValue(item, "lease_id"),
    toolCallId: stringValue(item, "tool_call_id"), title: stringValue(item, "title"),
    toolKind: nullableString(item, "tool_kind"), toolName: nullableString(item, "tool_name"),
    locations: JSON.parse(stringValue(item, "locations_json")) as string[], requiresElevation: Boolean(item.requires_elevation),
    options: JSON.parse(stringValue(item, "options_json")) as ExecutionPermission["options"],
    status: stringValue(item, "status") as ExecutionPermission["status"], selectedOptionId: nullableString(item, "selected_option_id"),
    createdAt: stringValue(item, "created_at"), resolvedAt: nullableString(item, "resolved_at") };
}
function parseUsage(value: string | null): import("../core/contracts.js").TokenUsage | null {
  if (!value) return null;
  try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as NonNullable<TaskExecution["usage"]> : null; }
  catch { return null; }
}
function mapExecutionFileChange(row: unknown): ExecutionFileChange | null {
  if (!row) return null; const item = row as Row;
  return { id: stringValue(item, "id"), executionId: stringValue(item, "execution_id"), directoryId: stringValue(item, "directory_id"), path: stringValue(item, "path"),
    kind: stringValue(item, "kind") as ExecutionFileChange["kind"], additions: item.additions === null ? null : Number(item.additions), deletions: item.deletions === null ? null : Number(item.deletions) };
}
function mapLog(row: unknown): ExecutionLog | null {
  if (!row) return null; const item = row as Row;
  return { id: stringValue(item, "id"), executionId: stringValue(item, "execution_id"), level: stringValue(item, "level") as ExecutionLog["level"], message: stringValue(item, "message"), createdAt: stringValue(item, "created_at") };
}
function mapDelegation(row: unknown): DelegationDecision | null {
  if (!row) return null; const item = row as Row;
  return { id: stringValue(item, "id"), taskId: stringValue(item, "task_id"), selectedProvider: nullableString(item, "selected_provider") as DelegationDecision["selectedProvider"], reason: stringValue(item, "reason"), candidates: JSON.parse(stringValue(item, "candidates_json")) as DelegationDecision["candidates"], requestedActions: JSON.parse(stringValue(item, "actions_json")) as DelegationDecision["requestedActions"], createdAt: stringValue(item, "created_at") };
}
function mapTransition(row: unknown): TaskTransition | null {
  if (!row) return null; const item = row as Row;
  return { id: stringValue(item, "id"), taskId: stringValue(item, "task_id"), fromStatus: stringValue(item, "from_status") as TaskTransition["fromStatus"], fromDispatchLease: nullableString(item, "from_lease"), toStatus: stringValue(item, "to_status") as TaskTransition["toStatus"], actor: stringValue(item, "actor"), reason: nullableString(item, "reason"), createdAt: stringValue(item, "created_at") };
}
function mapPreferences(item: Row): ProviderPreferences {
  return { enabled: Boolean(item.enabled), automatic: Boolean(item.automatic),
    executablePath: nullableString(item, "executable_path"), defaultModel: nullableString(item, "default_model"),
    ...(item.daily_token_budget !== null && item.daily_token_budget !== undefined ? { dailyTokenBudget: Number(item.daily_token_budget) } : {}) };
}
function mapOutboundAction(row: unknown): TaskOutboundAction | null {
  if (!row) return null; const item = row as Row;
  return { id: stringValue(item, "id"), taskId: stringValue(item, "task_id"), kind: stringValue(item, "kind") as TaskOutboundAction["kind"],
    status: stringValue(item, "status") as TaskOutboundAction["status"], title: nullableString(item, "title"), body: nullableString(item, "body"),
    targets: JSON.parse(stringValue(item, "targets_json")) as TaskOutboundAction["targets"], result: nullableString(item, "result"),
    requestedBy: stringValue(item, "requested_by"), createdAt: stringValue(item, "created_at"),
    decidedAt: nullableString(item, "decided_at"), finishedAt: nullableString(item, "finished_at") };
}
