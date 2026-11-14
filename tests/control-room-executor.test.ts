import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRunRequest, ProviderName, RouteDecision } from "../src/core/contracts.js";
import type { OrchestratorRun } from "../src/core/orchestrator.js";
import { GitChangeCollector } from "../src/control-room/git-change-collector.js";
import { createControlRoomServer } from "../src/control-room/local-api.js";
import { ControlRoomTaskExecutor, type ControlRoomTaskRunner } from "../src/control-room/task-executor.js";
import { createLocalControlRoomService } from "../src/control-room/local-service.js";
import { SqliteControlRoomStore } from "../src/persistence/sqlite-control-room-store.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("Control Room task executor", () => {
  it("inicia somente uma tarefa na fila e persiste o resultado do provedor", async () => {
    const { service, store } = await fixture();
    const project = service.registerProject({ name: "Core", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "Analisar", prompt: "Planeje a proxima etapa" });
    const runner = fakeRunner({ provider: "codex", status: "success", response: "Plano concluido.", durationMs: 125 });
    const executor = new ControlRoomTaskExecutor(service, runner);

    const started = await executor.start(task.id, "codex");
    expect(started).toMatchObject({ status: "running", dispatchLease: expect.any(String) });
    await settle();

    expect(store.getTask(task.id)).toMatchObject({ status: "completed", dispatchLease: null });
    expect(store.listExecutions(task.id)).toMatchObject([{ provider: "codex", status: "completed", summary: "Plano concluido." }]);
    expect(store.listLogs(store.listExecutions(task.id)[0]!.id)).toMatchObject([{ level: "info", message: expect.stringContaining("125 ms") }]);
    store.close();
  });

  it("registra uma falha do provedor e libera o bloqueio persistido", async () => {
    const { service, store } = await fixture();
    const project = service.registerProject({ name: "Core", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "Analisar", prompt: "Planeje a proxima etapa" });
    const executor = new ControlRoomTaskExecutor(service, fakeRunner({ provider: "codex", status: "error", response: "", error: "CLI indisponivel", durationMs: 42 }));

    await executor.start(task.id);
    await settle();

    expect(store.getTask(task.id)).toMatchObject({ status: "failed", dispatchLease: null });
    expect(store.listExecutions(task.id)).toMatchObject([{ status: "failed", summary: "CLI indisponivel" }]);
    expect(store.listLogs(store.listExecutions(task.id)[0]!.id)).toMatchObject([{ level: "error", message: expect.stringContaining("falhou") }]);
    store.close();
  });

  it("nao inicia uma tarefa que ainda aguarda aprovacao", async () => {
    const { service, store } = await fixture();
    const extra = await mkdtemp(join(tmpdir(), "eleazar-control-room-scope-")); temporaryDirectories.push(extra);
    const project = service.registerProject({ name: "Core", directories: [{ path: process.cwd() }, { path: extra }] });
    const task = service.createTask({ projectId: project.id, targetDirectoryId: project.directories[0]!.id, directoryIds: project.directories.map((directory) => directory.id), title: "Analisar", prompt: "Planeje a proxima etapa" });

    const executor = new ControlRoomTaskExecutor(service, fakeRunner({ provider: "codex", status: "success", response: "ok", durationMs: 1 }));
    await expect(executor.start(task.id)).rejects.toThrow("precisa ser aprovada");
    await expect(executor.start(task.id, "claude")).rejects.toThrow("precisa ser aprovada");
    expect(store.getTask(task.id)?.status).toBe("waiting_approval");
    store.close();
  });

  it("aceita Claude ACP em execute e coleta arquivos do checkout", async () => {
    const { service, store } = await fixture();
    const project = service.registerProject({ name: "Core", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, kind: "planning", title: "Comunicação", prompt: "Responda OK" });
    const runner = fakeRunner({ provider: "claude", status: "success", response: "OK", durationMs: 1 });
    const run = vi.spyOn(runner, "run");
    const changes = new GitChangeCollector();
    const capture = vi.spyOn(changes, "capture");
    const executor = new ControlRoomTaskExecutor(service, runner, changes);
    const server = createControlRoomServer(service, executor);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Endereço local indisponível");
      const endpoint = `http://127.0.0.1:${address.port}/api/control-room/tasks/${task.id}`;
      const post = (action: string, body: object) => fetch(`${endpoint}/${action}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
      });
      expect((await post("dispatch", { selectedProvider: "claude", reason: "teste", requestedActions: ["read_project"] })).status).toBe(400);
      const response = await post("execute", { provider: "claude" });
      expect(response.status).toBe(202);
      await response.json();
      await vi.waitFor(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({ taskKind: "planning", prompt: expect.stringContaining("Responda OK"), additionalDirectories: [] }), "claude"));
      expect(capture).toHaveBeenCalled();
      await vi.waitFor(() => expect(store.listExecutions(task.id)).toMatchObject([{ provider: "claude", transport: "acp", status: "completed", summary: "OK" }]));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    }
  });

  it("mantém a tarefa na fila quando a autenticação impede escolher Claude", async () => {
    const { service, store } = await fixture();
    try {
      const project = service.registerProject({ name: "Core", path: process.cwd() });
      const incompatible = service.createTask({ projectId: project.id, kind: "implementation", title: "Implementação", prompt: "Implemente a mudança." });
      const compatible = service.createTask({ projectId: project.id, kind: "review", title: "Revisão", prompt: "Revise o texto." });
      const route = vi.fn<ControlRoomTaskRunner["router"]["route"]>().mockResolvedValue({ selected: null, taskKind: "review", candidates: [] });
      const runner = { router: { route }, run: vi.fn<ControlRoomTaskRunner["run"]>() };
      const executor = new ControlRoomTaskExecutor(service, runner);

      await expect(executor.start(incompatible.id, "claude")).rejects.toThrow("instalado e autenticado");
      await expect(executor.start(compatible.id, "claude")).rejects.toThrow("instalado e autenticado");
      expect(runner.run).not.toHaveBeenCalled();
      for (const task of [incompatible, compatible]) {
        expect(store.getTask(task.id)).toMatchObject({ status: "queued", dispatchLease: null });
        expect(store.listExecutions(task.id)).toHaveLength(0);
      }
    } finally {
      store.close();
    }
  });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "eleazar-control-room-executor-"));
  temporaryDirectories.push(directory);
  const store = new SqliteControlRoomStore(join(directory, ".eleazar", "control-room.sqlite"));
  return { store, service: createLocalControlRoomService(store) };
}

function fakeRunner(result: OrchestratorRun["result"]): ControlRoomTaskRunner {
  const route: RouteDecision = {
    taskKind: "planning",
    selected: result.provider,
    candidates: [{ provider: result.provider, score: 100, reasons: ["teste"], health: { provider: result.provider, available: true, authenticated: true, detail: "teste" } }]
  };
  return {
    router: { route: async () => route },
    run: async (_request: AgentRunRequest, _preferredProvider?: ProviderName) => ({ route, result })
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
}
