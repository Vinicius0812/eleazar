import { mkdtemp, readdir, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ControlRoomService, type WorktreeProvisioner } from "../src/core/control-room-service.js";
import type { ControlRoomTask, LocalProject } from "../src/core/control-room.js";
import { GitWorktreeProvisioner } from "../src/core/git-worktree-provisioner.js";
import { createControlRoomServer } from "../src/control-room/local-api.js";
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

  it("faz update e historico de transicao na mesma transacao SQLite", async () => {
    const { service, store } = await fixture();
    const project = service.registerProject({ name: "Core", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "Tarefa", prompt: "Planeje algo" });
    const planning = { ...task, status: "planning" as const, updatedAt: "2026-01-01T00:00:00.000Z" };
    store.transitionTask(planning, { id: "transition-id", taskId: task.id, fromStatus: "queued", toStatus: "planning", actor: "test", reason: null, createdAt: planning.updatedAt });
    const running = { ...planning, status: "running" as const, updatedAt: "2026-01-01T00:00:01.000Z" };
    expect(() => store.transitionTask(running, { id: "transition-id", taskId: task.id, fromStatus: "planning", toStatus: "running", actor: "test", reason: null, createdAt: running.updatedAt })).toThrow();
    expect(store.getTask(task.id)?.status).toBe("planning");
    expect(store.listTransitions(task.id)).toHaveLength(1);
    store.close();
  });
});

class FakeWorktrees implements WorktreeProvisioner {
  calls = 0;
  async prepare(_project: LocalProject, task: ControlRoomTask): Promise<string> { this.calls += 1; return `/isolated/${task.id}`; }
}

class BlockingWorktrees implements WorktreeProvisioner {
  calls = 0;
  #startedResolve!: () => void;
  #release!: () => void;
  readonly started = new Promise<void>((resolve) => { this.#startedResolve = resolve; });
  readonly released = new Promise<void>((resolve) => { this.#release = resolve; });
  async prepare(_project: LocalProject, task: ControlRoomTask): Promise<string> {
    this.calls += 1; this.#startedResolve(); await this.released; return `/isolated/${task.id}`;
  }
  release(): void { this.#release(); }
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

  it("reserva o despacho atomicamente e impede execucoes duplicadas", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eleazar-control-room-")); temporaryDirectories.push(directory);
    const store = new SqliteControlRoomStore(join(directory, ".eleazar", "control-room.sqlite"));
    const worktrees = new BlockingWorktrees(); const service = new ControlRoomService(store, worktrees);
    const project = service.registerProject({ name: "Core", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "Testar", prompt: "Teste a camada" });
    const first = service.dispatch(task.id, { selectedProvider: "codex", reason: "primeiro", candidates: [], requestedActions: ["create_worktree"] });
    await worktrees.started;
    await expect(service.dispatch(task.id, { selectedProvider: "codex", reason: "segundo", candidates: [], requestedActions: ["create_worktree"] })).rejects.toThrow("reservada");
    worktrees.release();
    expect((await first).status).toBe("running");
    expect(worktrees.calls).toBe(1);
    expect(store.listExecutions(task.id)).toHaveLength(1);
    store.close();
  });

  it("preserva cancelamento ocorrido durante prepare sem sobrescrever o estado", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eleazar-control-room-")); temporaryDirectories.push(directory);
    const store = new SqliteControlRoomStore(join(directory, ".eleazar", "control-room.sqlite"));
    const worktrees = new BlockingWorktrees(); const service = new ControlRoomService(store, worktrees);
    const project = service.registerProject({ name: "Core", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "Testar", prompt: "Teste a camada" });
    const dispatched = service.dispatch(task.id, { selectedProvider: "codex", reason: "isolado", candidates: [], requestedActions: ["create_worktree"] });
    await worktrees.started;
    service.transitionTask(task.id, "cancelled", "user", "cancelou");
    worktrees.release();
    expect((await dispatched).status).toBe("cancelled");
    expect(store.getTask(task.id)?.status).toBe("cancelled");
    expect(store.listExecutions(task.id)).toMatchObject([{ status: "cancelled" }]);
    store.close();
  });

  it("isola por create_worktree mesmo quando a classificacao nao e implementation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eleazar-control-room-")); temporaryDirectories.push(directory);
    const store = new SqliteControlRoomStore(join(directory, ".eleazar", "control-room.sqlite"));
    const worktrees = new FakeWorktrees(); const service = new ControlRoomService(store, worktrees);
    const project = service.registerProject({ name: "Core", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "Testar", prompt: "Teste a camada" });
    expect(task.kind).toBe("testing");
    const dispatched = await service.dispatch(task.id, { selectedProvider: "codex", reason: "isolado", candidates: [], requestedActions: ["create_worktree"] });
    expect(dispatched.worktreePath).toBe(`/isolated/${task.id}`);
    expect(worktrees.calls).toBe(1);
    store.close();
  });
});

describe("Git worktree isolation", () => {
  it("forca um hooksPath temporario e vazio para o subprocesso Git", async () => {
    const projectDirectory = await mkdtemp(join(tmpdir(), "eleazar-project-")); temporaryDirectories.push(projectDirectory);
    let seenArgs: readonly string[] = [];
    const provisioner = new GitWorktreeProvisioner(async (_cwd, args) => {
      seenArgs = args;
      const setting = args.find((item) => item.startsWith("core.hooksPath="));
      expect(setting).toBeDefined();
      expect(await readdir(setting!.slice("core.hooksPath=".length))).toEqual([]);
    });
    const task: ControlRoomTask = { id: "task-1", projectId: "project-1", title: "T", prompt: "P", priority: "normal", status: "planning", kind: "testing", worktreePath: null, createdAt: "now", updatedAt: "now" };
    await provisioner.prepare({ id: "project-1", name: "Project", path: projectDirectory, createdAt: "now" }, task);
    expect(seenArgs).toEqual(["-c", expect.stringMatching(/^core\.hooksPath=/), "worktree", "add", "--detach", join(projectDirectory, ".eleazar", "worktrees", task.id)]);
  });
});

describe("local Control Room API", () => {
  it("aceita JSON Unicode dividido entre chunks somente de host loopback", async () => {
    const { service, store } = await fixture();
    const server = createControlRoomServer(service);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Endereco ausente");
    const body = Buffer.from(JSON.stringify({ name: "Ação local", path: process.cwd() }));
    const split = body.indexOf(Buffer.from("ç")) + 1;
    const response = await send(address.port, "/api/control-room/projects", [body.subarray(0, split), body.subarray(split)], { "content-type": "application/json", origin: `http://127.0.0.1:${address.port}` });
    expect(response.status).toBe(201);
    expect(response.body.name).toBe("Ação local");
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  });

  it("recusa mutacoes sem host loopback ou Content-Type JSON", async () => {
    const { service, store } = await fixture();
    const server = createControlRoomServer(service);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Endereco ausente");
    expect((await send(address.port, "/api/control-room/projects", [Buffer.from("{}")], { host: "example.test", "content-type": "application/json" })).status).toBe(403);
    expect((await send(address.port, "/api/control-room/projects", [Buffer.from("{}")])).status).toBe(415);
    expect((await send(address.port, "/api/control-room/projects", [Buffer.from("{}")], { "content-type": "application/jsonp" })).status).toBe(415);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  });
});

function send(port: number, path: string, chunks: readonly Buffer[], headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path, method: "POST", headers }, (response) => {
      let text = ""; response.setEncoding("utf8"); response.on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> }));
    });
    request.once("error", reject); for (const chunk of chunks) request.write(chunk); request.end();
  });
}
