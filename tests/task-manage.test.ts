import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ControlRoomService } from "../src/core/control-room-service.js";
import { createControlRoomServer } from "../src/control-room/local-api.js";
import { SqliteControlRoomStore } from "../src/persistence/sqlite-control-room-store.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "eleazar-manage-")); temporaryDirectories.push(directory);
  const store = new SqliteControlRoomStore(join(directory, ".eleazar", "control-room.sqlite"));
  const service = new ControlRoomService(store, undefined, { useWorktrees: false });
  const project = service.registerProject({ name: "Core", path: process.cwd() });
  return { store, service, project };
}

describe("Fixar e excluir tarefas", () => {
  it("fixa e desafixa uma tarefa", async () => {
    const { store, service, project } = await fixture();
    const task = service.createTask({ projectId: project.id, title: "Fixa", prompt: "P" });
    expect(service.pinTask(task.id, true).pinnedAt).toEqual(expect.any(String));
    expect(store.getTask(task.id)?.pinnedAt).toEqual(expect.any(String));
    expect(service.pinTask(task.id, false).pinnedAt).toBeUndefined();
    store.close();
  });

  it("exclui a tarefa com todo o historico, mas nunca enquanto o agente trabalha", async () => {
    const { store, service, project } = await fixture();
    const task = service.createTask({ projectId: project.id, title: "Excluir", prompt: "P" });
    const other = service.createTask({ projectId: project.id, title: "Fica", prompt: "P" });
    const running = await service.dispatch(task.id, { selectedProvider: "codex", reason: "teste", candidates: [], requestedActions: [] });
    service.recordAgentUpdate(store.listExecutions(task.id)[0]!.id, running.dispatchLease!, { sessionId: "s", kind: "agent_message_chunk", payload: { content: { type: "text", text: "oi" } } });
    expect(() => service.deleteTask(task.id)).toThrow("em execucao");
    service.finishProviderRun(task.id, running.dispatchLease!, { provider: "codex", status: "success", response: "ok", durationMs: 1 });
    const execution = store.listExecutions(task.id)[0]!;

    const server = createControlRoomServer(service);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("Endereco ausente");
      const post = (path: string, body: object) => fetch(`http://127.0.0.1:${address.port}/api/control-room${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      expect((await post(`/tasks/${task.id}/pin`, { pinned: true })).status).toBe(200);
      expect((await post(`/tasks/${task.id}/delete`, {})).status).toBe(200);
      expect((await post(`/tasks/${task.id}/delete`, {})).status).toBe(400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(store.getTask(task.id)).toBeNull();
    expect(store.getExecution(execution.id)).toBeNull();
    expect(store.listExecutionEvents(execution.id)).toEqual([]);
    expect(store.listTransitions(task.id)).toEqual([]);
    expect(store.listTasks().map((item) => item.id)).toEqual([other.id]);
    store.close();
  });
});
