import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { ControlRoomService, isTaskPriority } from "../core/control-room-service.js";
import { outboundActionKinds, taskActions, taskStatuses, type OutboundActionKind, type ProjectIsolation, type ProviderPreferencesPatch, type TaskAction, type TaskPriority, type TaskStatus } from "../core/control-room.js";
import { isProviderName, taskKinds } from "../core/contracts.js";
import type { ControlRoomTaskExecutor } from "./task-executor.js";
import type { ProviderStatusService } from "./provider-status.js";
import type { OutboundActionService } from "../core/outbound-actions.js";
import type { PullRequestService } from "../core/pull-requests.js";
import { TaskFileExplorer } from "./file-explorer.js";
import type { ProjectTerminals, TerminalEvent } from "./project-terminal.js";

const uiOrigins = new Set([
  "http://127.0.0.1:5173", "http://localhost:5173",
  "http://127.0.0.1:4173", "http://localhost:4173"
]);

/** A small, local JSON API intended for the future React Control Room UI. */
export function createControlRoomServer(service: ControlRoomService, executor?: ControlRoomTaskExecutor, providers?: ProviderStatusService, actions?: OutboundActionService, pullRequests?: PullRequestService, explorer: TaskFileExplorer = new TaskFileExplorer(service), terminals?: ProjectTerminals): Server {
  return createServer(async (request, response) => {
    try {
      await route(service, executor, providers, actions, pullRequests, explorer, terminals, request, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erro interno.";
      const status = error instanceof Error ? (error as Error & { statusCode?: number }).statusCode : undefined;
      json(response, status ?? 400, { error: message });
    }
  });
}

async function route(service: ControlRoomService, executor: ControlRoomTaskExecutor | undefined, providers: ProviderStatusService | undefined, actions: OutboundActionService | undefined, pullRequests: PullRequestService | undefined, explorer: TaskFileExplorer, terminals: ProjectTerminals | undefined, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  assertSafeLocalRequest(request);
  setLocalCors(response, request.headers.origin);
  if (method === "OPTIONS") {
    response.writeHead(204, { "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, last-event-id" });
    response.end();
    return;
  }
  if (method !== "GET" && method !== "HEAD") assertJsonMutation(request);
  if (method === "GET" && url.pathname === "/api/control-room/snapshot") return json(response, 200, service.snapshot());
  if (method === "GET" && url.pathname === "/api/control-room/providers/status") {
    if (!providers) return json(response, 200, []);
    return json(response, 200, await providers.list(url.searchParams.get("refresh") === "true"));
  }
  const providerConfigMatch = /^\/api\/control-room\/providers\/([a-z][a-z0-9-]{0,31})\/config$/.exec(url.pathname);
  if (method === "GET" && providerConfigMatch?.[1]) {
    if (!executor) throw new Error("Executor ACP nao configurado.");
    const directoryId = url.searchParams.get("directoryId");
    if (!directoryId) throw new Error("Informe directoryId para o catalogo ACP.");
    return json(response, 200, await executor.providerConfig(providerConfigMatch[1], directoryId));
  }
  const providerActionMatch = /^\/api\/control-room\/providers\/([a-z][a-z0-9-]{0,31})\/(settings|verify)$/.exec(url.pathname);
  if (method === "POST" && providerActionMatch?.[1]) {
    if (!providers) throw new Error("Provedores nao configurados neste host local.");
    const body = await readBody(request);
    return json(response, 200, providerActionMatch[2] === "verify"
      ? await providers.verify(providerActionMatch[1])
      : await providers.updatePreferences(providerActionMatch[1], preferencesPatch(body)));
  }
  const eventsMatch = /^\/api\/control-room\/executions\/([^/]+)\/events$/.exec(url.pathname);
  if (method === "GET" && eventsMatch?.[1]) {
    return streamExecutionEvents(service, decodeURIComponent(eventsMatch[1]), request, response);
  }
  const cancelMatch = /^\/api\/control-room\/executions\/([^/]+)\/cancel$/.exec(url.pathname);
  if (method === "POST" && cancelMatch?.[1]) {
    if (!executor) throw new Error("Executor nao configurado.");
    await readBody(request);
    const executionId = decodeURIComponent(cancelMatch[1]);
    executor.cancel(executionId);
    return json(response, 200, service.executionDetail(executionId)?.execution);
  }
  const permissionMatch = /^\/api\/control-room\/executions\/([^/]+)\/permissions\/([^/]+)$/.exec(url.pathname);
  if (method === "POST" && permissionMatch?.[1] && permissionMatch[2]) {
    if (!executor) throw new Error("Executor nao configurado.");
    const body = await readBody(request);
    const executionId = decodeURIComponent(permissionMatch[1]);
    const permissionId = decodeURIComponent(permissionMatch[2]);
    executor.respondPermission(executionId, permissionId, stringField(body, "optionId"));
    return json(response, 200, service.store.getExecutionPermission(permissionId));
  }
  const executionMatch = /^\/api\/control-room\/executions\/([^/]+)$/.exec(url.pathname);
  if (method === "GET" && executionMatch?.[1]) {
    const detail = service.executionDetail(decodeURIComponent(executionMatch[1]));
    if (!detail) {
      const error = new Error("Execucao nao encontrada.");
      (error as Error & { statusCode?: number }).statusCode = 404;
      throw error;
    }
    return json(response, 200, detail);
  }
  // Read-only file explorer of a task: its worktree, or the project folder when it runs in place.
  const filesMatch = /^\/api\/control-room\/tasks\/([^/]+)\/(files\/roots|files\/content|files\/search|files|changes)$/.exec(url.pathname);
  if (method === "GET" && filesMatch?.[1] && filesMatch[2]) {
    const taskId = decodeURIComponent(filesMatch[1]);
    if (filesMatch[2] === "files/roots") return json(response, 200, explorer.roots(taskId));
    const directoryId = url.searchParams.get("directoryId");
    if (!directoryId) throw new Error("Informe directoryId.");
    const path = url.searchParams.get("path") ?? "";
    if (filesMatch[2] === "files") return json(response, 200, await explorer.list(taskId, directoryId, path));
    if (filesMatch[2] === "changes") return json(response, 200, await explorer.changes(taskId, directoryId));
    if (filesMatch[2] === "files/search") return json(response, 200, await explorer.search(taskId, directoryId, (url.searchParams.get("q") ?? "").slice(0, 200)));
    return json(response, 200, await explorer.file(taskId, directoryId, path));
  }
  if (url.pathname === "/api/control-room/templates" && (method === "GET" || method === "POST")) {
    if (method === "GET") return json(response, 200, service.listTemplates());
    const body = await readBody(request); const priority = optionalString(body, "priority"); const kind = optionalString(body, "kind");
    if (priority && !isTaskPriority(priority)) throw new Error("Prioridade invalida.");
    if (kind && !taskKinds.includes(kind as typeof taskKinds[number])) throw new Error("Tipo de tarefa invalido.");
    const title = optionalString(body, "title"); const projectId = optionalString(body, "projectId");
    return json(response, 201, service.createTemplate({ name: stringField(body, "name"), prompt: stringField(body, "prompt"),
      ...(title ? { title } : {}), ...(projectId ? { projectId } : {}),
      ...(priority ? { priority: priority as TaskPriority } : {}), ...(kind ? { kind: kind as typeof taskKinds[number] } : {}) }));
  }
  const templateDeleteMatch = /^\/api\/control-room\/templates\/([^/]+)\/delete$/.exec(url.pathname);
  if (method === "POST" && templateDeleteMatch?.[1]) {
    await readBody(request);
    service.deleteTemplate(decodeURIComponent(templateDeleteMatch[1]));
    return json(response, 200, service.listTemplates());
  }
  // Bash in one of the project's folders, opened and driven only by the local operator.
  const projectTerminalMatch = /^\/api\/control-room\/projects\/([^/]+)\/terminals$/.exec(url.pathname);
  if (projectTerminalMatch?.[1] && (method === "GET" || method === "POST")) {
    if (!terminals) throw new Error("Terminal nao configurado neste host local.");
    const projectId = decodeURIComponent(projectTerminalMatch[1]);
    if (method === "GET") return json(response, 200, terminals.list(projectId));
    return json(response, 201, terminals.open(projectId, stringField(await readBody(request), "directoryId")));
  }
  const terminalMatch = /^\/api\/control-room\/terminals\/([^/]+)\/(events|input|close)$/.exec(url.pathname);
  if (terminalMatch?.[1] && terminalMatch[2]) {
    if (!terminals) throw new Error("Terminal nao configurado neste host local.");
    const sessionId = decodeURIComponent(terminalMatch[1]);
    if (method === "GET" && terminalMatch[2] === "events") return streamTerminal(terminals, sessionId, request, response);
    if (method === "POST" && terminalMatch[2] === "input") {
      const body = await readBody(request);
      const command = typeof body.command === "string" ? body.command : "";
      if (!command.trim()) throw new Error("Campo obrigatorio: command");
      terminals.write(sessionId, command);
      return json(response, 202, terminals.get(sessionId));
    }
    if (method === "POST" && terminalMatch[2] === "close") { await readBody(request); return json(response, 200, await terminals.close(sessionId)); }
  }
  // The same read-only explorer over the project's own folders.
  const projectFilesMatch = /^\/api\/control-room\/projects\/([^/]+)\/(files\/roots|files\/content|files\/search|files|changes)$/.exec(url.pathname);
  if (method === "GET" && projectFilesMatch?.[1] && projectFilesMatch[2]) {
    const scope = { projectId: decodeURIComponent(projectFilesMatch[1]) };
    if (projectFilesMatch[2] === "files/roots") return json(response, 200, explorer.projectRoots(scope.projectId));
    const directoryId = url.searchParams.get("directoryId");
    if (!directoryId) throw new Error("Informe directoryId.");
    const path = url.searchParams.get("path") ?? "";
    if (projectFilesMatch[2] === "files") return json(response, 200, await explorer.list(scope, directoryId, path));
    if (projectFilesMatch[2] === "changes") return json(response, 200, await explorer.changes(scope, directoryId));
    if (projectFilesMatch[2] === "files/search") return json(response, 200, await explorer.search(scope, directoryId, (url.searchParams.get("q") ?? "").slice(0, 200)));
    return json(response, 200, await explorer.file(scope, directoryId, path));
  }
  if (method === "GET" && url.pathname === "/api/control-room/projects") return json(response, 200, service.store.listProjects());
  if (method === "GET" && url.pathname === "/api/control-room/tasks") return json(response, 200, service.listTasks(url.searchParams.get("projectId") ?? undefined));
  if (method === "POST" && url.pathname === "/api/control-room/projects") {
    const body = await readBody(request);
    const directories = optionalDirectories(body.directories);
    const isolation = optionalString(body, "isolation");
    return json(response, 201, service.registerProject({
      name: stringField(body, "name"),
      ...(isolation ? { isolation: isolation as ProjectIsolation } : {}),
      ...(directories ? { directories } : { path: stringField(body, "path") })
    }));
  }
  const projectSettingsMatch = /^\/api\/control-room\/projects\/([^/]+)\/settings$/.exec(url.pathname);
  if (method === "POST" && projectSettingsMatch?.[1]) {
    const isolation = stringField(await readBody(request), "isolation");
    return json(response, 200, service.setProjectIsolation(decodeURIComponent(projectSettingsMatch[1]), isolation as ProjectIsolation));
  }
  if (method === "POST" && url.pathname === "/api/control-room/tasks") {
    const body = await readBody(request); const priority = optionalString(body, "priority"); const kind = optionalString(body, "kind");
    if (priority && !isTaskPriority(priority)) throw new Error("Prioridade invalida.");
    if (kind && !taskKinds.includes(kind as typeof taskKinds[number])) throw new Error("Tipo de tarefa invalido.");
    const targetDirectoryId = optionalString(body, "targetDirectoryId");
    const directoryIds = optionalArrayOfStrings(body.directoryIds, "directoryIds");
    return json(response, 201, service.createTask({ projectId: stringField(body, "projectId"), title: stringField(body, "title"), prompt: stringField(body, "prompt"), ...(priority ? { priority: priority as TaskPriority } : {}), ...(kind ? { kind: kind as typeof taskKinds[number] } : {}), ...(targetDirectoryId ? { targetDirectoryId } : {}), ...(directoryIds ? { directoryIds } : {}) }));
  }
  const transitionMatch = /^\/api\/control-room\/tasks\/([^/]+)\/transition$/.exec(url.pathname);
  if (method === "POST" && transitionMatch?.[1]) {
    const body = await readBody(request); const status = stringField(body, "status");
    if (!taskStatuses.includes(status as TaskStatus)) throw new Error("Status invalido.");
    return json(response, 200, service.transitionTask(transitionMatch[1], status as TaskStatus, optionalString(body, "actor") ?? "local-api", optionalString(body, "reason")));
  }
  const dispatchMatch = /^\/api\/control-room\/tasks\/([^/]+)\/dispatch$/.exec(url.pathname);
  if (method === "POST" && dispatchMatch?.[1]) {
    const body = await readBody(request);
    // Naming a provider here would skip the login confirmation that execute does.
    if (optionalString(body, "selectedProvider")) throw new Error("Escolha o provedor em execute, que confirma a autenticacao.");
    const actions = arrayOfStrings(body.requestedActions, "requestedActions") as TaskAction[];
    if (!actions.every((action) => taskActions.includes(action))) throw new Error("Acao de despacho invalida.");
    return json(response, 202, await service.dispatch(dispatchMatch[1], { selectedProvider: null, reason: stringField(body, "reason"), candidates: [], requestedActions: actions }));
  }
  const executeMatch = /^\/api\/control-room\/tasks\/([^/]+)\/execute$/.exec(url.pathname);
  if (method === "POST" && executeMatch?.[1]) {
    if (!executor) throw new Error("Executor de provedores nao configurado neste host local.");
    const body = await readBody(request);
    const provider = optionalString(body, "provider") ?? "auto";
    if (provider !== "auto" && !isProviderName(provider)) throw new Error("Provedor invalido.");
    const model = optionalString(body, "model");
    const sessionId = optionalString(body, "sessionId");
    return json(response, 202, await executor.start(executeMatch[1], provider === "auto" ? undefined : provider, model, sessionId));
  }
  const messageMatch = /^\/api\/control-room\/tasks\/([^/]+)\/messages$/.exec(url.pathname);
  if (method === "POST" && messageMatch?.[1]) {
    if (!executor) throw new Error("Executor de provedores nao configurado neste host local.");
    const body = await readBody(request);
    const provider = optionalString(body, "provider");
    if (provider !== undefined && !isProviderName(provider)) throw new Error("Provedor invalido.");
    return json(response, 202, await executor.continueTask(messageMatch[1], stringField(body, "prompt"), provider, optionalString(body, "model")));
  }
  if (method === "POST" && url.pathname === "/api/control-room/comparisons") {
    if (!executor) throw new Error("Executor de provedores nao configurado neste host local.");
    const body = await readBody(request); const priority = optionalString(body, "priority"); const kind = optionalString(body, "kind");
    if (priority && !isTaskPriority(priority)) throw new Error("Prioridade invalida.");
    if (kind && !taskKinds.includes(kind as typeof taskKinds[number])) throw new Error("Tipo de tarefa invalido.");
    const providers = arrayOfStrings(body.providers, "providers");
    if (providers.length < 2 || providers.length > 3 || !providers.every(isProviderName)) throw new Error("Informe de dois a tres provedores validos para comparar.");
    const targetDirectoryId = optionalString(body, "targetDirectoryId");
    return json(response, 202, await executor.startComparison({ projectId: stringField(body, "projectId"), title: stringField(body, "title"), prompt: stringField(body, "prompt"),
      ...(priority ? { priority: priority as TaskPriority } : {}), ...(kind ? { kind: kind as typeof taskKinds[number] } : {}),
      ...(targetDirectoryId ? { targetDirectoryId, directoryIds: [targetDirectoryId] } : {}) }, providers));
  }
  const comparisonMatch = /^\/api\/control-room\/comparisons\/([^/]+)(\/choose)?$/.exec(url.pathname);
  if (comparisonMatch?.[1]) {
    const comparisonId = decodeURIComponent(comparisonMatch[1]);
    if (method === "GET" && !comparisonMatch[2]) return json(response, 200, service.listComparison(comparisonId));
    if (method === "POST" && comparisonMatch[2]) {
      const taskId = stringField(await readBody(request), "taskId");
      if (service.getTask(taskId)?.comparisonId !== comparisonId) throw new Error("A tarefa nao pertence a esta comparacao.");
      service.chooseComparisonAttempt(taskId);
      return json(response, 200, service.listComparison(comparisonId));
    }
  }
  const resumeMatch = /^\/api\/control-room\/tasks\/([^/]+)\/resume$/.exec(url.pathname);
  if (method === "POST" && resumeMatch?.[1]) {
    if (!executor) throw new Error("Executor de provedores nao configurado neste host local.");
    await readBody(request);
    return json(response, 202, await executor.resume(decodeURIComponent(resumeMatch[1])));
  }
  const worktreeMatch = /^\/api\/control-room\/tasks\/([^/]+)\/worktrees\/remove$/.exec(url.pathname);
  if (method === "POST" && worktreeMatch?.[1]) {
    await readBody(request);
    return json(response, 200, await service.removeTaskWorktrees(worktreeMatch[1]));
  }
  const taskActionsMatch = /^\/api\/control-room\/tasks\/([^/]+)\/actions$/.exec(url.pathname);
  if (taskActionsMatch?.[1] && (method === "GET" || method === "POST")) {
    if (!actions) throw new Error("Acoes de saida nao configuradas neste host local.");
    if (method === "GET") return json(response, 200, actions.list(taskActionsMatch[1]));
    const body = await readBody(request); const kind = stringField(body, "kind");
    if (!outboundActionKinds.includes(kind as OutboundActionKind)) throw new Error("Acao de saida invalida.");
    const title = optionalString(body, "title"); const text = optionalString(body, "body");
    return json(response, 201, await actions.request(taskActionsMatch[1], { kind: kind as OutboundActionKind, ...(title ? { title } : {}), ...(text ? { body: text } : {}) }));
  }
  const decisionMatch = /^\/api\/control-room\/actions\/([^/]+)\/decision$/.exec(url.pathname);
  if (method === "POST" && decisionMatch?.[1]) {
    if (!actions) throw new Error("Acoes de saida nao configuradas neste host local.");
    const decision = stringField(await readBody(request), "decision");
    if (decision !== "approve" && decision !== "reject") throw new Error("Decisao invalida.");
    const decided = await actions.decide(decodeURIComponent(decisionMatch[1]), decision);
    // A push or a new pull request changes what the forge reports; pick it up right away.
    if (pullRequests && decided.status === "completed" && decided.kind !== "commit") await pullRequests.refresh(decided.taskId).catch(() => undefined);
    return json(response, 200, decided);
  }
  const refreshMatch = /^\/api\/control-room\/(?:tasks\/([^/]+)\/)?pull-requests\/refresh$/.exec(url.pathname);
  if (method === "POST" && refreshMatch) {
    if (!pullRequests) throw new Error("Consulta de pull requests nao configurada neste host local.");
    await readBody(request);
    return json(response, 200, refreshMatch[1] ? await pullRequests.refresh(decodeURIComponent(refreshMatch[1])) : await pullRequests.refreshAll());
  }
  json(response, 404, { error: "Rota nao encontrada." });
}

function streamExecutionEvents(service: ControlRoomService, executionId: string, request: IncomingMessage, response: ServerResponse): void {
  const execution = service.store.getExecution(executionId);
  if (!execution) {
    const error = new Error("Execucao nao encontrada.");
    (error as Error & { statusCode?: number }).statusCode = 404;
    throw error;
  }
  const lastId = request.headers["last-event-id"];
  let cursor = 0;
  if (lastId) {
    const match = new RegExp(`^${escapeRegExp(executionId)}:(\\d+)$`).exec(Array.isArray(lastId) ? lastId[0] ?? "" : lastId);
    if (!match) throw new Error("Last-Event-ID invalido para esta execucao.");
    cursor = Number(match[1]);
    if (!Number.isSafeInteger(cursor)) throw new Error("Last-Event-ID invalido.");
  }
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  response.write(": connected\n\n");
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe = () => {};
  const cleanup = () => { if (closed) return; closed = true; if (heartbeat) clearInterval(heartbeat); unsubscribe(); };
  const deliver = (event: import("../core/control-room.js").ExecutionEvent) => {
    if (closed || event.sequence <= cursor) return;
    cursor = event.sequence;
    const writable = response.write(`id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
    if (!writable) { cleanup(); response.end(); return; }
    if (["completed", "failed", "cancelled", "interrupted"].includes(event.kind)) { cleanup(); response.end(); }
  };
  response.on("close", cleanup);
  unsubscribe = service.onExecutionEvent(executionId, deliver);
  for (const event of service.listExecutionEvents(executionId, cursor)) deliver(event);
  if (closed) return;
  if (["completed", "failed", "cancelled"].includes(service.store.getExecution(executionId)?.status ?? "")) {
    cleanup(); response.end(); return;
  }
  heartbeat = setInterval(() => { if (!closed) response.write(": heartbeat\n\n"); }, 15_000);
  heartbeat.unref();
}
function streamTerminal(terminals: ProjectTerminals, sessionId: string, request: IncomingMessage, response: ServerResponse): void {
  const info = terminals.get(sessionId);
  const lastId = request.headers["last-event-id"];
  const match = lastId ? new RegExp(`^${escapeRegExp(sessionId)}:(\\d+)$`).exec(Array.isArray(lastId) ? lastId[0] ?? "" : lastId) : null;
  if (lastId && !match) throw new Error("Last-Event-ID invalido para este terminal.");
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  response.write(": connected\n\n");
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe = () => {};
  const cleanup = () => { if (closed) return; closed = true; if (heartbeat) clearInterval(heartbeat); unsubscribe(); };
  const deliver = (event: TerminalEvent) => {
    if (closed) return;
    response.write(`id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
    if (event.kind === "exit") { cleanup(); response.end(); }
  };
  response.on("close", cleanup);
  unsubscribe = terminals.subscribe(sessionId, match ? Number(match[1]) : 0, deliver);
  if (closed) return;
  if (info.closed) { cleanup(); response.end(); return; }
  heartbeat = setInterval(() => { if (!closed) response.write(": heartbeat\n\n"); }, 15_000);
  heartbeat.unref();
}
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  let byteLength = 0;
  const decoder = new TextDecoder();
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    byteLength += bytes.byteLength;
    if (byteLength > 1_000_000) throw new Error("Corpo da requisicao excede 1 MB.");
    text += decoder.decode(bytes, { stream: true });
  }
  text += decoder.decode();
  try { const parsed: unknown = JSON.parse(text || "{}"); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); return parsed as Record<string, unknown>; }
  catch { throw new Error("Corpo JSON invalido."); }
}
function stringField(body: Record<string, unknown>, name: string): string { const value = optionalString(body, name); if (!value) throw new Error(`Campo obrigatorio: ${name}`); return value; }
function optionalString(body: Record<string, unknown>, name: string): string | undefined { const value = body[name]; return typeof value === "string" ? value.trim() : undefined; }
function preferencesPatch(body: Record<string, unknown>): ProviderPreferencesPatch {
  const patch: ProviderPreferencesPatch = {};
  for (const name of ["enabled", "automatic"] as const) {
    const value = body[name];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw new Error(`Campo invalido: ${name}`);
    patch[name] = value;
  }
  if (body.dailyTokenBudget !== undefined) {
    const value = body.dailyTokenBudget;
    if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)) throw new Error("Campo invalido: dailyTokenBudget");
    patch.dailyTokenBudget = value;
  }
  for (const name of ["executablePath", "defaultModel"] as const) {
    const value = body[name];
    if (value === undefined) continue;
    if (value !== null && (typeof value !== "string" || value.length > 500)) throw new Error(`Campo invalido: ${name}`);
    patch[name] = value?.trim() || null;
  }
  return patch;
}
function optionalDirectories(value: unknown): Array<{ name?: string; path: string }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length) throw new Error("Campo directories deve conter ao menos um diretorio.");
  return value.map((directory) => {
    if (!directory || typeof directory !== "object" || Array.isArray(directory)) throw new Error("Diretorio invalido.");
    const item = directory as Record<string, unknown>;
    const path = typeof item.path === "string" ? item.path.trim() : "";
    const name = typeof item.name === "string" ? item.name.trim() : undefined;
    if (!path) throw new Error("Cada diretorio exige path.");
    return { path, ...(name ? { name } : {}) };
  });
}
function optionalArrayOfStrings(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || !value.every((item) => typeof item === "string" && item.trim())) throw new Error(`Campo invalido: ${name}`);
  return value.map((item) => item.trim());
}
function arrayOfStrings(value: unknown, name: string): string[] { if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`Campo obrigatorio: ${name}`); return value; }
function json(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify(body)); }

function assertSafeLocalRequest(request: IncomingMessage): void {
  const host = loopbackHost(request.headers.host);
  if (!isLoopbackAddress(request.socket.remoteAddress) || !host) {
    const error = new Error("A API local exige origem de rede e Host loopback.");
    (error as Error & { statusCode?: number }).statusCode = 403;
    throw error;
  }
  const origin = request.headers.origin;
  const sameOrigin = origin === host.origin && Number(host.port || "80") === request.socket.localPort;
  if (origin !== undefined && !sameOrigin && !uiOrigins.has(origin)) {
    const error = new Error("Origin nao autorizada para a API local.");
    (error as Error & { statusCode?: number }).statusCode = 403;
    throw error;
  }
}

function assertJsonMutation(request: IncomingMessage): void {
  const mediaType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    const error = new Error("Mutacoes locais exigem Content-Type application/json.");
    (error as Error & { statusCode?: number }).statusCode = 415;
    throw error;
  }
}

function setLocalCors(response: ServerResponse, origin: string | undefined): void {
  response.setHeader("vary", "Origin");
  if (origin) response.setHeader("access-control-allow-origin", origin);
}

function loopbackHost(host: string | undefined): URL | undefined {
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)) return undefined;
  try { return new URL(`http://${host}`); } catch { return undefined; }
}
function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
