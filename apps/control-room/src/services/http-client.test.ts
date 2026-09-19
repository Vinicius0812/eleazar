import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpControlRoomClient } from "./http-client.js";

afterEach(() => vi.unstubAllGlobals());

describe("HTTP Control Room client", () => {
  it("maps the persisted core snapshot and derives only real pending approvals", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      projects: [],
      tasks: [{ id: "task-1", projectId: "project-1", title: "Review", prompt: "Inspect", priority: "critical", status: "waiting_approval", kind: "review", worktreePath: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
      executions: [], logs: []
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const snapshot = await createHttpControlRoomClient("http://127.0.0.1:4317/api/control-room").getSnapshot();
    expect(snapshot.approvals).toMatchObject([{ taskId: "task-1", action: "Retomar planejamento ou cancelar tarefa" }]);
    expect(snapshot.alerts).toHaveLength(1);
  });

  it("uses the transition API for a local operator decision", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await createHttpControlRoomClient("http://127.0.0.1:4317/api/control-room").decideApproval("task 1", "reject");
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:4317/api/control-room/tasks/task%201/transition", expect.objectContaining({ method: "POST" }));
  });
});
