import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { createMockControlRoomClient } from "./services/mock-client.js";
import { createDemoSnapshot } from "./services/demo-data.js";
async function setup(client = createMockControlRoomClient()) {
  const user = userEvent.setup();
  render(<App client={client} />);
  await screen.findByRole("heading", { name: "Seus projetos" });
  return { user, client };
}
describe("operator flows", () => {
  it("registers a project and creates a task with visible queue and metrics update", async () => {
    const { user, client } = await setup();
    await user.click(screen.getByRole("button", { name: "Cadastrar projeto" }));
    const registration = screen.getByRole("dialog");
    await user.type(
      within(registration).getByLabelText("Nome do projeto"),
      "Novo projeto",
    );
    await user.type(
      within(registration).getByLabelText(/Caminho local absoluto/),
      "C:\\Projetos\\novo",
    );
    await user.click(
      within(registration).getByRole("button", { name: "Cadastrar projeto" }),
    );
    await screen.findByText(/Projeto cadastrado\./);
    await user.click(screen.getByRole("button", { name: "Nova tarefa" }));
    const taskForm = screen.getByRole("dialog");
    const project = (await client.getSnapshot()).projects.find(
      (item) => item.name === "Novo projeto",
    )!;
    await user.selectOptions(
      within(taskForm).getByLabelText("Projeto"),
      project.id,
    );
    await user.type(
      within(taskForm).getByLabelText("Título"),
      "Cobrir novo fluxo",
    );
    await user.type(
      within(taskForm).getByLabelText("Prompt"),
      "Implementar testes com contexto local.",
    );
    await user.selectOptions(
      within(taskForm).getByLabelText("Prioridade"),
      "high",
    );
    await user.click(
      within(taskForm).getByRole("button", { name: "Adicionar à fila" }),
    );
    await screen.findByRole("button", { name: "Cobrir novo fluxo" });
    const row = screen
      .getByRole("button", { name: "Cobrir novo fluxo" })
      .closest("tr")!;
    expect(within(row).getByText("Novo projeto")).toBeInTheDocument();
    expect(within(row).getByText("Alta")).toBeInTheDocument();
    expect(within(row).getByText("Na fila")).toBeInTheDocument();
    expect(
      screen.getByText("Tarefas na fila").closest(".metric"),
    ).toHaveTextContent("04");
  });
  it("keeps project form open on service validation error", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "Cadastrar projeto" }));
    const form = screen.getByRole("dialog");
    await user.type(within(form).getByLabelText("Nome do projeto"), "Invalid");
    await user.type(
      within(form).getByLabelText(/Caminho local absoluto/),
      "relative",
    );
    await user.click(
      within(form).getByRole("button", { name: "Cadastrar projeto" }),
    );
    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "absoluto",
    );
    expect(within(form).getByLabelText("Nome do projeto")).toHaveValue(
      "Invalid",
    );
  });
  it.each(["approve", "reject"] as const)(
    "reviews context then applies %s visibly",
    async (decision) => {
      const { user } = await setup();
      await user.click(
        screen.getByRole("button", { name: "Revisar proposta" }),
      );
      const review = screen.getByRole("dialog");
      expect(
        within(review).getByText(/nenhum comando Git é executado/),
      ).toBeInTheDocument();
      await user.click(
        within(review).getByRole("button", {
          name: decision === "approve" ? "Aprovar proposta" : "Rejeitar",
        }),
      );
      await screen.findByText("Tudo revisado");
      expect(
        screen.getByRole("heading", { name: "Suas aprovações" }),
      ).toHaveFocus();
      const row = screen
        .getByRole("button", { name: "Integrar revisão da branch" })
        .closest("tr")!;
      expect(
        within(row).getByText(decision === "approve" ? "Na fila" : "Bloqueada"),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("Uma decisão aguarda você"),
      ).not.toBeInTheDocument();
    },
  );
  it("filters tasks and displays prompt details as plain text", async () => {
    const { user } = await setup();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filtrar por projeto" }),
      "studio",
    );
    expect(screen.getAllByRole("row")).toHaveLength(2);
    await user.type(
      screen.getByRole("textbox", { name: "Buscar tarefa" }),
      "missing",
    );
    expect(
      screen.getByText("Nenhuma tarefa corresponde aos filtros."),
    ).toBeInTheDocument();
    await user.clear(screen.getByRole("textbox", { name: "Buscar tarefa" }));
    await user.click(
      screen.getByRole("button", { name: "Documentar tokens de design" }),
    );
    expect(
      within(screen.getByRole("dialog")).getByText(
        "Documentar cores, espaçamentos e tipografia.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Fechar" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("recovers from initial API failure through refresh", async () => {
    const client = createMockControlRoomClient();
    vi.spyOn(client, "getSnapshot").mockRejectedValueOnce(
      new Error("API indisponível"),
    );
    const user = userEvent.setup();
    render(<App client={client} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "API indisponível",
    );
    await user.click(screen.getByRole("button", { name: "Atualizar" }));
    await screen.findByRole("heading", { name: "Seus projetos" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("does not repeat a successful mutation when snapshot refresh fails", async () => {
    const { user, client } = await setup();
    const create = vi.spyOn(client, "createTask");
    vi.spyOn(client, "getSnapshot").mockRejectedValueOnce(
      new Error("Read failed"),
    );
    await user.click(screen.getByRole("button", { name: "Nova tarefa" }));
    const form = screen.getByRole("dialog");
    await user.type(within(form).getByLabelText("Título"), "Only once");
    await user.type(within(form).getByLabelText("Prompt"), "Context");
    await user.click(
      within(form).getByRole("button", { name: "Adicionar à fila" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A ação foi concluída",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Atualizar" }));
    await screen.findByRole("button", { name: "Only once" });
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("offers registration when workspace has no projects", async () => {
    const empty = createDemoSnapshot();
    empty.projects = [];
    empty.tasks = [];
    empty.runs = [];
    empty.approvals = [];
    empty.alerts = [];
    empty.logs = [];
    const { user } = await setup(createMockControlRoomClient(empty));
    expect(screen.getByRole("button", { name: "Nova tarefa" })).toBeDisabled();
    expect(
      screen.getByText("Cadastre seu primeiro projeto local para começar."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cadastrar projeto" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  it("filters logs independently from the task queue", async () => {
    const { user } = await setup();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filtrar nível dos logs" }),
      "error",
    );
    expect(screen.getByText("Nenhum log neste nível.")).toBeInTheDocument();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filtrar nível dos logs" }),
      "warning",
    );
    await waitFor(() =>
      expect(
        screen.getByText("TSK-102 · Aguardando decisão do operador."),
      ).toBeInTheDocument(),
    );
    expect(screen.getAllByRole("row")).toHaveLength(7);
  });
  it("clears existing search and selects the created task project", async () => {
    const { user } = await setup();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filtrar por projeto" }),
      "studio",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Buscar tarefa" }),
      "missing",
    );
    await user.click(screen.getByRole("button", { name: "Nova tarefa" }));
    const form = screen.getByRole("dialog");
    expect(within(form).getByLabelText("Projeto")).toHaveFocus();
    await user.selectOptions(within(form).getByLabelText("Projeto"), "eleazar");
    await user.type(within(form).getByLabelText("Título"), "Visible task");
    await user.type(within(form).getByLabelText("Prompt"), "Context");
    await user.click(
      within(form).getByRole("button", { name: "Adicionar à fila" }),
    );
    await screen.findByRole("button", { name: "Visible task" });
    expect(screen.getByRole("textbox", { name: "Buscar tarefa" })).toHaveValue(
      "",
    );
    expect(
      screen.getByRole("combobox", { name: "Filtrar por projeto" }),
    ).toHaveValue("eleazar");
    expect(screen.getByRole("button", { name: "Nova tarefa" })).toHaveFocus();
  });
});
