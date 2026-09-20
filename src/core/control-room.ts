import type { ProviderName, TaskKind } from "./contracts.js";

export const taskPriorities = ["low", "normal", "high", "critical"] as const;
export type TaskPriority = (typeof taskPriorities)[number];

export const taskStatuses = [
  "queued",
  "planning",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled"
] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export const taskActions = ["read_project", "create_worktree", "run_tests", "push", "merge", "deploy"] as const;
export type TaskAction = (typeof taskActions)[number];

export interface LocalProject {
  id: string;
  name: string;
  /** Primary directory kept for callers that only understand the original format. */
  path: string;
  directories: LocalProjectDirectory[];
  createdAt: string;
}

/** A local checkout which belongs to a project, ordered by `position`. */
export interface LocalProjectDirectory {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  isGitRepository: boolean;
}

export interface ControlRoomTask {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  priority: TaskPriority;
  status: TaskStatus;
  kind: TaskKind;
  /** Directory selected by the operator. Null only represents an unmigrated legacy row. */
  targetDirectoryId: string | null;
  /** Ordered execution scope. The primary target is always its first member. */
  directoryIds: string[];
  usesWorktree: boolean;
  worktreePath: string | null;
  dispatchLease: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ExecutionStatus = "planned" | "running" | "completed" | "failed" | "cancelled";

export interface TaskExecution {
  id: string;
  taskId: string;
  leaseId: string | null;
  provider: ProviderName | null;
  status: ExecutionStatus;
  startedAt: string | null;
  finishedAt: string | null;
  summary: string | null;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface ExecutionLog {
  id: string;
  executionId: string;
  level: LogLevel;
  message: string;
  createdAt: string;
}

export interface DelegationCandidate {
  provider: ProviderName;
  score: number;
  reasons: readonly string[];
}

export interface DelegationDecision {
  id: string;
  taskId: string;
  selectedProvider: ProviderName | null;
  reason: string;
  candidates: readonly DelegationCandidate[];
  requestedActions: readonly TaskAction[];
  createdAt: string;
}

export interface TaskTransition {
  id: string;
  taskId: string;
  fromStatus: TaskStatus;
  /** Lease observed with fromStatus; required to reject stale reserved-task snapshots. */
  fromDispatchLease: string | null;
  toStatus: TaskStatus;
  actor: string;
  reason: string | null;
  createdAt: string;
}

export interface DispatchAttempt {
  leaseId: string;
  /** A worktree isolates writes, so only direct-directory dispatches need a directory lock. */
  usesWorktree: boolean;
  transition: TaskTransition;
  decision: DelegationDecision;
  execution: TaskExecution;
}

/** Read-only aggregate exposed by the local HTTP API. */
export interface ControlRoomSnapshot {
  projects: LocalProject[];
  tasks: ControlRoomTask[];
  executions: TaskExecution[];
  logs: ExecutionLog[];
}

export interface NewProject {
  name: string;
  /** Legacy single-directory input. New callers should use directories. */
  path?: string;
  directories?: readonly NewProjectDirectory[];
}

export interface NewProjectDirectory {
  name?: string;
  path: string;
}

export interface NewTask {
  projectId: string;
  title: string;
  prompt: string;
  priority?: TaskPriority;
  kind?: TaskKind;
  /** Defaults to the project's first directory for legacy callers. */
  targetDirectoryId?: string;
  /** Additional directories affected by the task, in execution-scope order. */
  directoryIds?: readonly string[];
}

export interface ControlRoomStore {
  createProject(project: LocalProject): void;
  getProject(id: string): LocalProject | null;
  listProjects(): LocalProject[];
  hasActiveDispatchForDirectories(directoryIds: readonly string[], excludingTaskId?: string): boolean;
  createTask(task: ControlRoomTask): void;
  getTask(id: string): ControlRoomTask | null;
  listTasks(projectId?: string): ControlRoomTask[];
  updateTask(task: ControlRoomTask): void;
  transitionTask(task: ControlRoomTask, transition: TaskTransition): ControlRoomTask | null;
  claimDispatch(taskId: string, attempt: DispatchAttempt): ControlRoomTask | null;
  completeDispatchPreparation(taskId: string, leaseId: string, worktreePath: string | null, transition: TaskTransition, startedAt: string): ControlRoomTask | null;
  failDispatchAttempt(taskId: string, leaseId: string, transition: TaskTransition, executionSummary: string, log: ExecutionLog): ControlRoomTask | null;
  createExecution(execution: TaskExecution): void;
  getExecution(id: string): TaskExecution | null;
  updateExecution(execution: TaskExecution): void;
  listExecutions(taskId: string): TaskExecution[];
  appendLog(log: ExecutionLog): void;
  listLogs(executionId: string): ExecutionLog[];
  recordDelegation(decision: DelegationDecision): void;
  listDelegations(taskId: string): DelegationDecision[];
  recordTransition(transition: TaskTransition): void;
  listTransitions(taskId: string): TaskTransition[];
}

const transitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["planning", "waiting_approval", "cancelled"],
  planning: ["queued", "running", "waiting_approval", "failed", "cancelled"],
  running: ["waiting_approval", "completed", "failed", "cancelled"],
  waiting_approval: ["queued", "cancelled"],
  completed: [],
  failed: ["queued", "cancelled"],
  cancelled: []
};

export function assertValidTransition(from: TaskStatus, to: TaskStatus): void {
  if (!transitions[from].includes(to)) {
    throw new Error(`Transicao invalida: ${from} -> ${to}`);
  }
}

export function assertSafeTaskActions(actions: readonly TaskAction[]): void {
  const unknown = actions.filter((action) => !taskActions.includes(action));
  if (unknown.length > 0) {
    throw new Error(`Acao de despacho desconhecida: ${unknown.join(", ")}`);
  }
  const prohibited = actions.filter((action) => action === "push" || action === "merge" || action === "deploy");
  if (prohibited.length > 0) {
    throw new Error(`Acao requer aprovacao explicita e nao pode ser despachada: ${prohibited.join(", ")}`);
  }
}
