import type { ControlRoomSnapshot } from "./contracts.js";
import { needsYou, type InboxReason } from "./inbox.js";

export interface PendingNotification { tag: string; title: string; body: string; href: string; }

const reasonTitle: Record<InboxReason, string> = {
  permission: "O agente pede uma permissão",
  publication: "Publicação aguarda você",
  scope: "Escopo aguarda aprovação",
  failure: "Execução falhou",
  pull_request: "Pull request precisa de você",
};

type Facts = Pick<ControlRoomSnapshot, "tasks" | "runs"> & Partial<Pick<ControlRoomSnapshot, "actions" | "pullRequests">>;

/**
 * What changed for the operator between two snapshots: something new waits on them, or a turn
 * that was running finished. A first load (no previous snapshot) announces nothing.
 */
export function notificationsBetween(previous: Facts | null, next: Facts): PendingNotification[] {
  if (!previous) return [];
  const known = new Set(needsYou(previous).map((item) => `${item.task.id}:${item.reason}:${item.fact}`));
  const fresh = needsYou(next).filter((item) => !known.has(`${item.task.id}:${item.reason}:${item.fact}`)).map((item) => ({
    tag: `${item.task.id}:${item.reason}`, title: reasonTitle[item.reason], body: `${item.task.title} · ${item.fact}`, href: item.href,
  }));
  const wasWorking = new Set(previous.tasks.filter((task) => task.status === "planning" || task.status === "running").map((task) => task.id));
  const finished = next.tasks.filter((task) => task.status === "completed" && wasWorking.has(task.id)).map((task) => ({
    tag: `${task.id}:completed`, title: "Turno concluído", body: `${task.title} · pronto para revisar`, href: `#/tasks/${encodeURIComponent(task.id)}`,
  }));
  return [...fresh, ...finished];
}

export type NotificationSupport = "unsupported" | NotificationPermission;

export function notificationSupport(): NotificationSupport {
  return typeof window !== "undefined" && "Notification" in window ? window.Notification.permission : "unsupported";
}

/** Shows the notices with the browser's own API; clicking one brings the tab forward on the right screen. */
export function showNotifications(items: readonly PendingNotification[]): void {
  if (notificationSupport() !== "granted") return;
  for (const item of items) {
    try {
      const notice = new window.Notification(item.title, { body: item.body, tag: item.tag });
      notice.onclick = () => { window.focus(); window.location.hash = item.href.replace(/^#/, ""); notice.close(); };
    } catch { /* Some browsers only allow notifications from a service worker. */ }
  }
}
