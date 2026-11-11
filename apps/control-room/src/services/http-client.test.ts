import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpControlRoomClient, createSseParser } from "./http-client.js";

const frame = (sequence: number, kind: string, payload: Record<string, unknown> = {}) => `id: run-1:${sequence}\nevent: ${kind}\ndata: ${JSON.stringify({ executionId: "run-1", sequence, id: `run-1:${sequence}`, kind, payload, createdAt: "2026-01-01T00:00:00.000Z" })}\n\n`;
function sseResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("HTTP Control Room client", () => {
  it("maps the persisted core snapshot and derives only real pending approvals", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      projects: [],
      tasks: [{ id: "task-1", projectId: "project-1", targetDirectoryId: "directory-1", directoryIds: ["directory-1", "directory-2"], usesWorktree: false, title: "Review", prompt: "Inspect", priority: "critical", status: "waiting_approval", kind: "review", worktreePath: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
      executions: [], logs: []
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const snapshot = await createHttpControlRoomClient("http://127.0.0.1:4317/api/control-room").getSnapshot();
    expect(snapshot.approvals).toMatchObject([{ taskId: "task-1", action: "Liberar para a fila ou cancelar tarefa" }]);
    expect(snapshot.alerts).toHaveLength(1);
  });

  it("does not count a leased ACP decision as scope approval, including legacy snapshots without a lease field", async () => {
    const base = { projectId: "p", targetDirectoryId: "d", directoryIds: ["d"], usesWorktree: false, title: "T", prompt: "P", priority: "normal", status: "waiting_approval", kind: "implementation", worktreePath: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const run = (taskId: string) => ({ id: `run-${taskId}`, taskId, provider: "codex", status: "running", startedAt: null, finishedAt: null, summary: null });
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      projects: [], logs: [],
      tasks: [{ ...base, id: "acp", dispatchLease: "lease" }, { ...base, id: "legacy-acp" }, { ...base, id: "scope", dispatchLease: null }, { ...base, id: "scope-legacy" }],
      executions: [run("acp"), run("legacy-acp")]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const snapshot = await createHttpControlRoomClient("http://127.0.0.1:4317/api/control-room").getSnapshot();
    expect(snapshot.approvals.map((approval) => approval.taskId)).toEqual(["scope", "scope-legacy"]);
  });

  it("uses the transition API for a local operator decision", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await createHttpControlRoomClient("http://127.0.0.1:4317/api/control-room").decideApproval("task 1", "approve");
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:4317/api/control-room/tasks/task%201/transition", expect.objectContaining({ method: "POST", body: expect.stringContaining("queued") }));
  });

  it("reenqueues a failed task through the same guarded transition API", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await createHttpControlRoomClient("http://127.0.0.1:4317/api/control-room").retryTask("task 1");
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:4317/api/control-room/tasks/task%201/transition", expect.objectContaining({ method: "POST", body: expect.stringContaining("reenfileirada") }));
  });

  it("starts an explicit provider run through the local execute endpoint", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "task-1", status: "running" }), { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    await createHttpControlRoomClient("http://127.0.0.1:4317/api/control-room").executeTask("task 1", "codex");
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:4317/api/control-room/tasks/task%201/execute", expect.objectContaining({ method: "POST", body: JSON.stringify({ provider: "codex" }) }));
  });

  it("loads a detailed execution only when its result page is opened", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ execution: { id: "run 1" }, task: {}, project: {}, logs: [], files: [], history: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await createHttpControlRoomClient("http://127.0.0.1:4317/api/control-room").getExecutionDetail("run 1");
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:4317/api/control-room/executions/run%201", expect.any(Object));
  });

  it("reads provider capacity through the dedicated local endpoint", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ provider: "codex", available: true, authenticated: true, version: "test", detail: "ok", fetchedAt: "2026-01-01T00:00:00.000Z", usage: { source: "codex_account", usedPercent: 20, resetAt: "2026-01-01T01:00:00.000Z", windowDurationMins: 300, totalTokens: null, lifetimeTokens: null, todayTokens: null } }]), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const statuses = await createHttpControlRoomClient("http://127.0.0.1:4317/api/control-room").getProviderStatuses(true);
    expect(statuses[0]).toMatchObject({ provider: "codex", usage: { usedPercent: 20 } });
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:4317/api/control-room/providers/status?refresh=true", expect.any(Object));
  });

  it("turns persisted provider failures into actionable dashboard alerts", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      projects: [], tasks: [], logs: [],
      executions: [{ id: "run-1", taskId: "task-1", provider: "codex", status: "failed", startedAt: null, finishedAt: null, summary: '{"detail":"Atualize o Codex"}' }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const snapshot = await createHttpControlRoomClient("http://127.0.0.1:4317/api/control-room").getSnapshot();
    expect(snapshot.alerts).toMatchObject([{ level: "error", title: "Execucao falhou no codex", message: "Atualize o Codex" }]);
  });

  it("parses frames split at any chunk boundary, ignoring comments and malformed data", () => {
    const text = `: connected\n\n${frame(1, "agent_message_chunk", { text: "olá" })}data: {nao json}\n\n${frame(2, "completed")}`.replace(/\n/g, "\r\n");
    const parser = createSseParser();
    const received = [...text].flatMap((character) => parser.push(character));
    expect(received.map((item) => item.id)).toEqual(["run-1:1", "run-1:2"]);
    expect(received[0]?.payload).toEqual({ text: "olá" });
    expect(createSseParser().push(frame(1, "tool_call").slice(0, -1))).toEqual([]);
  });

  it("streams events with Last-Event-ID, reports a terminal close and surfaces HTTP errors", async () => {
    const whole = frame(2, "agent_message_chunk", { text: "x" }) + frame(3, "completed");
    const fetch = vi.fn()
      .mockResolvedValueOnce(sseResponse([whole.slice(0, 20), whole.slice(20)]))
      .mockResolvedValueOnce(sseResponse([": heartbeat\n\n"]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Execucao nao encontrada." }), { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    const client = createHttpControlRoomClient("http://127.0.0.1:4317/api/control-room");
    const seen: string[] = [];
    const controller = new AbortController();
    expect(await client.streamExecutionEvents("run 1", { afterId: "run 1:1", signal: controller.signal, onEvent: (item) => seen.push(item.id) })).toBe(true);
    expect(seen).toEqual(["run-1:2", "run-1:3"]);
    expect(fetch).toHaveBeenNthCalledWith(1, "http://127.0.0.1:4317/api/control-room/executions/run%201/events", expect.objectContaining({ signal: controller.signal, headers: expect.objectContaining({ "last-event-id": "run 1:1", accept: "text/event-stream" }) }));
    expect(await client.streamExecutionEvents("run-1", { signal: controller.signal, onEvent: () => undefined })).toBe(false);
    await expect(client.streamExecutionEvents("missing", { signal: controller.signal, onEvent: () => undefined })).rejects.toThrow("Execucao nao encontrada.");
  });

  it("sends the chosen model, cancel and permission decisions, and reads the Codex catalog", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const client = createHttpControlRoomClient("http://127.0.0.1:4317/api/control-room");
    await client.executeTask("t1", "codex", { model: "gpt-x" });
    await client.cancelExecution("run 1");
    await client.respondPermission("run 1", "perm/1", "allow");
    await client.getCodexConfig("dir 1");
    expect(fetch).toHaveBeenNthCalledWith(1, expect.stringContaining("/tasks/t1/execute"), expect.objectContaining({ body: JSON.stringify({ provider: "codex", model: "gpt-x" }) }));
    expect(fetch).toHaveBeenNthCalledWith(2, expect.stringContaining("/executions/run%201/cancel"), expect.objectContaining({ method: "POST", body: "{}" }));
    expect(fetch).toHaveBeenNthCalledWith(3, expect.stringContaining("/executions/run%201/permissions/perm%2F1"), expect.objectContaining({ body: JSON.stringify({ optionId: "allow" }) }));
    expect(fetch).toHaveBeenNthCalledWith(4, expect.stringContaining("/providers/codex/config?directoryId=dir%201"), expect.any(Object));
  });

  it("sends directory collections and an explicit task target without importing host contracts", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "project-1" }), { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    const client = createHttpControlRoomClient("http://127.0.0.1:4317/api/control-room");
    await client.registerProject({ name: "Produto", directories: [{ name: "API", path: "C:\\produto-api" }, { name: "Web", path: "C:\\produto-web" }] });
    await client.createTask({ projectId: "project-1", targetDirectoryId: "directory-web", directoryIds: ["directory-web"], title: "Tela", prompt: "Implemente", priority: "normal" });
    expect(fetch).toHaveBeenNthCalledWith(1, expect.stringContaining("/projects"), expect.objectContaining({ body: expect.stringContaining("directories") }));
    expect(fetch).toHaveBeenNthCalledWith(2, expect.stringContaining("/tasks"), expect.objectContaining({ body: expect.stringContaining("directoryIds") }));
  });
});
