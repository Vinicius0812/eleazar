import type { ProviderName, TaskKind, TokenUsage } from "./contracts.js";

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
  /** Branch dedicated to this task; null while it runs directly in a plain folder. */
  branch?: string | null;
  dispatchLease: string | null;
  createdAt: string;
  updatedAt: string;
}

/** An isolated checkout of one scope directory, kept for the whole life of the task. */
export interface TaskWorktree {
  taskId: string;
  directoryId: string;
  path: string;
  branch: string;
  /** Commit the branch started from; used to count what the task added. */
  baseCommit: string | null;
  createdAt: string;
}

export const outboundActionKinds = ["commit", "push", "pull_request"] as const;
export type OutboundActionKind = (typeof outboundActionKinds)[number];
export type OutboundActionStatus = "pending" | "running" | "completed" | "failed" | "rejected";

/** What an outbound action would touch in one directory, captured for the operator's review. */
export interface OutboundActionTarget {
  directoryId: string;
  directoryName: string;
  branch: string;
  /** Remote URL without credentials; null when the repository has no `origin`. */
  remote: string | null;
  changedFiles: number;
  /** First changed paths, capped for display. */
  files: string[];
  commitsAhead: number;
}

/** A commit, push or pull request that leaves the worktree only after explicit approval. */
export interface TaskOutboundAction {
  id: string;
  taskId: string;
  kind: OutboundActionKind;
  status: OutboundActionStatus;
  /** Commit subject or pull request title. */
  title: string | null;
  body: string | null;
  targets: OutboundActionTarget[];
  result: string | null;
  requestedBy: string;
  createdAt: string;
  decidedAt: string | null;
  finishedAt: string | null;
}

/** What the forge reports for a branch's pull request, reduced to what places a task on the board. */
export interface PullRequestState {
  number: number;
  url: string;
  title: string;
  state: "open" | "closed" | "merged";
  isDraft: boolean;
  reviewDecision: "approved" | "changes_requested" | "review_required" | null;
  mergeable: "mergeable" | "conflicting" | "unknown";
  checks: { total: number; passed: number; failed: number; pending: number; /** Names of failed checks, capped. */ failing: string[] };
}

/** Last known pull request of one task directory. */
export interface TaskPullRequest extends PullRequestState {
  taskId: string;
  directoryId: string;
  headBranch: string;
  fetchedAt: string;
}

/** Read-only view of pull requests. Implementations use the user's own forge CLI and never read tokens. */
export interface PullRequestInspector {
  /** Null when the branch has no pull request. Rejects when the forge cannot be queried. */
  find(path: string, branch: string): Promise<PullRequestState | null>;
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
  /** Follow-up message that started this turn; null when the turn ran the task's own prompt. */
  prompt?: string | null;
  /** Full provider output, capped before persistence to protect the local database. */
  output?: string | null;
  /** Provider-reported token figures; absent when a CLI does not expose them. */
  usage?: TokenUsage | null;
  transport?: "acp" | "legacy" | null;
  model?: string | null;
  sessionId?: string | null;
}

export interface ExecutionEvent {
  executionId: string;
  sequence: number;
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ExecutionPermission {
  id: string;
  executionId: string;
  leaseId: string;
  toolCallId: string;
  title: string;
  toolKind: string | null;
  toolName: string | null;
  locations: string[];
  requiresElevation: boolean;
  options: Array<{ id: string; name: string; kind: string }>;
  status: "pending" | "selected" | "cancelled";
  selectedOptionId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export type ProviderUsageSource = "codex_account" | "eleazar_executions" | "unavailable";
export interface ProviderUsageStatus {
  source: ProviderUsageSource;
  usedPercent: number | null;
  resetAt: string | null;
  windowDurationMins: number | null;
  totalTokens: number | null;
  lifetimeTokens: number | null;
  todayTokens: number | null;
}
export interface ProviderStatus {
  provider: ProviderName;
  available: boolean;
  authenticated: boolean | null;
  version: string | null;
  detail: string;
  fetchedAt: string;
  usage: ProviderUsageStatus;
}

export type ExecutionFileChangeKind = "added" | "modified" | "deleted" | "untracked" | "preexisting";

export interface ExecutionFileChange {
  id: string;
  executionId: string;
  directoryId: string;
  path: string;
  kind: ExecutionFileChangeKind;
  additions: number | null;
  deletions: number | null;
}

export interface ExecutionDetail {
  execution: TaskExecution;
  task: ControlRoomTask;
  project: LocalProject;
  logs: ExecutionLog[];
  files: ExecutionFileChange[];
  history: TaskExecution[];
  events: ExecutionEvent[];
  permissions: ExecutionPermission[];
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
  actions: TaskOutboundAction[];
  pullRequests: TaskPullRequest[];
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
  completeDispatchPreparation(taskId: string, leaseId: string, worktrees: readonly TaskWorktree[] | null, transition: TaskTransition, startedAt: string): ControlRoomTask | null;
  failDispatchAttempt(taskId: string, leaseId: string, transition: TaskTransition, executionSummary: string, log: ExecutionLog): ControlRoomTask | null;
  finishExecution(taskId: string, leaseId: string, provider: ProviderName, status: "completed" | "failed", transition: TaskTransition, summary: string, output: string, files: readonly ExecutionFileChange[], log: ExecutionLog, usage?: TokenUsage): ControlRoomTask | null;
  createExecution(execution: TaskExecution): void;
  getExecution(id: string): TaskExecution | null;
  updateExecution(execution: TaskExecution): void;
  listExecutions(taskId: string): TaskExecution[];
  listExecutionFiles(executionId: string): ExecutionFileChange[];
  appendLog(log: ExecutionLog): void;
  listLogs(executionId: string): ExecutionLog[];
  recordDelegation(decision: DelegationDecision): void;
  listDelegations(taskId: string): DelegationDecision[];
  recordTransition(transition: TaskTransition): void;
  listTransitions(taskId: string): TaskTransition[];
  setExecutionMetadata(executionId: string, leaseId: string, transport: TaskExecution["transport"], model: string | null, sessionId?: string | null): boolean;
  appendExecutionEvent(executionId: string, leaseId: string, kind: string, payload: Record<string, unknown>): ExecutionEvent | null;
  listExecutionEvents(executionId: string, afterSequence?: number): ExecutionEvent[];
  requestExecutionPermission(permission: ExecutionPermission): ExecutionEvent | null;
  getExecutionPermission(permissionId: string): ExecutionPermission | null;
  listExecutionPermissions(executionId: string): ExecutionPermission[];
  decideExecutionPermission(permissionId: string, optionId: string): { permission: ExecutionPermission; event: ExecutionEvent } | null;
  cancelActiveExecution(executionId: string, reason: string): { execution: TaskExecution; event: ExecutionEvent } | null;
  recoverInterruptedExecutions(reason: string): number;
  listTaskWorktrees(taskId: string): TaskWorktree[];
  deleteTaskWorktrees(taskId: string): void;
  upsertTaskPullRequest(pullRequest: TaskPullRequest): void;
  listTaskPullRequests(taskId?: string): TaskPullRequest[];
  createOutboundAction(action: TaskOutboundAction): void;
  getOutboundAction(id: string): TaskOutboundAction | null;
  listOutboundActions(taskId?: string): TaskOutboundAction[];
  /** Compare-and-set on the status so two decisions cannot both win. */
  updateOutboundAction(id: string, fromStatus: OutboundActionStatus, patch: Pick<TaskOutboundAction, "status"> & Partial<Pick<TaskOutboundAction, "result" | "decidedAt" | "finishedAt">>): TaskOutboundAction | null;
}

/** Runs the Git/GitHub side of an approved outbound action. Implementations never print credentials. */
export interface RepositoryPublisher {
  inspect(worktree: TaskWorktree): Promise<{ remote: string | null; changedFiles: number; files: string[]; commitsAhead: number }>;
  commit(worktree: TaskWorktree, message: string): Promise<string>;
  push(worktree: TaskWorktree): Promise<string>;
  openPullRequest(worktree: TaskWorktree, title: string, body: string): Promise<string>;
}

const transitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["planning", "waiting_approval", "cancelled"],
  planning: ["queued", "running", "waiting_approval", "failed", "cancelled"],
  running: ["waiting_approval", "completed", "failed", "cancelled"],
  waiting_approval: ["queued", "cancelled"],
  // A finished turn can be followed by another one in the same session.
  completed: ["planning"],
  failed: ["queued", "planning", "cancelled"],
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
