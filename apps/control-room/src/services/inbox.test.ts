import { describe, expect, it } from "vitest";

import { needsYou } from "./inbox.js";
import type { Run, Task, TaskOutboundAction } from "./contracts.js";

const at = "2026-01-01T00:00:00.000Z";
const task = (id: string, over: Partial<Task> = {}): Task => ({ id, projectId: "p", targetDirectoryId: "d", directoryIds: ["d"], usesWorktree: false, title: id, prompt: "P", priority: "normal", status: "queued", kind: "implementation", worktreePath: null, dispatchLease: null, createdAt: at, updatedAt: at, ...over });
const run = (taskId: string, over: Partial<Run> = {}): Run => ({ id: `run-${taskId}`, taskId, provider: "codex", status: "completed", startedAt: at, finishedAt: at, summary: null, ...over });
const action = (taskId: string): TaskOutboundAction => ({ id: `a-${taskId}`, taskId, kind: "push", status: "pending", title: null, body: null, targets: [], result: null, requestedBy: "op", createdAt: at, decidedAt: null, finishedAt: null });

describe("needsYou", () => {
  it("reúne permissões, publicações, escopos e falhas, do mais bloqueante ao menos", () => {
    const items = needsYou({
      tasks: [task("falhou", { status: "failed" }), task("escopo", { status: "waiting_approval" }), task("pronta"), task("push", { status: "completed" }),
        task("permissao", { status: "waiting_approval", dispatchLease: "l" }), task("concluida", { status: "completed" })],
      runs: [run("falhou", { status: "failed" }), run("push"), run("permissao", { status: "running", finishedAt: null }), run("concluida")],
      actions: [action("push")],
    });
    expect(items.map((item) => [item.task.id, item.reason])).toEqual([["permissao", "permission"], ["push", "publication"], ["escopo", "scope"], ["falhou", "failure"]]);
    expect(items[0]!.href).toBe("#/executions/run-permissao");
    expect(items[1]!.href).toBe("#/tasks/push/publish");
    expect(items[1]!.fact).toBe("Envio da branch aguardando aprovação");
    expect(items[3]!.href).toBe("#/tasks/falhou");
  });
});
