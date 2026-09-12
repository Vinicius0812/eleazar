import type { ControlRoomSnapshot } from "./contracts.js";
export function createDemoSnapshot(): ControlRoomSnapshot {
  return {
    projects: [
      {
        id: "eleazar",
        name: "Eleazar",
        path: "C:\\Projetos\\eleazar",
        branch: "main",
        color: "purple",
      },
      {
        id: "atlas",
        name: "Atlas API",
        path: "C:\\Projetos\\atlas-api",
        branch: "develop",
        color: "blue",
      },
      {
        id: "studio",
        name: "Design Studio",
        path: "C:\\Projetos\\design-studio",
        branch: "main",
        color: "orange",
      },
    ],
    tasks: [
      {
        id: "TSK-104",
        projectId: "eleazar",
        title: "Construir a sala de controle",
        prompt:
          "Criar o dashboard local do Eleazar com contratos independentes.",
        priority: "high",
        status: "running",
        createdAt: "2026-09-12T13:00:00Z",
      },
      {
        id: "TSK-103",
        projectId: "atlas",
        title: "Revisar tratamento de erros",
        prompt: "Revisar os erros de validação da API e propor melhorias.",
        priority: "normal",
        status: "running",
        createdAt: "2026-09-12T12:55:00Z",
      },
      {
        id: "TSK-102",
        projectId: "eleazar",
        title: "Integrar revisão da branch",
        prompt: "Preparar a revisão para integração da branch de contratos.",
        priority: "high",
        status: "awaiting_approval",
        createdAt: "2026-09-12T12:50:00Z",
      },
      {
        id: "TSK-101",
        projectId: "atlas",
        title: "Adicionar testes de contrato",
        prompt: "Cobrir os contratos públicos da API com testes unitários.",
        priority: "high",
        status: "queued",
        createdAt: "2026-09-12T12:40:00Z",
      },
      {
        id: "TSK-100",
        projectId: "studio",
        title: "Documentar tokens de design",
        prompt: "Documentar cores, espaçamentos e tipografia.",
        priority: "normal",
        status: "queued",
        createdAt: "2026-09-12T12:30:00Z",
      },
      {
        id: "TSK-099",
        projectId: "eleazar",
        title: "Atualizar guia de desenvolvimento",
        prompt: "Revisar as instruções para desenvolvimento local.",
        priority: "low",
        status: "queued",
        createdAt: "2026-09-12T12:20:00Z",
      },
    ],
    runs: [
      {
        id: "RUN-42",
        taskId: "TSK-104",
        providerId: "codex",
        phase: "Implementando componentes",
        progress: 64,
        startedAt: "2026-09-12T13:00:00Z",
      },
      {
        id: "RUN-41",
        taskId: "TSK-103",
        providerId: "antigravity",
        phase: "Analisando contratos",
        progress: 32,
        startedAt: "2026-09-12T12:55:00Z",
      },
    ],
    providers: [
      {
        id: "codex",
        name: "Codex",
        status: "available",
        detail: "Disponível · 1 execução demonstrativa",
      },
      {
        id: "antigravity",
        name: "Antigravity",
        status: "available",
        detail: "Disponível · 1 execução demonstrativa",
      },
      {
        id: "local",
        name: "Provedor local",
        status: "offline",
        detail: "Nenhum adaptador conectado",
      },
    ],
    approvals: [
      {
        id: "APR-12",
        taskId: "TSK-102",
        title: "Integração de branch",
        description:
          "Revisar a proposta de integração de control-room/contracts em main. Nesta demonstração, a decisão apenas muda o estado da tarefa; nenhum comando Git é executado.",
        action: "Integrar control-room/contracts → main",
      },
    ],
    alerts: [
      {
        id: "ALT-1",
        level: "warning",
        title: "Uma decisão aguarda você",
        message: "Revise a proposta de integração antes de continuar.",
      },
      {
        id: "ALT-2",
        level: "info",
        title: "Ambiente de demonstração",
        message: "Dados em memória. Recarregar a página restaura os exemplos.",
      },
    ],
    logs: [
      {
        id: "LOG-3",
        time: "2026-09-12T13:02:00Z",
        level: "info",
        message: "RUN-42 · Implementação de componentes iniciada.",
      },
      {
        id: "LOG-2",
        time: "2026-09-12T13:01:00Z",
        level: "warning",
        message: "TSK-102 · Aguardando decisão do operador.",
      },
      {
        id: "LOG-1",
        time: "2026-09-12T13:00:00Z",
        level: "info",
        message: "Control Room · Serviço de demonstração conectado.",
      },
    ],
  };
}
