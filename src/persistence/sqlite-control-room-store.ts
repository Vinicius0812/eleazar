import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import type {
  ControlRoomStore,
  ControlRoomTask,
  DelegationDecision,
  ExecutionLog,
  LocalProject,
  TaskExecution,
  TaskTransition
} from "../core/control-room.js";

/** SQLite persistence for the local Control Room. Database paths normally live under .eleazar/. */
export class SqliteControlRoomStore implements ControlRoomStore {
  readonly #db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.#db = new Database(databasePath);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("foreign_keys = ON");
    this.#migrate();
  }

  close(): void { this.#db.close(); }

  createProject(project: LocalProject): void {
    this.#db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES (@id, @name, @path, @createdAt)").run(project);
  }
  getProject(id: string): LocalProject | null {
    return mapProject(this.#db.prepare("SELECT * FROM projects WHERE id = ?").get(id));
  }
  listProjects(): LocalProject[] {
    return this.#db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all().map(mapProject).filter(isPresent);
  }
  createTask(task: ControlRoomTask): void {
    this.#db.prepare(`INSERT INTO tasks (id, project_id, title, prompt, priority, status, kind, worktree_path, dispatch_lease, created_at, updated_at)
      VALUES (@id, @projectId, @title, @prompt, @priority, @status, @kind, @worktreePath, @dispatchLease, @createdAt, @updatedAt)`).run(task);
  }
  getTask(id: string): ControlRoomTask | null { return mapTask(this.#db.prepare("SELECT * FROM tasks WHERE id = ?").get(id)); }
  listTasks(projectId?: string): ControlRoomTask[] {
    const rows = projectId
      ? this.#db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC").all(projectId)
      : this.#db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all();
    return rows.map(mapTask).filter(isPresent);
  }
  updateTask(task: ControlRoomTask): void {
    const result = this.#db.prepare(`UPDATE tasks SET title = @title, prompt = @prompt, priority = @priority, status = @status,
      kind = @kind, worktree_path = @worktreePath, dispatch_lease = @dispatchLease, updated_at = @updatedAt WHERE id = @id`).run(task);
    if (result.changes !== 1) throw new Error("Tarefa nao encontrada para atualizacao.");
  }
  transitionTask(task: ControlRoomTask, transition: TaskTransition): ControlRoomTask | null {
    return this.#db.transaction(() => {
      const previous = this.getTask(task.id);
      if (!previous) return null;
      const result = this.#db.prepare(`UPDATE tasks SET title = @title, prompt = @prompt, priority = @priority, status = @status,
        kind = @kind, worktree_path = @worktreePath, dispatch_lease = @dispatchLease, updated_at = @updatedAt
        WHERE id = @id AND status = @fromStatus`).run({ ...task, fromStatus: transition.fromStatus });
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
      if (!current || current.status !== "queued") return null;
      const claimed = { ...current, status: "planning" as const, dispatchLease: attempt.leaseId, updatedAt: attempt.transition.createdAt };
      const result = this.#db.prepare(`UPDATE tasks SET status = @status, dispatch_lease = @dispatchLease, updated_at = @updatedAt
        WHERE id = @id AND status = 'queued' AND dispatch_lease IS NULL`).run(claimed);
      if (result.changes !== 1) return null;
      this.recordTransition(attempt.transition);
      this.recordDelegation(attempt.decision);
      this.createExecution(attempt.execution);
      return claimed;
    })();
  }
  completeDispatchPreparation(taskId: string, leaseId: string, worktreePath: string | null, transition: TaskTransition, startedAt: string): ControlRoomTask | null {
    return this.#db.transaction(() => {
      const current = this.getTask(taskId);
      if (!current || current.status !== "planning" || current.dispatchLease !== leaseId) return null;
      const completed = { ...current, status: "running" as const, worktreePath: worktreePath ?? current.worktreePath, updatedAt: transition.createdAt };
      const task = this.#db.prepare(`UPDATE tasks SET status = @status, worktree_path = @worktreePath, updated_at = @updatedAt
        WHERE id = @id AND status = 'planning' AND dispatch_lease = @leaseId`).run({ ...completed, leaseId });
      if (task.changes !== 1) return null;
      const execution = this.#db.prepare(`UPDATE executions SET status = 'running', started_at = @startedAt
        WHERE task_id = @taskId AND lease_id = @leaseId AND status = 'planned'`).run({ taskId, leaseId, startedAt });
      if (execution.changes !== 1) throw new Error("Execucao reservada nao encontrada.");
      this.recordTransition(transition);
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
      return failed;
    })();
  }
  createExecution(execution: TaskExecution): void {
    this.#db.prepare(`INSERT INTO executions (id, task_id, lease_id, provider, status, started_at, finished_at, summary)
      VALUES (@id, @taskId, @leaseId, @provider, @status, @startedAt, @finishedAt, @summary)`).run(execution);
  }
  getExecution(id: string): TaskExecution | null { return mapExecution(this.#db.prepare("SELECT * FROM executions WHERE id = ?").get(id)); }
  updateExecution(execution: TaskExecution): void {
    const result = this.#db.prepare(`UPDATE executions SET lease_id = @leaseId, provider = @provider, status = @status, started_at = @startedAt,
      finished_at = @finishedAt, summary = @summary WHERE id = @id`).run(execution);
    if (result.changes !== 1) throw new Error("Execucao nao encontrada para atualizacao.");
  }
  listExecutions(taskId: string): TaskExecution[] {
    return this.#db.prepare("SELECT * FROM executions WHERE task_id = ? ORDER BY rowid DESC").all(taskId).map(mapExecution).filter(isPresent);
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
    this.#db.prepare(`INSERT INTO task_transitions (id, task_id, from_status, to_status, actor, reason, created_at)
      VALUES (@id, @taskId, @fromStatus, @toStatus, @actor, @reason, @createdAt)`).run(transition);
  }
  listTransitions(taskId: string): TaskTransition[] {
    return this.#db.prepare("SELECT * FROM task_transitions WHERE task_id = ? ORDER BY rowid").all(taskId).map(mapTransition).filter(isPresent);
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
        prompt TEXT NOT NULL, priority TEXT NOT NULL, status TEXT NOT NULL, kind TEXT NOT NULL, worktree_path TEXT, dispatch_lease TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), lease_id TEXT, provider TEXT,
        status TEXT NOT NULL, started_at TEXT, finished_at TEXT, summary TEXT);
      CREATE TABLE IF NOT EXISTS execution_logs (id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES executions(id),
        level TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS delegation_decisions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), selected_provider TEXT,
        reason TEXT NOT NULL, candidates_json TEXT NOT NULL, actions_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_transitions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), from_status TEXT NOT NULL,
        to_status TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL);
    `);
    this.#addColumnIfMissing("tasks", "dispatch_lease", "TEXT");
    this.#addColumnIfMissing("executions", "lease_id", "TEXT");
  }

  #addColumnIfMissing(table: "tasks" | "executions", column: string, definition: string): void {
    const columns = this.#db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

type Row = Record<string, unknown>;
const isPresent = <T>(value: T | null): value is T => value !== null;
const stringValue = (row: Row, key: string): string => String(row[key]);
const nullableString = (row: Row, key: string): string | null => row[key] === null ? null : String(row[key]);

function mapProject(row: unknown): LocalProject | null {
  if (!row) return null; const item = row as Row;
  return { id: stringValue(item, "id"), name: stringValue(item, "name"), path: stringValue(item, "path"), createdAt: stringValue(item, "created_at") };
}
function mapTask(row: unknown): ControlRoomTask | null {
  if (!row) return null; const item = row as Row;
  return { id: stringValue(item, "id"), projectId: stringValue(item, "project_id"), title: stringValue(item, "title"), prompt: stringValue(item, "prompt"),
    priority: stringValue(item, "priority") as ControlRoomTask["priority"], status: stringValue(item, "status") as ControlRoomTask["status"],
    kind: stringValue(item, "kind") as ControlRoomTask["kind"], worktreePath: nullableString(item, "worktree_path"), dispatchLease: nullableString(item, "dispatch_lease"), createdAt: stringValue(item, "created_at"), updatedAt: stringValue(item, "updated_at") };
}
function mapExecution(row: unknown): TaskExecution | null {
  if (!row) return null; const item = row as Row;
  return { id: stringValue(item, "id"), taskId: stringValue(item, "task_id"), leaseId: nullableString(item, "lease_id"), provider: nullableString(item, "provider") as TaskExecution["provider"],
    status: stringValue(item, "status") as TaskExecution["status"], startedAt: nullableString(item, "started_at"), finishedAt: nullableString(item, "finished_at"), summary: nullableString(item, "summary") };
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
  return { id: stringValue(item, "id"), taskId: stringValue(item, "task_id"), fromStatus: stringValue(item, "from_status") as TaskTransition["fromStatus"], toStatus: stringValue(item, "to_status") as TaskTransition["toStatus"], actor: stringValue(item, "actor"), reason: nullableString(item, "reason"), createdAt: stringValue(item, "created_at") };
}
