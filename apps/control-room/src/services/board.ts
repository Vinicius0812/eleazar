import { isLiveExecution, type OutboundActionKind, type Run, type Task, type TaskOutboundAction, type TaskPullRequest } from "./contracts.js";

export type LaneId = "queued" | "working" | "needs_you" | "review" | "in_review" | "ready";
export type BoardPlace = LaneId | "archive";

export const lanes: ReadonlyArray<{ id: LaneId; label: string; empty: string }> = [
  { id: "queued", label: "Na fila", empty: "Nada esperando para começar." },
  { id: "working", label: "Trabalhando", empty: "Nenhum agente em execução." },
  { id: "needs_you", label: "Precisa de você", empty: "Nada depende de você agora." },
  { id: "review", label: "Para revisar", empty: "Nenhum turno concluído para revisar." },
  { id: "in_review", label: "Em revisão", empty: "Nenhum pull request em revisão." },
  { id: "ready", label: "Pronto para merge", empty: "Nenhum pull request aprovado." }
];

export interface BoardCard {
  task: Task;
  place: BoardPlace;
  /** The live fact that put the task in this lane, in the operator's words. */
  fact: string;
  run: Run | undefined;
  /** The pull request that decided the lane, when the task has one. */
  pullRequest?: TaskPullRequest;
  /** Instant of that fact, for the relative time on the card. */
  at: string;
}

const pendingCopy: Record<OutboundActionKind, string> = {
  commit: "Commit aguardando aprovação", push: "Envio da branch aguardando aprovação", pull_request: "Pull request aguardando aprovação"
};
const doneCopy: Record<OutboundActionKind, string> = { commit: "Commit criado", push: "Branch enviada", pull_request: "Pull request aberto" };

/**
 * Places a task on the board from facts already in the snapshot — its status, its latest
 * run, its outbound actions and its pull requests — so nobody has to move cards by hand.
 * `runs` and `actions` are expected newest first, as the API returns them.
 */
export function placeTask(task: Task, runs: readonly Run[], actions: readonly TaskOutboundAction[] = [], pullRequests: readonly TaskPullRequest[] = []): BoardCard {
  const run = runs.find((item) => item.taskId === task.id);
  const own = actions.filter((action) => action.taskId === task.id);
  const pending = own.find((action) => action.status === "pending");
  const at = run?.finishedAt ?? run?.startedAt ?? task.updatedAt;
  const card = (place: BoardPlace, fact: string, when = at): BoardCard => ({ task, place, fact, run, at: when });

  if (task.status === "cancelled") return card("archive", "Cancelada", task.updatedAt);
  if (pending) return card("needs_you", pendingCopy[pending.kind], pending.createdAt);
  if (task.status === "waiting_approval") {
    return run && isLiveExecution(task, run) ? card("needs_you", "Agente aguarda uma permissão") : card("needs_you", "Escopo aguardando aprovação", task.updatedAt);
  }
  if (task.status === "failed") return card("needs_you", "Execução falhou");
  if (task.status === "planning") return card("working", "Preparando execução", task.updatedAt);
  if (task.status === "running") return card("working", "Agente trabalhando");
  if (task.status === "completed") {
    const latest = own[0];
    if (latest?.status === "failed") return card("needs_you", "Publicação falhou", latest.finishedAt ?? latest.createdAt);
    // With several repositories, the pull request that needs the most attention decides the lane.
    const verdicts = pullRequests.filter((item) => item.taskId === task.id).map((pullRequest) => ({ pullRequest, ...judge(pullRequest) }))
      .sort((left, right) => urgency.indexOf(left.place) - urgency.indexOf(right.place));
    if (verdicts[0]) return { ...card(verdicts[0].place, verdicts[0].fact), pullRequest: verdicts[0].pullRequest };
    if (latest?.status === "completed") return card("review", doneCopy[latest.kind], latest.finishedAt ?? latest.createdAt);
    return card("review", "Turno concluído");
  }
  return card("queued", "Pronta para executar", task.updatedAt);
}

const urgency: readonly BoardPlace[] = ["needs_you", "in_review", "ready", "review", "archive"];

/** Reads CI, conflicts and review state of one pull request, most blocking fact first. */
function judge(pullRequest: TaskPullRequest): { place: BoardPlace; fact: string } {
  const { checks } = pullRequest;
  if (pullRequest.state === "merged") return { place: "archive", fact: "Pull request mesclado" };
  if (pullRequest.state === "closed") return { place: "review", fact: "Pull request fechado sem merge" };
  if (checks.failed > 0) return { place: "needs_you", fact: `CI falhou${checks.failing[0] ? ` · ${checks.failing[0]}` : ""}` };
  if (pullRequest.mergeable === "conflicting") return { place: "needs_you", fact: "Conflito de merge" };
  if (pullRequest.reviewDecision === "changes_requested") return { place: "needs_you", fact: "Alterações solicitadas" };
  if (pullRequest.isDraft) return { place: "in_review", fact: "Rascunho" };
  if (checks.pending > 0) return { place: "in_review", fact: "Checks em execução" };
  if (pullRequest.reviewDecision === "approved") return { place: "ready", fact: "Aprovado" };
  if (pullRequest.reviewDecision === "review_required") return { place: "in_review", fact: "Revisão pendente" };
  // No review policy on the repository: green checks are all there is to wait for.
  return checks.total > 0 ? { place: "ready", fact: "Checks aprovados" } : { place: "in_review", fact: "Aguardando revisão" };
}

/** Pinned tasks first (the most recently pinned on top); the rest keep their order. */
export function pinnedFirst<T extends { task: Task }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => (right.task.pinnedAt ?? "").localeCompare(left.task.pinnedAt ?? ""));
}

/** Compact age for a card: "agora", "5 min", "3 h", "2 d". */
export function relativeTime(at: string, now = Date.now()): string {
  const minutes = Math.floor((now - new Date(at).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "agora";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}
