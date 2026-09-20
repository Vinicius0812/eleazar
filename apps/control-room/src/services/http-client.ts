import type { Approval, ControlRoomClient, ControlRoomSnapshot, CreateTaskInput, ExecutionDetail, ExecutionProvider, Project, ProviderStatus, RegisterProjectInput, Run, Task } from "./contracts.js";

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
        action: "Liberar para a fila ou cancelar tarefa"
      }));
      const failedRuns = snapshot.executions.filter((run) => run.status === "failed");
      const alerts = [
        ...(approvals.length ? [{ id: "waiting-approval", level: "warning" as const, title: "Decisao pendente", message: `${approvals.length} tarefa(s) aguardam revisao.` }] : []),
        ...failedRuns.map((run) => ({
          id: `failed-${run.id}`,
          level: "error" as const,
          title: `Execucao falhou${run.provider ? ` no ${run.provider}` : ""}`,
          message: readableProviderMessage(run.summary)
        }))
      ];
      return { projects: snapshot.projects, tasks: snapshot.tasks, runs: snapshot.executions, logs: snapshot.logs, approvals,
        alerts } satisfies ControlRoomSnapshot;
    },
    getExecutionDetail(executionId: string) { return request<ExecutionDetail>(`/executions/${encodeURIComponent(executionId)}`); },
    getProviderStatuses(refresh = false) { return request<ProviderStatus[]>(`/providers/status${refresh ? "?refresh=true" : ""}`); },
    registerProject(input: RegisterProjectInput) { return request<Project>("/projects", { method: "POST", body: JSON.stringify(input) }); },
    createTask(input: CreateTaskInput) { return request<Task>("/tasks", { method: "POST", body: JSON.stringify(input) }); },
    executeTask(taskId: string, provider: ExecutionProvider) { return request<Task>(`/tasks/${encodeURIComponent(taskId)}/execute`, { method: "POST", body: JSON.stringify({ provider }) }); },
    async retryTask(taskId) {
      await request<Task>(`/tasks/${encodeURIComponent(taskId)}/transition`, { method: "POST", body: JSON.stringify({ status: "queued", actor: "local-operator", reason: "reenfileirada pelo operador" }) });
    },
    async decideApproval(taskId, decision) {
      await request<Task>(`/tasks/${encodeURIComponent(taskId)}/transition`, { method: "POST", body: JSON.stringify({ status: decision === "approve" ? "queued" : "cancelled", actor: "local-operator", reason: decision === "approve" ? "aprovada pelo operador" : "cancelada pelo operador" }) });
    }
  };
}
function readableProviderMessage(summary: string | null): string {
  if (!summary) return "O provedor nao retornou detalhes. Abra a tarefa e consulte os logs persistidos.";
  try {
    const parsed: unknown = JSON.parse(summary);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const item = parsed as Record<string, unknown>;
      for (const key of ["detail", "error", "message"]) {
        if (typeof item[key] === "string" && item[key].trim()) return item[key].trim();
      }
    }
  } catch { /* Older persisted entries can contain ordinary text. */ }
  return summary;
}
function errorMessage(body: unknown, status: number): string {
  return body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `A API local respondeu com erro ${status}.`;
}
