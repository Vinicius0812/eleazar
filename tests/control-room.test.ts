import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ControlRoomService, type WorktreeProvisioner } from "../src/core/control-room-service.js";
import type { ControlRoomTask, LocalProject } from "../src/core/control-room.js";
import { SqliteControlRoomStore } from "../src/persistence/sqlite-control-room-store.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture(): Promise<{ service: ControlRoomService; store: SqliteControlRoomStore }> {
  const directory = await mkdtemp(join(tmpdir(), "eleazar-control-room-"));
  temporaryDirectories.push(directory);
  const store = new SqliteControlRoomStore(join(directory, ".eleazar", "control-room.sqlite"));
  return { store, service: new ControlRoomService(store) };
}

describe("Control Room SQLite persistence", () => {
  it("persiste projetos, tarefas e historico de transicoes", async () => {
    const { service, store } = await fixture();
    const project = service.registerProject({ name: "Core", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "Planejar", prompt: "Planeje a arquitetura", priority: "high" });
    service.transitionTask(task.id, "planning", "teste", "inicio do planejamento");

    expect(store.getProject(project.id)).toMatchObject({ name: "Core", path: process.cwd() });
    expect(store.getTask(task.id)).toMatchObject({ status: "planning", priority: "high" });
    expect(store.listTransitions(task.id)).toMatchObject([{ fromStatus: "queued", toStatus: "planning", actor: "teste" }]);
    store.close();
  });

  it("rejeita transicoes fora da maquina de estados", async () => {
    const { service, store } = await fixture();
    const project = service.registerProject({ name: "Core", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "Tarefa", prompt: "Planeje algo" });
    expect(() => service.transitionTask(task.id, "completed")).toThrow("Transicao invalida");
    store.close();
  });
});

class FakeWorktrees implements WorktreeProvisioner {
  calls = 0;
  async prepare(_project: LocalProject, task: ControlRoomTask): Promise<string> { this.calls += 1; return `/isolated/${task.id}`; }
}

describe("safe delegation dispatch", () => {
  it("registra a decisao e prepara worktree isolada para implementacao", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eleazar-control-room-")); temporaryDirectories.push(directory);
    const store = new SqliteControlRoomStore(join(directory, ".eleazar", "control-room.sqlite"));
    const worktrees = new FakeWorktrees(); const service = new ControlRoomService(store, worktrees);
    const project = service.registerProject({ name: "Core", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "Implementar", prompt: "Implemente a camada local" });

    const dispatched = await service.dispatch(task.id, { selectedProvider: "codex", reason: "afinidade", candidates: [{ provider: "codex", score: 90, reasons: ["implementacao"] }], requestedActions: ["create_worktree", "run_tests"] });
    expect(dispatched.status).toBe("running");
    expect(dispatched.worktreePath).toBe(`/isolated/${task.id}`);
    expect(worktrees.calls).toBe(1);
    expect(store.listDelegations(task.id)).toMatchObject([{ selectedProvider: "codex", requestedActions: ["create_worktree", "run_tests"] }]);
    expect(store.listExecutions(task.id)).toMatchObject([{ status: "running", provider: "codex" }]);
    store.close();
  });

  it("bloqueia push, merge e deploy antes de provisionar ou persistir um despacho", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eleazar-control-room-")); temporaryDirectories.push(directory);
    const store = new SqliteControlRoomStore(join(directory, ".eleazar", "control-room.sqlite"));
    const worktrees = new FakeWorktrees(); const service = new ControlRoomService(store, worktrees);
    const project = service.registerProject({ name: "Core", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "Implementar", prompt: "Implemente a camada local" });

    await expect(service.dispatch(task.id, { selectedProvider: "codex", reason: "nao autorizado", candidates: [], requestedActions: ["push"] })).rejects.toThrow("requer aprovacao");
    expect(worktrees.calls).toBe(0);
    expect(store.getTask(task.id)?.status).toBe("queued");
    expect(store.listDelegations(task.id)).toEqual([]);
    store.close();
  });

  it("recusa acoes nao reconhecidas", async () => {
    const { service, store } = await fixture();
    const project = service.registerProject({ name: "Core", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "Planejar", prompt: "Planeje a camada" });
    await expect(service.dispatch(task.id, { selectedProvider: "codex", reason: "invalida", candidates: [], requestedActions: ["shell" as never] })).rejects.toThrow("desconhecida");
    expect(store.getTask(task.id)?.status).toBe("queued");
    store.close();
  });
});
