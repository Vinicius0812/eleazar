import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { ControlRoomService, isTaskPriority } from "../core/control-room-service.js";
import { taskActions, taskStatuses, type TaskAction, type TaskPriority, type TaskStatus } from "../core/control-room.js";
import { providerNames, taskKinds, type ProviderName } from "../core/contracts.js";

/** A small, local JSON API intended for the future React Control Room UI. */
export function createControlRoomServer(service: ControlRoomService): Server {
  return createServer(async (request, response) => {
    try {
      await route(service, request, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erro interno.";
      const status = error instanceof Error ? (error as Error & { statusCode?: number }).statusCode : undefined;
      json(response, status ?? 400, { error: message });
    }
  });
}

async function route(service: ControlRoomService, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  assertSafeLocalRequest(request);
  if (method !== "GET" && method !== "HEAD") assertJsonMutation(request);
  if (method === "GET" && url.pathname === "/api/control-room/projects") return json(response, 200, service.store.listProjects());
  if (method === "GET" && url.pathname === "/api/control-room/tasks") return json(response, 200, service.listTasks(url.searchParams.get("projectId") ?? undefined));
  if (method === "POST" && url.pathname === "/api/control-room/projects") {
    const body = await readBody(request);
    return json(response, 201, service.registerProject({ name: stringField(body, "name"), path: stringField(body, "path") }));
  }
  if (method === "POST" && url.pathname === "/api/control-room/tasks") {
    const body = await readBody(request); const priority = optionalString(body, "priority"); const kind = optionalString(body, "kind");
    if (priority && !isTaskPriority(priority)) throw new Error("Prioridade invalida.");
    if (kind && !taskKinds.includes(kind as typeof taskKinds[number])) throw new Error("Tipo de tarefa invalido.");
    return json(response, 201, service.createTask({ projectId: stringField(body, "projectId"), title: stringField(body, "title"), prompt: stringField(body, "prompt"), ...(priority ? { priority: priority as TaskPriority } : {}), ...(kind ? { kind: kind as typeof taskKinds[number] } : {}) }));
  }
  const transitionMatch = /^\/api\/control-room\/tasks\/([^/]+)\/transition$/.exec(url.pathname);
  if (method === "POST" && transitionMatch?.[1]) {
    const body = await readBody(request); const status = stringField(body, "status");
    if (!taskStatuses.includes(status as TaskStatus)) throw new Error("Status invalido.");
    return json(response, 200, service.transitionTask(transitionMatch[1], status as TaskStatus, optionalString(body, "actor") ?? "local-api", optionalString(body, "reason")));
  }
  const dispatchMatch = /^\/api\/control-room\/tasks\/([^/]+)\/dispatch$/.exec(url.pathname);
  if (method === "POST" && dispatchMatch?.[1]) {
    const body = await readBody(request); const selectedProvider = optionalString(body, "selectedProvider");
    if (selectedProvider && !providerNames.includes(selectedProvider as ProviderName)) throw new Error("Provedor invalido.");
    const actions = arrayOfStrings(body.requestedActions, "requestedActions") as TaskAction[];
    if (!actions.every((action) => taskActions.includes(action))) throw new Error("Acao de despacho invalida.");
    return json(response, 202, await service.dispatch(dispatchMatch[1], { selectedProvider: selectedProvider as ProviderName | null ?? null, reason: stringField(body, "reason"), candidates: [], requestedActions: actions }));
  }
  json(response, 404, { error: "Rota nao encontrada." });
}

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
function arrayOfStrings(value: unknown, name: string): string[] { if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`Campo obrigatorio: ${name}`); return value; }
function json(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify(body)); }

function assertSafeLocalRequest(request: IncomingMessage): void {
  if (!isLoopbackAddress(request.socket.remoteAddress) || !isLoopbackHost(request.headers.host)) {
    const error = new Error("A API local exige origem de rede e Host loopback.");
    (error as Error & { statusCode?: number }).statusCode = 403;
    throw error;
  }
  const origin = request.headers.origin;
  if (origin && !isLoopbackOrigin(origin)) {
    const error = new Error("Mutacoes locais exigem uma Origin loopback.");
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

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  try { return isLoopbackName(new URL(`http://${host}`).hostname); } catch { return false; }
}
function isLoopbackOrigin(origin: string): boolean {
  try { return isLoopbackName(new URL(origin).hostname); } catch { return false; }
}
function isLoopbackName(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}
function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
