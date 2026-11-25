import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GitRepositoryPublisher, withoutCredentials } from "../src/adapters/git-publisher.js";
import { runProcess } from "../src/adapters/process-runner.js";
import type { AgentRunRequest, AgentRunResult, ProviderName, RouteDecision } from "../src/core/contracts.js";
import { OutboundActionService } from "../src/core/outbound-actions.js";
import { createControlRoomServer } from "../src/control-room/local-api.js";
import { createLocalControlRoomService } from "../src/control-room/local-service.js";
import { ControlRoomTaskExecutor, type ControlRoomTaskRunner } from "../src/control-room/task-executor.js";
import { SqliteControlRoomStore } from "../src/persistence/sqlite-control-room-store.js";
import { acpRegistry } from "./helpers.js";

const temporaryDirectories: string[] = [];
const stores: SqliteControlRoomStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 3 })));
});

describe("tarefa isolada em worktree", () => {
  it("roda em branch propria, continua na mesma worktree e nao toca o checkout do usuario", async () => {
    const { service, store, repository } = await fixture();
    const project = service.registerProject({ name: "Repo", path: repository });
    const task = service.createTask({ projectId: project.id, title: "Criar nota", prompt: "Crie nota.txt" });
    const runner = writingRunner("nota.txt");
    const executor = new ControlRoomTaskExecutor(service, runner, acpRegistry());

    await executor.start(task.id, "codex");
    await vi.waitFor(() => expect(store.getTask(task.id)?.status).toBe("completed"));
    const [worktree] = store.listTaskWorktrees(task.id);
    expect(worktree).toMatchObject({ branch: expect.stringMatching(/^eleazar\/criar-nota-/), directoryId: project.directories[0]!.id });
    expect(runner.requests[0]).toMatchObject({ cwd: worktree!.path, prompt: expect.stringContaining(`Branch da tarefa: ${worktree!.branch}`) });
    expect(existsSync(join(worktree!.path, "nota.txt"))).toBe(true);
    expect(existsSync(join(repository, "nota.txt"))).toBe(false);
    expect(store.getTask(task.id)).toMatchObject({ branch: worktree!.branch, worktreePath: worktree!.path, usesWorktree: true });
    expect(store.listExecutionFiles(store.listExecutions(task.id)[0]!.id)).toMatchObject([{ path: "nota.txt", kind: "untracked" }]);

    await executor.continueTask(task.id, "Agora acrescente uma linha");
    await vi.waitFor(() => expect(store.getTask(task.id)?.status).toBe("completed"));
    expect(runner.requests[1]).toMatchObject({ cwd: worktree!.path });
    expect(runner.requests[1]!.prompt).toContain("Agora acrescente uma linha");
    expect(runner.requests[1]!.prompt).toContain("Crie nota.txt");
    expect(store.listExecutions(task.id)).toMatchObject([{ prompt: "Agora acrescente uma linha", status: "completed" }, { prompt: null, status: "completed" }]);
    expect(store.listTaskWorktrees(task.id)).toHaveLength(1);
  });

  it("permite duas tarefas simultaneas no mesmo repositorio", async () => {
    const { service, store, repository } = await fixture();
    const project = service.registerProject({ name: "Repo", path: repository });
    const first = service.createTask({ projectId: project.id, title: "A", prompt: "Planeje A" });
    const second = service.createTask({ projectId: project.id, title: "B", prompt: "Planeje B" });
    const runner = writingRunner("a.txt", true);
    const executor = new ControlRoomTaskExecutor(service, runner, acpRegistry());
    await executor.start(first.id, "codex");
    await expect(executor.start(second.id, "codex")).resolves.toMatchObject({ status: "running", usesWorktree: true });
    expect(store.listTaskWorktrees(first.id)[0]!.path).not.toBe(store.listTaskWorktrees(second.id)[0]!.path);
    runner.release();
    await vi.waitFor(() => expect(store.getTask(second.id)?.status).toBe("completed"));
  });

  it("uma pasta comum, sem Git, roda direto no lugar e aceita continuacao", async () => {
    const { service, store } = await fixture();
    const folder = await temporary("eleazar-plain-folder-");
    const project = service.registerProject({ name: "Pasta", path: folder });
    const task = service.createTask({ projectId: project.id, title: "Anotar", prompt: "Crie nota.txt" });
    const runner = writingRunner("nota.txt");
    const executor = new ControlRoomTaskExecutor(service, runner, acpRegistry());

    await executor.start(task.id, "codex");
    await vi.waitFor(() => expect(store.getTask(task.id)?.status).toBe("completed"));
    expect(runner.requests[0]!.cwd).toBe(folder);
    expect(existsSync(join(folder, "nota.txt"))).toBe(true);
    expect(store.getTask(task.id)).toMatchObject({ usesWorktree: false, branch: null, worktreePath: null });
    expect(store.listTaskWorktrees(task.id)).toEqual([]);

    await executor.continueTask(task.id, "Continue");
    await vi.waitFor(() => expect(store.listExecutions(task.id)).toMatchObject([{ status: "completed" }, { status: "completed" }]));
    expect(runner.requests[1]!.cwd).toBe(folder);

    const actions = new OutboundActionService(store, new GitRepositoryPublisher());
    await expect(actions.request(task.id, { kind: "commit", title: "x" })).rejects.toThrow("roda direto na pasta");
  });

  it("recusa nova mensagem enquanto o turno nao terminou e expoe a rota HTTP", async () => {
    const { service, store, repository } = await fixture();
    const project = service.registerProject({ name: "Repo", path: repository });
    const task = service.createTask({ projectId: project.id, title: "A", prompt: "Planeje A" });
    const runner = writingRunner("a.txt");
    const executor = new ControlRoomTaskExecutor(service, runner, acpRegistry());
    await expect(executor.continueTask(task.id, "cedo demais")).rejects.toThrow("depois que o turno anterior terminar");
    await executor.start(task.id, "codex");
    await vi.waitFor(() => expect(store.getTask(task.id)?.status).toBe("completed"));

    const server = createControlRoomServer(service, executor);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("Endereco ausente");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/control-room/tasks/${task.id}/messages`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "Mais um passo" }) });
      expect(response.status).toBe(202);
      await vi.waitFor(() => expect(store.listExecutions(task.id)).toMatchObject([{ prompt: "Mais um passo", status: "completed" }, { status: "completed" }]));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("remove a worktree limpa, mantem a branch e recusa quando ha trabalho sem commit", async () => {
    const { service, store, repository } = await fixture();
    const project = service.registerProject({ name: "Repo", path: repository });
    const task = service.createTask({ projectId: project.id, title: "Limpar", prompt: "Crie nota.txt" });
    const executor = new ControlRoomTaskExecutor(service, writingRunner("nota.txt"), acpRegistry());
    await executor.start(task.id, "codex");
    await vi.waitFor(() => expect(store.getTask(task.id)?.status).toBe("completed"));
    const [worktree] = store.listTaskWorktrees(task.id);

    await expect(service.removeTaskWorktrees(task.id)).rejects.toThrow("alteracoes sem commit");
    expect(existsSync(worktree!.path)).toBe(true);
    await rm(join(worktree!.path, "nota.txt"));
    await expect(service.removeTaskWorktrees(task.id)).resolves.toMatchObject({ worktreePath: null, branch: null });
    expect(existsSync(worktree!.path)).toBe(false);
    expect((await git(repository, ["branch", "--list", worktree!.branch])).trim()).toContain(worktree!.branch);
  });
});

describe("acoes de saida com aprovacao", () => {
  it("so cria o commit e envia a branch depois da aprovacao do operador", async () => {
    const { service, store, repository } = await fixture();
    const remote = await temporary("eleazar-remote-");
    await git(remote, ["init", "--bare"]);
    await git(repository, ["remote", "add", "origin", remote]);
    const project = service.registerProject({ name: "Repo", path: repository });
    const task = service.createTask({ projectId: project.id, title: "Publicar", prompt: "Crie nota.txt" });
    const executor = new ControlRoomTaskExecutor(service, writingRunner("nota.txt"), acpRegistry());
    await executor.start(task.id, "codex");
    await vi.waitFor(() => expect(store.getTask(task.id)?.status).toBe("completed"));
    const [worktree] = store.listTaskWorktrees(task.id);
    const actions = new OutboundActionService(store, new GitRepositoryPublisher());

    await expect(actions.request(task.id, { kind: "push" })).rejects.toThrow("faca o commit primeiro");
    await expect(actions.request(task.id, { kind: "commit" })).rejects.toThrow("mensagem do commit");
    const commit = await actions.request(task.id, { kind: "commit", title: "Adiciona nota", body: "Detalhe" });
    expect(commit).toMatchObject({ status: "pending", targets: [{ changedFiles: 1, files: ["nota.txt"], commitsAhead: 0, branch: worktree!.branch }] });
    expect((await git(worktree!.path, ["rev-list", "--count", "HEAD"])).trim()).toBe("1");
    await expect(actions.request(task.id, { kind: "commit", title: "outro" })).rejects.toThrow("aguardando decisao");

    await expect(actions.decide(commit.id, "approve")).resolves.toMatchObject({ status: "completed", result: expect.stringContaining("commit ") });
    expect((await git(worktree!.path, ["log", "-1", "--format=%s%n%b"])).trim()).toBe("Adiciona nota\nDetalhe");
    await expect(actions.decide(commit.id, "approve")).rejects.toThrow("ja foi decidida");

    const rejected = await actions.request(task.id, { kind: "push" });
    await expect(actions.decide(rejected.id, "reject")).resolves.toMatchObject({ status: "rejected" });
    await expect(git(remote, ["rev-parse", "--verify", `refs/heads/${worktree!.branch}`])).rejects.toThrow();

    const push = await actions.request(task.id, { kind: "push" });
    expect(push.targets).toMatchObject([{ commitsAhead: 1, remote }]);
    await expect(actions.decide(push.id, "approve")).resolves.toMatchObject({ status: "completed" });
    expect((await git(remote, ["rev-parse", "--verify", `refs/heads/${worktree!.branch}`])).trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(service.snapshot().actions.map((action) => action.status)).toEqual(["completed", "rejected", "completed"]);
  });

  it("nao age enquanto o agente trabalha e registra a falha sem expor credenciais", async () => {
    const { service, store, repository } = await fixture();
    const project = service.registerProject({ name: "Repo", path: repository });
    const task = service.createTask({ projectId: project.id, title: "PR", prompt: "Crie nota.txt" });
    const runner = writingRunner("nota.txt", true);
    const executor = new ControlRoomTaskExecutor(service, runner, acpRegistry());
    await executor.start(task.id, "codex");
    const calls: string[][] = [];
    const publisher = new GitRepositoryPublisher(async (command, args) => {
      calls.push([command, ...args]);
      if (command === "gh") return { exitCode: 1, stdout: "", stderr: "fatal: https://user:segredo@example.invalid/repo.git recusou", durationMs: 1, timedOut: false };
      const stdout = args[0] === "remote" ? "https://user:segredo@example.invalid/repo.git\n" : args[0] === "rev-list" ? "2\n" : "";
      return { exitCode: 0, stdout, stderr: "", durationMs: 1, timedOut: false };
    });
    const actions = new OutboundActionService(store, publisher);
    await expect(actions.request(task.id, { kind: "pull_request", title: "Abrir" })).rejects.toThrow("em execucao");
    runner.release();
    await vi.waitFor(() => expect(store.getTask(task.id)?.status).toBe("completed"));

    const request = await actions.request(task.id, { kind: "pull_request", title: "Abrir PR", body: "Corpo" });
    expect(request.targets[0]).toMatchObject({ remote: "https://example.invalid/repo.git", commitsAhead: 2 });
    const decided = await actions.decide(request.id, "approve");
    expect(decided).toMatchObject({ status: "failed" });
    expect(decided.result).toContain("recusou");
    expect(JSON.stringify(store.listOutboundActions(task.id))).not.toContain("segredo");
    expect(calls.at(-1)).toEqual(["gh", "pr", "create", "--head", store.listTaskWorktrees(task.id)[0]!.branch, "--title", "Abrir PR", "--body", "Corpo"]);
    expect(withoutCredentials("ssh://git@host/x e https://a:b@host/y")).toBe("ssh://host/x e https://host/y");
  });
});

async function temporary(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function fixture() {
  const home = await temporary("eleazar-task-worktrees-");
  const repository = await temporary("eleazar-task-repo-");
  await git(repository, ["init"]);
  await git(repository, ["config", "user.email", "test@example.invalid"]);
  await git(repository, ["config", "user.name", "Eleazar Test"]);
  await git(repository, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(repository, "README.md"), "inicial\n");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "initial"]);
  const store = new SqliteControlRoomStore(join(home, "control-room.sqlite"));
  stores.push(store);
  return { store, repository, service: createLocalControlRoomService(store, { worktreeRoot: join(home, "worktrees") }) };
}

/** Deterministic stand-in for a provider: appends a line to `file` in the directory it was sent to. */
function writingRunner(file: string, blocked = false) {
  const route: RouteDecision = { taskKind: "implementation", selected: "codex",
    candidates: [{ provider: "codex", score: 100, reasons: ["teste"], health: { provider: "codex", available: true, authenticated: true, detail: "teste" } }] };
  const requests: AgentRunRequest[] = [];
  let release = () => {};
  const gate = blocked ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
  const runner: ControlRoomTaskRunner & { requests: AgentRunRequest[]; release(): void } = {
    requests,
    release: () => release(),
    router: { route: async () => route },
    run: async (request: AgentRunRequest, _preferred?: ProviderName) => {
      requests.push(request);
      await gate;
      const path = join(request.cwd, file);
      await writeFile(path, `${existsSync(path) ? await readFile(path, "utf8") : ""}linha\n`);
      const result: AgentRunResult = { provider: "codex", status: "success", response: "feito", durationMs: 1 };
      return { route, result };
    }
  };
  return runner;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 20_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || `git ${args.join(" ")} falhou`);
  return result.stdout;
}
