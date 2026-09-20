import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { afterEach, describe, expect, it } from "vitest";

import { ControlRoomService, type WorktreeProvisioner } from "../src/core/control-room-service.js";
import type { ControlRoomTask, DispatchAttempt, LocalProject, TaskExecution } from "../src/core/control-room.js";
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
  it("permite cleanup idempotente do store", async () => {
    const { store } = await fixture();
    expect(() => {
      store.close();
      store.close();
    }).not.toThrow();
  });

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
    store.transitionTask(planning, { id: "transition-id", taskId: task.id, fromStatus: "queued", fromDispatchLease: null, toStatus: "planning", actor: "test", reason: null, createdAt: planning.updatedAt });
    const running = { ...planning, status: "running" as const, updatedAt: "2026-01-01T00:00:01.000Z" };
    expect(() => store.transitionTask(running, { id: "transition-id", taskId: task.id, fromStatus: "planning", fromDispatchLease: null, toStatus: "running", actor: "test", reason: null, createdAt: running.updatedAt })).toThrow();
    expect(store.getTask(task.id)?.status).toBe("planning");
    expect(store.listTransitions(task.id)).toHaveLength(1);
    store.close();
  });

  it("nao sobrescreve cancelamento concorrente com snapshot obsoleto de outra conexao", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eleazar-control-room-")); temporaryDirectories.push(directory);
    const first = new SqliteControlRoomStore(join(directory, ".eleazar", "control-room.sqlite"));
    const second = new SqliteControlRoomStore(join(directory, ".eleazar", "control-room.sqlite"));
    const service = new ControlRoomService(first);
    const project = service.registerProject({ name: "Core", path: process.cwd() });
    const created = service.createTask({ projectId: project.id, title: "Tarefa", prompt: "Planeje algo" });
    const planning = service.transitionTask(created.id, "planning");
    const stale = first.getTask(created.id)!;
    const cancelled = { ...second.getTask(created.id)!, status: "cancelled" as const, dispatchLease: null, updatedAt: "2026-01-01T00:00:00.000Z" };
    expect(second.transitionTask(cancelled, { id: "cancel", taskId: created.id, fromStatus: "planning", fromDispatchLease: null, toStatus: "cancelled", actor: "test", reason: null, createdAt: cancelled.updatedAt })?.status).toBe("cancelled");
    const obsolete = { ...stale, status: "running" as const, updatedAt: "2026-01-01T00:00:01.000Z" };
    expect(first.transitionTask(obsolete, { id: "stale", taskId: created.id, fromStatus: planning.status, fromDispatchLease: stale.dispatchLease, toStatus: "running", actor: "test", reason: null, createdAt: obsolete.updatedAt })).toBeNull();
    expect(first.getTask(created.id)?.status).toBe("cancelled");
    first.close(); second.close();
  });

  it("rejeita transicao generica de lease antigo quando uma nova reserva ainda esta em planning", async () => {
    const { service, store } = await fixture();
    const project = service.registerProject({ name: "Core", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "Tarefa", prompt: "Planeje algo" });
    const oldAttempt = dispatchAttempt(task.id, "old-lease", "old-decision", "old-execution");
    const reserved = store.claimDispatch(task.id, oldAttempt)!;
    const stale = { ...reserved, status: "cancelled" as const, dispatchLease: null, updatedAt: "2026-01-01T00:00:01.000Z" };
    expect(store.transitionTask({ ...reserved, status: "queued", dispatchLease: null, updatedAt: "2026-01-01T00:00:00.000Z" }, { id: "requeue", taskId: task.id, fromStatus: "planning", fromDispatchLease: "old-lease", toStatus: "queued", actor: "test", reason: null, createdAt: "2026-01-01T00:00:00.000Z" })?.status).toBe("queued");
    const newAttempt = dispatchAttempt(task.id, "new-lease", "new-decision", "new-execution");
    expect(store.claimDispatch(task.id, newAttempt)?.dispatchLease).toBe("new-lease");
    expect(store.transitionTask(stale, { id: "stale", taskId: task.id, fromStatus: "planning", fromDispatchLease: "old-lease", toStatus: "cancelled", actor: "test", reason: null, createdAt: stale.updatedAt })).toBeNull();
    expect(store.getTask(task.id)).toMatchObject({ status: "planning", dispatchLease: "new-lease" });
    store.close();
  });

  it("migra um projeto legado de path unico para seu primeiro diretorio sem perder tarefas", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eleazar-legacy-")); temporaryDirectories.push(directory);
    const databasePath = join(directory, "control-room.sqlite");
    const legacy = new Database(databasePath);
    legacy.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL, priority TEXT NOT NULL, status TEXT NOT NULL, kind TEXT NOT NULL, worktree_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE executions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, provider TEXT, status TEXT NOT NULL, started_at TEXT, finished_at TEXT, summary TEXT);
      CREATE TABLE execution_logs (id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE delegation_decisions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, selected_provider TEXT, reason TEXT NOT NULL, candidates_json TEXT NOT NULL, actions_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE task_transitions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, from_status TEXT NOT NULL, to_status TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL);`);
    legacy.prepare("INSERT INTO projects VALUES (?, ?, ?, ?)").run("legacy-project", "Legado", process.cwd(), "2026-01-01T00:00:00.000Z");
    legacy.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("legacy-task", "legacy-project", "Tarefa", "Prompt", "normal", "queued", "planning", null, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    legacy.close();
    const store = new SqliteControlRoomStore(databasePath);
    expect(store.getProject("legacy-project")).toMatchObject({ path: process.cwd(), directories: [{ id: "legacy-legacy-project", path: process.cwd(), name: "Legado" }] });
    expect(store.getTask("legacy-task")?.targetDirectoryId).toBe("legacy-legacy-project");
    store.close();
  });

  it("registra diretorios ordenados, rejeita invalidos ou duplicados e vincula a tarefa ao alvo escolhido", async () => {
    const { service, store } = await fixture();
    const extra = await mkdtemp(join(tmpdir(), "eleazar-directory-")); temporaryDirectories.push(extra);
    const project = service.registerProject({ name: "Composto", directories: [{ name: "Núcleo", path: process.cwd() }, { name: "Web", path: extra }] });
    expect(project.directories.map((directory) => directory.name)).toEqual(["Núcleo", "Web"]);
    const task = service.createTask({ projectId: project.id, targetDirectoryId: project.directories[1]!.id, title: "Interface", prompt: "Implemente a interface" });
    expect(task.targetDirectoryId).toBe(project.directories[1]!.id);
    expect(() => service.registerProject({ name: "Duplicado", directories: [{ path: process.cwd() }, { path: process.cwd() }] })).toThrow("duplicados");
    expect(() => service.registerProject({ name: "Invalido", directories: [{ path: join(extra, "ausente") }] })).toThrow("nao existe");
    store.close();
  });

  it("permite despacho de escopo unico em qualquer diretorio de projeto composto", async () => {
    const { store } = await fixture();
    const service = new ControlRoomService(store, undefined, { useWorktrees: false });
    const extra = await mkdtemp(join(tmpdir(), "eleazar-directory-")); temporaryDirectories.push(extra);
    const project = service.registerProject({ name: "Composto", directories: [{ path: process.cwd() }, { path: extra }] });
    const task = service.createTask({ projectId: project.id, title: "Coordene", prompt: "Planeje a integracao" });
    await expect(service.dispatch(task.id, { selectedProvider: "codex", reason: "teste", candidates: [], requestedActions: [] })).resolves.toMatchObject({ status: "running", usesWorktree: false });
    expect(store.listExecutions(task.id)).toMatchObject([{ status: "running" }]);
    store.close();
  });

  it("bloqueia despachos diretos concorrentes no mesmo diretorio, mas permite diretorios distintos", async () => {
    const { service, store } = await fixture();
    const extra = await mkdtemp(join(tmpdir(), "eleazar-directory-")); temporaryDirectories.push(extra);
    const project = service.registerProject({ name: "Composto", directories: [{ path: process.cwd() }, { path: extra }] });
    const first = service.createTask({ projectId: project.id, targetDirectoryId: project.directories[0]!.id, title: "A", prompt: "Planeje A" });
    const same = service.createTask({ projectId: project.id, targetDirectoryId: project.directories[0]!.id, title: "B", prompt: "Planeje B" });
    const other = service.createTask({ projectId: project.id, targetDirectoryId: project.directories[1]!.id, title: "C", prompt: "Planeje C" });
    expect(store.claimDispatch(first.id, dispatchAttempt(first.id, "lease-a", "decision-a", "execution-a"))).not.toBeNull();
    expect(store.claimDispatch(same.id, dispatchAttempt(same.id, "lease-b", "decision-b", "execution-b"))).toBeNull();
    expect(store.claimDispatch(other.id, dispatchAttempt(other.id, "lease-c", "decision-c", "execution-c"))).not.toBeNull();
    store.close();
  });

  it("no modo sem worktrees nao depende de provisionador e serializa o mesmo diretorio", async () => {
    const { store } = await fixture();
    const worktrees = new FakeWorktrees();
    const service = new ControlRoomService(store, worktrees, { useWorktrees: false });
    const project = service.registerProject({ name: "Direto", path: process.cwd() });
    const first = service.createTask({ projectId: project.id, title: "A", prompt: "Planeje A" });
    const second = service.createTask({ projectId: project.id, title: "B", prompt: "Planeje B" });
    await expect(service.dispatch(first.id, { selectedProvider: "codex", reason: "direto", candidates: [], requestedActions: [] })).resolves.toMatchObject({ status: "running", worktreePath: null });
    await expect(service.dispatch(second.id, { selectedProvider: "codex", reason: "direto", candidates: [], requestedActions: [] })).rejects.toThrow("reservada");
    expect(worktrees.calls).toBe(0);
    await expect(service.dispatch(second.id, { selectedProvider: "codex", reason: "invalido", candidates: [], requestedActions: ["create_worktree"] })).rejects.toThrow("modo sem worktrees");
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

class FirstAttemptWorktrees implements WorktreeProvisioner {
  calls = 0;
  #startedResolve!: () => void;
  #settle!: () => void;
  #fail!: (error: Error) => void;
  readonly started = new Promise<void>((resolve) => { this.#startedResolve = resolve; });
  readonly first = new Promise<string>((resolve, reject) => { this.#settle = () => resolve("/isolated/old"); this.#fail = reject; });
  async prepare(_project: LocalProject, task: ControlRoomTask): Promise<string> {
    this.calls += 1;
    if (this.calls === 1) { this.#startedResolve(); return this.first; }
    return `/isolated/${task.id}`;
  }
  succeedFirst(): void { this.#settle(); }
  failFirst(): void { this.#fail(new Error("worktree antiga falhou")); }
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
    const otherStore = new SqliteControlRoomStore(join(directory, ".eleazar", "control-room.sqlite"));
    const otherService = new ControlRoomService(otherStore);
    const project = service.registerProject({ name: "Core", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "Testar", prompt: "Teste a camada" });
    const first = service.dispatch(task.id, { selectedProvider: "codex", reason: "primeiro", candidates: [], requestedActions: ["create_worktree"] });
    await worktrees.started;
    await expect(otherService.dispatch(task.id, { selectedProvider: "codex", reason: "segundo", candidates: [], requestedActions: ["create_worktree"] })).rejects.toThrow("reservada");
    worktrees.release();
    expect((await first).status).toBe("running");
    expect(worktrees.calls).toBe(1);
    expect(store.listExecutions(task.id)).toHaveLength(1);
    otherStore.close();
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

  it("nao permite que tentativa antiga conclua depois de reenfileiramento e novo lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eleazar-control-room-")); temporaryDirectories.push(directory);
    const store = new SqliteControlRoomStore(join(directory, ".eleazar", "control-room.sqlite"));
    const worktrees = new FirstAttemptWorktrees(); const service = new ControlRoomService(store, worktrees);
    const project = service.registerProject({ name: "Core", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "Testar", prompt: "Teste a camada" });
    const first = service.dispatch(task.id, { selectedProvider: "codex", reason: "primeira", candidates: [], requestedActions: ["create_worktree"] });
    await worktrees.started;
    const oldLease = store.getTask(task.id)?.dispatchLease;
    service.transitionTask(task.id, "queued", "user", "reenfileirou");
    const current = await service.dispatch(task.id, { selectedProvider: "codex", reason: "segunda", candidates: [], requestedActions: [] });
    expect(current.status).toBe("running");
    expect(current.dispatchLease).not.toBe(oldLease);
    worktrees.succeedFirst();
    expect((await first).dispatchLease).toBe(current.dispatchLease);
    expect(store.getTask(task.id)?.worktreePath).toBeNull();
    expect(store.listExecutions(task.id)).toMatchObject([{ status: "running" }, { status: "cancelled" }]);
    store.close();
  });

  it("nao permite que falha de tentativa antiga afete um novo lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eleazar-control-room-")); temporaryDirectories.push(directory);
    const store = new SqliteControlRoomStore(join(directory, ".eleazar", "control-room.sqlite"));
    const worktrees = new FirstAttemptWorktrees(); const service = new ControlRoomService(store, worktrees);
    const project = service.registerProject({ name: "Core", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "Testar", prompt: "Teste a camada" });
    const first = service.dispatch(task.id, { selectedProvider: "codex", reason: "primeira", candidates: [], requestedActions: ["create_worktree"] });
    await worktrees.started;
    service.transitionTask(task.id, "queued", "user", "reenfileirou");
    const current = await service.dispatch(task.id, { selectedProvider: "codex", reason: "segunda", candidates: [], requestedActions: [] });
    const oldExecution = store.listExecutions(task.id).find((execution) => execution.status === "cancelled");
    worktrees.failFirst();
    expect((await first).dispatchLease).toBe(current.dispatchLease);
    expect(store.getTask(task.id)?.status).toBe("running");
    expect(oldExecution && store.listLogs(oldExecution.id)).toEqual([]);
    store.close();
  });
});

describe("dispatch claim transaction", () => {
  it("reverte claim quando persistir a decisao falha e permite novo despacho", async () => {
    const { service, store } = await fixture();
    const project = service.registerProject({ name: "Core", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "Tarefa", prompt: "Planeje algo" });
    const attempt = dispatchAttempt(task.id, "lease-a", "decision-duplicate", "execution-a");
    store.recordDelegation(attempt.decision);
    expect(() => store.claimDispatch(task.id, attempt)).toThrow();
    expect(store.getTask(task.id)?.status).toBe("queued");
    expect(store.listTransitions(task.id)).toEqual([]);
    expect(store.listExecutions(task.id)).toEqual([]);
    expect((await service.dispatch(task.id, { selectedProvider: "codex", reason: "novo", candidates: [], requestedActions: [] })).status).toBe("running");
    store.close();
  });

  it("reverte claim quando criar a execucao falha e permite novo despacho", async () => {
    const { service, store } = await fixture();
    const project = service.registerProject({ name: "Core", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "Tarefa", prompt: "Planeje algo" });
    const attempt = dispatchAttempt(task.id, "lease-a", "decision-a", "execution-duplicate");
    store.createExecution({ id: "execution-duplicate", taskId: task.id, leaseId: null, provider: null, status: "cancelled", startedAt: null, finishedAt: null, summary: null });
    expect(() => store.claimDispatch(task.id, attempt)).toThrow();
    expect(store.getTask(task.id)?.status).toBe("queued");
    expect(store.listTransitions(task.id)).toEqual([]);
    expect(store.listDelegations(task.id)).toEqual([]);
    expect((await service.dispatch(task.id, { selectedProvider: "codex", reason: "novo", candidates: [], requestedActions: [] })).status).toBe("running");
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
      await mkdir(args.at(-1)!, { recursive: true });
      return "";
    });
    const task: ControlRoomTask = { id: "task-1", projectId: "project-1", targetDirectoryId: "directory-1", usesWorktree: true, title: "T", prompt: "P", priority: "normal", status: "planning", kind: "testing", worktreePath: null, dispatchLease: "lease-1", createdAt: "now", updatedAt: "now" };
    await provisioner.prepare({ id: "project-1", name: "Project", path: projectDirectory, directories: [], createdAt: "now" }, task);
    expect(seenArgs).toEqual(["-c", expect.stringMatching(/^core\.hooksPath=/), "worktree", "add", "--detach", join(projectDirectory, ".eleazar", "worktrees", "task-1-lease-1")]);
  });

  it("usa destino distinto por lease e nunca remove worktree antiga", async () => {
    const projectDirectory = await mkdtemp(join(tmpdir(), "eleazar-project-")); temporaryDirectories.push(projectDirectory);
    const oldTask: ControlRoomTask = { id: "task-1", projectId: "project-1", targetDirectoryId: "directory-1", usesWorktree: true, title: "T", prompt: "P", priority: "normal", status: "planning", kind: "testing", worktreePath: null, dispatchLease: "old-lease", createdAt: "now", updatedAt: "now" };
    const newTask = { ...oldTask, dispatchLease: "new-lease" };
    const commands: readonly string[][] = [];
    const provisioner = new GitWorktreeProvisioner(async (_cwd, args) => {
      (commands as string[][]).push([...args]);
      if (args.includes("add")) { await mkdir(args.at(-1)!, { recursive: true }); return ""; }
      throw new Error("comando inesperado");
    });
    const project = { id: "project-1", name: "Project", path: projectDirectory, directories: [], createdAt: "now" };
    const oldTarget = await provisioner.prepare(project, oldTask);
    const newTarget = await provisioner.prepare(project, newTask);
    expect(oldTarget).toBe(join(projectDirectory, ".eleazar", "worktrees", "task-1-old-lease"));
    expect(newTarget).toBe(join(projectDirectory, ".eleazar", "worktrees", "task-1-new-lease"));
    expect(commands.some((args) => args.includes("remove"))).toBe(false);
  });
});

describe("local Control Room API", () => {
  it("exposes a single persisted snapshot for the loopback UI", async () => {
    const { service, store } = await fixture();
    const project = service.registerProject({ name: "Local", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "Snapshot", prompt: "Read state", priority: "high" });
    const server = createControlRoomServer(service);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Endereco ausente");
    const response = await send(address.port, "/api/control-room/snapshot", [], { host: `127.0.0.1:${address.port}`, origin: "http://127.0.0.1:5173" }, "GET");
    expect(response.status).toBe(200);
    expect(response.body.projects).toEqual([expect.objectContaining({ id: project.id })]);
    expect(response.body.tasks).toEqual([expect.objectContaining({ id: task.id, priority: "high" })]);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  });

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

  it("aceita colecao de diretorios e o alvo explicito pela API local", async () => {
    const { service, store } = await fixture();
    const extra = await mkdtemp(join(tmpdir(), "eleazar-api-directory-")); temporaryDirectories.push(extra);
    const server = createControlRoomServer(service);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Endereco ausente");
    const headers = { "content-type": "application/json", origin: `http://127.0.0.1:${address.port}` };
    const projectResponse = await send(address.port, "/api/control-room/projects", [Buffer.from(JSON.stringify({ name: "Produto", directories: [{ name: "API", path: process.cwd() }, { name: "Web", path: extra }] }))], headers);
    expect(projectResponse.status).toBe(201);
    const directories = projectResponse.body.directories as Array<{ id: string; name: string }>;
    expect(directories.map((directory) => directory.name)).toEqual(["API", "Web"]);
    const taskResponse = await send(address.port, "/api/control-room/tasks", [Buffer.from(JSON.stringify({ projectId: projectResponse.body.id, targetDirectoryId: directories[1]!.id, title: "Tela", prompt: "Implemente", priority: "normal" }))], headers);
    expect(taskResponse.status).toBe(201);
    expect(taskResponse.body.targetDirectoryId).toBe(directories[1]!.id);
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
    expect((await send(address.port, "/api/control-room/tasks", [], { host: "example.test" }, "GET")).status).toBe(403);
    expect((await send(address.port, "/api/control-room/projects", [Buffer.alloc(1_000_001)], { "content-type": "application/json" })).status).toBe(400);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  });

  it("aceita leitura pela forma IPv6 loopback [::1]", async () => {
    const { service, store } = await fixture();
    const server = createControlRoomServer(service);
    await new Promise<void>((resolve) => server.listen(0, "::1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Endereco ausente");
    expect((await send(address.port, "/api/control-room/projects", [], { host: `[::1]:${address.port}` }, "GET", "::1")).status).toBe(200);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  });
});

function dispatchAttempt(taskId: string, leaseId: string, decisionId: string, executionId: string): DispatchAttempt {
  const createdAt = "2026-01-01T00:00:00.000Z";
  const execution: TaskExecution = { id: executionId, taskId, leaseId, provider: "codex", status: "planned", startedAt: null, finishedAt: null, summary: null };
  return {
    leaseId,
    usesWorktree: false,
    transition: { id: `transition-${leaseId}`, taskId, fromStatus: "queued", fromDispatchLease: null, toStatus: "planning", actor: "test", reason: null, createdAt },
    decision: { id: decisionId, taskId, selectedProvider: "codex", reason: "test", candidates: [], requestedActions: [], createdAt },
    execution
  };
}

function send(port: number, path: string, chunks: readonly Buffer[], headers: Record<string, string> = {}, method = "POST", hostname = "127.0.0.1"): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname, port, path, method, headers }, (response) => {
      let text = ""; response.setEncoding("utf8"); response.on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> }));
    });
    request.once("error", reject); for (const chunk of chunks) request.write(chunk); request.end();
  });
}
