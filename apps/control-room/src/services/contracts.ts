/**
 * JSON transport mirror of the Control Room contracts in src/core/control-room.ts.
 * It deliberately contains no Node, database, or provider SDK imports so it can run
 * in the browser. The local API is the only boundary between this UI and the core.
 */
export type Priority = "low" | "normal" | "high" | "critical";
export type TaskStatus = "queued" | "planning" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";
export type ExecutionStatus = "planned" | "running" | "completed" | "failed" | "cancelled";
export type LogLevel = "debug" | "info" | "warn" | "error";
export interface TokenUsage { input?: number; output?: number; thinking?: number; cacheRead?: number; total?: number; }
export interface ProjectDirectory { id: string; name: string; path: string; createdAt: string; isGitRepository: boolean; }
/** Where agents work: an isolated worktree per task, or the project's own folders. */
export type ProjectIsolation = "worktree" | "direct";
export interface Project { id: string; name: string; path: string; directories: ProjectDirectory[]; isolation: ProjectIsolation; createdAt: string; }
export interface Task { id: string; projectId: string; targetDirectoryId: string | null; directoryIds: string[]; usesWorktree: boolean; title: string; prompt: string; priority: Priority; status: TaskStatus; kind: string; worktreePath: string | null; branch?: string | null; dispatchLease?: string | null; comparisonId?: string | null; pinnedAt?: string | null; createdAt: string; updatedAt: string; }
export interface Run { id: string; taskId: string; provider: string | null; status: ExecutionStatus; startedAt: string | null; finishedAt: string | null; summary: string | null; prompt?: string | null; output?: string | null; usage?: TokenUsage | null; transport?: "acp" | "legacy" | null; model?: string | null; sessionId?: string | null; }
export interface LogEntry { id: string; executionId: string; level: LogLevel; message: string; createdAt: string; }
export interface ExecutionFileChange { id: string; executionId: string; directoryId: string; path: string; kind: "added" | "modified" | "deleted" | "untracked" | "preexisting"; additions: number | null; deletions: number | null; }
export interface ExecutionDetail { execution: Run; task: Task; project: Project; logs: LogEntry[]; files: ExecutionFileChange[]; history: Run[]; events?: ExecutionEvent[]; permissions?: ExecutionPermission[]; }
export interface ExecutionEvent { executionId: string; sequence: number; id: string; kind: string; payload: Record<string, unknown>; createdAt: string; }
export const terminalEventKinds: readonly string[] = ["completed", "failed", "cancelled", "interrupted"];
/**
 * A run is live while it is running and its task still holds a dispatch lease. The backend
 * parks such a task in `waiting_approval` while an ACP permission awaits a decision, so that
 * status alone does not mean scope approval. Legacy DTOs without `dispatchLease` fall back
 * to the running run itself, since a scope-approval task never has one.
 */
export function isLiveExecution(task: Task, run: Run): boolean {
  return run.taskId === task.id && run.status === "running" && task.dispatchLease !== null
    && (task.status === "planning" || task.status === "running" || task.status === "waiting_approval");
}
export interface ExecutionPermissionOption { id: string; name: string; kind: string; }
export interface ExecutionPermission { id: string; executionId: string; toolCallId: string; title: string; toolKind: string | null; toolName: string | null; locations: string[]; requiresElevation: boolean; options: ExecutionPermissionOption[]; status: "pending" | "selected" | "cancelled"; selectedOptionId: string | null; createdAt: string; resolvedAt: string | null; }
/** Provider id as registered in the host; the interface never lists providers on its own. */
export type AcpProvider = string;
/** Operational catalog of an ACP provider. `capabilities` is optional and only present when the backend announces it. */
export interface ProviderConfig { directoryId: string; runtime: { path: string; version: string; source: string }; protocolVersion: number; settings: Array<{ id: string; name: string; category: string | null; type: "select" | "boolean"; currentValue: string | boolean; options: Array<{ id: string; name: string }> }>; models: Array<{ id: string; name: string }>; defaultModel: string | null; capabilities?: { loadSession?: boolean }; }
/** Kept for compatibility with the original Codex-only catalog. */
export type CodexConfig = ProviderConfig;
export interface ExecuteOptions { model?: string; sessionId?: string; }
export interface EventStreamOptions { afterId?: string | undefined; signal: AbortSignal; onEvent(event: ExecutionEvent): void; }
export type OutboundActionKind = "commit" | "push" | "pull_request";
export interface OutboundActionTarget { directoryId: string; directoryName: string; branch: string; remote: string | null; changedFiles: number; files: string[]; commitsAhead: number; }
/** Commit, push or pull request recorded for a task; it runs only after the operator approves it. */
export interface TaskOutboundAction { id: string; taskId: string; kind: OutboundActionKind; status: "pending" | "running" | "completed" | "failed" | "rejected"; title: string | null; body: string | null; targets: OutboundActionTarget[]; result: string | null; requestedBy: string; createdAt: string; decidedAt: string | null; finishedAt: string | null; }
/** Last known pull request of one task directory, as read from GitHub by the local host. */
export interface TaskPullRequest { taskId: string; directoryId: string; headBranch: string; number: number; url: string; title: string; state: "open" | "closed" | "merged"; isDraft: boolean; reviewDecision: "approved" | "changes_requested" | "review_required" | null; mergeable: "mergeable" | "conflicting" | "unknown"; checks: { total: number; passed: number; failed: number; pending: number; failing: string[] }; fetchedAt: string; }
export interface PullRequestRefresh { pullRequests: TaskPullRequest[]; warnings: string[]; }
export interface OutboundActionInput { kind: OutboundActionKind; title?: string; body?: string; }
export interface Approval { id: string; taskId: string; title: string; description: string; action: string; }
export interface Alert { id: string; level: "warning" | "info" | "error"; title: string; message: string; }
export type ProviderUsageSource = "codex_account" | "eleazar_executions" | "unavailable";
/** What the Automatico mode reads before choosing a provider: the account limit or the operator's daily budget. */
export interface ProviderQuotaStatus { usedPercent: number; source: "account" | "budget"; dailyTokenBudget: number | null; todayTokens: number | null; state: "ok" | "low" | "exhausted"; }
export interface ProviderUsageStatus { source: ProviderUsageSource; usedPercent: number | null; resetAt: string | null; windowDurationMins: number | null; totalTokens: number | null; lifetimeTokens: number | null; todayTokens: number | null; quota?: ProviderQuotaStatus | null; }
export interface ProviderPreferences { enabled: boolean; automatic: boolean; executablePath: string | null; defaultModel: string | null; dailyTokenBudget?: number | null; }
export type ProviderPreferencesPatch = Partial<ProviderPreferences>;
/** Result of opening and closing one session of the provider, without a prompt. */
export interface ProviderVerification { connected: boolean; authenticated: boolean | null; detail: string; models: Array<{ id: string; name: string }>; defaultModel: string | null; checkedAt: string; }
export interface ProviderStatus { provider: string; label: string; available: boolean; authenticated: boolean | null; version: string | null; detail: string; executable: { path: string; source: string } | null; transport: "acp" | "legacy"; roles: { implementer: boolean; reviewer: boolean }; login: { command: string; hint: string }; preferences: ProviderPreferences; verification: ProviderVerification | null; fetchedAt: string; usage: ProviderUsageStatus; }
export interface ControlRoomSnapshot { projects: Project[]; tasks: Task[]; runs: Run[]; logs: LogEntry[]; approvals: Approval[]; alerts: Alert[]; actions?: TaskOutboundAction[]; pullRequests?: TaskPullRequest[]; }
/** New state of a project: directories with an `id` are kept (path fixed), the others are added, missing ones removed. */
export interface UpdateProjectInput { name: string; isolation?: ProjectIsolation; directories: Array<{ id?: string; name?: string; path?: string }>; }
export interface RegisterProjectInput { name: string; directories: Array<{ name?: string; path: string }>; isolation?: ProjectIsolation; }
/** Attempts of one comparison; an attempt that could not start stays queued and is listed in `errors`. */
export interface ComparisonStart { comparisonId: string; tasks: Task[]; errors: Array<{ taskId: string; provider: string; error: string }>; }
/** A request the operator runs often, saved to start new tasks from it. */
export interface TaskTemplate { id: string; name: string; title: string; prompt: string; kind: string | null; priority: Priority; projectId: string | null; createdAt: string; }
export interface TaskTemplateInput { name: string; title?: string; prompt: string; kind?: string; priority?: Priority; projectId?: string; }
export interface CreateTaskInput { projectId: string; targetDirectoryId: string; directoryIds: string[]; title: string; prompt: string; priority: Priority; kind?: string; }
/** `auto` or a registered provider id. */
export type ExecutionProvider = string;
export type ExplorerChangeKind = "added" | "modified" | "deleted" | "renamed" | "untracked";
/** Folder a task works in: its worktree, or the project folder when it runs in place. */
export interface ExplorerRoot { directoryId: string; name: string; path: string; mode: "worktree" | "direct"; branch: string | null; isGitRepository: boolean; base: string | null; }
export interface ExplorerEntry { name: string; path: string; type: "file" | "directory" | "symlink" | "other"; size: number | null; change: ExplorerChangeKind | null; changedBelow: number; }
export interface ExplorerListing { root: ExplorerRoot; path: string; entries: ExplorerEntry[]; truncated: boolean; }
export interface ExplorerChange { path: string; previousPath: string | null; kind: ExplorerChangeKind; additions: number | null; deletions: number | null; preexisting?: boolean; }
export interface ExplorerSearch { root: ExplorerRoot; query: string; paths: string[]; truncated: boolean; }
export interface ExplorerChanges { root: ExplorerRoot; changes: ExplorerChange[]; warnings: string[]; }
export interface ExplorerFile { root: ExplorerRoot; path: string; exists: boolean; size: number | null; binary: boolean; content: string | null; tooLarge: boolean; change: ExplorerChange | null; diff: string | null; diffTruncated: boolean; }

/** A bash shell the host runs in one of the project's folders. */
export interface TerminalSession { id: string; projectId: string; directoryId: string; root: string; cwd: string; shell: string; startedAt: string; busy: boolean; exitCode: number | null; closed: boolean; }
export interface TerminalEvent { sessionId: string; sequence: number; id: string; kind: "input" | "stdout" | "stderr" | "done" | "exit"; text?: string; exitCode?: number | null; cwd?: string; createdAt: string; }
export interface TerminalStreamOptions { afterId?: string | undefined; signal: AbortSignal; onEvent(event: TerminalEvent): void; }

export interface ControlRoomClient {
  getSnapshot(): Promise<ControlRoomSnapshot>;
  getExecutionDetail(executionId: string): Promise<ExecutionDetail>;
  getProviderStatuses(refresh?: boolean): Promise<ProviderStatus[]>;
  /** Opens and closes one session, without a prompt, to confirm connection and login. */
  verifyProvider(provider: string): Promise<ProviderStatus[]>;
  updateProvider(provider: string, patch: ProviderPreferencesPatch): Promise<ProviderStatus[]>;
  registerProject(input: RegisterProjectInput): Promise<Project>;
  updateProjectIsolation(projectId: string, isolation: ProjectIsolation): Promise<Project>;
  updateProject(projectId: string, input: UpdateProjectInput): Promise<Project>;
  createTask(input: CreateTaskInput): Promise<Task>;
  getProviderConfig(provider: AcpProvider, directoryId: string): Promise<ProviderConfig>;
  getCodexConfig(directoryId: string): Promise<CodexConfig>;
  executeTask(taskId: string, provider: ExecutionProvider, options?: ExecuteOptions): Promise<Task>;
  /** Resolves true when the stream ended after a terminal event, false on any other end. Rejects on network/HTTP failure or abort. */
  streamExecutionEvents(executionId: string, options: EventStreamOptions): Promise<boolean>;
  cancelExecution(executionId: string): Promise<void>;
  respondPermission(executionId: string, permissionId: string, optionId: string): Promise<void>;
  retryTask(taskId: string): Promise<void>;
  listTemplates(): Promise<TaskTemplate[]>;
  createTemplate(input: TaskTemplateInput): Promise<TaskTemplate>;
  /** Removes a saved template and returns the ones left. */
  deleteTemplate(templateId: string): Promise<TaskTemplate[]>;
  /** Runs the same request with several agents, each in its own task and worktree. */
  startComparison(input: CreateTaskInput, providers: string[]): Promise<ComparisonStart>;
  /** Keeps one attempt and sets the other finished ones aside. */
  chooseComparisonAttempt(comparisonId: string, taskId: string): Promise<Task[]>;
  /** Continues a failed or interrupted turn with the same agent, reloading its session when possible. */
  resumeTask(taskId: string): Promise<Task>;
  /** Starts another turn on a finished task, in the same folder or worktree. */
  sendTaskMessage(taskId: string, prompt: string): Promise<Task>;
  requestTaskAction(taskId: string, input: OutboundActionInput): Promise<TaskOutboundAction>;
  decideTaskAction(actionId: string, decision: "approve" | "reject"): Promise<TaskOutboundAction>;
  removeTaskWorktrees(taskId: string): Promise<Task>;
  /** Re-reads pull requests from GitHub: one task, or every task with a pushed branch. */
  refreshPullRequests(taskId?: string): Promise<PullRequestRefresh>;
  decideApproval(taskId: string, decision: "approve" | "reject"): Promise<void>;
  /** Read-only file explorer of a task. */
  getTaskFileRoots(taskId: string): Promise<ExplorerRoot[]>;
  listTaskFiles(taskId: string, directoryId: string, path?: string): Promise<ExplorerListing>;
  getTaskChanges(taskId: string, directoryId: string): Promise<ExplorerChanges>;
  getTaskFile(taskId: string, directoryId: string, path: string): Promise<ExplorerFile>;
  searchTaskFiles(taskId: string, directoryId: string, query: string): Promise<ExplorerSearch>;
  pinTask(taskId: string, pinned: boolean): Promise<Task>;
  /** Deletes the task and its history; the host refuses while it runs or still owns a worktree. */
  deleteTask(taskId: string): Promise<void>;
  listTerminals(projectId: string): Promise<TerminalSession[]>;
  openTerminal(projectId: string, directoryId: string): Promise<TerminalSession>;
  /** Writes one command line to the shell; the output arrives through the stream. */
  sendTerminalInput(sessionId: string, command: string): Promise<TerminalSession>;
  closeTerminal(sessionId: string): Promise<TerminalSession>;
  /** Resolves true when the shell exited, false when the stream ended for another reason. */
  streamTerminalEvents(sessionId: string, options: TerminalStreamOptions): Promise<boolean>;
  /** The same explorer over the project's own folders, compared with their HEAD. */
  getProjectFileRoots(projectId: string): Promise<ExplorerRoot[]>;
  listProjectFiles(projectId: string, directoryId: string, path?: string): Promise<ExplorerListing>;
  getProjectChanges(projectId: string, directoryId: string): Promise<ExplorerChanges>;
  getProjectFile(projectId: string, directoryId: string, path: string): Promise<ExplorerFile>;
  searchProjectFiles(projectId: string, directoryId: string, query: string): Promise<ExplorerSearch>;
}
export const priorityOrder: Record<Priority, number> = { critical: 0, high: 1, normal: 2, low: 3 };
