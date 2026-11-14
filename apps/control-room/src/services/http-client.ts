import { readableProviderMessage } from "./run-messages.js";
import { isLiveExecution, terminalEventKinds, type Approval, type AcpProvider, type CodexConfig, type ProviderConfig, type ExecuteOptions, type EventStreamOptions, type ExecutionEvent, type ControlRoomClient, ControlRoomSnapshot, CreateTaskInput, ExecutionDetail, ExecutionProvider, Project, ProviderStatus, RegisterProjectInput, Run, Task } from "./contracts.js";

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
      const approvals = snapshot.tasks.filter((task) => task.status === "waiting_approval" && !snapshot.executions.some((run) => isLiveExecution(task, run))).map((task): Approval => ({
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
    getProviderConfig(provider: AcpProvider, directoryId: string) { return request<ProviderConfig>(`/providers/${provider}/config?directoryId=${encodeURIComponent(directoryId)}`); },
    getCodexConfig(directoryId: string) { return request<CodexConfig>(`/providers/codex/config?directoryId=${encodeURIComponent(directoryId)}`); },
    executeTask(taskId: string, provider: ExecutionProvider, options?: ExecuteOptions) {
      const body: Record<string, string> = { provider };
      if (options?.model) body.model = options.model;
      if (options?.sessionId) body.sessionId = options.sessionId;
      return request<Task>(`/tasks/${encodeURIComponent(taskId)}/execute`, { method: "POST", body: JSON.stringify(body) });
    },
    async cancelExecution(executionId) { await request<unknown>(`/executions/${encodeURIComponent(executionId)}/cancel`, { method: "POST", body: "{}" }); },
    async respondPermission(executionId, permissionId, optionId) {
      await request<unknown>(`/executions/${encodeURIComponent(executionId)}/permissions/${encodeURIComponent(permissionId)}`, { method: "POST", body: JSON.stringify({ optionId }) });
    },
    async streamExecutionEvents(executionId: string, options: EventStreamOptions) {
      const headers: Record<string, string> = { accept: "text/event-stream" };
      if (options.afterId) headers["last-event-id"] = options.afterId;
      const response = await fetch(`${baseUrl}/executions/${encodeURIComponent(executionId)}/events`, { headers, signal: options.signal });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => ({}));
        throw new Error(errorMessage(body, response.status));
      }
      if (!response.body) throw new Error("A API local nao retornou um fluxo de eventos.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser();
      let terminal = false;
      const deliver = (events: ExecutionEvent[]) => {
        for (const event of events) { options.onEvent(event); if (terminalEventKinds.includes(event.kind)) terminal = true; }
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          deliver(parser.push(decoder.decode(value, { stream: true })));
        }
        deliver(parser.push(decoder.decode()));
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      return terminal;
    },
    async retryTask(taskId) {
      await request<Task>(`/tasks/${encodeURIComponent(taskId)}/transition`, { method: "POST", body: JSON.stringify({ status: "queued", actor: "local-operator", reason: "reenfileirada pelo operador" }) });
    },
    async decideApproval(taskId, decision) {
      await request<Task>(`/tasks/${encodeURIComponent(taskId)}/transition`, { method: "POST", body: JSON.stringify({ status: decision === "approve" ? "queued" : "cancelled", actor: "local-operator", reason: decision === "approve" ? "aprovada pelo operador" : "cancelada pelo operador" }) });
    }
  };
}
function errorMessage(body: unknown, status: number): string {
  return body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `A API local respondeu com erro ${status}.`;
}

/**
 * Incremental Server-Sent Events parser. Accepts arbitrary chunk boundaries and yields
 * only well-formed execution events; comments, heartbeats and malformed JSON are ignored.
 * An unterminated trailing frame is discarded, as the SSE specification requires.
 */
export function createSseParser() {
  let buffer = "";
  let data: string[] = [];
  return {
    push(chunk: string): ExecutionEvent[] {
      const out: ExecutionEvent[] = [];
      buffer += chunk;
      // A trailing CR may be the first half of a CRLF split across chunks; hold it back.
      const held = buffer.endsWith("\r") ? "\r" : "";
      const parts = buffer.slice(0, buffer.length - held.length).split(/\r\n|\n|\r/);
      buffer = (parts.pop() ?? "") + held;
      for (const line of parts) {
        if (line === "") {
          if (!data.length) continue;
          const text = data.join("\n");
          data = [];
          try {
            const item = JSON.parse(text) as Partial<ExecutionEvent> | null;
            if (item && typeof item.id === "string" && typeof item.kind === "string" && typeof item.sequence === "number" && item.payload && typeof item.payload === "object") out.push(item as ExecutionEvent);
          } catch { /* A foreign or truncated frame must not break the stream. */ }
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") data.push(value);
      }
      return out;
    }
  };
}
