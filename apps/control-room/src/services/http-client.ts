import { readableProviderMessage } from "./run-messages.js";
import { isLiveExecution, terminalEventKinds, type Approval, type AcpProvider, type CodexConfig, type ProviderConfig, type ExecuteOptions, type EventStreamOptions, type ExecutionEvent, type ControlRoomClient, type OutboundActionInput, type TaskOutboundAction, type TaskPullRequest, type PullRequestRefresh, type ExplorerRoot, type ExplorerListing, type ExplorerChanges, type ExplorerFile, type ExplorerSearch, type ComparisonStart, type TaskTemplate, type TerminalEvent, type TerminalSession, ControlRoomSnapshot, CreateTaskInput, ExecutionDetail, ExecutionProvider, Project, ProviderStatus, RegisterProjectInput, Run, Task } from "./contracts.js";

// VITE_CONTROL_ROOM_API points a second copy of the interface at another local host, such as a test database.
const apiBase = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_CONTROL_ROOM_API ?? "http://127.0.0.1:4317/api/control-room";
type ApiSnapshot = { projects: Project[]; tasks: Task[]; executions: Run[]; logs: ControlRoomSnapshot["logs"]; actions?: TaskOutboundAction[]; pullRequests?: TaskPullRequest[]; };

function explorerQuery(directoryId: string, path?: string): string {
  const query = new URLSearchParams({ directoryId });
  if (path !== undefined) query.set("path", path);
  return query.toString();
}

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
      const pendingActions = (snapshot.actions ?? []).filter((action) => action.status === "pending");
      const alerts = [
        ...(approvals.length ? [{ id: "waiting-approval", level: "warning" as const, title: "Decisao pendente", message: `${approvals.length} tarefa(s) aguardam revisao.` }] : []),
        ...(pendingActions.length ? [{ id: "pending-actions", level: "warning" as const, title: "Publicacao pendente", message: `${pendingActions.length} commit, push ou pull request aguarda(m) a sua aprovacao na tarefa.` }] : []),
        ...failedRuns.map((run) => ({
          id: `failed-${run.id}`,
          level: "error" as const,
          title: `Execucao falhou${run.provider ? ` no ${run.provider}` : ""}`,
          message: readableProviderMessage(run.summary)
        }))
      ];
      return { projects: snapshot.projects, tasks: snapshot.tasks, runs: snapshot.executions, logs: snapshot.logs, approvals,
        alerts, actions: snapshot.actions ?? [], pullRequests: snapshot.pullRequests ?? [] } satisfies ControlRoomSnapshot;
    },
    getTaskFileRoots(taskId) { return request<ExplorerRoot[]>(`/tasks/${encodeURIComponent(taskId)}/files/roots`); },
    listTaskFiles(taskId, directoryId, path = "") { return request<ExplorerListing>(`/tasks/${encodeURIComponent(taskId)}/files?${explorerQuery(directoryId, path)}`); },
    getTaskChanges(taskId, directoryId) { return request<ExplorerChanges>(`/tasks/${encodeURIComponent(taskId)}/changes?${explorerQuery(directoryId)}`); },
    getTaskFile(taskId, directoryId, path) { return request<ExplorerFile>(`/tasks/${encodeURIComponent(taskId)}/files/content?${explorerQuery(directoryId, path)}`); },
    searchTaskFiles(taskId, directoryId, query) { return request<ExplorerSearch>(`/tasks/${encodeURIComponent(taskId)}/files/search?${explorerQuery(directoryId)}&${new URLSearchParams({ q: query }).toString()}`); },
    pinTask(taskId, pinned) { return request<Task>(`/tasks/${encodeURIComponent(taskId)}/pin`, { method: "POST", body: JSON.stringify({ pinned }) }); },
    async deleteTask(taskId) { await request<unknown>(`/tasks/${encodeURIComponent(taskId)}/delete`, { method: "POST", body: "{}" }); },
    projectIconUrl(projectId) { return `${baseUrl}/projects/${encodeURIComponent(projectId)}/icon`; },
    listTerminals(projectId) { return request<TerminalSession[]>(`/projects/${encodeURIComponent(projectId)}/terminals`); },
    openTerminal(projectId, directoryId) { return request<TerminalSession>(`/projects/${encodeURIComponent(projectId)}/terminals`, { method: "POST", body: JSON.stringify({ directoryId }) }); },
    sendTerminalInput(sessionId, command) { return request<TerminalSession>(`/terminals/${encodeURIComponent(sessionId)}/input`, { method: "POST", body: JSON.stringify({ command }) }); },
    closeTerminal(sessionId) { return request<TerminalSession>(`/terminals/${encodeURIComponent(sessionId)}/close`, { method: "POST", body: "{}" }); },
    async streamTerminalEvents(sessionId, options) {
      const headers: Record<string, string> = { accept: "text/event-stream" };
      if (options.afterId) headers["last-event-id"] = options.afterId;
      const response = await fetch(`${baseUrl}/terminals/${encodeURIComponent(sessionId)}/events`, { headers, signal: options.signal });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => ({}));
        throw new Error(errorMessage(body, response.status));
      }
      if (!response.body) throw new Error("A API local nao retornou um fluxo de eventos.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser<TerminalEvent>(isTerminalEvent);
      let exited = false;
      const deliver = (events: TerminalEvent[]) => { for (const event of events) { options.onEvent(event); if (event.kind === "exit") exited = true; } };
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
      return exited;
    },
    getProjectFileRoots(projectId) { return request<ExplorerRoot[]>(`/projects/${encodeURIComponent(projectId)}/files/roots`); },
    listProjectFiles(projectId, directoryId, path = "") { return request<ExplorerListing>(`/projects/${encodeURIComponent(projectId)}/files?${explorerQuery(directoryId, path)}`); },
    getProjectChanges(projectId, directoryId) { return request<ExplorerChanges>(`/projects/${encodeURIComponent(projectId)}/changes?${explorerQuery(directoryId)}`); },
    getProjectFile(projectId, directoryId, path) { return request<ExplorerFile>(`/projects/${encodeURIComponent(projectId)}/files/content?${explorerQuery(directoryId, path)}`); },
    searchProjectFiles(projectId, directoryId, query) { return request<ExplorerSearch>(`/projects/${encodeURIComponent(projectId)}/files/search?${explorerQuery(directoryId)}&${new URLSearchParams({ q: query }).toString()}`); },
    getExecutionDetail(executionId: string) { return request<ExecutionDetail>(`/executions/${encodeURIComponent(executionId)}`); },
    getProviderStatuses(refresh = false) { return request<ProviderStatus[]>(`/providers/status${refresh ? "?refresh=true" : ""}`); },
    verifyProvider(provider) { return request<ProviderStatus[]>(`/providers/${encodeURIComponent(provider)}/verify`, { method: "POST", body: "{}" }); },
    updateProvider(provider, patch) { return request<ProviderStatus[]>(`/providers/${encodeURIComponent(provider)}/settings`, { method: "POST", body: JSON.stringify(patch) }); },
    registerProject(input: RegisterProjectInput) { return request<Project>("/projects", { method: "POST", body: JSON.stringify(input) }); },
    updateProject(projectId, input) { return request<Project>(`/projects/${encodeURIComponent(projectId)}/update`, { method: "POST", body: JSON.stringify(input) }); },
    updateProjectIsolation(projectId, isolation) { return request<Project>(`/projects/${encodeURIComponent(projectId)}/settings`, { method: "POST", body: JSON.stringify({ isolation }) }); },
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
    listTemplates() { return request<TaskTemplate[]>("/templates"); },
    createTemplate(input) { return request<TaskTemplate>("/templates", { method: "POST", body: JSON.stringify(input) }); },
    deleteTemplate(templateId) { return request<TaskTemplate[]>(`/templates/${encodeURIComponent(templateId)}/delete`, { method: "POST", body: "{}" }); },
    startComparison(input, providers) {
      return request<ComparisonStart>("/comparisons", { method: "POST", body: JSON.stringify({ projectId: input.projectId, targetDirectoryId: input.targetDirectoryId, title: input.title, prompt: input.prompt, priority: input.priority, ...(input.kind ? { kind: input.kind } : {}), providers }) });
    },
    chooseComparisonAttempt(comparisonId, taskId) {
      return request<Task[]>(`/comparisons/${encodeURIComponent(comparisonId)}/choose`, { method: "POST", body: JSON.stringify({ taskId }) });
    },
    resumeTask(taskId: string) {
      return request<Task>(`/tasks/${encodeURIComponent(taskId)}/resume`, { method: "POST", body: "{}" });
    },
    sendTaskMessage(taskId: string, prompt: string) {
      return request<Task>(`/tasks/${encodeURIComponent(taskId)}/messages`, { method: "POST", body: JSON.stringify({ prompt }) });
    },
    requestTaskAction(taskId: string, input: OutboundActionInput) {
      return request<TaskOutboundAction>(`/tasks/${encodeURIComponent(taskId)}/actions`, { method: "POST", body: JSON.stringify(input) });
    },
    decideTaskAction(actionId: string, decision: "approve" | "reject") {
      return request<TaskOutboundAction>(`/actions/${encodeURIComponent(actionId)}/decision`, { method: "POST", body: JSON.stringify({ decision }) });
    },
    removeTaskWorktrees(taskId: string) {
      return request<Task>(`/tasks/${encodeURIComponent(taskId)}/worktrees/remove`, { method: "POST", body: "{}" });
    },
    refreshPullRequests(taskId?: string) {
      return request<PullRequestRefresh>(`${taskId ? `/tasks/${encodeURIComponent(taskId)}` : ""}/pull-requests/refresh`, { method: "POST", body: "{}" });
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
function isExecutionEvent(item: unknown): item is ExecutionEvent {
  const event = item as Partial<ExecutionEvent> | null;
  return Boolean(event && typeof event.id === "string" && typeof event.kind === "string" && typeof event.sequence === "number" && event.payload && typeof event.payload === "object");
}
function isTerminalEvent(item: unknown): item is TerminalEvent {
  const event = item as Partial<TerminalEvent> | null;
  return Boolean(event && typeof event.id === "string" && typeof event.kind === "string" && typeof event.sequence === "number");
}

export function createSseParser<T = ExecutionEvent>(accept: (item: unknown) => item is T = isExecutionEvent as unknown as (item: unknown) => item is T) {
  let buffer = "";
  let data: string[] = [];
  return {
    push(chunk: string): T[] {
      const out: T[] = [];
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
            const item: unknown = JSON.parse(text);
            if (accept(item)) out.push(item);
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
