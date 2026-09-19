import type { Approval, ControlRoomClient, ControlRoomSnapshot, CreateTaskInput, Project, RegisterProjectInput, Run, Task } from "./contracts.js";

const apiBase = "http://127.0.0.1:4317/api/control-room";
type ApiSnapshot = { projects: Project[]; tasks: Task[]; executions: Run[]; logs: ControlRoomSnapshot["logs"]; };

export function createHttpControlRoomClient(baseUrl = apiBase): ControlRoomClient {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(errorMessage(body, response.status));
    return body as T;
  }
  return {
    async getSnapshot() {
      const snapshot = await request<ApiSnapshot>("/snapshot");
      const approvals = snapshot.tasks.filter((task) => task.status === "waiting_approval").map((task): Approval => ({
        id: task.id, taskId: task.id, title: task.title,
        description: "A tarefa esta aguardando uma decisao do operador no nucleo local.",
        action: "Retomar planejamento ou cancelar tarefa"
      }));
      return { projects: snapshot.projects, tasks: snapshot.tasks, runs: snapshot.executions, logs: snapshot.logs, approvals,
        alerts: approvals.length ? [{ id: "waiting-approval", level: "warning" as const, title: "Decisao pendente", message: `${approvals.length} tarefa(s) aguardam revisao.` }] : [] } satisfies ControlRoomSnapshot;
    },
    registerProject(input: RegisterProjectInput) { return request<Project>("/projects", { method: "POST", body: JSON.stringify(input) }); },
    createTask(input: CreateTaskInput) { return request<Task>("/tasks", { method: "POST", body: JSON.stringify(input) }); },
    async decideApproval(taskId, decision) {
      await request<Task>(`/tasks/${encodeURIComponent(taskId)}/transition`, { method: "POST", body: JSON.stringify({ status: decision === "approve" ? "planning" : "cancelled", actor: "local-operator", reason: decision === "approve" ? "aprovada pelo operador" : "cancelada pelo operador" }) });
    }
  };
}
function errorMessage(body: unknown, status: number): string {
  return body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `A API local respondeu com erro ${status}.`;
}
