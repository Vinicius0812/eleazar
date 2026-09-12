import type {
  ControlRoomClient,
  ControlRoomSnapshot,
  Priority,
} from "./contracts.js";
import { createDemoSnapshot } from "./demo-data.js";
export const priorityOrder: Record<Priority, number> = {
  high: 0,
  normal: 1,
  low: 2,
};
export function createMockControlRoomClient(
  initial: ControlRoomSnapshot = createDemoSnapshot(),
): ControlRoomClient {
  const state = structuredClone(initial);
  let sequence = 200;
  const id = (prefix: string) => `${prefix}-${++sequence}`;
  const log = (message: string) =>
    state.logs.unshift({
      id: id("LOG"),
      time: new Date().toISOString(),
      level: "info",
      message,
    });
  return {
    async getSnapshot() {
      return structuredClone(state);
    },
    async registerProject(input) {
      const name = input.name.trim();
      const path = input.path.trim();
      if (!name || !path)
        throw new Error("Informe o nome e o caminho do projeto.");
      if (!/^(?:[A-Za-z]:[\\/]|\/|\\\\[^\\]+\\[^\\]+)/.test(path))
        throw new Error("Informe um caminho absoluto local.");
      const normalize = (value: string) =>
        value.replace(/\\/g, "/").replace(/\/$/, "");
      if (
        state.projects.some(
          (project) =>
            normalize(project.path).toLocaleLowerCase() ===
            normalize(path).toLocaleLowerCase(),
        )
      )
        throw new Error("Este caminho já está cadastrado.");
      const project = {
        id: id("PRJ"),
        name,
        path,
        branch: "Não verificada",
        color: "purple",
      };
      state.projects.push(project);
      log(`Projeto ${name} cadastrado na demonstração.`);
      return structuredClone(project);
    },
    async createTask(input) {
      if (!state.projects.some((project) => project.id === input.projectId))
        throw new Error("Selecione um projeto cadastrado.");
      if (!input.title.trim() || !input.prompt.trim())
        throw new Error("Informe título e prompt da tarefa.");
      if (!(input.priority in priorityOrder))
        throw new Error("Prioridade inválida.");
      const task = {
        ...input,
        title: input.title.trim(),
        prompt: input.prompt.trim(),
        id: id("TSK"),
        status: "queued" as const,
        createdAt: new Date().toISOString(),
      };
      state.tasks.push(task);
      log(`${task.id} · Tarefa adicionada à fila: ${task.title}`);
      return structuredClone(task);
    },
    async decideApproval(approvalId, decision) {
      const approval = state.approvals.find((item) => item.id === approvalId);
      if (!approval)
        throw new Error(
          "Esta aprovação não está mais pendente. Atualize o painel.",
        );
      const task = state.tasks.find((item) => item.id === approval.taskId);
      if (!task) throw new Error("Tarefa da aprovação não encontrada.");
      task.status = decision === "approve" ? "queued" : "blocked";
      state.approvals = state.approvals.filter(
        (item) => item.id !== approvalId,
      );
      if (!state.approvals.length)
        state.alerts = state.alerts.filter((item) => item.id !== "ALT-1");
      log(
        `${task.id} · Proposta ${decision === "approve" ? "aprovada" : "rejeitada"} pelo operador (simulação).`,
      );
    },
  };
}
