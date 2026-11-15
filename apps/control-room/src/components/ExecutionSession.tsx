import { Ban, MessageSquare, ShieldQuestion, Terminal, Wrench } from "lucide-react";

import { AgentMarkdown } from "./AgentMarkdown.js";
import { useExecutionSession, type ConnectionState } from "./useExecutionSession.js";
import { terminalEventKinds, type ControlRoomClient, type ExecutionDetail, type ExecutionEvent, type ExecutionPermission } from "../services/contracts.js";
import { readableSummary } from "../services/run-messages.js";

const connectionCopy: Record<ConnectionState, string> = {
  loading: "Carregando sessão…",
  connecting: "Conectando ao agente…",
  live: "Ao vivo",
  reconnecting: "Reconectando…",
  closed: "Sessão encerrada",
  error: "Conexão perdida"
};
const toolStatusCopy: Record<string, string> = { pending: "Pendente", in_progress: "Em andamento", completed: "Concluída", failed: "Falhou" };
const permissionStatusCopy: Record<ExecutionPermission["status"], string> = { pending: "Aguardando decisão", selected: "Decidida", cancelled: "Cancelada" };

/**
 * Per-execution ACP session shared by the task workspace and the execution result page:
 * original request, progressive agent text, tool activity, permission decisions and cancel.
 * Legacy executions (no events) fall back to the persisted output/summary.
 */
export function ExecutionSession({ client, executionId, showRequest = true, showOutcome = true, onChanged, retryDelayMs }: {
  client: ControlRoomClient;
  executionId: string;
  showRequest?: boolean;
  /** False when the host screen already shows the failure reason from the snapshot, to avoid repeating it. */
  showOutcome?: boolean;
  onChanged?: () => void;
  retryDelayMs?: (attempt: number) => number;
}) {
  const session = useExecutionSession(client, executionId, onChanged, retryDelayMs);
  const { detail, permissions, text, tools, connection, error, actionError, pendingAction } = session;
  if (!detail) {
    return <div className={connection === "error" ? "error" : "empty"} role={connection === "error" ? "alert" : "status"}>
      {connection === "error" ? error || "Não foi possível carregar a sessão." : "Carregando sessão…"}
      {connection === "error" && <> <button className="text-button" onClick={session.retry}>Tentar novamente</button></>}
    </div>;
  }
  const { execution, task } = detail;
  const outcome = failedOutcome(execution, session.events);
  const settled = session.events.some((event) => terminalEventKinds.includes(event.kind));
  const active = (execution.status === "running" || execution.status === "planned") && !settled;
  const pending = permissions.filter((permission) => permission.status === "pending");
  const decided = permissions.filter((permission) => permission.status !== "pending");
  const hasEvents = session.events.length > 0;
  // Persisted fallback for runs without streamed text (legacy history or a reload). For a failed or
  // cancelled run it is kept as partial output, unless it merely repeats the reason shown above.
  const persisted = execution.output?.trim() || "";
  const persistedBody = outcome
    ? (persisted && !repeatsReason(persisted, outcome.message) ? persisted : "")
    : persisted || execution.summary?.trim() || "";
  const body = text || (!active ? persistedBody : "");

  return (
    <section className="execution-session" aria-label="Sessão do agente">
      {showRequest && (
        <article className="session-request">
          <div className="task-turn-heading"><MessageSquare size={16} aria-hidden="true" /><h3>{execution.prompt ? "Mensagem desta continuação" : "Mensagem original"}</h3></div>
          <p className="task-request-text">{execution.prompt ?? task.prompt}</p>
        </article>
      )}
      <div className="session-status" role="status" aria-live="polite">
        <span className={`connection-pill ${connection}`}>{connectionCopy[connection]}</span>
        {execution.model && <span className="provider-tag">{execution.model}</span>}
        {execution.transport === "legacy" && <span className="provider-tag">Legado</span>}
        {active && (
          <button className="secondary session-cancel" disabled={pendingAction} onClick={() => void session.cancel()}>
            <Ban size={15} aria-hidden="true" /> {pendingAction ? "Aguarde…" : "Cancelar execução"}
          </button>
        )}
      </div>
      {outcome && showOutcome && (
        <div className="task-failure" role="alert">
          <strong>{outcomeTitle[outcome.kind]}</strong>
          <p>{outcome.message ?? outcomeFallback[outcome.kind]}</p>
        </div>
      )}
      {error && connection !== "closed" && <div className="error" role="alert">Falha na conexão com o fluxo de eventos: {error} {connection === "error" && <button className="text-button" onClick={session.retry}>Tentar novamente</button>}</div>}
      {actionError && <div className="error" role="alert">{actionError}</div>}
      {pending.map((permission) => <PermissionCard key={permission.id} permission={permission} busy={pendingAction} onChoose={(optionId) => void session.respond(permission.id, optionId)} />)}
      {body ? <AgentMarkdown>{body}</AgentMarkdown>
        : active && <p className="session-waiting">{hasEvents ? "O agente está trabalhando…" : "Aguardando a primeira resposta do agente…"}</p>}
      {tools.length > 0 && (
        <div className="session-tools">
          <div className="task-turn-heading"><Wrench size={16} aria-hidden="true" /><h3>Atividade de ferramentas</h3></div>
          <ul>
            {tools.map((tool) => <li key={tool.toolCallId}>
              <strong>{tool.title}</strong>
              {tool.status && <span className={`tool-status ${tool.status}`}>{toolStatusCopy[tool.status] ?? tool.status}</span>}
              {tool.locations.length > 0 && <small>{tool.locations.join(", ")}</small>}
            </li>)}
          </ul>
        </div>
      )}
      {decided.length > 0 && (
        <div className="session-tools">
          <div className="task-turn-heading"><Terminal size={16} aria-hidden="true" /><h3>Decisões de permissão</h3></div>
          <ul>
            {decided.map((permission) => <li key={permission.id}>
              <strong>{permission.title}</strong>
              <span className="tool-status">{permission.status === "selected" ? permission.options.find((option) => option.id === permission.selectedOptionId)?.name ?? permissionStatusCopy.selected : permissionStatusCopy[permission.status]}</span>
            </li>)}
          </ul>
        </div>
      )}
    </section>
  );
}

/** True only when the normalized output is exactly the reason; a truncated reason never hides a fuller output. */
function repeatsReason(output: string, reason: string | null): boolean {
  return reason !== null && (readableSummary(output) ?? output) === reason;
}

type OutcomeKind = "failed" | "cancelled" | "interrupted";
const outcomeTitle: Record<OutcomeKind, string> = { failed: "Motivo da falha", cancelled: "Motivo do cancelamento", interrupted: "Execução interrompida" };
const outcomeFallback: Record<OutcomeKind, string> = {
  failed: "A execução falhou e nenhum detalhe foi registrado.",
  cancelled: "A execução foi cancelada e nenhum motivo foi registrado.",
  interrupted: "A execução foi interrompida e nenhum motivo foi registrado."
};

/**
 * Why a run ended unsuccessfully. A terminal event can arrive before the detail snapshot is
 * refreshed, so it counts as much as `execution.status`; the persisted summary wins as the fuller text.
 * Returns null for running and completed runs.
 */
function failedOutcome(execution: ExecutionDetail["execution"], events: ExecutionEvent[]): { kind: OutcomeKind; message: string | null } | null {
  const event = [...events].reverse().find((item) => item.kind === "failed" || item.kind === "cancelled" || item.kind === "interrupted");
  const kind: OutcomeKind | null = event ? event.kind as OutcomeKind : execution.status === "failed" || execution.status === "cancelled" ? execution.status : null;
  if (!kind) return null;
  const payload = event?.payload;
  const fromEvent = typeof payload?.summary === "string" ? payload.summary : typeof payload?.reason === "string" ? payload.reason : null;
  return { kind, message: readableSummary(execution.summary) ?? readableSummary(fromEvent) };
}

function PermissionCard({ permission, busy, onChoose }: { permission: ExecutionPermission; busy: boolean; onChoose(optionId: string): void }) {
  return (
    <div className="permission-card" role="group" aria-label={`Permissão: ${permission.title}`}>
      <span className="approval-label"><ShieldQuestion size={14} aria-hidden="true" /> O AGENTE PRECISA DE UMA DECISÃO</span>
      <h4>{permission.title}</h4>
      <p>{permission.toolName ?? permission.toolKind ?? "Ferramenta"} solicita permissão para continuar.</p>
      {permission.locations.length > 0 && <ul className="permission-paths">{permission.locations.map((path) => <li key={path}><code>{path}</code></li>)}</ul>}
      {permission.requiresElevation && <p className="permission-warning">Esta ação exige elevação de escopo e não pode ser aprovada neste fluxo. Rejeite ou cancele a execução.</p>}
      <div className="permission-options">
        {permission.options.map((option) => {
          const blocked = option.kind === "allow_always" || (option.kind === "allow_once" && permission.requiresElevation);
          return <button key={option.id} className={option.kind.startsWith("allow") ? "primary" : "secondary"} disabled={busy || blocked}
            title={blocked ? "Bloqueado: permissão persistente ou elevação não é aprovada por esta interface." : undefined}
            onClick={() => onChoose(option.id)}>{option.name}</button>;
        })}
      </div>
    </div>
  );
}
