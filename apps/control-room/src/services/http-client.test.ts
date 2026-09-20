import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpControlRoomClient } from "./http-client.js";

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
