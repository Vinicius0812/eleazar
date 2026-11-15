import { useState, type FormEvent } from "react";
import { GitBranch, GitPullRequest, RefreshCw, ShieldQuestion } from "lucide-react";

import type { OutboundActionKind, Task, TaskOutboundAction, TaskPullRequest } from "../services/contracts.js";

const kindLabel: Record<OutboundActionKind, string> = { commit: "Commit", push: "Enviar branch", pull_request: "Abrir pull request" };
const stateLabel: Record<TaskPullRequest["state"], string> = { open: "aberto", closed: "fechado", merged: "mesclado" };
const reviewLabel: Record<NonNullable<TaskPullRequest["reviewDecision"]>, string> = { approved: "aprovado", changes_requested: "alterações solicitadas", review_required: "revisão pendente" };
const statusLabel: Record<TaskOutboundAction["status"], string> = { pending: "Aguardando aprovação", running: "Executando", completed: "Concluída", failed: "Falhou", rejected: "Rejeitada" };

/**
 * Commit, push and pull request for a task that owns a branch. Requesting an action only
 * records what it would do; it runs after the operator approves that record.
 */
export function TaskPublishing({ task, actions, pullRequests = [], busy, locked, onRequest, onDecide, onRemoveWorktree, onRefreshPullRequests }: {
  task: Task;
  actions: TaskOutboundAction[];
  pullRequests?: TaskPullRequest[];
  busy: boolean;
  /** True while the agent is working: nothing may leave the worktree mid-turn. */
  locked: boolean;
  onRequest(input: { kind: OutboundActionKind; title?: string; body?: string }): void;
  onDecide(actionId: string, decision: "approve" | "reject"): void;
  onRemoveWorktree(): void;
  onRefreshPullRequests?(): void;
}) {
  const [draft, setDraft] = useState<OutboundActionKind | null>(null);
  const pending = actions.find((action) => action.status === "pending");
  const latest = actions.find((action) => action.status !== "pending");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const fields = new FormData(event.currentTarget);
    const title = String(fields.get("title") ?? "").trim();
    const body = String(fields.get("body") ?? "").trim();
    onRequest({ kind: draft, ...(title ? { title } : {}), ...(body ? { body } : {}) });
    setDraft(null);
  }

  return (
    <article className="task-turn task-publishing" aria-labelledby="task-publishing-title">
      <div className="task-turn-heading">
        <GitBranch size={16} aria-hidden="true" />
        <h2 id="task-publishing-title">Publicação</h2>
      </div>
      <p className="task-publishing-branch">Branch da tarefa: <code>{task.branch}</code></p>
      {pullRequests.map((pullRequest) => (
        <div key={pullRequest.directoryId} className="task-pull-request">
          <GitPullRequest size={15} aria-hidden="true" />
          <a href={pullRequest.url} target="_blank" rel="noreferrer">#{pullRequest.number} {pullRequest.title}</a>
          <span>{pullRequest.isDraft && pullRequest.state === "open" ? "rascunho" : stateLabel[pullRequest.state]}</span>
          {pullRequest.checks.total > 0 && <span>{pullRequest.checks.passed}/{pullRequest.checks.total} checks{pullRequest.checks.failed ? ` · falhou: ${pullRequest.checks.failing.join(", ")}` : ""}</span>}
          {pullRequest.reviewDecision && <span>{reviewLabel[pullRequest.reviewDecision]}</span>}
          {pullRequest.mergeable === "conflicting" && <span>conflito de merge</span>}
        </div>
      ))}
      {onRefreshPullRequests && <button className="text-button task-pull-request-refresh" disabled={busy} onClick={onRefreshPullRequests}><RefreshCw size={13} aria-hidden="true" /> Atualizar pull request</button>}
      {pending ? (
        <div className="permission-card" role="group" aria-label={`Aprovação: ${kindLabel[pending.kind]}`}>
          <span className="approval-label"><ShieldQuestion size={14} aria-hidden="true" /> AÇÃO AGUARDANDO SUA APROVAÇÃO</span>
          <h4>{kindLabel[pending.kind]}{pending.title ? `: ${pending.title}` : ""}</h4>
          {pending.body && <p>{pending.body}</p>}
          <ul className="permission-paths">
            {pending.targets.map((target) => <li key={target.directoryId}>
              <strong>{target.directoryName}</strong> · <code>{target.branch}</code>
              {pending.kind === "commit"
                ? <> · {target.changedFiles} arquivo(s)<br /><code>{target.files.join(", ")}{target.changedFiles > target.files.length ? ", …" : ""}</code></>
                : <> · {target.commitsAhead} commit(s) → <code>{target.remote}</code></>}
            </li>)}
          </ul>
          <div className="permission-options">
            <button className="primary" disabled={busy || locked} onClick={() => onDecide(pending.id, "approve")}>{busy ? "Aguarde…" : "Aprovar e executar"}</button>
            <button className="secondary" disabled={busy} onClick={() => onDecide(pending.id, "reject")}>Rejeitar</button>
          </div>
        </div>
      ) : draft ? (
        <form className="task-publishing-form" onSubmit={submit}>
          <strong>{kindLabel[draft]}</strong>
          {draft === "push" ? <p>A branch da tarefa será enviada para o remoto <code>origin</code>.</p> : <>
            <label>{draft === "commit" ? "Mensagem do commit" : "Título do pull request"}<input name="title" required maxLength={200} /></label>
            <label>Descrição (opcional)<textarea name="body" rows={3} /></label>
          </>}
          <div className="permission-options">
            <button className="primary" disabled={busy}>Revisar antes de executar</button>
            <button type="button" className="secondary" onClick={() => setDraft(null)}>Cancelar</button>
          </div>
        </form>
      ) : (
        <div className="permission-options">
          {(Object.keys(kindLabel) as OutboundActionKind[]).map((kind) =>
            <button key={kind} className="secondary" disabled={busy || locked} onClick={() => setDraft(kind)}>{kindLabel[kind]}</button>)}
          <button className="text-button" disabled={busy || locked} onClick={onRemoveWorktree}>Remover worktree</button>
        </div>
      )}
      {locked && <p className="task-publishing-note">Disponível quando o agente terminar o turno.</p>}
      {latest && (
        <div className={latest.status === "failed" ? "task-failure" : "task-agent-log"}>
          <strong>{kindLabel[latest.kind]}</strong>
          <span>{statusLabel[latest.status]}</span>
          {latest.result && <p>{latest.result}</p>}
        </div>
      )}
    </article>
  );
}
