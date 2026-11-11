import type { ReactNode } from "react";
import { ArrowLeft, MessageSquare, Terminal } from "lucide-react";

import { AgentMarkdown } from "./AgentMarkdown.js";
import type { LogEntry, Run, Task } from "../services/contracts.js";

const statusCopy: Record<Task["status"], string> = {
  queued: "A tarefa está pronta para ser executada. Confirme quando quiser começar.",
  planning: "O Eleazar está preparando a execução.",
  running: "A execução está em andamento. Esta página se atualiza enquanto o agente trabalha.",
  waiting_approval: "Revise o escopo da tarefa para que ela possa voltar à fila.",
  completed: "A execução foi concluída.",
  failed: "Consulte o motivo da falha antes de tentar novamente.",
  cancelled: "A tarefa foi cancelada.",
};

export function TaskWorkspace({ task, statusLabel, projectName, directoryName, scopeNames, run, latestLog, failure, actions }: {
  task: Task;
  statusLabel: string;
  projectName: string;
  directoryName: string;
  scopeNames: string;
  run: Run | undefined;
  latestLog: LogEntry | undefined;
  failure: string | undefined;
  actions: ReactNode;
}) {
  const result = task.status === "completed" && run?.status === "completed" ? run.output?.trim() || run.summary?.trim() : null;
  const showLog = task.status === "planning" || task.status === "running" || task.status === "failed";
  const showProvider = showLog || task.status === "completed";

  return (
    <>
      <article className="task-turn task-request" aria-labelledby="task-request-title">
        <div className="task-turn-heading">
          <MessageSquare size={16} aria-hidden="true" />
          <h2 id="task-request-title">Sua solicitação</h2>
          <time dateTime={task.createdAt}>{new Date(task.createdAt).toLocaleString("pt-BR")}</time>
        </div>
        <p className="task-request-text">{task.prompt}</p>
        <details className="task-context">
          <summary>Contexto da tarefa</summary>
          <dl>
            <div><dt>Projeto</dt><dd>{projectName}</dd></div>
            <div><dt>Diretório-alvo</dt><dd>{directoryName}</dd></div>
            {task.directoryIds.length > 1 && <div><dt>Escopo</dt><dd>{scopeNames}</dd></div>}
          </dl>
        </details>
      </article>
      <article className="task-turn task-agent" aria-labelledby="task-agent-title">
        <div className="task-turn-heading">
          <Terminal size={17} aria-hidden="true" />
          <h2 id="task-agent-title">Execução</h2>
          {showProvider && run?.provider && <span className="provider-tag">{run.provider}</span>}
        </div>
        <div className="task-progress" role="status" aria-label="Status da tarefa" aria-atomic="true">
          <span className={`status ${task.status}`}>{statusLabel}</span>
          <p>{statusCopy[task.status]}</p>
        </div>
        {failure && <div className="task-failure"><strong>Motivo da falha</strong><p>{failure}</p></div>}
        {showLog && latestLog && (
          <div className="task-agent-log">
            <strong>Último registro</strong>
            <time dateTime={latestLog.createdAt}>{new Date(latestLog.createdAt).toLocaleTimeString("pt-BR")}</time>
            <p>{latestLog.message}</p>
          </div>
        )}
        {result && <AgentMarkdown>{result}</AgentMarkdown>}
        <div className="task-next-actions">
          <a className="text-button" href="#/tasks"><ArrowLeft size={15} aria-hidden="true" /> Voltar à fila</a>
          {actions}
        </div>
      </article>
    </>
  );
}
