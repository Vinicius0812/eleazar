import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderName, RouteDecision } from "../src/core/contracts.js";
import { ControlRoomService, type WorktreeProvisioner } from "../src/core/control-room-service.js";
import type { ControlRoomTask, LocalProject, TaskWorktree } from "../src/core/control-room.js";
import { ControlRoomTaskExecutor, type ControlRoomTaskRunner } from "../src/control-room/task-executor.js";
import { GitChangeCollector } from "../src/control-room/git-change-collector.js";
import { SqliteControlRoomStore } from "../src/persistence/sqlite-control-room-store.js";
import { acpRegistry } from "./helpers.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

class FakeWorktrees implements WorktreeProvisioner {
  async prepare(_project: LocalProject, task: ControlRoomTask): Promise<TaskWorktree[]> {
    return [{ taskId: task.id, directoryId: task.targetDirectoryId!, path: join(tmpdir(), `wt-${task.id}`), branch: `eleazar/${task.id}`, baseCommit: null, createdAt: "now" }];
  }
}

/** Routes to whichever provider was asked for, like an explicit choice in the launch dialog. */
function echoRunner(): ControlRoomTaskRunner {
  const decision = (provider: ProviderName): RouteDecision => ({ taskKind: "implementation", selected: provider,
    candidates: [{ provider, score: 100, reasons: ["teste"], health: { provider, available: true, authenticated: true, detail: "ok" } }] });
  return {
    router: { route: async (request) => decision(request.preferredProvider ?? "codex") },
    run: async (_request, provider = "codex") => ({ route: decision(provider), result: { provider, status: "success", response: `feito por ${provider}`, durationMs: 1 } })
  };
}

async function fixture(isolation: "worktree" | "direct" = "worktree") {
  const home = await mkdtemp(join(tmpdir(), "eleazar-comparison-")); temporaryDirectories.push(home);
  const repository = join(home, "repo");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(repository));
  await writeFile(join(repository, ".git"), "gitdir: ../metadata");
  const store = new SqliteControlRoomStore(join(home, ".eleazar", "control-room.sqlite"));
  const service = new ControlRoomService(store, new FakeWorktrees(), { useWorktrees: true });
  const project = service.registerProject({ name: "Repo", path: repository, isolation });
  const changes = new GitChangeCollector();
  vi.spyOn(changes, "capture").mockResolvedValue({ collect: async () => ({ files: [], warnings: [] }) } as unknown as Awaited<ReturnType<GitChangeCollector["capture"]>>);
  const executor = new ControlRoomTaskExecutor(service, echoRunner(), acpRegistry(), changes);
  return { store, service, project, executor };
}

describe("Comparacao entre agentes", () => {
  it("roda o mesmo pedido com dois agentes, cada um na propria branch, e guarda a versao escolhida", async () => {
    const { store, service, project, executor } = await fixture();
    try {
      const started = await executor.startComparison({ projectId: project.id, title: "Corrigir login", prompt: "Corrija o login" }, ["codex", "claude"]);
      expect(started.errors).toEqual([]);
      expect(started.tasks.map((task) => task.title)).toEqual(["Corrigir login · Codex", "Corrigir login · Claude Code"]);
      expect(new Set(started.tasks.map((task) => task.comparisonId)).size).toBe(1);
      for (const task of started.tasks) await vi.waitFor(() => expect(store.getTask(task.id)?.status).toBe("completed"));
      const [first, second] = started.tasks;
      expect(store.getTask(first!.id)?.branch).not.toBe(store.getTask(second!.id)?.branch);
      expect(store.listExecutions(second!.id)).toMatchObject([{ provider: "claude", summary: "feito por claude" }]);
      expect(service.listComparison(started.comparisonId).map((task) => task.id)).toEqual([first!.id, second!.id]);

      service.chooseComparisonAttempt(first!.id);
      expect(store.getTask(first!.id)?.status).toBe("completed");
      expect(store.getTask(second!.id)?.status).toBe("cancelled");
    } finally { store.close(); }
  });

  it("recusa comparar sem worktree ou com o mesmo agente duas vezes", async () => {
    const direct = await fixture("direct");
    try {
      await expect(direct.executor.startComparison({ projectId: direct.project.id, title: "T", prompt: "P" }, ["codex", "claude"])).rejects.toThrow("worktree");
      await expect(direct.executor.startComparison({ projectId: direct.project.id, title: "T", prompt: "P" }, ["codex", "codex"])).rejects.toThrow("agentes diferentes");
      expect(direct.store.listTasks()).toEqual([]);
    } finally { direct.store.close(); }
  });
});
