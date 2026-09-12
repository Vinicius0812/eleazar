/** UI transport DTOs only. No imports from domain, provider SDKs or Node APIs. */
export type Priority = "high" | "normal" | "low";
export type TaskStatus =
  "queued" | "running" | "awaiting_approval" | "completed" | "blocked";
export interface Project {
  id: string;
  name: string;
  path: string;
  branch: string;
  color: string;
}
export interface Task {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  priority: Priority;
  status: TaskStatus;
  createdAt: string;
}
export interface Run {
  id: string;
  taskId: string;
  providerId: string;
  phase: string;
  progress: number;
  startedAt: string;
}
export interface Provider {
  id: string;
  name: string;
  status: "available" | "degraded" | "offline";
  detail: string;
}
export interface Alert {
  id: string;
  level: "warning" | "info";
  title: string;
  message: string;
}
export interface Approval {
  id: string;
  taskId: string;
  title: string;
  description: string;
  action: string;
}
export interface LogEntry {
  id: string;
  time: string;
  level: "info" | "warning" | "error";
  message: string;
}
export interface ControlRoomSnapshot {
  projects: Project[];
  tasks: Task[];
  runs: Run[];
  providers: Provider[];
  alerts: Alert[];
  approvals: Approval[];
  logs: LogEntry[];
}
export interface RegisterProjectInput {
  name: string;
  path: string;
}
export interface CreateTaskInput {
  projectId: string;
  title: string;
  prompt: string;
  priority: Priority;
}
/** Async boundary: the integration owns persistence, validation, authorization and scheduling.
 * Mutations must finish before resolving; rejected promises are presented to the operator.
 * Snapshot dates are ISO-8601; progress is 0–100. No secrets belong in these DTOs.
 */
export interface ControlRoomClient {
  getSnapshot(): Promise<ControlRoomSnapshot>;
  registerProject(input: RegisterProjectInput): Promise<Project>;
  createTask(input: CreateTaskInput): Promise<Task>;
  decideApproval(id: string, decision: "approve" | "reject"): Promise<void>;
}
