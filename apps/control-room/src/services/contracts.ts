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
export interface Task { id: string; projectId: string; targetDirectoryId: string | null; directoryIds: string[]; usesWorktree: boolean; title: string; prompt: string; priority: Priority; status: TaskStatus; kind: string; worktreePath: string | null; createdAt: string; updatedAt: string; }
export interface Run { id: string; taskId: string; provider: string | null; status: ExecutionStatus; startedAt: string | null; finishedAt: string | null; summary: string | null; output?: string | null; usage?: TokenUsage | null; }
export interface LogEntry { id: string; executionId: string; level: LogLevel; message: string; createdAt: string; }
export interface ExecutionFileChange { id: string; executionId: string; directoryId: string; path: string; kind: "added" | "modified" | "deleted" | "untracked" | "preexisting"; additions: number | null; deletions: number | null; }
export interface ExecutionDetail { execution: Run; task: Task; project: Project; logs: LogEntry[]; files: ExecutionFileChange[]; history: Run[]; }
export interface Approval { id: string; taskId: string; title: string; description: string; action: string; }
export interface Alert { id: string; level: "warning" | "info" | "error"; title: string; message: string; }
export type ProviderUsageSource = "codex_account" | "eleazar_executions" | "unavailable";
export interface ProviderUsageStatus { source: ProviderUsageSource; usedPercent: number | null; resetAt: string | null; windowDurationMins: number | null; totalTokens: number | null; lifetimeTokens: number | null; todayTokens: number | null; }
export interface ProviderStatus { provider: "codex" | "antigravity"; available: boolean; authenticated: boolean | null; version: string | null; detail: string; fetchedAt: string; usage: ProviderUsageStatus; }
export interface ControlRoomSnapshot { projects: Project[]; tasks: Task[]; runs: Run[]; logs: LogEntry[]; approvals: Approval[]; alerts: Alert[]; }
export interface RegisterProjectInput { name: string; directories: Array<{ name?: string; path: string }>; }
export interface CreateTaskInput { projectId: string; targetDirectoryId: string; directoryIds: string[]; title: string; prompt: string; priority: Priority; kind?: string; }
export type ExecutionProvider = "auto" | "codex" | "antigravity";
export interface ControlRoomClient {
  getSnapshot(): Promise<ControlRoomSnapshot>;
  getExecutionDetail(executionId: string): Promise<ExecutionDetail>;
  getProviderStatuses(refresh?: boolean): Promise<ProviderStatus[]>;
  registerProject(input: RegisterProjectInput): Promise<Project>;
  createTask(input: CreateTaskInput): Promise<Task>;
  executeTask(taskId: string, provider: ExecutionProvider): Promise<Task>;
  retryTask(taskId: string): Promise<void>;
  decideApproval(taskId: string, decision: "approve" | "reject"): Promise<void>;
}
export const priorityOrder: Record<Priority, number> = { critical: 0, high: 1, normal: 2, low: 3 };
