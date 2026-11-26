import { FolderTree, MessageSquare, Send } from "lucide-react";

export type TaskTab = "conversation" | "files" | "publish";

const tabs: ReadonlyArray<{ id: TaskTab; label: string; icon: typeof MessageSquare }> = [
  { id: "conversation", label: "Conversa", icon: MessageSquare },
  { id: "files", label: "Arquivos", icon: FolderTree },
  { id: "publish", label: "Publicação", icon: Send },
];

export function taskTabHash(taskId: string, tab: TaskTab): string {
  const base = `#/tasks/${encodeURIComponent(taskId)}`;
  return tab === "conversation" ? base : `${base}/${tab}`;
}

/** `#/tasks/:id/publish` → the task id; null for any other route. */
export function taskPublishRoute(hash: string): string | null {
  const [section, id, page, ...rest] = (hash.replace(/^#\/?/, "").split("?")[0] ?? "").split("/");
  if (section !== "tasks" || !id || page !== "publish" || rest.length) return null;
  try { return decodeURIComponent(id); } catch { return null; }
}

/**
 * The three sides of a task: what was said, what changed on disk and what leaves the machine.
 * Each one is its own route, so the browser's back button and links keep working.
 */
export function TaskTabs({ taskId, active, pendingPublications = 0, changedFiles }: {
  taskId: string;
  active: TaskTab;
  /** Commits, pushes or pull requests waiting for the operator. */
  pendingPublications?: number;
  changedFiles?: number;
}) {
  return (
    <nav className="task-tabs" aria-label="Seções da tarefa">
      {tabs.map((tab) => {
        const count = tab.id === "publish" ? pendingPublications : tab.id === "files" ? changedFiles ?? 0 : 0;
        return (
          <a key={tab.id} href={taskTabHash(taskId, tab.id)} className={active === tab.id ? "active" : ""} aria-current={active === tab.id ? "page" : undefined}>
            <tab.icon size={15} aria-hidden="true" />
            <span>{tab.label}</span>
            {count > 0 && <b className={`task-tab-count ${tab.id === "publish" ? "attention" : ""}`} aria-label={tab.id === "publish" ? `${count} aguardando aprovação` : `${count} alterado(s)`}>{count}</b>}
          </a>
        );
      })}
    </nav>
  );
}
