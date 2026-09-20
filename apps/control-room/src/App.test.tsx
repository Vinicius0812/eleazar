import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import type { ControlRoomClient, ControlRoomSnapshot, ExecutionDetail } from "./services/contracts.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = "";
  vi.unstubAllGlobals();
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
