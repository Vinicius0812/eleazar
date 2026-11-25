import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GhPullRequestInspector, parsePullRequest } from "../src/adapters/gh-pull-requests.js";
import { runProcess } from "../src/adapters/process-runner.js";
import type { AgentRunRequest, RouteDecision } from "../src/core/contracts.js";
import type { PullRequestInspector, PullRequestState, RepositoryPublisher } from "../src/core/control-room.js";
import { OutboundActionService } from "../src/core/outbound-actions.js";
import { PullRequestService } from "../src/core/pull-requests.js";
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

const open: PullRequestState = { number: 12, url: "https://github.com/o/r/pull/12", title: "Nota", state: "open", isDraft: false,
  reviewDecision: "review_required", mergeable: "mergeable", checks: { total: 2, passed: 1, failed: 0, pending: 1, failing: [] } };

describe("GhPullRequestInspector", () => {
  it("resume estado, revisao, conflito e checks de check runs e commit statuses", () => {
    expect(parsePullRequest({ number: 7, url: "https://x:tok@github.com/o/r/pull/7", title: "T", state: "OPEN", isDraft: true, reviewDecision: "CHANGES_REQUESTED", mergeable: "CONFLICTING",
      statusCheckRollup: [
        { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", name: "e2e (chrome)", status: "COMPLETED", conclusion: "FAILURE" },
        { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: "" },
        { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "SKIPPED" },
        { __typename: "StatusContext", context: "deploy/preview", state: "PENDING" },
        { __typename: "StatusContext", context: "legacy-ci", state: "ERROR" }
      ] })).toEqual({ number: 7, url: "https://github.com/o/r/pull/7", title: "T", state: "open", isDraft: true, reviewDecision: "changes_requested", mergeable: "conflicting",
      checks: { total: 6, passed: 2, failed: 2, pending: 2, failing: ["e2e (chrome)", "legacy-ci"] } });
    expect(parsePullRequest({ number: 1, state: "MERGED", reviewDecision: "", mergeable: "UNKNOWN" })).toMatchObject({ state: "merged", reviewDecision: null, mergeable: "unknown", checks: { total: 0 } });
  });

  it("consulta so leitura, devolve null sem pull request e explica falhas sem credenciais", async () => {
    const calls: string[][] = [];
    const reply = (exitCode: number, stdout: string, stderr = "") => async (command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      return { exitCode, stdout, stderr, durationMs: 1, timedOut: false };
    };
    await expect(new GhPullRequestInspector(reply(0, JSON.stringify({ number: 3, url: "u", title: "t", state: "OPEN" }))).find("/repo", "eleazar/x")).resolves.toMatchObject({ number: 3, state: "open" });
    expect(calls[0]).toEqual(["gh", "pr", "view", "eleazar/x", "--json", "number,url,title,state,isDraft,reviewDecision,mergeable,statusCheckRollup"]);
    await expect(new GhPullRequestInspector(reply(1, "", 'no pull requests found for branch "eleazar/x"')).find("/repo", "eleazar/x")).resolves.toBeNull();
    await expect(new GhPullRequestInspector(reply(1, "", "fatal: https://u:segredo@github.com falhou")).find("/repo", "b")).rejects.toThrow(/^(?!.*segredo).*falhou/);
    await expect(new GhPullRequestInspector(async () => { throw new Error("ENOENT"); }).find("/repo", "b")).rejects.toThrow("gh) nao encontrado");
  });
});

describe("PullRequestService", () => {
  it("guarda o pull request da branch da tarefa e o inclui no snapshot", async () => {
    const { service, store, task } = await finishedTask();
    let state: PullRequestState | null = null;
    const find = vi.fn<PullRequestInspector["find"]>(async () => state);
    const pullRequests = new PullRequestService(store, { find });
    const [worktree] = store.listTaskWorktrees(task.id);

    await expect(pullRequests.refresh(task.id)).resolves.toEqual({ pullRequests: [], warnings: [] });
    expect(find).toHaveBeenCalledWith(worktree!.path, worktree!.branch);
    state = open;
    await expect(pullRequests.refresh(task.id)).resolves.toMatchObject({ pullRequests: [{ taskId: task.id, number: 12, headBranch: worktree!.branch, state: "open" }] });
    state = { ...open, state: "merged", reviewDecision: "approved" };
    await pullRequests.refresh(task.id);
    expect(service.snapshot().pullRequests).toMatchObject([{ number: 12, state: "merged", reviewDecision: "approved", checks: open.checks }]);

    // A removed worktree keeps the branch: the pull request is still followed from the source repository.
    const project = service.getProject(task.projectId)!;
    await rm(worktree!.path, { recursive: true, force: true });
    find.mockClear();
    await pullRequests.refresh(task.id);
    expect(find).toHaveBeenCalledWith(project.directories[0]!.path, worktree!.branch);
  });

  it("a varredura le so tarefas enviadas e ainda abertas, e relata o gh indisponivel uma vez", async () => {
    const { store, task } = await finishedTask();
    const find = vi.fn<PullRequestInspector["find"]>(async () => open);
    const pullRequests = new PullRequestService(store, { find });
    await pullRequests.refreshAll();
    expect(find).not.toHaveBeenCalled();

    store.createOutboundAction({ id: "pushed", taskId: task.id, kind: "push", status: "completed", title: null, body: null, targets: [], result: "ok",
      requestedBy: "op", createdAt: "now", decidedAt: "now", finishedAt: "now" });
    await expect(Promise.all([pullRequests.refreshAll(), pullRequests.refreshAll()])).resolves.toMatchObject([{ warnings: [] }, { warnings: [] }]);
    expect(find).toHaveBeenCalledTimes(1);

    find.mockRejectedValue(new Error("GitHub CLI (gh) nao encontrado."));
    await expect(pullRequests.refreshAll()).resolves.toMatchObject({ pullRequests: [{ number: 12 }], warnings: ["GitHub CLI (gh) nao encontrado."] });

    find.mockReset(); find.mockResolvedValue({ ...open, state: "closed" });
    await pullRequests.refreshAll();
    find.mockClear();
    await pullRequests.refreshAll();
    expect(find).not.toHaveBeenCalled();
  });

  it("a API atualiza sob demanda e logo depois de abrir o pull request aprovado", async () => {
    const { service, store, task } = await finishedTask();
    const publisher: RepositoryPublisher = {
      inspect: async () => ({ remote: "https://github.com/o/r.git", changedFiles: 0, files: [], commitsAhead: 1 }),
      commit: async () => "commit", push: async () => "push", openPullRequest: async () => "https://github.com/o/r/pull/12"
    };
    const actions = new OutboundActionService(store, publisher);
    const find = vi.fn<PullRequestInspector["find"]>(async () => open);
    const server = createControlRoomServer(service, undefined, undefined, actions, new PullRequestService(store, { find }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("Endereco ausente");
      const post = (path: string, body: object) => fetch(`http://127.0.0.1:${address.port}/api/control-room${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const requested = await (await post(`/tasks/${task.id}/actions`, { kind: "pull_request", title: "Nota" })).json() as { id: string };
      expect(find).not.toHaveBeenCalled();
      expect((await post(`/actions/${requested.id}/decision`, { decision: "approve" })).status).toBe(200);
      expect(store.listTaskPullRequests(task.id)).toMatchObject([{ number: 12 }]);
      const refreshed = await post(`/tasks/${task.id}/pull-requests/refresh`, {});
      expect(await refreshed.json()).toMatchObject({ pullRequests: [{ number: 12 }], warnings: [] });
      expect((await post("/pull-requests/refresh", {})).status).toBe(200);
      expect((await post("/tasks/inexistente/pull-requests/refresh", {})).status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/** A task that already ran once in its own worktree, using real Git and a deterministic runner. */
async function finishedTask() {
  const home = await mkdtemp(join(tmpdir(), "eleazar-pull-requests-")); temporaryDirectories.push(home);
  const repository = await mkdtemp(join(tmpdir(), "eleazar-pull-requests-repo-")); temporaryDirectories.push(repository);
  for (const args of [["init"], ["config", "user.email", "test@example.invalid"], ["config", "user.name", "Eleazar Test"], ["config", "commit.gpgsign", "false"]]) await git(repository, args);
  await writeFile(join(repository, "README.md"), "inicial\n");
  await git(repository, ["add", "."]); await git(repository, ["commit", "-m", "initial"]);
  const store = new SqliteControlRoomStore(join(home, "control-room.sqlite")); stores.push(store);
  const service = createLocalControlRoomService(store, { worktreeRoot: join(home, "worktrees") });
  const project = service.registerProject({ name: "Repo", path: repository });
  const task = service.createTask({ projectId: project.id, title: "Nota", prompt: "Crie nota.txt" });
  const route: RouteDecision = { taskKind: "implementation", selected: "codex",
    candidates: [{ provider: "codex", score: 100, reasons: ["teste"], health: { provider: "codex", available: true, authenticated: true, detail: "teste" } }] };
  const runner: ControlRoomTaskRunner = { router: { route: async () => route },
    run: async (_request: AgentRunRequest) => ({ route, result: { provider: "codex", status: "success", response: "feito", durationMs: 1 } }) };
  await new ControlRoomTaskExecutor(service, runner, acpRegistry()).start(task.id, "codex");
  await vi.waitFor(() => expect(store.getTask(task.id)?.status).toBe("completed"));
  return { service, store, task };
}

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 20_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || `git ${args.join(" ")} falhou`);
}
