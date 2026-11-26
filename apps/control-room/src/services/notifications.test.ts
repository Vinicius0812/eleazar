import { describe, expect, it } from "vitest";

import { notificationsBetween } from "./notifications.js";
import type { Run, Task } from "./contracts.js";

const at = "2026-01-01T00:00:00.000Z";
const task = (id: string, status: Task["status"], over: Partial<Task> = {}): Task => ({ id, projectId: "p", targetDirectoryId: "d", directoryIds: ["d"], usesWorktree: false, title: `Tarefa ${id}`, prompt: "P", priority: "normal", status, kind: "implementation", worktreePath: null, dispatchLease: null, createdAt: at, updatedAt: at, ...over });
const run = (taskId: string, status: Run["status"]): Run => ({ id: `run-${taskId}`, taskId, provider: "codex", status, startedAt: at, finishedAt: status === "running" ? null : at, summary: null });

describe("notificationsBetween", () => {
  it("avisa sobre o que passou a depender do operador e sobre turnos concluídos", () => {
    const before = { tasks: [task("a", "running", { dispatchLease: "l" }), task("b", "running", { dispatchLease: "l" }), task("c", "failed")], runs: [run("a", "running"), run("b", "running"), run("c", "failed")] };
    const after = { tasks: [task("a", "completed"), task("b", "waiting_approval", { dispatchLease: "l" }), task("c", "failed")], runs: [run("a", "completed"), run("b", "running"), run("c", "failed")] };
    const notices = notificationsBetween(before, after);
    expect(notices.map((item) => item.title)).toEqual(["O agente pede uma permissão", "Turno concluído"]);
    expect(notices[0]).toMatchObject({ body: "Tarefa b · Agente aguarda uma permissão", href: "#/executions/run-b" });
    expect(notices[1]).toMatchObject({ href: "#/tasks/a" });
  });

  it("não anuncia nada no primeiro carregamento", () => {
    expect(notificationsBetween(null, { tasks: [task("c", "failed")], runs: [run("c", "failed")] })).toEqual([]);
  });
});
