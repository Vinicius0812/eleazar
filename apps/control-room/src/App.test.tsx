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
    expect(screen.getByText(/sua sessão oficial já autenticada e trabalha no escopo aprovado/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Executar agora" }));
    expect(executeTask).toHaveBeenCalledWith(queued.id, "claude");
  });

  it("offers only the announced Codex models and sends the chosen one", async () => {
    window.location.hash = "#/tasks/task-1";
    const controlled = client();
    const snapshot = await controlled.getSnapshot();
    const queued = { ...snapshot.tasks[0]!, status: "queued" as const };
    vi.spyOn(controlled, "getSnapshot").mockResolvedValue({ ...snapshot, tasks: [queued], runs: [] });
    const getProviderConfig = vi.spyOn(controlled, "getProviderConfig").mockResolvedValue({ directoryId: "directory-1", runtime: { path: "codex", version: "9.9.9", source: "path" }, protocolVersion: 1, settings: [], models: [{ id: "m-a", name: "Modelo A" }, { id: "m-b", name: "Modelo B" }], defaultModel: "m-a" });
    const executeTask = vi.spyOn(controlled, "executeTask").mockResolvedValue(queued);
    const user = userEvent.setup();
    render(<App client={controlled} />);
    await user.click(await screen.findByRole("button", { name: "Executar tarefa" }));
    expect(getProviderConfig).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Modelo")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Provedor"), "codex");
    const model = await screen.findByLabelText("Modelo");
    expect(getProviderConfig).toHaveBeenCalledWith("codex", "directory-1");
    expect(within(model).getAllByRole("option").map((option) => option.textContent)).toEqual(["Padrão anunciado (Modelo A)", "Modelo A", "Modelo B"]);
    expect(screen.getByText("9.9.9")).toBeInTheDocument();
    await user.selectOptions(model, "m-b");
    await user.click(screen.getByRole("button", { name: "Executar agora" }));
    expect(executeTask).toHaveBeenCalledWith(queued.id, "codex", { model: "m-b" });
  });

  it("offers resuming the previous session only as an explicit opt-in and shows the API refusal", async () => {
    window.location.hash = "#/tasks/task-2";
    const controlled = client();
    const snapshot = await controlled.getSnapshot();
    const previous = { ...snapshot.tasks[0]!, status: "completed" as const };
    const queued = { ...previous, id: "task-2", status: "queued" as const };
    const earlier = { ...snapshot.runs[0]!, transport: "acp" as const, sessionId: "sess-1" };
    vi.spyOn(controlled, "getSnapshot").mockResolvedValue({ ...snapshot, tasks: [queued, previous], runs: [earlier] });
    vi.spyOn(controlled, "getProviderConfig").mockResolvedValue(catalog("codex", "1", [], null, true));
    const executeTask = vi.spyOn(controlled, "executeTask").mockRejectedValueOnce(new Error("Retomada nao suportada.")).mockResolvedValue(queued);
    const user = userEvent.setup();
    render(<App client={controlled} />);
    await user.click(await screen.findByRole("button", { name: "Executar tarefa" }));
    await user.selectOptions(screen.getByLabelText("Provedor"), "codex");
    const resume = await screen.findByLabelText(/Tentar retomar a sessão anterior/);
    expect(resume).not.toBeChecked();
    await user.click(resume);
    await user.click(screen.getByRole("button", { name: "Executar agora" }));
    expect(executeTask).toHaveBeenCalledWith(queued.id, "codex", { sessionId: "sess-1" });
    expect(await screen.findByText("Retomada nao suportada.")).toBeInTheDocument();
    await user.click(screen.getByLabelText(/Tentar retomar a sessão anterior/));
    await user.click(screen.getByRole("button", { name: "Executar agora" }));
    expect(executeTask).toHaveBeenLastCalledWith(queued.id, "codex");
  });

  it("runs Claude as a full ACP provider for any task kind, with its own catalog and model", async () => {
    window.location.hash = "#/tasks/task-1";
    const controlled = client();
    const snapshot = await controlled.getSnapshot();
    const queued = { ...snapshot.tasks[0]!, kind: "implementation", status: "queued" as const };
    vi.spyOn(controlled, "getSnapshot").mockResolvedValue({ ...snapshot, tasks: [queued], runs: [] });
    const getProviderConfig = vi.spyOn(controlled, "getProviderConfig").mockResolvedValue(catalog("claude", "3.4.5", ["sonnet", "opus"], "sonnet"));
    const executeTask = vi.spyOn(controlled, "executeTask").mockResolvedValue(queued);
    const user = userEvent.setup();
    render(<App client={controlled} />);
    await user.click(await screen.findByRole("button", { name: "Executar tarefa" }));
    await user.selectOptions(screen.getByLabelText("Provedor"), "claude");
    const model = await screen.findByLabelText("Modelo");
    expect(getProviderConfig).toHaveBeenCalledWith("claude", queued.targetDirectoryId);
    expect(within(model).getAllByRole("option").map((option) => option.textContent)).toEqual(["Padrão anunciado (sonnet)", "sonnet", "opus"]);
    expect(screen.getByText("3.4.5")).toBeInTheDocument();
    expect(screen.queryByText(/sem acesso aos arquivos/i)).not.toBeInTheDocument();
    await user.selectOptions(model, "opus");
    await user.click(screen.getByRole("button", { name: "Executar agora" }));
    expect(executeTask).toHaveBeenCalledWith(queued.id, "claude", { model: "opus" });
  });

  it("shows a visible Claude catalog failure and sends no model", async () => {
    window.location.hash = "#/tasks/task-1";
    const controlled = client();
    const snapshot = await controlled.getSnapshot();
    const queued = { ...snapshot.tasks[0]!, status: "queued" as const };
    vi.spyOn(controlled, "getSnapshot").mockResolvedValue({ ...snapshot, tasks: [queued], runs: [] });
    vi.spyOn(controlled, "getProviderConfig").mockRejectedValue(new Error("Claude indisponivel"));
    const executeTask = vi.spyOn(controlled, "executeTask").mockResolvedValue(queued);
    const user = userEvent.setup();
    render(<App client={controlled} />);
    await user.click(await screen.findByRole("button", { name: "Executar tarefa" }));
    await user.selectOptions(screen.getByLabelText("Provedor"), "claude");
    expect(await screen.findByRole("alert")).toHaveTextContent("Claude indisponivel");
    expect(screen.queryByLabelText("Modelo")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Executar agora" }));
    expect(executeTask).toHaveBeenCalledWith(queued.id, "claude");
  });

  it("drops the chosen model and ignores a late catalog when the provider changes", async () => {
    window.location.hash = "#/tasks/task-1";
    const controlled = client();
    const snapshot = await controlled.getSnapshot();
    const queued = { ...snapshot.tasks[0]!, status: "queued" as const };
    vi.spyOn(controlled, "getSnapshot").mockResolvedValue({ ...snapshot, tasks: [queued], runs: [] });
    let releaseCodex: (value: ReturnType<typeof catalog>) => void = () => undefined;
    vi.spyOn(controlled, "getProviderConfig").mockImplementation((provider) => provider === "codex"
      ? new Promise((resolve) => { releaseCodex = resolve; })
      : Promise.resolve(catalog("claude", "1.0.0", ["haiku"], null)));
    const executeTask = vi.spyOn(controlled, "executeTask").mockResolvedValue(queued);
    const user = userEvent.setup();
    render(<App client={controlled} />);
    await user.click(await screen.findByRole("button", { name: "Executar tarefa" }));
    await user.selectOptions(screen.getByLabelText("Provedor"), "codex");
    await user.selectOptions(screen.getByLabelText("Provedor"), "claude");
    expect(await screen.findByText("haiku")).toBeInTheDocument();
    await act(async () => releaseCodex(catalog("codex", "9.0.0", ["gpt-late"], null)));
    expect(screen.queryByText("gpt-late")).not.toBeInTheDocument();
    expect(screen.queryByText("9.0.0")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Modelo"), "haiku");
    await user.selectOptions(screen.getByLabelText("Provedor"), "codex");
    await user.selectOptions(screen.getByLabelText("Provedor"), "claude");
    expect(await screen.findByLabelText("Modelo")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Executar agora" }));
    expect(executeTask).toHaveBeenCalledWith(queued.id, "claude");
  });

  it("offers resume only for the same provider, scope and announced loadSession", async () => {
    window.location.hash = "#/tasks/task-9";
    const controlled = client();
    const snapshot = await controlled.getSnapshot();
    const base = snapshot.tasks[0]!;
    const queued = { ...base, id: "task-9", status: "queued" as const };
    const sibling = { ...base, id: "task-codex" };
    const otherScope = { ...base, id: "task-other", directoryIds: ["directory-1", "directory-2"] };
    const run = (id: string, taskId: string, provider: string, sessionId: string) => ({ ...snapshot.runs[0]!, id, taskId, provider, transport: "acp" as const, sessionId });
    const runs = [run("run-claude-other-scope", "task-other", "claude", "s-x"), run("run-codex", "task-codex", "codex", "s-codex"), run("run-claude", "task-codex", "claude", "s-claude")];
    vi.spyOn(controlled, "getSnapshot").mockResolvedValue({ ...snapshot, tasks: [queued, sibling, otherScope], runs });
    const config = vi.spyOn(controlled, "getProviderConfig").mockImplementation(async (provider) => catalog(provider, "1", [], null, true));
    const executeTask = vi.spyOn(controlled, "executeTask").mockResolvedValue(queued);
    const user = userEvent.setup();
    render(<App client={controlled} />);
    await user.click(await screen.findByRole("button", { name: "Executar tarefa" }));
    await user.selectOptions(screen.getByLabelText("Provedor"), "codex");
    expect(await screen.findByLabelText(/retomar a sessão anterior \(run-codex\)/)).not.toBeChecked();
    await user.selectOptions(screen.getByLabelText("Provedor"), "claude");
    const resume = await screen.findByLabelText(/retomar a sessão anterior \(run-claude\)/);
    expect(screen.queryByLabelText(/run-codex/)).not.toBeInTheDocument();
    await user.click(resume);
    await user.click(screen.getByRole("button", { name: "Executar agora" }));
    expect(executeTask).toHaveBeenCalledWith(queued.id, "claude", { sessionId: "s-claude" });
    await user.click(await screen.findByRole("button", { name: "Executar tarefa" }));
    expect(screen.getByLabelText("Provedor")).toHaveValue("auto");
    expect(screen.queryByLabelText(/retomar a sessão/)).not.toBeInTheDocument();
    // Declared false, undeclared and a failed catalog must never offer resuming.
    config.mockImplementation(async (provider) => catalog(provider, "1", [], null, false));
    await user.selectOptions(screen.getByLabelText("Provedor"), "codex");
    await screen.findByText("Detalhes do runtime");
    expect(screen.queryByLabelText(/retomar a sessão/)).not.toBeInTheDocument();
    config.mockImplementation(async (provider) => catalog(provider, "2", [], null));
    await user.selectOptions(screen.getByLabelText("Provedor"), "claude");
    await screen.findByText("2");
    expect(screen.queryByLabelText(/retomar a sessão/)).not.toBeInTheDocument();
    config.mockRejectedValue(new Error("catalogo indisponivel"));
    await user.selectOptions(screen.getByLabelText("Provedor"), "codex");
    expect(await screen.findByRole("alert")).toHaveTextContent("catalogo indisponivel");
    expect(screen.queryByLabelText(/retomar a sessão/)).not.toBeInTheDocument();
  });

  it("shows a catalog failure and runs Codex without inventing a model", async () => {
    window.location.hash = "#/tasks/task-1";
    const controlled = client();
    const snapshot = await controlled.getSnapshot();
    const queued = { ...snapshot.tasks[0]!, status: "queued" as const };
    vi.spyOn(controlled, "getSnapshot").mockResolvedValue({ ...snapshot, tasks: [queued], runs: [] });
    vi.spyOn(controlled, "getProviderConfig").mockRejectedValue(new Error("Codex indisponivel"));
    const executeTask = vi.spyOn(controlled, "executeTask").mockResolvedValue(queued);
    const user = userEvent.setup();
    render(<App client={controlled} />);
    await user.click(await screen.findByRole("button", { name: "Executar tarefa" }));
    await user.selectOptions(screen.getByLabelText("Provedor"), "codex");
    expect(await screen.findByText(/Codex indisponivel/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Modelo")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Executar agora" }));
    expect(executeTask).toHaveBeenCalledWith(queued.id, "codex");
  });

  it("links approvals to a live execution that waits for an ACP permission without treating it as scope approval", async () => {
    window.location.hash = "#/approvals";
    const controlled = client();
    const snapshot = await controlled.getSnapshot();
    const running = { ...snapshot.tasks[0]!, status: "running" as const, dispatchLease: "lease-1" };
    const run = { ...snapshot.runs[0]!, status: "running" as const, finishedAt: null };
    vi.spyOn(controlled, "getSnapshot").mockResolvedValue({ ...snapshot, tasks: [running], runs: [run] });
    const base = await controlled.getExecutionDetail("run-1");
    vi.spyOn(controlled, "getExecutionDetail").mockResolvedValue({ ...base, execution: run, task: running, permissions: [{ id: "perm-1", executionId: "run-1", toolCallId: "t", title: "Executar npm test", toolKind: "execute", toolName: "shell", locations: [], requiresElevation: false, options: [], status: "pending", selectedOptionId: null, createdAt: run.startedAt!, resolvedAt: null } as never] });
    render(<App client={controlled} />);
    expect(await screen.findByText("Executar npm test")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Abrir sessão e decidir/ }));
    expect(window.location.hash).toBe("#/executions/run-1");
    expect(screen.queryByText("Revisar proposta")).not.toBeInTheDocument();
  });

  it("treats waiting_approval with a live lease as an ACP decision, and without one as scope approval", async () => {
    window.location.hash = "#/approvals";
    const controlled = client();
    const snapshot = await controlled.getSnapshot();
    const waiting = { ...snapshot.tasks[0]!, status: "waiting_approval" as const, dispatchLease: "lease-1" };
    const run = { ...snapshot.runs[0]!, status: "running" as const, finishedAt: null };
    vi.spyOn(controlled, "getSnapshot").mockResolvedValue({ ...snapshot, tasks: [waiting], runs: [run], approvals: [] });
    const base = await controlled.getExecutionDetail("run-1");
    vi.spyOn(controlled, "getExecutionDetail").mockResolvedValue({ ...base, execution: run, task: waiting, permissions: [{ id: "perm-1", executionId: "run-1", toolCallId: "t", title: "Gravar arquivo", toolKind: "edit", toolName: "patch", locations: [], requiresElevation: false, options: [], status: "pending", selectedOptionId: null, createdAt: run.startedAt!, resolvedAt: null } as never] });
    render(<App client={controlled} />);
    await userEvent.click(await screen.findByRole("button", { name: /Abrir sessão e decidir/ }));
    expect(window.location.hash).toBe("#/executions/run-1");
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

  it("shows only queued work in next tasks while completed work remains in recent executions", async () => {
    const controlled = client();
    const snapshot = await controlled.getSnapshot();
    const completed = { ...snapshot.tasks[0]!, priority: "critical" as const };
    const queuedNormal = { ...completed, id: "task-normal", title: "Próxima normal", priority: "normal" as const, status: "queued" as const };
    const queuedHigh = { ...completed, id: "task-high", title: "Próxima alta", priority: "high" as const, status: "queued" as const };
    const running = { ...completed, id: "task-running", title: "Em andamento", status: "running" as const };
    const failed = { ...completed, id: "task-failed", title: "Falha anterior", status: "failed" as const };
    vi.spyOn(controlled, "getSnapshot").mockResolvedValue({ ...snapshot, tasks: [completed, running, queuedNormal, failed, queuedHigh] });
    render(<App client={controlled} />);
    const next = within(await screen.findByRole("region", { name: "Próximas tarefas" }));
    expect(next.getAllByRole("button", { name: /Próxima/ }).map((button) => button.textContent)).toEqual([
      expect.stringContaining("Próxima alta"), expect.stringContaining("Próxima normal")
    ]);
    expect(next.queryByText("Resultado")).not.toBeInTheDocument();
    expect(next.queryByText("Em andamento")).not.toBeInTheDocument();
    expect(next.queryByText("Falha anterior")).not.toBeInTheDocument();
    expect(next.getByRole("button", { name: /Ver fila/ })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Execuções recentes" })).getByText("Resultado")).toBeInTheDocument();
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

function catalog(provider: "codex" | "claude", version: string, models: string[], defaultModel: string | null, loadSession?: boolean) {
  return { directoryId: "directory-1", runtime: { path: provider, version, source: "path" }, protocolVersion: 1, settings: [], models: models.map((id) => ({ id, name: id })), defaultModel, ...(loadSession === undefined ? {} : { capabilities: { loadSession } }) };
}

function client(): ControlRoomClient {
  const snapshot: ControlRoomSnapshot = { projects: [{ id: "project-1", name: "Projeto", path: "C:\\Projeto", directories: [{ id: "directory-1", name: "Principal", path: "C:\\Projeto", createdAt: "2026-01-01T00:00:00.000Z", isGitRepository: true }], createdAt: "2026-01-01T00:00:00.000Z" }], tasks: [{ id: "task-1", projectId: "project-1", targetDirectoryId: "directory-1", directoryIds: ["directory-1"], usesWorktree: false, title: "Resultado", prompt: "Teste", priority: "normal", status: "completed", kind: "planning", worktreePath: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }], runs: [{ id: "run-1", taskId: "task-1", provider: "codex", status: "completed", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", summary: "Resultado" }], logs: [], approvals: [], alerts: [] };
  const detail: ExecutionDetail = { execution: snapshot.runs[0]!, task: snapshot.tasks[0]!, project: snapshot.projects[0]!, logs: [], files: [], history: snapshot.runs };
  return { getSnapshot: async () => snapshot, getExecutionDetail: async () => detail, getProviderStatuses: async () => [], registerProject: async () => snapshot.projects[0]!, createTask: async () => snapshot.tasks[0]!, executeTask: async () => snapshot.tasks[0]!, getProviderConfig: async (_provider, directoryId) => ({ directoryId, runtime: { path: "acp", version: "1.0.0", source: "path" }, protocolVersion: 1, settings: [], models: [], defaultModel: null }), getCodexConfig: async () => ({ directoryId: "directory-1", runtime: { path: "codex", version: "1.0.0", source: "path" }, protocolVersion: 1, settings: [], models: [], defaultModel: null }), streamExecutionEvents: async () => true, cancelExecution: async () => undefined, respondPermission: async () => undefined, retryTask: async () => undefined, decideApproval: async () => undefined };
}
