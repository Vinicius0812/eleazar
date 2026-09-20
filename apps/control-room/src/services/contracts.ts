/**
 * JSON transport mirror of the Control Room contracts in src/core/control-room.ts.
 * It deliberately contains no Node, database, or provider SDK imports so it can run
 * in the browser. The local API is the only boundary between this UI and the core.
 */
export type Priority = "low" | "normal" | "high" | "critical";
export type TaskStatus = "queued" | "planning" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";
export type ExecutionStatus = "planned" | "running" | "completed" | "failed" | "cancelled";
export type LogLevel = "debug" | "info" | "warn" | "error";
export interface ProjectDirectory { id: string; name: string; path: string; createdAt: string; isGitRepository: boolean; }
export interface Project { id: string; name: string; path: string; directories: ProjectDirectory[]; createdAt: string; }
export interface Task { id: string; projectId: string; targetDirectoryId: string | null; usesWorktree: boolean; title: string; prompt: string; priority: Priority; status: TaskStatus; kind: string; worktreePath: string | null; createdAt: string; updatedAt: string; }
export interface Run { id: string; taskId: string; provider: string | null; status: ExecutionStatus; startedAt: string | null; finishedAt: string | null; summary: string | null; }
export interface LogEntry { id: string; executionId: string; level: LogLevel; message: string; createdAt: string; }
export interface Approval { id: string; taskId: string; title: string; description: string; action: string; }
export interface Alert { id: string; level: "warning" | "info"; title: string; message: string; }
export interface ControlRoomSnapshot { projects: Project[]; tasks: Task[]; runs: Run[]; logs: LogEntry[]; approvals: Approval[]; alerts: Alert[]; }
export interface RegisterProjectInput { name: string; directories: Array<{ name?: string; path: string }>; }
export interface CreateTaskInput { projectId: string; targetDirectoryId: string; title: string; prompt: string; priority: Priority; }
export interface ControlRoomClient {
  getSnapshot(): Promise<ControlRoomSnapshot>;
  registerProject(input: RegisterProjectInput): Promise<Project>;
  createTask(input: CreateTaskInput): Promise<Task>;
  decideApproval(taskId: string, decision: "approve" | "reject"): Promise<void>;
}
export const priorityOrder: Record<Priority, number> = { critical: 0, high: 1, normal: 2, low: 3 };
