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
