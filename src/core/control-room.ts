import type { AgentVerification, ProviderDescriptor, ProviderName, ProviderPreferences, TaskKind, TokenUsage } from "./contracts.js";

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

/** Where agents work: an isolated worktree per task, or the project's own folders. */
export const projectIsolations = ["worktree", "direct"] as const;
export type ProjectIsolation = (typeof projectIsolations)[number];

export interface LocalProject {
  id: string;
  name: string;
  /** Primary directory kept for callers that only understand the original format. */
  path: string;
  directories: LocalProjectDirectory[];
  /** Plain folders always run in place, whatever this says. */
  isolation: ProjectIsolation;
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
  /** Shared by the tasks that run the same request with different agents, to compare their changes. */
  comparisonId?: string | null;
  /** When the operator pinned the task to the top of its project; absent when not pinned. */
  pinnedAt?: string | null;
  /** Eleazar agent profile whose role and instructions lead every turn, whatever the provider. */
  agentProfileId?: string | null;
  /** Eleazar skills handed to the agent with the request. */
  skillIds?: string[];
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
  /** What Automatico reads before choosing this provider; null when nothing limits it. */
  quota: ProviderQuotaStatus | null;
}
export interface ProviderQuotaStatus {
  usedPercent: number;
  source: "account" | "budget";
  /** Operator's daily budget, when the quota comes from it. */
  dailyTokenBudget: number | null;
  /** Tokens counted against that budget today (host's local day). */
  todayTokens: number | null;
  state: "ok" | "low" | "exhausted";
}
export interface ProviderStatus {
  provider: ProviderName;
  label: string;
  available: boolean;
  authenticated: boolean | null;
  version: string | null;
  detail: string;
  executable: { path: string; source: string } | null;
  transport: ProviderDescriptor["transport"];
  roles: ProviderDescriptor["roles"];
  login: { command: string; hint: string };
  preferences: ProviderPreferences;
  /** Last connection check without a prompt; null until one runs in this host session. */
  verification: Omit<AgentVerification, "provider"> | null;
  fetchedAt: string;
  usage: ProviderUsageStatus;
}

/** Fields the operator may change; omitted fields keep their value. */
export type ProviderPreferencesPatch = Partial<ProviderPreferences>;

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
  /** Defaults to `worktree`. */
  isolation?: ProjectIsolation;
}

export interface NewProjectDirectory {
  name?: string;
  path: string;
}

/** Full new state of a project. Directories with an `id` are kept (their path cannot change); the others are added. */
export interface ProjectUpdate {
  name: string;
  isolation?: ProjectIsolation;
  directories: ReadonlyArray<{ id?: string; name?: string; path?: string }>;
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
  /** Groups this task with the other attempts of a comparison. */
  comparisonId?: string;
  agentProfileId?: string;
  skillIds?: readonly string[];
}

/** Where a skill came from. Imported ones keep the original file untouched; the Eleazar works on its own copy. */
export const skillSources = ["eleazar", "claude", "codex"] as const;
export type SkillSource = (typeof skillSources)[number];

/** Instructions in the SKILL.md format, usable with any provider because they travel in the prompt. */
export interface Skill {
  id: string;
  /** Folder name of the original, or a slug of the name. */
  slug: string;
  name: string;
  description: string;
  content: string;
  source: SkillSource;
  /** Original SKILL.md (or prompt file) for an imported skill. */
  sourcePath: string | null;
  /** Other files next to the original (scripts, references), listed for the agent; never copied. */
  supportFiles: string[];
  /** Hash of the content last imported; a different current hash means the copy was edited here. */
  importedHash: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A reusable agent: role, standing instructions, skills and the provider it prefers (null: Automatico). */
export interface AgentProfile {
  id: string;
  name: string;
  role: string;
  instructions: string;
  skillIds: string[];
  provider: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A request the operator runs often, saved to start new tasks from it. */
export interface TaskTemplate {
  id: string;
  name: string;
  /** Title for the new task; empty means "first line of the prompt". */
  title: string;
  prompt: string;
  kind: TaskKind | null;
  priority: TaskPriority;
  /** Project the template belongs to; null when it serves any project. */
  projectId: string | null;
  createdAt: string;
}

export interface NewTaskTemplate {
  name: string;
  title?: string;
  prompt: string;
  kind?: TaskKind;
  priority?: TaskPriority;
  projectId?: string;
}

export interface ControlRoomStore {
  createProject(project: LocalProject): void;
  getProject(id: string): LocalProject | null;
  listProjects(): LocalProject[];
  setProjectIsolation(id: string, isolation: ProjectIsolation): LocalProject | null;
  /** Replaces name, isolation and the ordered directory list in one transaction. */
  updateProject(project: LocalProject): LocalProject | null;
  /** True when a task scope, worktree or recorded file still points at the directory. */
  isDirectoryInUse(directoryId: string): boolean;
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
  getProviderPreferences(providerId: ProviderName): ProviderPreferences | null;
  saveProviderPreferences(providerId: ProviderName, preferences: ProviderPreferences, updatedAt: string): void;
  createOutboundAction(action: TaskOutboundAction): void;
  getOutboundAction(id: string): TaskOutboundAction | null;
  listOutboundActions(taskId?: string): TaskOutboundAction[];
  /** Compare-and-set on the status so two decisions cannot both win. */
  setTaskPinned(taskId: string, pinnedAt: string | null): ControlRoomTask | null;
  saveSkill(skill: Skill): void;
  getSkill(id: string): Skill | null;
  listSkills(): Skill[];
  deleteSkill(id: string): boolean;
  /** Originals the operator removed from the catalog; a later import skips them. */
  excludeSkillSource(sourcePath: string, createdAt: string): void;
  listExcludedSkillSources(): string[];
  saveAgentProfile(profile: AgentProfile): void;
  getAgentProfile(id: string): AgentProfile | null;
  listAgentProfiles(): AgentProfile[];
  deleteAgentProfile(id: string): boolean;
  /** Removes the task and everything recorded about it. True when it existed. */
  deleteTask(taskId: string): boolean;
  createTaskTemplate(template: TaskTemplate): void;
  listTaskTemplates(): TaskTemplate[];
  /** True when a template was removed. */
  deleteTaskTemplate(id: string): boolean;
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
  // A finished turn can be followed by another one in the same session, or set aside
  // when the operator keeps another attempt of the same comparison.
  completed: ["planning", "cancelled"],
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
