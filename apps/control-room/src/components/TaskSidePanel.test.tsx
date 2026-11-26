import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ProviderStatus, Run, Task } from "../services/contracts.js";
import { recruitedAgents, TaskSidePanel } from "./TaskSidePanel.js";

afterEach(cleanup);

const at = "2026-01-01T00:00:00.000Z";
const task = (over: Partial<Task> = {}): Task => ({ id: "t", projectId: "p", targetDirectoryId: "d", directoryIds: ["d"], usesWorktree: true, title: "T", prompt: "P", priority: "high", status: "completed", kind: "implementation", worktreePath: null, branch: "eleazar/t", createdAt: at, updatedAt: at, ...over });
const run = (id: string, provider: string, over: Partial<Run> = {}): Run => ({ id, taskId: "t", provider, status: "completed", startedAt: at, finishedAt: at, summary: null, transport: "acp", model: null, ...over });
const providers = [{ provider: "claude", label: "Claude Code" }, { provider: "codex", label: "Codex" }] as unknown as ProviderStatus[];

describe("TaskSidePanel", () => {
  it("lists each recruited agent with its role, model and provider", () => {
    // Runs arrive newest first: Codex implemented, then Claude continued twice with the same model.
    const runs = [run("r3", "claude", { model: "opus", usage: { total: 50 } }), run("r2", "claude", { model: "opus", usage: { total: 25 } }), run("r1", "codex", { model: "gpt-5" })];
    const agents = recruitedAgents(task(), runs, [], providers);
    expect(agents.map((agent) => [agent.label, agent.role, agent.model, agent.turns, agent.tokens])).toEqual([
      ["Codex", "Executor principal", "gpt-5", 1, 0],
      ["Claude Code", "Continuou a tarefa", "opus", 2, 75],
    ]);
  });

  it("shows comparison rivals and where the task works", () => {
    const sibling = task({ id: "s", title: "T · Claude" });
    render(<TaskSidePanel task={task({ comparisonId: "c" })} project={{ id: "p", name: "P", path: "C:\\p", isolation: "worktree", createdAt: at, directories: [{ id: "d", name: "Principal", path: "C:\\p", createdAt: at, isGitRepository: true }] }}
      runs={[run("r1", "codex")]} siblings={[{ task: sibling, runs: [run("s1", "claude", { taskId: "s" })] }]} providers={providers} />);
    const panel = within(screen.getByRole("complementary", { name: "Detalhes da tarefa" }));
    expect(panel.getByText("Executor nesta tentativa")).toBeInTheDocument();
    expect(panel.getByText("Tentativa concorrente na comparação")).toBeInTheDocument();
    expect(panel.getByRole("link", { name: "Abrir tentativa" })).toHaveAttribute("href", "#/tasks/s");
    expect(panel.getByText("eleazar/t")).toBeInTheDocument();
    expect(panel.getByText("Principal")).toBeInTheDocument();
    expect(panel.getAllByText("Padrão do provedor")).toHaveLength(2);
  });
});
