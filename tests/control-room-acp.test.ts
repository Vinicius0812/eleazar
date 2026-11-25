import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRunRequest, RouteDecision } from "../src/core/contracts.js";
import { CodexAcpClient } from "../src/adapters/codex-acp.js";
import { ClaudeAcpClient } from "../src/adapters/claude-acp.js";
import { createLocalControlRoomService } from "../src/control-room/local-service.js";
import { ControlRoomTaskExecutor, type ControlRoomTaskRunner } from "../src/control-room/task-executor.js";
import { createControlRoomServer } from "../src/control-room/local-api.js";
import { SqliteControlRoomStore } from "../src/persistence/sqlite-control-room-store.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "eleazar-acp-backend-")); directories.push(directory);
  const path = join(directory, ".eleazar", "control-room.sqlite");
  const store = new SqliteControlRoomStore(path);
  return { store, path, service: createLocalControlRoomService(store) };
}
const route: RouteDecision = { selected: "codex", taskKind: "implementation", candidates: [
  { provider: "codex", score: 1, reasons: ["test"], health: { provider: "codex", available: true, authenticated: true, detail: "test" } }
] };
const acpInspector = { inspect: vi.fn(async () => ({ runtime: { path: "C:/codex.exe", version: "0.167", source: "desktop" },
  protocolVersion: 1, agentName: "codex-acp", capabilities: { loadSession: true }, sessionId: "catalog",
  configOptions: [{ id: "mode", category: "mode", name: "Mode", type: "select", currentValue: "workspace-write",
    options: [{ value: "read-only", name: "Read only" }, { value: "workspace-write", name: "Workspace write" },
      { value: "agent-full-access", name: "Full access" }] },
    { id: "model", category: "model", name: "Model", type: "select", currentValue: "default",
    options: [{ value: "default", name: "Default" }, { value: "gpt-test", name: "Test" }] }] })) } as unknown as CodexAcpClient;

function runner(run: ControlRoomTaskRunner["run"]): ControlRoomTaskRunner { return { router: { route: async () => route }, run }; }
function post(url: string, body: object) { return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
async function serve(service: ReturnType<typeof createLocalControlRoomService>, executor: ControlRoomTaskExecutor) {
  const server = createControlRoomServer(service, executor);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No address");
  return { base: `http://127.0.0.1:${address.port}/api/control-room`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("ACP Control Room backend", () => {
  it("serves provider-neutral catalogs for Codex and Claude", async () => {
    const { store, service } = await fixture();
    const project = service.registerProject({ name: "P", path: process.cwd() });
    const claudeInspector = { inspect: async () => ({ runtime: { path: "C:/claude.exe", version: "2.1.322", source: "user" },
      protocolVersion: 1, agentName: "claude-acp", capabilities: { loadSession: true }, sessionId: "catalog",
      configOptions: [{ id: "model", category: "model", name: "Model", type: "select", currentValue: "sonnet",
        options: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }] }] }) } as unknown as ClaudeAcpClient;
    const executor = new ControlRoomTaskExecutor(service, runner(async () => ({ route,
      result: { provider: "codex", status: "success", response: "ok", durationMs: 1 } })), undefined, acpInspector, claudeInspector);
    const api = await serve(service, executor);
    try {
      const id = project.directories[0]!.id;
      const codex = await (await fetch(`${api.base}/providers/codex/config?directoryId=${id}`)).json();
      const claude = await (await fetch(`${api.base}/providers/claude/config?directoryId=${id}`)).json();
      expect(codex).toMatchObject({ provider: "codex", capabilities: { loadSession: true } });
      expect(codex.models).toContainEqual(expect.objectContaining({ id: "gpt-test" }));
      expect(claude).toMatchObject({ provider: "claude", capabilities: { loadSession: true }, defaultModel: "sonnet" });
      expect(claude.models).toContainEqual(expect.objectContaining({ id: "opus" }));
    } finally { await api.close(); store.close(); }
  });
  it("resumes Claude only from the same provider and scope with advertised capability", async () => {
    const { store, service } = await fixture();
    const project = service.registerProject({ name: "P", path: process.cwd() });
    const first = service.createTask({ projectId: project.id, title: "First", prompt: "P" });
    const running = await service.dispatch(first.id, { selectedProvider: "codex", reason: "test", candidates: [], requestedActions: [] });
    const prior = store.listExecutions(first.id)[0]!;
    service.setExecutionMetadata(prior.id, running.dispatchLease!, "acp", null, "same-id");
    service.finishProviderRun(first.id, running.dispatchLease!, { provider: "codex", status: "success", response: "ok", durationMs: 1 });
    const next = service.createTask({ projectId: project.id, title: "Next", prompt: "P" });
    const claudeRoute: RouteDecision = { ...route, selected: "claude", candidates: [{ provider: "claude", score: 1, reasons: ["test"],
      health: { provider: "claude", available: true, authenticated: true, detail: "test" } }] };
    const claudeInspector = { inspect: async () => ({ runtime: { path: "C:/claude.exe", version: "2.1.322", source: "user" },
      protocolVersion: 1, agentName: "claude-acp", capabilities: { loadSession: true }, sessionId: "catalog", configOptions: [] }) } as unknown as ClaudeAcpClient;
    const run = vi.fn<ControlRoomTaskRunner["run"]>(async () => ({ route: claudeRoute,
      result: { provider: "claude", status: "success", response: "ok", durationMs: 1 } }));
    const fake: ControlRoomTaskRunner = { router: { route: async () => claudeRoute }, run };
    const executor = new ControlRoomTaskExecutor(service, fake, undefined, acpInspector, claudeInspector);
    await expect(executor.start(next.id, "claude", undefined, "same-id")).rejects.toThrow("nao pertence");
    expect(store.listExecutions(next.id)).toHaveLength(0);
    const claudeTask = service.createTask({ projectId: project.id, title: "Claude previous", prompt: "P" });
    const claudeRunning = await service.dispatch(claudeTask.id, { selectedProvider: "claude", reason: "test", candidates: [], requestedActions: [] });
    const claudePrior = store.listExecutions(claudeTask.id)[0]!;
    service.setExecutionMetadata(claudePrior.id, claudeRunning.dispatchLease!, "acp", null, "claude-id");
    service.finishProviderRun(claudeTask.id, claudeRunning.dispatchLease!, { provider: "claude", status: "success", response: "ok", durationMs: 1 });
    await executor.start(next.id, "claude", undefined, "claude-id");
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "claude-id" }), "claude"));
    await vi.waitFor(() => expect(store.getTask(next.id)?.status).toBe("completed"));
    store.close();
  });
  it("backfills legacy executions without losing their output", async () => {
    const { store, path, service } = await fixture();
    const project = service.registerProject({ name: "P", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "Legacy", prompt: "P" });
    const running = await service.dispatch(task.id, { selectedProvider: "codex", reason: "test", candidates: [], requestedActions: [] });
    const id = store.listExecutions(task.id)[0]!.id;
    service.finishProviderRun(task.id, running.dispatchLease!, { provider: "codex", status: "success", response: "old output", durationMs: 1 });
    store.close();
    const reopened = new SqliteControlRoomStore(path);
    expect(reopened.getExecution(id)).toMatchObject({ transport: "legacy", output: "old output", model: null, sessionId: null });
    expect(reopened.listExecutionEvents(id).at(-1)?.kind).toBe("completed");
    reopened.close();
  });

  it("recovers an older running row with no lease", async () => {
    const { store, path, service } = await fixture();
    const project = service.registerProject({ name: "P", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "Legacy active", prompt: "P" });
    store.updateTask({ ...task, status: "running", dispatchLease: null });
    store.createExecution({ id: "old-run", taskId: task.id, leaseId: null, provider: "codex", status: "running",
      startedAt: new Date().toISOString(), finishedAt: null, summary: null });
    store.close();
    const reopened = new SqliteControlRoomStore(path);
    expect(reopened.recoverInterruptedExecutions("restart")).toBe(1);
    expect(reopened.getTask(task.id)).toMatchObject({ status: "failed", dispatchLease: null });
    expect(reopened.getExecution("old-run")).toMatchObject({ status: "failed", transport: "legacy" });
    reopened.close();
  });

  it("persists ordered visible events, permissions, metadata and recovers a waiting lease without replay", async () => {
    const { store, path, service } = await fixture();
    const project = service.registerProject({ name: "P", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "T", prompt: "P" });
    const dispatched = await service.dispatch(task.id, { selectedProvider: "codex", reason: "test", candidates: [], requestedActions: [] });
    const execution = store.listExecutions(task.id)[0]!;
    service.setExecutionMetadata(execution.id, dispatched.dispatchLease!, "acp", "gpt-test");
    service.recordAgentUpdate(execution.id, dispatched.dispatchLease!, { sessionId: "session-1", kind: "session_ready", payload: {
      protocolVersion: 1, configOptions: [{ id: "model", currentValue: "gpt-test" }] } });
    service.recordAgentUpdate(execution.id, dispatched.dispatchLease!, { sessionId: "session-1", kind: "agent_thought_chunk", payload: { content: { text: "private thought" } } });
    service.recordAgentUpdate(execution.id, dispatched.dispatchLease!, { sessionId: "session-1", kind: "agent_message_chunk", payload: { content: { type: "text", text: "visible" } } });
    const permission = service.requestAgentPermission(execution.id, dispatched.dispatchLease!, { sessionId: "session-1", toolCallId: "tool-1", title: "Read", toolKind: "read",
      options: [{ id: "allow", name: "Allow", kind: "allow_once" }] })!;
    expect(store.getTask(task.id)).toMatchObject({ status: "waiting_approval", dispatchLease: dispatched.dispatchLease });
    expect(service.listExecutionEvents(execution.id).map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(JSON.stringify(service.executionDetail(execution.id))).not.toContain("private thought");
    expect(store.getExecution(execution.id)).toMatchObject({ transport: "acp", model: "gpt-test", sessionId: "session-1" });
    expect(store.getExecutionPermission(permission.id)?.status).toBe("pending");
    store.close();

    const reopened = new SqliteControlRoomStore(path);
    expect(reopened.recoverInterruptedExecutions("restart")).toBe(1);
    expect(reopened.recoverInterruptedExecutions("restart")).toBe(0);
    expect(reopened.getExecution(execution.id)).toMatchObject({ status: "failed", sessionId: "session-1", model: "gpt-test" });
    expect(reopened.getExecutionPermission(permission.id)?.status).toBe("cancelled");
    expect(reopened.getTask(task.id)).toMatchObject({ status: "failed", dispatchLease: null });
    const recovered = createLocalControlRoomService(reopened);
    expect(recovered.transitionTask(task.id, "queued").status).toBe("queued");
    const retry = await recovered.dispatch(task.id, { selectedProvider: "codex", reason: "manual retry", candidates: [], requestedActions: [] });
    const retryExecution = reopened.listExecutions(task.id)[0]!;
    recovered.setExecutionMetadata(retryExecution.id, retry.dispatchLease!, "acp", null);
    recovered.recordAgentUpdate(retryExecution.id, retry.dispatchLease!, { sessionId: "session-2", kind: "session_ready",
      payload: { configOptions: [{ id: "model", currentValue: "default-model" }] } });
    expect(reopened.getExecution(retryExecution.id)).toMatchObject({ model: "default-model", sessionId: "session-2" });
    recovered.finishProviderRun(task.id, retry.dispatchLease!, { provider: "codex", status: "success", response: "ok", durationMs: 1 });
    reopened.close();
  });

  it("records message boundaries and a bounded plan without free-form fields", async () => {
    const { store, service } = await fixture();
    const project = service.registerProject({ name: "P", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "T", prompt: "P" });
    const dispatched = await service.dispatch(task.id, { selectedProvider: "codex", reason: "test", candidates: [], requestedActions: [] });
    const execution = store.listExecutions(task.id)[0]!;
    const record = (kind: string, payload: Record<string, unknown>) =>
      service.recordAgentUpdate(execution.id, dispatched.dispatchLease!, { sessionId: "s1", kind, payload });
    record("agent_message_chunk", { messageId: "m1", content: { type: "text", text: "one" } });
    record("agent_message_chunk", { messageId: 7, content: { type: "text", text: "two" } });
    record("plan", { entries: [
      { content: "x".repeat(600), status: "in_progress", priority: "high", _meta: { secret: "hidden" } },
      { content: "  ", status: "pending" }, null, { content: "no status" }
    ] });
    record("plan", { entries: Array.from({ length: 60 }, (_, index) => ({ content: `step ${index}`, status: "pending" })) });
    record("plan", { entries: "invalid" });
    const events = service.listExecutionEvents(execution.id);
    expect(events.map((event) => event.kind)).toEqual(["agent_message_chunk", "agent_message_chunk", "plan", "plan"]);
    expect(events[0]!.payload).toEqual({ text: "one", messageId: "m1" });
    expect(events[1]!.payload).toEqual({ text: "two" });
    expect(events[2]!.payload).toEqual({ entries: [{ content: "x".repeat(500), status: "in_progress" }, { content: "no status", status: "pending" }] });
    expect(events[3]!.payload.entries).toHaveLength(50);
    expect(JSON.stringify(events)).not.toContain("hidden");
    store.close();
  });

  it("accepts model before dispatch, streams replay in order and resolves permission once", async () => {
    const { store, service } = await fixture();
    const project = service.registerProject({ name: "P", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "T", prompt: "P" });
    let seenRequest: AgentRunRequest | undefined;
    const fake = runner(async (request) => {
      seenRequest = request;
      request.onUpdate?.({ sessionId: "s1", kind: "session_ready", payload: { protocolVersion: 1,
        configOptions: [{ id: "model", category: "model", currentValue: request.model }] } });
      request.onUpdate?.({ sessionId: "s1", kind: "agent_message_chunk", payload: { content: { type: "text", text: "Hello" } } });
      const choice = await request.onPermission?.({ sessionId: "s1", toolCallId: "tool", title: "Read", toolKind: "read", options: [
        { id: "allow", name: "Allow", kind: "allow_once" }, { id: "deny", name: "Deny", kind: "reject_once" }] });
      return { route, result: { provider: "codex", status: "success", response: String(choice), durationMs: 1, sessionId: "s1" } };
    });
    const executor = new ControlRoomTaskExecutor(service, fake, undefined, acpInspector);
    const api = await serve(service, executor);
    try {
      const config = await (await fetch(`${api.base}/providers/codex/config?directoryId=${project.directories[0]!.id}`)).json();
      expect(config).toMatchObject({ defaultModel: "default", runtime: { path: "C:/codex.exe" } });
      expect(config.models).toHaveLength(2);
      expect(config.settings).toMatchObject([{ id: "mode", currentValue: "workspace-write" }, { id: "model", currentValue: "default" }]);
      expect(config.settings[0].options.map((option: { id: string }) => option.id)).toEqual(["read-only", "workspace-write"]);
      expect((await post(`${api.base}/tasks/${task.id}/execute`, { provider: "codex", model: "missing" })).status).toBe(400);
      expect(store.listExecutions(task.id)).toHaveLength(0);
      expect((await post(`${api.base}/tasks/${task.id}/execute`, { provider: "codex", model: "gpt-test" })).status).toBe(202);
      expect((await post(`${api.base}/tasks/${task.id}/execute`, { provider: "codex", model: "gpt-test" })).status).toBe(400);
      const execution = store.listExecutions(task.id)[0]!;
      await vi.waitFor(() => expect(store.listExecutionPermissions(execution.id)).toHaveLength(1));
      const permission = store.listExecutionPermissions(execution.id)[0]!;
      const path = `${api.base}/executions/${execution.id}`;
      const replay = await fetch(`${path}/events`, { headers: { "last-event-id": `${execution.id}:1` } });
      expect(replay.status).toBe(200);
      const reader = replay.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).not.toContain(`id: ${execution.id}:1\n`);
      const decision = await post(`${path}/permissions/${permission.id}`, { optionId: "allow" });
      expect(decision.status).toBe(200);
      expect((await post(`${path}/permissions/${permission.id}`, { optionId: "deny" })).status).toBe(409);
      await vi.waitFor(() => expect(store.getExecution(execution.id)?.status).toBe("completed"));
      const rest = await reader.read();
      expect(first + new TextDecoder().decode(rest.value)).toContain("permission_resolved");
      await reader.cancel().catch(() => {});
      await vi.waitFor(() => expect(executor.isActive(execution.id)).toBe(false));
      const all = await (await fetch(`${path}/events`)).text();
      expect(all).toContain(`id: ${execution.id}:1`);
      expect(all).toContain("event: completed");
      const ids = [...all.matchAll(/^id: (.+)$/gm)].map((match) => match[1]);
      expect(ids).toEqual(store.listExecutionEvents(execution.id).map((event) => event.id));
      const resumed = await (await fetch(`${path}/events`, { headers: { "last-event-id": `${execution.id}:2` } })).text();
      expect([...resumed.matchAll(/^id: (.+)$/gm)].map((match) => match[1])).toEqual(ids.slice(2));
      expect(store.getExecution(execution.id)).toMatchObject({ transport: "acp", model: "gpt-test", sessionId: "s1" });
      expect(service.snapshot().executions[0]).not.toHaveProperty("output");
      expect(service.executionDetail(execution.id)).toMatchObject({ events: expect.any(Array), permissions: [expect.objectContaining({ id: permission.id })] });
      expect(seenRequest).toMatchObject({ model: "gpt-test" });
      expect((await post(`${path}/permissions/${permission.id}`, { optionId: "allow" })).status).toBe(409);
      expect((await post(`${path}/cancel`, {})).status).toBe(409);
    } finally { await api.close(); store.close(); }
  });

  it("cancels an active permission and keeps cancellation ahead of late results", async () => {
    const { store, service } = await fixture();
    const project = service.registerProject({ name: "P", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "T", prompt: "P" });
    const fake = runner(async (request) => {
      await request.onPermission?.({ sessionId: "s1", toolCallId: "tool", title: "Read", options: [{ id: "deny", name: "Deny", kind: "reject_once" }] });
      return { route, result: { provider: "codex", status: "success", response: "late", durationMs: 1 } };
    });
    const executor = new ControlRoomTaskExecutor(service, fake, undefined, acpInspector);
    await executor.start(task.id, "codex");
    const execution = store.listExecutions(task.id)[0]!;
    await vi.waitFor(() => expect(store.listExecutionPermissions(execution.id)).toHaveLength(1));
    executor.cancel(execution.id);
    expect(store.getExecution(execution.id)?.status).toBe("cancelled");
    await vi.waitFor(() => expect(store.listExecutionEvents(execution.id).some((event) => event.kind === "cancelled")).toBe(true));
    expect(store.getTask(task.id)).toMatchObject({ status: "cancelled", dispatchLease: null });
    expect(store.listExecutionPermissions(execution.id)[0]?.status).toBe("cancelled");
    await expect(executor.start(task.id, "codex")).rejects.toThrow("Apenas tarefas na fila");
    await vi.waitFor(() => expect(executor.isActive(execution.id)).toBe(false));
    store.close();
  });

  it("keeps a multi-directory lease while permission waits and accepts only matching retries", async () => {
    const { store, service } = await fixture();
    const extra = await mkdtemp(join(tmpdir(), "eleazar-acp-scope-")); directories.push(extra);
    const project = service.registerProject({ name: "P", directories: [{ path: process.cwd() }, { path: extra }] });
    const task = service.createTask({ projectId: project.id, targetDirectoryId: project.directories[0]!.id,
      directoryIds: project.directories.map((item) => item.id), title: "T", prompt: "P" });
    service.transitionTask(task.id, "queued", "operator", "scope approved");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let seenRequest: AgentRunRequest | undefined;
    const fake = runner(async (request) => {
      seenRequest = request;
      await request.onPermission?.({ sessionId: "s1", toolCallId: "tool", title: "Read", toolKind: "read", options: [
        { id: "allow", name: "Allow", kind: "allow_once" }, { id: "deny", name: "Deny", kind: "reject_once" }] });
      await gate;
      return { route, result: { provider: "codex", status: "success", response: "done", durationMs: 1 } };
    });
    const executor = new ControlRoomTaskExecutor(service, fake, undefined, acpInspector);
    await executor.start(task.id, "codex");
    const execution = store.listExecutions(task.id)[0]!;
    await vi.waitFor(() => expect(store.listExecutionPermissions(execution.id)).toHaveLength(1));
    const permission = store.listExecutionPermissions(execution.id)[0]!;
    expect(seenRequest?.additionalDirectories).toEqual([extra]);
    expect(store.hasActiveDispatchForDirectories(project.directories.map((item) => item.id))).toBe(true);
    expect(() => executor.respondPermission(execution.id, permission.id, "allow")).not.toThrow();
    expect(() => executor.respondPermission(execution.id, permission.id, "allow")).not.toThrow();
    expect(() => executor.respondPermission(execution.id, permission.id, "deny")).toThrow();
    expect(store.listExecutionEvents(execution.id).filter((event) => event.kind === "permission_resolved")).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(store.getTask(task.id)?.status).toBe("completed"));
    expect(() => executor.respondPermission(execution.id, permission.id, "allow")).toThrow();
    await vi.waitFor(() => expect(executor.isActive(execution.id)).toBe(false));
    store.close();
  });

  it("releases SSE listeners when the client disconnects and permits Last-Event-ID preflight", async () => {
    const { store, service } = await fixture();
    const project = service.registerProject({ name: "P", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "T", prompt: "P" });
    const dispatched = await service.dispatch(task.id, { selectedProvider: "codex", reason: "test", candidates: [], requestedActions: [] });
    const execution = store.listExecutions(task.id)[0]!;
    const executor = new ControlRoomTaskExecutor(service, runner(async () => ({ route, result: { provider: "codex", status: "success", response: "ok", durationMs: 1 } })));
    let removed = false;
    const original = service.onExecutionEvent.bind(service);
    vi.spyOn(service, "onExecutionEvent").mockImplementation((id, listener) => {
      const off = original(id, listener);
      return () => { removed = true; off(); };
    });
    const api = await serve(service, executor);
    try {
      const preflight = await fetch(`${api.base}/executions/${execution.id}/events`, {
        method: "OPTIONS", headers: { origin: "http://127.0.0.1:5173", "access-control-request-headers": "last-event-id" }
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-headers")).toContain("last-event-id");
      const stream = await fetch(`${api.base}/executions/${execution.id}/events`);
      const reader = stream.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("connected");
      await reader.cancel();
      await vi.waitFor(() => expect(removed).toBe(true));
      service.recordAgentUpdate(execution.id, dispatched.dispatchLease!, { sessionId: "s1", kind: "agent_message_chunk", payload: { content: { type: "text", text: "after disconnect" } } });
      expect(service.listExecutionEvents(execution.id)).toHaveLength(1);
    } finally { await api.close(); store.close(); }
  });

  it("denies proven scope elevation and persistent permission, but accepts reject_once", async () => {
    const { store, service } = await fixture();
    const project = service.registerProject({ name: "P", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "T", prompt: "P" });
    const dispatched = await service.dispatch(task.id, { selectedProvider: "codex", reason: "test", candidates: [], requestedActions: [] });
    const execution = store.listExecutions(task.id)[0]!;
    const permission = service.requestAgentPermission(execution.id, dispatched.dispatchLease!, { sessionId: "s1", toolCallId: "tool", title: "Outside root",
      toolKind: "execute", requiresElevation: true, locations: ["C:/outside"], options: [
        { id: "once", name: "Once", kind: "allow_once" }, { id: "always", name: "Always", kind: "allow_always" },
        { id: "reject", name: "Reject", kind: "reject_once" }] })!;
    expect(() => service.decideAgentPermission(permission.id, "once")).toThrow("Elevacao");
    expect(() => service.decideAgentPermission(permission.id, "always")).toThrow("Elevacao");
    expect(service.decideAgentPermission(permission.id, "reject")).toMatchObject({ status: "selected", selectedOptionId: "reject" });
    expect(store.getTask(task.id)).toMatchObject({ status: "running", dispatchLease: dispatched.dispatchLease });
    store.close();
  });

  it("loads only a prior ACP session from the same project scope", async () => {
    const { store, service } = await fixture();
    const project = service.registerProject({ name: "P", path: process.cwd() });
    const first = service.createTask({ projectId: project.id, title: "First", prompt: "P" });
    const running = await service.dispatch(first.id, { selectedProvider: "codex", reason: "test", candidates: [], requestedActions: [] });
    const prior = store.listExecutions(first.id)[0]!;
    service.setExecutionMetadata(prior.id, running.dispatchLease!, "acp", "gpt-test", "owned-session");
    service.finishProviderRun(first.id, running.dispatchLease!, { provider: "codex", status: "success", response: "ok", durationMs: 1 });
    const next = service.createTask({ projectId: project.id, title: "Next", prompt: "P" });
    let requestSeen: AgentRunRequest | undefined;
    const fake = runner(async (request) => { requestSeen = request; return { route,
      result: { provider: "codex", status: "success", response: "ok", durationMs: 1 } }; });
    const executor = new ControlRoomTaskExecutor(service, fake, undefined, acpInspector);
    await expect(executor.start(next.id, "codex", undefined, "foreign-session")).rejects.toThrow("nao pertence");
    expect(store.listExecutions(next.id)).toHaveLength(0);
    await executor.start(next.id, "codex", undefined, "owned-session");
    const execution = store.listExecutions(next.id)[0]!;
    await vi.waitFor(() => expect(executor.isActive(execution.id)).toBe(false));
    expect(requestSeen?.sessionId).toBe("owned-session");
    store.close();
  });

  it("clears a pending permission when the provider times out", async () => {
    const { store, service } = await fixture();
    const project = service.registerProject({ name: "P", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "T", prompt: "P" });
    const fake = runner(async (request) => {
      void request.onPermission?.({ sessionId: "s1", toolCallId: "tool", title: "Read", options: [
        { id: "allow", name: "Allow", kind: "allow_once" }] });
      return { route, result: { provider: "codex", status: "error", response: "", error: "Tempo ACP esgotado", durationMs: 50 } };
    });
    const executor = new ControlRoomTaskExecutor(service, fake, undefined, acpInspector);
    await executor.start(task.id, "codex");
    const execution = store.listExecutions(task.id)[0]!;
    await vi.waitFor(() => expect(store.getTask(task.id)?.status).toBe("failed"));
    await vi.waitFor(() => expect(executor.isActive(execution.id)).toBe(false));
    expect(store.getTask(task.id)).toMatchObject({ status: "failed", dispatchLease: null });
    expect(store.getExecution(execution.id)).toMatchObject({ status: "failed" });
    expect(store.listExecutionPermissions(execution.id)[0]?.status).toBe("cancelled");
    expect(store.listExecutionEvents(execution.id).at(-1)?.kind).toBe("failed");
    store.close();
  });

  it("returns a clear unavailable response when the Codex catalog cannot initialize", async () => {
    const { store, service } = await fixture();
    const project = service.registerProject({ name: "P", path: process.cwd() });
    const unavailable = { inspect: async () => { throw new Error("runtime ausente"); } } as unknown as CodexAcpClient;
    const executor = new ControlRoomTaskExecutor(service, runner(async () => ({ route,
      result: { provider: "codex", status: "success", response: "ok", durationMs: 1 } })), undefined, unavailable);
    const api = await serve(service, executor);
    try {
      const response = await fetch(`${api.base}/providers/codex/config?directoryId=${project.directories[0]!.id}`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining("runtime ausente") });
    } finally { await api.close(); store.close(); }
  });
});
