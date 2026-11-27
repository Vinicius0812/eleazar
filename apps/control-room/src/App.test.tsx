import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import type { AcpProvider, ControlRoomClient, ControlRoomSnapshot, ExecutionDetail, ProviderStatus } from "./services/contracts.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.location.hash = "";
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = "";
  vi.unstubAllGlobals();
});

describe("File explorer", () => {
  it("opens from the task and shows the diff of a changed file", async () => {
    window.location.hash = "#/tasks/task-1";
    const user = userEvent.setup();
    render(<App client={client()} />);
    await user.click(await screen.findByRole("link", { name: "Explorar arquivos" }));
    expect(window.location.hash).toBe("#/tasks/task-1/files");
    await user.click(await screen.findByRole("button", { name: /README\.md/ }));
    const diff = await screen.findByRole("region", { name: "Diff do arquivo" });
    expect(within(diff).getByText("velho")).toBeInTheDocument();
    expect(within(diff).getByText("novo")).toBeInTheDocument();
    expect(window.location.hash).toBe("#/tasks/task-1/files?directory=directory-1&path=README.md");
    await user.click(screen.getByRole("button", { name: /Conteúdo/ }));
    expect(await screen.findByRole("region", { name: "Conteúdo do arquivo" })).toHaveTextContent("novo");
    await user.click(screen.getByRole("button", { name: /Voltar à tarefa/ }));
    expect(window.location.hash).toBe("#/tasks/task-1");
  });
});

describe("Task tabs", () => {
  it("moves between conversation, files and publication of the same task", async () => {
    window.location.hash = "#/tasks/task-1";
    const user = userEvent.setup();
    render(<App client={client()} />);
    const tabs = within(await screen.findByRole("navigation", { name: "Seções da tarefa" }));
    expect(tabs.getByRole("link", { name: /Conversa/ })).toHaveAttribute("aria-current", "page");
    await user.click(tabs.getByRole("link", { name: /Publicação/ }));
    expect(window.location.hash).toBe("#/tasks/task-1/publish");
    expect(await screen.findByText("Nada para publicar por aqui")).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Você está em" })).getByText("Publicação")).toHaveAttribute("aria-current", "location");
    await user.click(within(screen.getByRole("navigation", { name: "Seções da tarefa" })).getByRole("link", { name: /Arquivos/ }));
    expect(window.location.hash).toBe("#/tasks/task-1/files");
    expect(await screen.findByRole("button", { name: /README\.md/ })).toBeInTheDocument();
    await user.click(within(screen.getByRole("navigation", { name: "Seções da tarefa" })).getByRole("link", { name: /Conversa/ }));
    expect(window.location.hash).toBe("#/tasks/task-1");
    expect(await screen.findByRole("heading", { name: "Sua solicitação" })).toBeInTheDocument();
  });
});

describe("Needs you", () => {
  it("lists what waits on the operator and counts it in the menu", async () => {
    window.location.hash = "#/inbox";
    const controlled = client();
    const snapshot = await controlled.getSnapshot();
    vi.spyOn(controlled, "getSnapshot").mockResolvedValue({ ...snapshot, tasks: [{ ...snapshot.tasks[0]!, status: "failed" }], runs: [{ ...snapshot.runs[0]!, status: "failed" }] });
    render(<App client={controlled} />);
    const list = within(await screen.findByRole("list", { name: "Itens que precisam de você" }));
    expect(list.getByText("Resultado")).toBeInTheDocument();
    expect(list.getByRole("link", { name: "Ver motivo: Resultado" })).toHaveAttribute("href", "#/tasks/task-1");
    expect(screen.getByRole("link", { name: "Precisa de você" })).toHaveTextContent("1");
  });
});

describe("Keyboard shortcuts", () => {
  it("goes to a screen with G then a key and lists the shortcuts with ?", async () => {
    window.location.hash = "#/overview";
    const user = userEvent.setup();
    render(<App client={client()} />);
    await screen.findByRole("heading", { name: "Sala de controle" });
    await user.keyboard("gi");
    await waitFor(() => expect(window.location.hash).toBe("#/inbox"));
    await user.keyboard("?");
    const dialog = within(await screen.findByRole("dialog", { name: "Atalhos de teclado" }));
    expect(dialog.getByText("Ir para Precisa de você")).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "Entendi" }));
    window.location.hash = "#/tasks/task-1";
    await screen.findByRole("heading", { name: "Sua solicitação" });
    await user.keyboard("3");
    await waitFor(() => expect(window.location.hash).toBe("#/tasks/task-1/publish"));
  });
});

describe("Agent comparison", () => {
  it("starts two agents from the composer and shows both diffs side by side", async () => {
    window.location.hash = "#/tasks/new";
    const controlled = client();
    const snapshot = await controlled.getSnapshot();
    const attempt = (id: string, provider: string) => ({ task: { ...snapshot.tasks[0]!, id, title: `Corrigir · ${provider}`, comparisonId: "cmp", status: "completed" as const }, run: { ...snapshot.runs[0]!, id: `run-${id}`, taskId: id, provider, summary: `Feito pelo ${provider}` } });
    const a = attempt("a", "codex"); const b = attempt("b", "claude");
    const startComparison = vi.spyOn(controlled, "startComparison").mockImplementation(async () => {
      vi.spyOn(controlled, "getSnapshot").mockResolvedValue({ ...snapshot, tasks: [a.task, b.task], runs: [a.run, b.run] });
      return { comparisonId: "cmp", tasks: [a.task, b.task], errors: [] };
    });
    vi.spyOn(controlled, "getTaskFile").mockImplementation(async (taskId, _directory, path) => ({ root: explorerRoot, path, exists: true, size: 4, binary: false, content: "x", tooLarge: false, change: null,
      diff: `@@ -1 +1 @@
-velho
+versao-${taskId}
`, diffTruncated: false }));
    const choose = vi.spyOn(controlled, "chooseComparisonAttempt").mockResolvedValue([]);
    const user = userEvent.setup();
    render(<App client={controlled} />);
    await user.type(await screen.findByLabelText("Solicitação"), "Corrigir o login");
    await user.click(screen.getByText("Tipo, prioridade e escopo"));
    await user.click(await screen.findByLabelText(/Rodar com dois agentes/));
    await user.selectOptions(screen.getByLabelText("Segundo agente"), "claude");
    await user.click(screen.getByRole("button", { name: /Criar e comparar/ }));
    expect(startComparison).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Corrigir o login", directoryIds: ["directory-1"] }), ["codex", "claude"]);
    await waitFor(() => expect(window.location.hash).toBe("#/comparisons/cmp"));
    expect(await screen.findByText("Feito pelo claude")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "README.md" }));
    const diffs = within(await screen.findByRole("group", { name: "Diffs de README.md" }));
    expect(await diffs.findByText("versao-a")).toBeInTheDocument();
    expect(diffs.getByText("versao-b")).toBeInTheDocument();
    await user.click(within(screen.getByRole("article", { name: "Tentativa Corrigir · codex" })).getByRole("button", { name: /Ficar com esta versão/ }));
    expect(choose).toHaveBeenCalledWith("cmp", "a");
    await waitFor(() => expect(window.location.hash).toBe("#/tasks/a"));
  });
});

describe("Resume", () => {
  it("resumes an interrupted turn with the same agent", async () => {
    window.location.hash = "#/tasks/task-1";
    const controlled = client();
    const snapshot = await controlled.getSnapshot();
    vi.spyOn(controlled, "getSnapshot").mockResolvedValue({ ...snapshot, tasks: [{ ...snapshot.tasks[0]!, status: "failed" }], runs: [{ ...snapshot.runs[0]!, status: "failed", summary: "Host local reiniciado; execucao interrompida." }] });
    const resume = vi.spyOn(controlled, "resumeTask").mockResolvedValue(snapshot.tasks[0]!);
    const user = userEvent.setup();
    render(<App client={controlled} />);
    await user.click(await screen.findByRole("button", { name: /Retomar de onde parou/ }));
    expect(resume).toHaveBeenCalledWith("task-1");
    expect(await screen.findByText("Execução retomada de onde parou.")).toBeInTheDocument();
  });
});

describe("Task templates", () => {
  it("starts a task from a saved template and saves the current request as a new one", async () => {
    window.location.hash = "#/tasks/new";
    const controlled = client();
    const saved = { id: "tpl-1", name: "Revisar PR", title: "Revisão do PR", prompt: "Revise o PR aberto.", kind: "review", priority: "high" as const, projectId: "project-1", createdAt: "2026-01-01T00:00:00.000Z" };
    vi.spyOn(controlled, "listTemplates").mockResolvedValue([saved]);
    const createTask = vi.spyOn(controlled, "createTask");
    const createTemplate = vi.spyOn(controlled, "createTemplate");
    const user = userEvent.setup();
    render(<App client={controlled} />);
    await user.selectOptions(await screen.findByLabelText("Começar de um modelo"), "tpl-1");
    expect(screen.getByLabelText("Solicitação")).toHaveValue("Revise o PR aberto.");
    expect(screen.getByLabelText("Título")).toHaveValue("Revisão do PR");
    await user.click(screen.getByRole("button", { name: /Salvar como modelo/ }));
    const name = screen.getByLabelText("Nome do modelo");
    await user.clear(name);
    await user.type(name, "Outro modelo");
    await user.click(screen.getByRole("button", { name: "Salvar modelo" }));
    expect(createTemplate).toHaveBeenCalledWith({ name: "Outro modelo", prompt: "Revise o PR aberto.", title: "Revisão do PR", kind: "review", priority: "high", projectId: "project-1" });
    await user.click(screen.getByRole("button", { name: /Criar tarefa/ }));
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Revise o PR aberto.", title: "Revisão do PR", kind: "review", priority: "high" }));
  });
});

describe("Project page", () => {
  it("lists the project's tasks and explores its own folders", async () => {
    window.location.hash = "#/projects/project-1";
    const user = userEvent.setup();
    render(<App client={client()} />);
    expect(await screen.findByRole("heading", { name: "Projeto", level: 1 })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Projeto" })).getByRole("link", { name: "Resultado" })).toHaveAttribute("href", "#/tasks/task-1");
    await user.click(within(screen.getByRole("navigation", { name: "Seções do projeto" })).getByRole("link", { name: /Arquivos/ }));
    expect(window.location.hash).toBe("#/projects/project-1/files");
    await user.click(await screen.findByRole("tab", { name: /Todos os arquivos/ }));
    await user.click(await screen.findByRole("button", { name: /package\.json/ }));
    expect(await screen.findByRole("region", { name: "Conteúdo do arquivo" })).toHaveTextContent("{}");
    expect(window.location.hash).toBe("#/projects/project-1/files?directory=directory-1&path=package.json");
  });
});

describe("Pin and delete tasks", () => {
  it("pins a task from its screen and deletes it after confirmation, returning to the project", async () => {
    window.location.hash = "#/tasks/task-1";
    const controlled = client();
    const pin = vi.spyOn(controlled, "pinTask");
    const remove = vi.spyOn(controlled, "deleteTask");
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const user = userEvent.setup();
    render(<App client={controlled} />);
    await user.click(await screen.findByRole("button", { name: "Fixar Resultado" }));
    expect(pin).toHaveBeenCalledWith("task-1", true);
    await user.click(screen.getByRole("button", { name: "Excluir Resultado" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Excluir Resultado" }));
    expect(remove).toHaveBeenCalledWith("task-1");
    await waitFor(() => expect(window.location.hash).toBe("#/projects/project-1"));
  });
});

describe("Edit project", () => {
  it("renames the project and a directory label, keeps its path fixed and adds a folder", async () => {
    window.location.hash = "#/projects/project-1";
    const controlled = client();
    const update = vi.spyOn(controlled, "updateProject");
    const user = userEvent.setup();
    render(<App client={controlled} />);
    await user.click(await screen.findByRole("button", { name: /Editar projeto/ }));
    const dialog = within(await screen.findByRole("dialog", { name: "Editar projeto" }));
    const name = dialog.getByLabelText("Nome do projeto");
    await user.clear(name);
    await user.type(name, "Renomeado");
    const labels = dialog.getAllByLabelText("Rótulo do diretório");
    await user.clear(labels[0]!);
    await user.type(labels[0]!, "Raiz");
    expect(dialog.getAllByLabelText("Caminho local absoluto")[0]).toHaveAttribute("readonly");
    await user.click(dialog.getByRole("button", { name: /Adicionar diretório/ }));
    await user.type(dialog.getAllByLabelText("Caminho local absoluto")[1]!, "C:\\Outro");
    await user.click(dialog.getByRole("button", { name: "Salvar alterações" }));
    expect(update).toHaveBeenCalledWith("project-1", { name: "Renomeado", isolation: "worktree", directories: [{ id: "directory-1", name: "Raiz" }, { name: "", path: "C:\\Outro" }] });
    expect(await screen.findByText("Projeto atualizado.")).toBeInTheDocument();
  });
});

describe("Skills and agents", () => {
  const skill = { id: "s1", slug: "gerar-prompts", name: "gerar-prompts", description: "Prompts por repositório", content: "# Gerar prompts", source: "claude" as const, sourcePath: "C:\\Users\\x\\.claude\\skills\\gerar-prompts\\SKILL.md", supportFiles: [], importedHash: "h", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  const agent = { id: "a1", name: "Revisor", role: "Revisa código", instructions: "Aponte riscos.", skillIds: ["s1"], provider: "claude", model: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };

  it("edits an imported skill without touching the original", async () => {
    window.location.hash = "#/skills";
    const controlled = client();
    vi.spyOn(controlled, "listSkills").mockResolvedValue([skill]);
    const update = vi.spyOn(controlled, "updateSkill").mockResolvedValue({ ...skill, content: "Nova" });
    const user = userEvent.setup();
    render(<App client={controlled} />);
    await user.click(await screen.findByRole("button", { name: /gerar-prompts/ }));
    const form = within(screen.getByRole("form", { name: "Editar gerar-prompts" }));
    expect(form.getByText(/Editar aqui não altera o original/)).toBeInTheDocument();
    await user.clear(form.getByLabelText("Conteúdo"));
    await user.type(form.getByLabelText("Conteúdo"), "Nova");
    await user.click(form.getByRole("button", { name: "Salvar skill" }));
    expect(update).toHaveBeenCalledWith("s1", { name: "gerar-prompts", description: "Prompts por repositório", content: "Nova" });
  });

  it("explains the expected format, previews the attached files and imports with the chosen conflict rule", async () => {
    window.location.hash = "#/skills";
    const controlled = client();
    const preview = vi.spyOn(controlled, "previewCatalogImport").mockResolvedValue({
      skills: [{ name: "gerar-prompts", origin: "claude", status: "conflict", path: "skills/gerar-prompts/SKILL.md" }, { name: "nova", origin: "eleazar", status: "new", path: "skills/nova/SKILL.md" }],
      agents: [{ name: "Revisor", status: "same", path: "agents/revisor.json", missingSkills: [] }], ignored: ["README.txt"], warnings: [] });
    const importCatalog = vi.spyOn(controlled, "importCatalog");
    const user = userEvent.setup();
    render(<App client={controlled} />);
    await user.click(await screen.findByRole("button", { name: "Importar" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Importar skills e agentes" }));
    expect(dialog.getByRole("note")).toHaveTextContent("skills/<nome>/SKILL.md");
    await user.click(dialog.getByRole("button", { name: /Entendi, escolher arquivos/ }));
    const file = new File(["---\nname: nova\n---\nConteúdo"], "SKILL.md", { type: "text/markdown" });
    Object.defineProperty(file, "webkitRelativePath", { value: "minhas/skills/nova/SKILL.md" });
    await user.upload(dialog.getByLabelText("Pasta do catálogo"), file);
    await waitFor(() => expect(dialog.queryByRole("alert")?.textContent ?? "sem erro").toBe("sem erro"));
    await waitFor(() => expect(preview).toHaveBeenCalledWith({ files: [{ path: "minhas/skills/nova/SKILL.md", text: "---\nname: nova\n---\nConteúdo" }] }));
    const list = within(await dialog.findByRole("list", { name: "Prévia da importação" }));
    expect(list.getByText("Conflito")).toBeInTheDocument();
    expect(dialog.getByText("1 arquivo(s) fora do formato foram ignorados.")).toBeInTheDocument();
    await user.click(dialog.getByLabelText(/Manter os dois/));
    await user.click(dialog.getByRole("button", { name: "Importar 2 item(ns)" }));
    expect(importCatalog).toHaveBeenCalledWith({ files: [{ path: "minhas/skills/nova/SKILL.md", text: "---\nname: nova\n---\nConteúdo" }] }, "duplicate");
    expect(await screen.findByText(/Importação concluída/)).toBeInTheDocument();
  });

  it("creates an agent with skills and a preferred provider", async () => {
    window.location.hash = "#/agents";
    const controlled = client();
    vi.spyOn(controlled, "listSkills").mockResolvedValue([skill]);
    const create = vi.spyOn(controlled, "createAgent").mockResolvedValue(agent);
    const user = userEvent.setup();
    render(<App client={controlled} />);
    await user.click(await screen.findByRole("button", { name: /Novo agente/ }));
    const form = within(screen.getByRole("form", { name: "Novo agente" }));
    await user.type(form.getByLabelText("Nome"), "Revisor");
    await user.type(form.getByLabelText("Função"), "Revisa código");
    await user.selectOptions(form.getByLabelText("Provedor preferido"), "claude");
    await user.click(await form.findByRole("checkbox", { name: /gerar-prompts/ }));
    await user.click(form.getByRole("button", { name: "Criar agente" }));
    expect(create).toHaveBeenCalledWith({ name: "Revisor", role: "Revisa código", instructions: "", skillIds: ["s1"], provider: "claude", model: null });
  });

  it("sends the chosen agent and extra skills with a new task", async () => {
    window.location.hash = "#/tasks/new";
    const controlled = client();
    vi.spyOn(controlled, "listSkills").mockResolvedValue([skill, { ...skill, id: "s2", name: "documentacao", source: "codex" }]);
    vi.spyOn(controlled, "listAgents").mockResolvedValue([agent]);
    const createTask = vi.spyOn(controlled, "createTask");
    const user = userEvent.setup();
    render(<App client={controlled} />);
    await user.type(await screen.findByLabelText("Solicitação"), "Revise o módulo");
    await user.click(await screen.findByText(/Agente e skills/));
    await user.selectOptions(screen.getByRole("combobox", { name: /^Agente/ }), "a1");
    expect(screen.getByRole("checkbox", { name: "gerar-prompts" })).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "documentacao" }));
    await user.click(screen.getByRole("button", { name: /Criar tarefa/ }));
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ agentProfileId: "a1", skillIds: ["s2"] }));
  });
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

  it("offers the providers the host registered, without the disabled or signed-out ones", async () => {
    window.location.hash = "#/tasks/task-1";
    const controlled = client();
    const snapshot = await controlled.getSnapshot();
    const queued = { ...snapshot.tasks[0]!, status: "queued" as const };
    vi.spyOn(controlled, "getSnapshot").mockResolvedValue({ ...snapshot, tasks: [queued], runs: [] });
    vi.spyOn(controlled, "getProviderStatuses").mockResolvedValue([
      providerStatus("codex", { authenticated: false }), providerStatus("quarto", { label: "Quarto agente" }),
      providerStatus("claude", { preferences: { enabled: false, automatic: true, executablePath: null, defaultModel: null } }),
      providerStatus("antigravity", { preferences: { enabled: true, automatic: false, executablePath: null, defaultModel: "m-b" } })]);
    vi.spyOn(controlled, "getProviderConfig").mockImplementation(async (provider) => catalog(provider, "1", ["m-a", "m-b"], "m-a"));
    const executeTask = vi.spyOn(controlled, "executeTask").mockResolvedValue(queued);
    const user = userEvent.setup();
    render(<App client={controlled} />);
    await user.click(await screen.findByRole("button", { name: "Executar tarefa" }));
    const provider = screen.getByLabelText("Provedor");
    await within(provider).findByRole("option", { name: "Quarto agente" });
    expect(within(provider).getAllByRole("option").map((option) => option.textContent)).toEqual(["Automático (recomendado)", "Codex (falta entrar na conta)", "Quarto agente", "Antigravity"]);
    expect(within(provider).getByRole("option", { name: /Codex/ })).toBeDisabled();
    expect(screen.getByText(/Escolhe entre Codex, Quarto agente conforme/)).toBeInTheDocument();
    await user.selectOptions(provider, "antigravity");
    expect(await screen.findByRole("option", { name: "Seu padrão (m-b)" })).toBeInTheDocument();
    await user.selectOptions(provider, "quarto");
    await user.click(screen.getByRole("button", { name: "Executar agora" }));
    expect(executeTask).toHaveBeenCalledWith(queued.id, "quarto");
  });

  it("opens the providers screen and applies what the host answers", async () => {
    window.location.hash = "#/providers";
    const controlled = client();
    vi.spyOn(controlled, "getProviderStatuses").mockResolvedValue([providerStatus("antigravity", { authenticated: null })]);
    const verify = vi.spyOn(controlled, "verifyProvider").mockResolvedValue([providerStatus("antigravity")]);
    vi.spyOn(controlled, "updateProvider").mockRejectedValue(new Error("O executavel informado nao existe."));
    const user = userEvent.setup();
    render(<App client={controlled} />);
    const card = within(await screen.findByRole("article", { name: "Antigravity" }));
    expect(card.getByText("Login não confirmado")).toBeInTheDocument();
    await user.click(card.getByRole("button", { name: /Verificar conexão/ }));
    expect(verify).toHaveBeenCalledWith("antigravity");
    expect(await card.findByText("Pronto")).toBeInTheDocument();
    await user.click(card.getByLabelText("Ativo"));
    expect(await screen.findByRole("alert")).toHaveTextContent("O executavel informado nao existe.");
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

  it("keeps a success notice on its route and drops it when the route changes", async () => {
    window.location.hash = "#/overview";
    const controlled = client();
    render(<App client={controlled} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Atualizar/ }));
    expect(await screen.findAllByText("Painel atualizado.")).not.toHaveLength(0);
    await user.click(screen.getByRole("link", { name: "Fila de tarefas" }));
    await waitFor(() => expect(screen.queryByText("Painel atualizado.")).not.toBeInTheDocument());
    await user.click(screen.getByRole("link", { name: "Visão geral" }));
    await screen.findByRole("heading", { name: "Sala de controle" });
    expect(screen.queryByText("Painel atualizado.")).not.toBeInTheDocument();
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

  it("loads the Antigravity catalog and sends the selected model", async () => {
    window.location.hash = "#/tasks/task-9";
    const controlled = client();
    const snapshot = await controlled.getSnapshot();
    const queued = { ...snapshot.tasks[0]!, id: "task-9", status: "queued" as const };
    vi.spyOn(controlled, "getSnapshot").mockResolvedValue({ ...snapshot, tasks: [queued], runs: [] });
    const config = vi.spyOn(controlled, "getProviderConfig").mockImplementation(async (provider) => catalog(provider, "1.5.9", ["gemini-4-neon"], null, true));
    const executeTask = vi.spyOn(controlled, "executeTask").mockResolvedValue(queued);
    const user = userEvent.setup();
    render(<App client={controlled} />);
    await user.click(await screen.findByRole("button", { name: "Executar tarefa" }));
    await user.selectOptions(screen.getByLabelText("Provedor"), "antigravity");
    await user.selectOptions(await screen.findByLabelText("Modelo"), "gemini-4-neon");
    await user.click(screen.getByRole("button", { name: "Executar agora" }));
    expect(config).toHaveBeenCalledWith("antigravity", queued.targetDirectoryId);
    expect(executeTask).toHaveBeenCalledWith(queued.id, "antigravity", { model: "gemini-4-neon" });
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
    expect(screen.getByText("Tarefa criada.")).toBeInTheDocument();
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

  it("lets the operator choose per project where agents work and starts new projects from the last choice", async () => {
    const controlled = client();
    const snapshot = await controlled.getSnapshot();
    snapshot.projects[0]!.isolation = "direct";
    const update = vi.spyOn(controlled, "updateProjectIsolation"); const register = vi.spyOn(controlled, "registerProject");
    window.location.hash = "#/projects/project-1";
    render(<App client={controlled} />);
    await userEvent.selectOptions(await screen.findByLabelText("Onde o agente trabalha em Projeto"), "worktree");
    expect(update).toHaveBeenCalledWith("project-1", "worktree");
    window.location.hash = "#/projects";
    expect(await screen.findByRole("link", { name: "Abrir Projeto" })).toHaveAttribute("href", "#/projects/project-1");
    await userEvent.click(await screen.findByRole("button", { name: "Cadastrar projeto" }));
    await userEvent.type(screen.getByLabelText("Nome do projeto"), "Novo");
    await userEvent.type(screen.getByLabelText("Caminho local absoluto"), "C:/novo");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cadastrar projeto" }));
    await waitFor(() => expect(register).toHaveBeenCalledWith(expect.objectContaining({ name: "Novo", isolation: "direct" })));
  });

  it("covers the screen with a loading overlay instead of leaving it blank", async () => {
    const controlled = client();
    let deliver: () => void = () => undefined;
    const original = controlled.getSnapshot;
    controlled.getSnapshot = () => new Promise((resolve) => { deliver = () => void original().then(resolve); });
    window.location.hash = "#/overview";
    const { container } = render(<App client={controlled} />);
    expect(container.querySelector(".loading-overlay")).toHaveTextContent("Carregando sala de controle…");
    deliver();
    await waitFor(() => expect(screen.queryByText("Carregando sala de controle…")).not.toBeInTheDocument());
  });

  it("closes the launch dialog while the host still prepares the worktree", async () => {
    const controlled = client();
    const snapshot = await controlled.getSnapshot();
    snapshot.tasks[0]!.status = "queued";
    controlled.executeTask = () => { snapshot.tasks[0]!.status = "planning"; return new Promise(() => undefined); };
    window.location.hash = "#/tasks/task-1";
    render(<App client={controlled} />);
    await userEvent.click(await screen.findByRole("button", { name: "Executar tarefa" }));
    await userEvent.click(await screen.findByRole("button", { name: "Executar agora" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), { timeout: 4_000 });
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

function catalog(provider: AcpProvider, version: string, models: string[], defaultModel: string | null, loadSession?: boolean) {
  return { directoryId: "directory-1", runtime: { path: provider, version, source: "path" }, protocolVersion: 1, settings: [], models: models.map((id) => ({ id, name: id })), defaultModel, ...(loadSession === undefined ? {} : { capabilities: { loadSession } }) };
}

const providerNames: Record<string, string> = { codex: "Codex", antigravity: "Antigravity", claude: "Claude Code" };
function providerStatus(provider: string, fields: Partial<ProviderStatus> = {}): ProviderStatus {
  return { provider, label: providerNames[provider] ?? provider, available: true, authenticated: true, version: "1.0.0", detail: "ok", executable: { path: `C:\\${provider}.exe`, source: "user" },
    transport: "acp", roles: { implementer: true, reviewer: true }, login: { command: `${provider} login`, hint: "Entre na sua conta." },
    preferences: { enabled: true, automatic: true, executablePath: null, defaultModel: null }, verification: null, fetchedAt: "2026-01-01T00:00:00.000Z",
    usage: { source: "eleazar_executions", usedPercent: null, resetAt: null, windowDurationMins: null, totalTokens: 0, lifetimeTokens: null, todayTokens: null }, ...fields };
}
describe("Navigation", () => {
  it("opens the command palette with Ctrl+K and jumps to a task by name", async () => {
    window.location.hash = "#/overview";
    const user = userEvent.setup();
    render(<App client={client()} />);
    await screen.findByRole("heading", { name: "Sala de controle" });
    await user.keyboard("{Control>}k{/Control}");
    const search = await screen.findByRole("combobox", { name: "Buscar tarefas, projetos e telas" });
    await user.type(search, "resul");
    expect(screen.getByRole("option", { name: /Resultado/ })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(window.location.hash).toBe("#/tasks/task-1"));
    expect(screen.queryByRole("combobox", { name: "Buscar tarefas, projetos e telas" })).not.toBeInTheDocument();
  });

  it("shows where the operator is and links each level of the breadcrumb", async () => {
    window.location.hash = "#/tasks/task-1/files";
    render(<App client={client()} />);
    const trail = within(await screen.findByRole("navigation", { name: "Você está em" }));
    await waitFor(() => expect(trail.getByRole("link", { name: "Resultado" })).toHaveAttribute("href", "#/tasks/task-1"));
    expect(trail.getByRole("link", { name: "Projetos" })).toHaveAttribute("href", "#/projects");
    expect(trail.getByRole("link", { name: "Projeto" })).toHaveAttribute("href", "#/projects/project-1");
    expect(trail.getByText("Arquivos")).toHaveAttribute("aria-current", "location");
    expect(screen.getByRole("link", { name: "Voltar para Resultado" })).toHaveAttribute("href", "#/tasks/task-1");
    await userEvent.click(trail.getByRole("link", { name: "Resultado" }));
    await waitFor(() => expect(window.location.hash).toBe("#/tasks/task-1"));
    expect(screen.getByRole("link", { name: "Voltar para Projeto" })).toHaveAttribute("href", "#/projects/project-1");
    await userEvent.click(screen.getByRole("link", { name: "Voltar para Projeto" }));
    await waitFor(() => expect(window.location.hash).toBe("#/projects/project-1"));
  });

  it("opens the project page from the sidebar and remembers a collapsed project", async () => {
    window.location.hash = "#/overview";
    const user = userEvent.setup();
    render(<App client={client()} />);
    const sidebar = within(await screen.findByRole("navigation", { name: "Projetos e tarefas" }));
    await user.click(sidebar.getByRole("link", { name: "Projeto" }));
    await waitFor(() => expect(window.location.hash).toBe("#/projects/project-1"));
    expect(sidebar.getByRole("link", { name: "Projeto" })).toHaveAttribute("aria-current", "page");
    await user.click(sidebar.getByRole("button", { name: "Recolher Projeto" }));
    expect(sidebar.getByRole("button", { name: "Expandir Projeto" })).toHaveAttribute("aria-expanded", "false");
    expect(JSON.parse(window.localStorage.getItem("eleazar.collapsedProjects") ?? "[]")).toEqual(["project-1"]);
  });

  it("returns from an execution to its task", async () => {
    window.location.hash = "#/executions/run-1";
    const user = userEvent.setup();
    render(<App client={client()} />);
    await user.click(await screen.findByRole("button", { name: /Voltar à tarefa/ }));
    expect(window.location.hash).toBe("#/tasks/task-1");
  });
});

function client(): ControlRoomClient {
  const snapshot: ControlRoomSnapshot = { projects: [{ id: "project-1", name: "Projeto", path: "C:\\Projeto", directories: [{ id: "directory-1", name: "Principal", path: "C:\\Projeto", createdAt: "2026-01-01T00:00:00.000Z", isGitRepository: true }], isolation: "worktree", createdAt: "2026-01-01T00:00:00.000Z" }], tasks: [{ id: "task-1", projectId: "project-1", targetDirectoryId: "directory-1", directoryIds: ["directory-1"], usesWorktree: false, title: "Resultado", prompt: "Teste", priority: "normal", status: "completed", kind: "planning", worktreePath: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }], runs: [{ id: "run-1", taskId: "task-1", provider: "codex", status: "completed", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", summary: "Resultado" }], logs: [], approvals: [], alerts: [] };
  const detail: ExecutionDetail = { execution: snapshot.runs[0]!, task: snapshot.tasks[0]!, project: snapshot.projects[0]!, logs: [], files: [], history: snapshot.runs };
  return { getSnapshot: async () => snapshot, getExecutionDetail: async () => detail, getProviderStatuses: async () => ["codex", "antigravity", "claude"].map((id) => providerStatus(id)), verifyProvider: async () => [], updateProvider: async () => [], registerProject: async () => snapshot.projects[0]!, updateProjectIsolation: async () => snapshot.projects[0]!, updateProject: async (_id, input) => ({ ...snapshot.projects[0]!, name: input.name }), createTask: async () => snapshot.tasks[0]!, executeTask: async () => snapshot.tasks[0]!, getProviderConfig: async (_provider, directoryId) => ({ directoryId, runtime: { path: "acp", version: "1.0.0", source: "path" }, protocolVersion: 1, settings: [], models: [], defaultModel: null }), getCodexConfig: async () => ({ directoryId: "directory-1", runtime: { path: "codex", version: "1.0.0", source: "path" }, protocolVersion: 1, settings: [], models: [], defaultModel: null }), streamExecutionEvents: async () => true, cancelExecution: async () => undefined, respondPermission: async () => undefined, retryTask: async () => undefined, decideApproval: async () => undefined, sendTaskMessage: async () => snapshot.tasks[0]!, requestTaskAction: async () => { throw new Error("unused"); }, decideTaskAction: async () => { throw new Error("unused"); }, removeTaskWorktrees: async () => snapshot.tasks[0]!, resumeTask: async () => snapshot.tasks[0]!, listTemplates: async () => [], createTemplate: async (input) => ({ id: "tpl", title: "", kind: null, priority: "normal", projectId: null, createdAt: "2026-01-01T00:00:00.000Z", ...input }), deleteTemplate: async () => [], startComparison: async () => ({ comparisonId: "cmp", tasks: [], errors: [] }), chooseComparisonAttempt: async () => [], refreshPullRequests: async () => ({ pullRequests: [], warnings: [] }),
    getTaskFileRoots: async () => [explorerRoot], listTaskFiles: async (_task, _directory, path = "") => ({ root: explorerRoot, path, entries: [{ name: "README.md", path: "README.md", type: "file", size: 6, change: "modified", changedBelow: 0 }], truncated: false }),
    getTaskChanges: async () => ({ root: explorerRoot, changes: [{ path: "README.md", previousPath: null, kind: "modified", additions: 1, deletions: 1 }], warnings: [] }),
    getTaskFile: async (_task, _directory, path) => ({ root: explorerRoot, path, exists: true, size: 6, binary: false, content: "novo\n", tooLarge: false, change: { path, previousPath: null, kind: "modified", additions: 1, deletions: 1 }, diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-velho\n+novo\n`, diffTruncated: false }),
    searchTaskFiles: async (_task, _directory, query) => ({ root: explorerRoot, query, paths: ["README.md"], truncated: false }),
    listSkills: async () => [], exportCatalog: async () => ({ blob: new Blob(["zip"]), fileName: "eleazar-catalogo.zip" }), previewCatalogImport: async () => ({ skills: [], agents: [], ignored: [], warnings: [] }),
    importCatalog: async () => ({ skills: { added: [], replaced: [], skipped: [] }, agents: { added: [], replaced: [], skipped: [] }, warnings: [], skillsTotal: 0, agentsTotal: 0 }), createSkill: async () => { throw new Error("unused"); }, updateSkill: async () => { throw new Error("unused"); }, deleteSkill: async () => [],
    listAgents: async () => [], createAgent: async () => { throw new Error("unused"); }, updateAgent: async () => { throw new Error("unused"); }, deleteAgent: async () => [],
    pinTask: async (taskId, pinned) => ({ ...snapshot.tasks[0]!, id: taskId, pinnedAt: pinned ? "2026-01-02T00:00:00.000Z" : null }), deleteTask: async () => undefined,
    listTerminals: async () => [], openTerminal: async () => { throw new Error("unused"); }, sendTerminalInput: async () => { throw new Error("unused"); }, closeTerminal: async () => { throw new Error("unused"); }, streamTerminalEvents: async () => true,
    getProjectFileRoots: async () => [explorerRoot], listProjectFiles: async (_project, _directory, path = "") => ({ root: explorerRoot, path, entries: [{ name: "package.json", path: "package.json", type: "file", size: 6, change: null, changedBelow: 0 }], truncated: false }),
    getProjectChanges: async () => ({ root: explorerRoot, changes: [], warnings: [] }),
    getProjectFile: async (_project, _directory, path) => ({ root: explorerRoot, path, exists: true, size: 2, binary: false, content: "{}\n", tooLarge: false, change: null, diff: null, diffTruncated: false }),
    searchProjectFiles: async (_project, _directory, query) => ({ root: explorerRoot, query, paths: [], truncated: false }) };
}
const explorerRoot = { directoryId: "directory-1", name: "Principal", path: "C:\\Projeto", mode: "direct" as const, branch: null, isGitRepository: true, base: "HEAD" };
