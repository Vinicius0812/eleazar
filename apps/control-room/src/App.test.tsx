import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import type { ControlRoomClient, ControlRoomSnapshot, ExecutionDetail } from "./services/contracts.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.location.hash = "";
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = "";
  vi.unstubAllGlobals();
});

describe("Task workspace", () => {
  it("allows choosing Claude as the first provider for a text task", async () => {
    window.location.hash = "#/tasks/task-1";
    const controlled = client();
    const snapshot = await controlled.getSnapshot();
    const queued = { ...snapshot.tasks[0]!, kind: "planning", status: "queued" as const };
    vi.spyOn(controlled, "getSnapshot").mockResolvedValue({ ...snapshot, tasks: [queued], runs: [] });
    const executeTask = vi.spyOn(controlled, "executeTask").mockResolvedValue(queued);
    const user = userEvent.setup();
    render(<App client={controlled} />);

    await user.click(await screen.findByRole("button", { name: "Executar tarefa" }));
    const provider = screen.getByLabelText("Provedor");
    expect(provider).toHaveValue("auto");
    await user.selectOptions(provider, "claude");
    expect(screen.getByText(/o título e a solicitação serão enviados ao Claude Code/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Executar agora" }));
    expect(executeTask).toHaveBeenCalledWith(queued.id, "claude");
  });

  it("creates a task from the sidebar composer and reports execution, failure, and retry", async () => {
    const controlled = client();
    let snapshot = await controlled.getSnapshot();
    const queued = { ...snapshot.tasks[0]!, id: "task-new", title: "Revisar o checkout", prompt: "Revisar o tratamento de falhas.", status: "queued" as const };
    const activeRun = { ...snapshot.runs[0]!, id: "run-new", taskId: queued.id, status: "running" as const, finishedAt: null, summary: null };
    vi.spyOn(controlled, "getSnapshot").mockImplementation(async () => snapshot);
    const createTask = vi.spyOn(controlled, "createTask").mockImplementation(async () => {
      snapshot = { ...snapshot, tasks: [queued] };
      return queued;
    });
    const executeTask = vi.spyOn(controlled, "executeTask").mockImplementation(async () => {
      const running = { ...queued, status: "running" as const };
      snapshot = {
        ...snapshot,
        tasks: [running],
        runs: [activeRun],
        logs: [{ id: "log-1", executionId: activeRun.id, level: "info", message: "Provedor iniciado no diretório-alvo.", createdAt: queued.createdAt }],
      };
      return running;
    });
    const retryTask = vi.spyOn(controlled, "retryTask").mockImplementation(async () => {
      snapshot = { ...snapshot, tasks: [queued] };
    });
    const user = userEvent.setup();
    render(<App client={controlled} />);

    await user.click(screen.getByRole("link", { name: "Nova tarefa" }));
    await user.type(await screen.findByLabelText("Título"), queued.title);
    await user.type(screen.getByLabelText("Solicitação"), queued.prompt);
    await user.click(screen.getByRole("button", { name: "Criar tarefa" }));
    const status = await screen.findByRole("status", { name: "Status da tarefa" });
    expect(status).toHaveTextContent("Na fila");
    expect(screen.getByText(queued.prompt)).toBeInTheDocument();
    expect(window.location.hash).toBe("#/tasks/task-new");
    expect(createTask).toHaveBeenCalledWith({ projectId: queued.projectId, targetDirectoryId: queued.targetDirectoryId, directoryIds: queued.directoryIds, title: queued.title, prompt: queued.prompt, priority: "normal" });

    await user.click(screen.getByRole("button", { name: "Executar tarefa" }));
    await user.click(screen.getByRole("button", { name: "Executar agora" }));
    expect(executeTask).toHaveBeenCalledWith(queued.id, "auto");
    await waitFor(() => expect(status).toHaveTextContent("Em execução"));
    expect(screen.getByText("Provedor iniciado no diretório-alvo.")).toBeInTheDocument();

    snapshot = {
      ...snapshot,
      tasks: [{ ...queued, status: "failed" }],
      runs: [{ ...activeRun, status: "failed", summary: JSON.stringify({ error: "O checkout ficou indisponível." }) }],
    };
    await waitFor(() => expect(status).toHaveTextContent("Falhou"), { timeout: 4_000 });
    expect(screen.getByText("O checkout ficou indisponível.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reenfileirar tarefa" }));
    await waitFor(() => expect(status).toHaveTextContent("Na fila"));
    expect(retryTask).toHaveBeenCalledWith(queued.id);
    expect(screen.getByRole("button", { name: "Ver última tentativa" })).toBeInTheDocument();
    expect(screen.queryByText("O checkout ficou indisponível.")).not.toBeInTheDocument();
  }, 9_000);

  it("explains that approval blocks execution and returns the task to the queue", async () => {
    window.location.hash = "#/tasks/task-1";
    const controlled = client();
    let snapshot = await controlled.getSnapshot();
    const task = snapshot.tasks[0]!;
    snapshot = {
      ...snapshot,
      tasks: [{ ...task, status: "waiting_approval" }],
      runs: [],
      approvals: [{ id: task.id, taskId: task.id, title: task.title, description: "Revise os diretórios afetados.", action: "Liberar para a fila" }],
    };
    vi.spyOn(controlled, "getSnapshot").mockImplementation(async () => snapshot);
    const decideApproval = vi.spyOn(controlled, "decideApproval").mockImplementation(async () => {
      snapshot = { ...snapshot, tasks: [{ ...task, status: "queued" }], approvals: [] };
    });
    const user = userEvent.setup();
    render(<App client={controlled} />);
    const status = await screen.findByRole("status", { name: "Status da tarefa" });
    expect(status).toHaveTextContent("Aguardando aprovação");
    expect(screen.queryByRole("button", { name: "Executar tarefa" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Revisar aprovação" }));
    await user.click(screen.getByRole("button", { name: "Aprovar proposta" }));
    await waitFor(() => expect(status).toHaveTextContent("Na fila"));
    expect(decideApproval).toHaveBeenCalledWith(task.id, "approve");
    expect(screen.getByRole("button", { name: "Executar tarefa" })).toBeInTheDocument();
  });

  it("stops polling at completion, keeps previous executions accessible and renders agent content safely", async () => {
    window.location.hash = "#/tasks/task-1";
    vi.useFakeTimers();
    const controlled = client();
    const initial = await controlled.getSnapshot();
    const task = initial.tasks[0]!;
    const previous = { ...initial.runs[0]!, id: "run-previous", status: "failed" as const, summary: "Falha anterior" };
    const run = {
      ...initial.runs[0]!,
      output: "**Concluído.** [Leia](https://example.com) [Atalho](javascript:alert%281%29)\n\n![Imagem do agente](https://example.com/tracker.png)\n\n<script>alert(1)</script>",
    };
    const completed = { ...initial, runs: [run, previous] };
    const getSnapshot = vi.spyOn(controlled, "getSnapshot")
      .mockResolvedValueOnce({ ...initial, tasks: [{ ...task, status: "running" }], runs: [{ ...run, status: "running" }, previous] })
      .mockResolvedValue(completed);
    const getExecutionDetail = vi.spyOn(controlled, "getExecutionDetail").mockImplementation(async (id) => ({
      execution: id === run.id ? run : previous,
      task,
      project: initial.projects[0]!,
      logs: [],
      files: [],
      history: completed.runs,
    }));
    const { container } = await act(async () => render(<App client={controlled} />));
    expect(screen.getByRole("status", { name: "Status da tarefa" })).toHaveTextContent("Em execução");

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByRole("status", { name: "Status da tarefa" })).toHaveTextContent("Concluída");
    expect(screen.getByText("Concluído.").tagName).toBe("STRONG");
    expect(screen.getByRole("link", { name: "Leia" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText("[Imagem: Imagem do agente]")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Atalho" })).not.toBeInTheDocument();
    expect(container.querySelector("img, script")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(getSnapshot).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Ver detalhes da execução" }));
    const history = await screen.findByRole("complementary", { name: "Histórico da tarefa" });
    await user.click(within(history).getByRole("button", { name: /Falhou/ }));
    await waitFor(() => expect(getExecutionDetail).toHaveBeenCalledWith(previous.id));
    expect(await screen.findByText("Falha anterior")).toBeInTheDocument();
  });
});

describe("Control Room routes", () => {
  it("navigates to a dedicated task screen instead of scrolling inside overview", async () => {
    window.location.hash = "#/projects";
    render(<App client={client()} />);
    expect(await screen.findByRole("heading", { name: "Projetos" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Fila de tarefas" }));
    await waitFor(() => expect(window.location.hash).toBe("#/tasks"));
    expect(screen.getAllByRole("heading", { name: "Fila de tarefas" })).toHaveLength(2);
  });

  it("keeps the application shell around a direct execution URL", async () => {
    window.location.hash = "#/executions/run-1";
    render(<App client={client()} />);
    expect(await screen.findByRole("heading", { name: "Resultado" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Eleazar/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Criar tarefa relacionada" })).toBeInTheDocument();
  });

  it("restores a collapsed sidebar preference", async () => {
    window.localStorage.setItem("eleazar.sidebarCollapsed", "true");
    render(<App client={client()} />);
    expect(await screen.findByRole("heading", { name: "Sala de controle" })).toBeInTheDocument();
    expect(document.querySelector(".shell")).toHaveClass("sidebar-collapsed");
  });

  it("starts narrow screens with a compact sidebar without overwriting the desktop preference", async () => {
    window.localStorage.setItem("eleazar.sidebarCollapsed", "false");
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query.includes("max-width") })));
    render(<App client={client()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Expandir menu" }));
    expect(screen.getByRole("button", { name: "Recolher menu" })).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("link", { name: "Nova tarefa" }));
    expect(await screen.findByRole("button", { name: "Expandir menu" })).toHaveAttribute("aria-expanded", "false");
    expect(window.localStorage.getItem("eleazar.sidebarCollapsed")).toBe("false");
  });

  it("keeps local API information only in the sidebar and uses a compact overview", async () => {
    render(<App client={client()} />);
    expect(await screen.findByText("Modo local · API loopback")).toBeInTheDocument();
    expect(screen.queryByText("API LOCAL")).not.toBeInTheDocument();
    expect(screen.queryByText(/Ambiente local/i)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Próximas tarefas" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Execuções recentes" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Seus projetos" })).not.toBeInTheDocument();
  });

  it("switches themes and persists the manual preference", async () => {
    render(<App client={client()} />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Sala de controle" });
    expect(document.documentElement.dataset.theme).toBe("light");
    await user.click(screen.getByRole("button", { name: "Ativar modo escuro" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("eleazar.theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "Ativar modo claro" })).toHaveAttribute("aria-pressed", "true");
  });

  it("uses the saved theme before falling back to the system preference", async () => {
    window.localStorage.setItem("eleazar.theme", "light");
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    render(<App client={client()} />);
    await screen.findByRole("heading", { name: "Sala de controle" });
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("uses the system preference on a first visit", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    render(<App client={client()} />);
    await screen.findByRole("heading", { name: "Sala de controle" });
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("creates a related task with the complete execution context inherited", async () => {
    window.location.hash = "#/executions/run-1";
    const controlled = client(); const createTask = vi.spyOn(controlled, "createTask");
    render(<App client={controlled} />);
    await userEvent.click(await screen.findByRole("button", { name: "Criar tarefa relacionada" }));
    await userEvent.type(screen.getByLabelText("Título"), "Próxima etapa");
    await userEvent.type(screen.getByLabelText("Prompt"), "Continue a análise");
    await userEvent.click(screen.getByRole("button", { name: "Criar tarefa" }));
    await waitFor(() => expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-1", targetDirectoryId: "directory-1", directoryIds: ["directory-1"], priority: "normal", kind: "planning", title: "Próxima etapa", prompt: "Continue a análise" })));
  });
});

function client(): ControlRoomClient {
  const snapshot: ControlRoomSnapshot = { projects: [{ id: "project-1", name: "Projeto", path: "C:\\Projeto", directories: [{ id: "directory-1", name: "Principal", path: "C:\\Projeto", createdAt: "2026-01-01T00:00:00.000Z", isGitRepository: true }], createdAt: "2026-01-01T00:00:00.000Z" }], tasks: [{ id: "task-1", projectId: "project-1", targetDirectoryId: "directory-1", directoryIds: ["directory-1"], usesWorktree: false, title: "Resultado", prompt: "Teste", priority: "normal", status: "completed", kind: "planning", worktreePath: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }], runs: [{ id: "run-1", taskId: "task-1", provider: "codex", status: "completed", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", summary: "Resultado" }], logs: [], approvals: [], alerts: [] };
  const detail: ExecutionDetail = { execution: snapshot.runs[0]!, task: snapshot.tasks[0]!, project: snapshot.projects[0]!, logs: [], files: [], history: snapshot.runs };
  return { getSnapshot: async () => snapshot, getExecutionDetail: async () => detail, getProviderStatuses: async () => [], registerProject: async () => snapshot.projects[0]!, createTask: async () => snapshot.tasks[0]!, executeTask: async () => snapshot.tasks[0]!, retryTask: async () => undefined, decideApproval: async () => undefined };
}
