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
export interface Project { id: string; name: string; path: string; directories: ProjectDirectory[]; createdAt: string; }
export interface Task { id: string; projectId: string; targetDirectoryId: string | null; directoryIds: string[]; usesWorktree: boolean; title: string; prompt: string; priority: Priority; status: TaskStatus; kind: string; worktreePath: string | null; branch?: string | null; dispatchLease?: string | null; createdAt: string; updatedAt: string; }
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
export type AcpProvider = "codex" | "claude" | "antigravity";
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
export interface ProviderUsageStatus { source: ProviderUsageSource; usedPercent: number | null; resetAt: string | null; windowDurationMins: number | null; totalTokens: number | null; lifetimeTokens: number | null; todayTokens: number | null; }
export interface ProviderStatus { provider: "codex" | "antigravity" | "claude"; available: boolean; authenticated: boolean | null; version: string | null; detail: string; fetchedAt: string; usage: ProviderUsageStatus; }
export interface ControlRoomSnapshot { projects: Project[]; tasks: Task[]; runs: Run[]; logs: LogEntry[]; approvals: Approval[]; alerts: Alert[]; actions?: TaskOutboundAction[]; pullRequests?: TaskPullRequest[]; }
export interface RegisterProjectInput { name: string; directories: Array<{ name?: string; path: string }>; }
export interface CreateTaskInput { projectId: string; targetDirectoryId: string; directoryIds: string[]; title: string; prompt: string; priority: Priority; kind?: string; }
export type ExecutionProvider = "auto" | ProviderStatus["provider"];
export interface ControlRoomClient {
  getSnapshot(): Promise<ControlRoomSnapshot>;
  getExecutionDetail(executionId: string): Promise<ExecutionDetail>;
  getProviderStatuses(refresh?: boolean): Promise<ProviderStatus[]>;
  registerProject(input: RegisterProjectInput): Promise<Project>;
  createTask(input: CreateTaskInput): Promise<Task>;
  getProviderConfig(provider: AcpProvider, directoryId: string): Promise<ProviderConfig>;
  getCodexConfig(directoryId: string): Promise<CodexConfig>;
  executeTask(taskId: string, provider: ExecutionProvider, options?: ExecuteOptions): Promise<Task>;
  /** Resolves true when the stream ended after a terminal event, false on any other end. Rejects on network/HTTP failure or abort. */
  streamExecutionEvents(executionId: string, options: EventStreamOptions): Promise<boolean>;
  cancelExecution(executionId: string): Promise<void>;
  respondPermission(executionId: string, permissionId: string, optionId: string): Promise<void>;
  retryTask(taskId: string): Promise<void>;
  /** Starts another turn on a finished task, in the same folder or worktree. */
  sendTaskMessage(taskId: string, prompt: string): Promise<Task>;
  requestTaskAction(taskId: string, input: OutboundActionInput): Promise<TaskOutboundAction>;
  decideTaskAction(actionId: string, decision: "approve" | "reject"): Promise<TaskOutboundAction>;
  removeTaskWorktrees(taskId: string): Promise<Task>;
  /** Re-reads pull requests from GitHub: one task, or every task with a pushed branch. */
  refreshPullRequests(taskId?: string): Promise<PullRequestRefresh>;
  decideApproval(taskId: string, decision: "approve" | "reject"): Promise<void>;
}
export const priorityOrder: Record<Priority, number> = { critical: 0, high: 1, normal: 2, low: 3 };
