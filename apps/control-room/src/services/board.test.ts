import { describe, expect, it } from "vitest";

import { placeTask, relativeTime } from "./board.js";
import type { Run, Task, TaskOutboundAction, TaskPullRequest } from "./contracts.js";

const at = "2026-01-01T00:00:00.000Z";
const task = (over: Partial<Task> = {}): Task => ({ id: "task-1", projectId: "p", targetDirectoryId: "d", directoryIds: ["d"], usesWorktree: false, title: "T", prompt: "P", priority: "normal", status: "queued", kind: "implementation", worktreePath: null, dispatchLease: null, createdAt: at, updatedAt: at, ...over });
const run = (over: Partial<Run> = {}): Run => ({ id: "run-1", taskId: "task-1", provider: "codex", status: "completed", startedAt: at, finishedAt: "2026-01-01T00:05:00.000Z", summary: null, ...over });
const action = (over: Partial<TaskOutboundAction> = {}): TaskOutboundAction => ({ id: "a", taskId: "task-1", kind: "commit", status: "pending", title: "x", body: null, targets: [], result: null, requestedBy: "op", createdAt: "2026-01-01T00:06:00.000Z", decidedAt: null, finishedAt: null, ...over });

describe("placeTask", () => {
  it("coloca cada tarefa na raia que os fatos indicam", () => {
    expect(placeTask(task(), [])).toMatchObject({ place: "queued", fact: "Pronta para executar" });
    expect(placeTask(task({ status: "running", dispatchLease: "l" }), [run({ status: "running", finishedAt: null })])).toMatchObject({ place: "working", at });
    expect(placeTask(task({ status: "completed" }), [run()])).toMatchObject({ place: "review", fact: "Turno concluído", at: "2026-01-01T00:05:00.000Z" });
    expect(placeTask(task({ status: "failed" }), [run({ status: "failed" })])).toMatchObject({ place: "needs_you", fact: "Execução falhou" });
    expect(placeTask(task({ status: "cancelled" }), [])).toMatchObject({ place: "archive" });
  });

  it("distingue permissão do agente de aprovação de escopo", () => {
    expect(placeTask(task({ status: "waiting_approval", dispatchLease: "l" }), [run({ status: "running", finishedAt: null })])).toMatchObject({ place: "needs_you", fact: "Agente aguarda uma permissão" });
    expect(placeTask(task({ status: "waiting_approval" }), [])).toMatchObject({ place: "needs_you", fact: "Escopo aguardando aprovação" });
  });

  it("uma publicação pendente ou com falha pede a sua atenção; uma concluída vai para revisão", () => {
    const done = task({ status: "completed" });
    expect(placeTask(done, [run()], [action()])).toMatchObject({ place: "needs_you", fact: "Commit aguardando aprovação", at: "2026-01-01T00:06:00.000Z" });
    expect(placeTask(done, [run()], [action({ kind: "push", status: "failed" })])).toMatchObject({ place: "needs_you", fact: "Publicação falhou" });
    expect(placeTask(done, [run()], [action({ kind: "pull_request", status: "completed" }), action({ status: "rejected" })])).toMatchObject({ place: "review", fact: "Pull request aberto" });
    expect(placeTask(done, [run()], [action({ taskId: "outra" })])).toMatchObject({ place: "review", fact: "Turno concluído" });
  });
});

describe("placeTask com pull request", () => {
  const done = task({ status: "completed" });
  const pr = (over: Partial<TaskPullRequest> = {}): TaskPullRequest => ({ taskId: "task-1", directoryId: "d", headBranch: "eleazar/t", number: 12, url: "https://github.com/o/r/pull/12", title: "T", state: "open", isDraft: false,
    reviewDecision: "review_required", mergeable: "mergeable", checks: { total: 3, passed: 3, failed: 0, pending: 0, failing: [] }, fetchedAt: at, ...over });
  const place = (...prs: TaskPullRequest[]) => placeTask(done, [run()], [action({ kind: "pull_request", status: "completed" })], prs);

  it("segue CI, conflito e revisão até o merge", () => {
    expect(place(pr())).toMatchObject({ place: "in_review", fact: "Revisão pendente", pullRequest: { number: 12 } });
    expect(place(pr({ checks: { total: 3, passed: 1, failed: 0, pending: 2, failing: [] } }))).toMatchObject({ place: "in_review", fact: "Checks em execução" });
    expect(place(pr({ isDraft: true, reviewDecision: "approved" }))).toMatchObject({ place: "in_review", fact: "Rascunho" });
    expect(place(pr({ reviewDecision: "approved", checks: { total: 3, passed: 2, failed: 1, pending: 0, failing: ["e2e (chrome)"] } }))).toMatchObject({ place: "needs_you", fact: "CI falhou · e2e (chrome)" });
    expect(place(pr({ mergeable: "conflicting" }))).toMatchObject({ place: "needs_you", fact: "Conflito de merge" });
    expect(place(pr({ reviewDecision: "changes_requested" }))).toMatchObject({ place: "needs_you", fact: "Alterações solicitadas" });
    expect(place(pr({ reviewDecision: "approved" }))).toMatchObject({ place: "ready", fact: "Aprovado" });
    expect(place(pr({ reviewDecision: null }))).toMatchObject({ place: "ready", fact: "Checks aprovados" });
    expect(place(pr({ reviewDecision: null, checks: { total: 0, passed: 0, failed: 0, pending: 0, failing: [] } }))).toMatchObject({ place: "in_review", fact: "Aguardando revisão" });
    expect(place(pr({ state: "closed" }))).toMatchObject({ place: "review", fact: "Pull request fechado sem merge" });
    expect(place(pr({ state: "merged" }))).toMatchObject({ place: "archive", fact: "Pull request mesclado" });
  });

  it("com vários repositórios vale o pull request mais urgente, e o agente trabalhando tem precedência", () => {
    expect(place(pr({ reviewDecision: "approved" }), pr({ directoryId: "e", number: 13, mergeable: "conflicting" }))).toMatchObject({ place: "needs_you", pullRequest: { number: 13 } });
    expect(place(pr({ state: "merged" }), pr({ directoryId: "e", number: 13, reviewDecision: "approved" }))).toMatchObject({ place: "ready", pullRequest: { number: 13 } });
    expect(placeTask(task({ status: "running", dispatchLease: "l" }), [run({ status: "running", finishedAt: null })], [], [pr({ mergeable: "conflicting" })])).toMatchObject({ place: "working" });
    expect(place(pr({ taskId: "outra" }))).toMatchObject({ place: "review", fact: "Pull request aberto" });
  });
});

describe("relativeTime", () => {
  it("resume a idade em uma unidade", () => {
    const now = new Date("2026-01-03T00:00:00.000Z").getTime();
    expect(relativeTime("2026-01-02T23:59:40.000Z", now)).toBe("agora");
    expect(relativeTime("2026-01-02T23:55:00.000Z", now)).toBe("5 min");
    expect(relativeTime("2026-01-02T21:00:00.000Z", now)).toBe("3 h");
    expect(relativeTime(at, now)).toBe("2 d");
    expect(relativeTime("invalida", now)).toBe("agora");
  });
});
