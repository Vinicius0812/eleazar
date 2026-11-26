import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runProcess } from "../src/adapters/process-runner.js";
import type { AgentRunRequest, AgentRunResult, ProviderName, RouteDecision } from "../src/core/contracts.js";
import { addedFileDiff, parseNameStatus, parseNumstat, safeSegments, TaskFileExplorer } from "../src/control-room/file-explorer.js";
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

describe("explorador de arquivos da tarefa", () => {
  it("no modo direto lista a pasta do projeto e mostra o diff contra o HEAD", async () => {
    const { service, repository } = await fixture();
    const project = service.registerProject({ name: "Repo", path: repository, isolation: "direct" });
    const task = service.createTask({ projectId: project.id, title: "Ver", prompt: "Veja" });
    const directoryId = project.directories[0]!.id;
    await writeFile(join(repository, "README.md"), "inicial\nalterado\n");
    await writeFile(join(repository, "novo.txt"), "um\ndois\n");
    await unlink(join(repository, "apagar.txt"));
    const explorer = new TaskFileExplorer(service, 0);

    expect(explorer.roots(task.id)).toEqual([expect.objectContaining({ directoryId, mode: "direct", path: repository, base: "HEAD", branch: null })]);
    const listing = await explorer.list(task.id, directoryId);
    expect(listing.entries.map((entry) => entry.name)).toEqual(["src", "apagar.txt", "novo.txt", "README.md"]);
    expect(listing.entries).not.toContainEqual(expect.objectContaining({ name: ".git" }));
    expect(listing.entries.find((entry) => entry.name === "README.md")).toMatchObject({ change: "modified", type: "file" });
    expect(listing.entries.find((entry) => entry.name === "novo.txt")).toMatchObject({ change: "untracked" });
    expect(listing.entries.find((entry) => entry.name === "apagar.txt")).toMatchObject({ change: "deleted", size: null });

    const changes = await explorer.changes(task.id, directoryId);
    expect(changes.changes).toEqual([
      { path: "apagar.txt", previousPath: null, kind: "deleted", additions: 0, deletions: 1 },
      { path: "novo.txt", previousPath: null, kind: "untracked", additions: null, deletions: null },
      { path: "README.md", previousPath: null, kind: "modified", additions: 1, deletions: 0 }
    ]);

    const readme = await explorer.file(task.id, directoryId, "README.md");
    expect(readme).toMatchObject({ exists: true, binary: false, content: "inicial\nalterado\n" });
    expect(readme.diff).toContain("+alterado");
    const added = await explorer.file(task.id, directoryId, "novo.txt");
    expect(added.diff).toContain("@@ -0,0 +1,2 @@\n+um\n+dois");
    const removed = await explorer.file(task.id, directoryId, "apagar.txt");
    expect(removed).toMatchObject({ exists: false, content: null });
    expect(removed.diff).toContain("-sera apagado");
    const nested = await explorer.list(task.id, directoryId, "src");
    expect(nested.entries).toEqual([expect.objectContaining({ name: "app.ts", path: "src/app.ts", change: null })]);
    expect((await explorer.file(task.id, directoryId, "src\\app.ts")).content).toBe("export {};\n");
  });

  it("no modo worktree mostra o que a tarefa mudou desde o commit base, inclusive depois de commitar", async () => {
    const { service, store, repository } = await fixture();
    const project = service.registerProject({ name: "Repo", path: repository });
    const task = service.createTask({ projectId: project.id, title: "Criar nota", prompt: "Crie nota.txt" });
    const executor = new ControlRoomTaskExecutor(service, writingRunner("nota.txt"), acpRegistry());
    await executor.start(task.id, "codex");
    await vi.waitFor(() => expect(store.getTask(task.id)?.status).toBe("completed"));
    const [worktree] = store.listTaskWorktrees(task.id);
    const directoryId = project.directories[0]!.id;
    const explorer = new TaskFileExplorer(service, 0);

    expect(explorer.roots(task.id)).toEqual([expect.objectContaining({ mode: "worktree", path: worktree!.path, branch: worktree!.branch, base: worktree!.baseCommit })]);
    expect((await explorer.changes(task.id, directoryId)).changes).toEqual([expect.objectContaining({ path: "nota.txt", kind: "untracked" })]);
    await git(worktree!.path, ["add", "."]);
    await git(worktree!.path, ["commit", "-m", "nota"]);
    expect((await explorer.changes(task.id, directoryId)).changes).toEqual([{ path: "nota.txt", previousPath: null, kind: "added", additions: 1, deletions: 0 }]);
    expect((await explorer.file(task.id, directoryId, "nota.txt")).diff).toContain("+linha");
    // The user's own checkout is not what the task shows.
    expect(existsSync(join(repository, "nota.txt"))).toBe(false);
  });

  it("funciona em pastas sem Git e recusa caminhos fora da pasta da tarefa", async () => {
    const { service } = await fixture();
    const folder = await temporary("eleazar-explorer-plain-");
    const outside = await temporary("eleazar-explorer-outside-");
    await writeFile(join(folder, "notas.md"), "# Notas\n");
    await writeFile(join(folder, "imagem.bin"), Buffer.from([1, 0, 2, 3]));
    await writeFile(join(outside, "segredo.txt"), "fora");
    const linked = await symlink(outside, join(folder, "atalho"), "junction").then(() => true, () => false);
    const project = service.registerProject({ name: "Pasta", path: folder });
    const task = service.createTask({ projectId: project.id, title: "Ver", prompt: "Veja" });
    const directoryId = project.directories[0]!.id;
    const explorer = new TaskFileExplorer(service, 0);

    expect(explorer.roots(task.id)[0]).toMatchObject({ mode: "direct", isGitRepository: false, base: null });
    expect((await explorer.list(task.id, directoryId)).entries.map((entry) => entry.name)).toContain("notas.md");
    expect((await explorer.changes(task.id, directoryId)).warnings[0]).toMatch(/nao e um repositorio Git/);
    expect(await explorer.file(task.id, directoryId, "notas.md")).toMatchObject({ content: "# Notas\n", change: null, diff: null });
    expect(await explorer.file(task.id, directoryId, "imagem.bin")).toMatchObject({ binary: true, content: null });
    await expect(explorer.file(task.id, directoryId, "../segredo.txt")).rejects.toThrow(/fora da pasta/);
    await expect(explorer.file(task.id, directoryId, join(outside, "segredo.txt"))).rejects.toThrow(/relativo/);
    await expect(explorer.list(task.id, "outro")).rejects.toThrow(/fora do escopo/);
    if (linked) await expect(explorer.file(task.id, directoryId, "atalho/segredo.txt")).rejects.toThrow(/fora da pasta/);
  });

  it("serve a arvore, o conteudo e as alteracoes pela API local", async () => {
    const { service, repository } = await fixture();
    const project = service.registerProject({ name: "Repo", path: repository, isolation: "direct" });
    const task = service.createTask({ projectId: project.id, title: "Ver", prompt: "Veja" });
    const directoryId = project.directories[0]!.id;
    await writeFile(join(repository, "README.md"), "mudou\n");
    const server = createControlRoomServer(service);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("Endereco ausente");
      const base = `http://127.0.0.1:${address.port}/api/control-room/tasks/${task.id}`;
      const query = (path = "") => `directoryId=${encodeURIComponent(directoryId)}&path=${encodeURIComponent(path)}`;
      await expect(fetch(`${base}/files/roots`).then((response) => response.json())).resolves.toMatchObject([{ directoryId, mode: "direct" }]);
      await expect(fetch(`${base}/files?${query()}`).then((response) => response.json())).resolves.toMatchObject({ path: "", entries: expect.arrayContaining([expect.objectContaining({ name: "README.md", change: "modified" })]) });
      await expect(fetch(`${base}/changes?directoryId=${directoryId}`).then((response) => response.json())).resolves.toMatchObject({ changes: [{ path: "README.md", kind: "modified" }] });
      const file = await fetch(`${base}/files/content?${query("README.md")}`).then((response) => response.json()) as { diff: string };
      expect(file.diff).toContain("+mudou");
      expect((await fetch(`${base}/files/content?${query("../x")}`)).status).toBe(400);
      expect((await fetch(`${base}/files/content?${query("inexistente.txt")}`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${address.port}/api/control-room/tasks/nao-existe/files/roots`)).status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("no modo direto marca o que ja estava alterado antes da tarefa", async () => {
    const { service, store, repository } = await fixture();
    const project = service.registerProject({ name: "Repo", path: repository, isolation: "direct" });
    const task = service.createTask({ projectId: project.id, title: "Nota", prompt: "Crie nota.txt" });
    await writeFile(join(repository, "README.md"), "inicial\ndo usuario\n");
    const executor = new ControlRoomTaskExecutor(service, writingRunner("nota.txt"), acpRegistry());
    await executor.start(task.id, "codex");
    await vi.waitFor(() => expect(store.getTask(task.id)?.status).toBe("completed"));
    const { changes } = await new TaskFileExplorer(service, 0).changes(task.id, project.directories[0]!.id);
    expect(changes.find((change) => change.path === "README.md")).toMatchObject({ kind: "modified", preexisting: true });
    expect(changes.find((change) => change.path === "nota.txt")).not.toHaveProperty("preexisting");
  });

  it("busca arquivos no projeto inteiro, com e sem Git", async () => {
    const { service, repository } = await fixture();
    await mkdir(join(repository, "src", "profundo"), { recursive: true });
    await writeFile(join(repository, "src", "profundo", "alvo.ts"), "x\n");
    await writeFile(join(repository, ".gitignore"), "ignorado/\n");
    await mkdir(join(repository, "ignorado"));
    await writeFile(join(repository, "ignorado", "alvo.ts"), "x\n");
    const project = service.registerProject({ name: "Repo", path: repository, isolation: "direct" });
    const task = service.createTask({ projectId: project.id, title: "Ver", prompt: "Veja" });
    const explorer = new TaskFileExplorer(service, 0);
    expect((await explorer.search(task.id, project.directories[0]!.id, "ALVO")).paths).toEqual(["src/profundo/alvo.ts"]);
    expect((await explorer.search(task.id, project.directories[0]!.id, "src\\app")).paths).toEqual(["src/app.ts"]);

    const folder = await temporary("eleazar-explorer-search-");
    await mkdir(join(folder, "a", "node_modules"), { recursive: true });
    await writeFile(join(folder, "a", "alvo.md"), "x");
    await writeFile(join(folder, "a", "node_modules", "alvo.js"), "x");
    const plain = service.registerProject({ name: "Pasta", path: folder });
    const plainTask = service.createTask({ projectId: plain.id, title: "Ver", prompt: "Veja" });
    expect((await explorer.search(plainTask.id, plain.directories[0]!.id, "alvo")).paths).toEqual(["a/alvo.md"]);
  });

  it("interpreta a saida -z do Git, inclusive renomeacoes", () => {
    expect(parseNameStatus("M\0a.ts\0R100\0velho.ts\0novo.ts\0D\0b.ts\0A\0c d.ts\0")).toEqual([
      { path: "a.ts", previousPath: null, kind: "modified" },
      { path: "novo.ts", previousPath: "velho.ts", kind: "renamed" },
      { path: "b.ts", previousPath: null, kind: "deleted" },
      { path: "c d.ts", previousPath: null, kind: "added" }
    ]);
    expect([...parseNumstat("1\t2\ta.ts\0-\t-\timg.png\x000\t0\t\0velho.ts\0novo.ts\0")]).toEqual([
      ["a.ts", { additions: 1, deletions: 2 }], ["img.png", { additions: null, deletions: null }], ["novo.ts", { additions: 0, deletions: 0 }]
    ]);
    expect(addedFileDiff("x.txt", "")).not.toContain("@@");
    expect(safeSegments("a\\b/./c")).toEqual(["a", "b", "c"]);
    expect(() => safeSegments(".git/config")).toThrow(/Git/);
    expect(() => safeSegments("C:\\Windows")).toThrow(/relativo/);
  });
});

async function fixture() {
  const home = await temporary("eleazar-explorer-home-");
  const repository = await temporary("eleazar-explorer-repo-");
  await git(repository, ["init"]);
  await git(repository, ["config", "user.email", "test@example.invalid"]);
  await git(repository, ["config", "user.name", "Eleazar Test"]);
  await git(repository, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(repository, "README.md"), "inicial\n");
  await writeFile(join(repository, "apagar.txt"), "sera apagado\n");
  await mkdir(join(repository, "src"));
  await writeFile(join(repository, "src", "app.ts"), "export {};\n");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "initial"]);
  const store = new SqliteControlRoomStore(join(home, "control-room.sqlite"));
  stores.push(store);
  return { store, repository, service: createLocalControlRoomService(store, { worktreeRoot: join(home, "worktrees") }) };
}

function writingRunner(file: string) {
  const route: RouteDecision = { taskKind: "implementation", selected: "codex",
    candidates: [{ provider: "codex", score: 100, reasons: ["teste"], health: { provider: "codex", available: true, authenticated: true, detail: "teste" } }] };
  const runner: ControlRoomTaskRunner = {
    router: { route: async () => route },
    run: async (request: AgentRunRequest, _preferred?: ProviderName) => {
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

async function temporary(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}
