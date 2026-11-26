import { placeTask } from "./board.js";
import { isLiveExecution, type ControlRoomSnapshot, type Task } from "./contracts.js";

export type InboxReason = "permission" | "publication" | "scope" | "failure" | "pull_request";

export interface InboxItem {
  task: Task;
  reason: InboxReason;
  /** The fact, in the operator's words, as the board shows it. */
  fact: string;
  at: string;
  /** Where the decision is taken. */
  href: string;
  action: string;
}

/** Most blocking first: an agent stopped mid-turn waits on you before anything else does. */
const order: readonly InboxReason[] = ["permission", "publication", "scope", "failure", "pull_request"];

const actionCopy: Record<InboxReason, string> = {
  permission: "Decidir permissão",
  publication: "Revisar publicação",
  scope: "Revisar escopo",
  failure: "Ver motivo",
  pull_request: "Ver pull request",
};

/**
 * Everything that is waiting on the operator, across every project, derived from the same
 * facts that place a task in the "Precisa de você" lane of the board.
 */
export function needsYou(snapshot: Pick<ControlRoomSnapshot, "tasks" | "runs"> & Partial<Pick<ControlRoomSnapshot, "actions" | "pullRequests">>): InboxItem[] {
  const items = snapshot.tasks.flatMap((task): InboxItem[] => {
    const card = placeTask(task, snapshot.runs, snapshot.actions ?? [], snapshot.pullRequests ?? []);
    if (card.place !== "needs_you") return [];
    const pending = (snapshot.actions ?? []).some((action) => action.taskId === task.id && action.status === "pending");
    const reason = reasonOf(task, pending, card.run !== undefined && isLiveExecution(task, card.run), Boolean(card.pullRequest));
    const taskHash = `#/tasks/${encodeURIComponent(task.id)}`;
    const href = reason === "permission" && card.run ? `#/executions/${encodeURIComponent(card.run.id)}`
      : reason === "publication" || reason === "pull_request" ? `${taskHash}/publish` : taskHash;
    return [{ task, reason, fact: card.fact, at: card.at, href, action: actionCopy[reason] }];
  });
  return items.sort((left, right) => order.indexOf(left.reason) - order.indexOf(right.reason) || right.at.localeCompare(left.at));
}

/** Mirrors the order in which `placeTask` decides that a task needs the operator. */
function reasonOf(task: Task, pendingAction: boolean, live: boolean, hasPullRequest: boolean): InboxReason {
  if (pendingAction) return "publication";
  if (task.status === "waiting_approval") return live ? "permission" : "scope";
  if (task.status === "failed") return "failure";
  if (hasPullRequest) return "pull_request";
  // A completed task whose last commit, push or pull request failed.
  return "publication";
}
