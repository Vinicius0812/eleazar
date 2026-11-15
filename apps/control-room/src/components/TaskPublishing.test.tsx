import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskFollowUp } from "./TaskFollowUp.js";
import { TaskPublishing } from "./TaskPublishing.js";
import type { Task, TaskOutboundAction } from "../services/contracts.js";

afterEach(cleanup);

const at = "2026-01-01T00:00:00.000Z";
const task: Task = { id: "task-1", projectId: "p", targetDirectoryId: "d", directoryIds: ["d"], usesWorktree: true, title: "T", prompt: "P", priority: "normal", status: "completed", kind: "implementation", worktreePath: "C:\\wt\\task-1", branch: "eleazar/t-task1", createdAt: at, updatedAt: at };
const action = (over: Partial<TaskOutboundAction> = {}): TaskOutboundAction => ({ id: "action-1", taskId: "task-1", kind: "commit", status: "pending", title: "Adiciona nota", body: null,
  targets: [{ directoryId: "d", directoryName: "API", branch: "eleazar/t-task1", remote: null, changedFiles: 2, files: ["a.ts", "b.ts"], commitsAhead: 0 }],
  result: null, requestedBy: "local-operator", createdAt: at, decidedAt: null, finishedAt: null, ...over });
const handlers = () => ({ onRequest: vi.fn(), onDecide: vi.fn(), onRemoveWorktree: vi.fn() });

describe("TaskPublishing", () => {
  it("registra um commit apenas com mensagem e não executa nada antes da aprovação", async () => {
    const on = handlers();
    render(<TaskPublishing task={task} actions={[]} busy={false} locked={false} {...on} />);
    expect(screen.getByText("eleazar/t-task1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Commit" }));
    await userEvent.type(screen.getByLabelText("Mensagem do commit"), "Adiciona nota");
    await userEvent.click(screen.getByRole("button", { name: "Revisar antes de executar" }));
    expect(on.onRequest).toHaveBeenCalledWith({ kind: "commit", title: "Adiciona nota" });
    expect(on.onDecide).not.toHaveBeenCalled();
  });

  it("mostra o que a ação pendente fará e envia a decisão do operador", async () => {
    const on = handlers();
    render(<TaskPublishing task={task} actions={[action(), action({ id: "old", status: "failed", kind: "push", title: null, result: "Falhou: sem remoto" })]} busy={false} locked={false} {...on} />);
    const card = screen.getByRole("group", { name: "Aprovação: Commit" });
    expect(card).toHaveTextContent("Adiciona nota");
    expect(card).toHaveTextContent("2 arquivo(s)");
    expect(card).toHaveTextContent("a.ts, b.ts");
    expect(screen.getByText("Falhou: sem remoto")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enviar branch" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Rejeitar" }));
    await userEvent.click(screen.getByRole("button", { name: "Aprovar e executar" }));
    expect(on.onDecide.mock.calls).toEqual([["action-1", "reject"], ["action-1", "approve"]]);
  });

  it("bloqueia novas ações enquanto o agente trabalha", () => {
    render(<TaskPublishing task={{ ...task, status: "running" }} actions={[]} busy={false} locked {...handlers()} />);
    expect(screen.getByRole("button", { name: "Commit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remover worktree" })).toBeDisabled();
    expect(screen.getByText("Disponível quando o agente terminar o turno.")).toBeInTheDocument();
  });
});

describe("TaskPublishing com pull request", () => {
  it("mostra o estado do pull request com link e pede atualização sob demanda", async () => {
    const onRefreshPullRequests = vi.fn();
    render(<TaskPublishing task={task} actions={[]} busy={false} locked={false} {...handlers()} onRefreshPullRequests={onRefreshPullRequests}
      pullRequests={[{ taskId: "task-1", directoryId: "d", headBranch: "eleazar/t-task1", number: 12, url: "https://github.com/o/r/pull/12", title: "Adiciona nota", state: "open", isDraft: false,
        reviewDecision: "changes_requested", mergeable: "conflicting", checks: { total: 4, passed: 3, failed: 1, pending: 0, failing: ["e2e"] }, fetchedAt: at }]} />);
    expect(screen.getByRole("link", { name: "#12 Adiciona nota" })).toHaveAttribute("href", "https://github.com/o/r/pull/12");
    expect(screen.getByText("3/4 checks · falhou: e2e")).toBeInTheDocument();
    expect(screen.getByText("alterações solicitadas")).toBeInTheDocument();
    expect(screen.getByText("conflito de merge")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Atualizar pull request" }));
    expect(onRefreshPullRequests).toHaveBeenCalledOnce();
  });
});

describe("TaskFollowUp", () => {
  it("envia a mensagem sem espaços nas pontas e limpa o campo", async () => {
    const onSend = vi.fn();
    render(<TaskFollowUp busy={false} resumesSession onSend={onSend} />);
    const field = screen.getByLabelText("Nova mensagem para o agente");
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
    await userEvent.type(field, "  Ajuste o teste  ");
    await userEvent.click(screen.getByRole("button", { name: "Enviar" }));
    expect(onSend).toHaveBeenCalledWith("Ajuste o teste");
    expect(field).toHaveValue("");
  });
});
