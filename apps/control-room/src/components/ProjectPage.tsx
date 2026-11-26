import { useMemo, type ReactNode } from "react";
import { FolderGit2, FolderTree, ListTodo, Pin, Plus, TerminalSquare } from "lucide-react";

import { AgentGlyph } from "./AgentGlyph.js";
import { FileExplorerPage, projectExplorerSource, type FileExplorerLocation } from "./FileExplorerPage.js";
import { pinnedFirst, relativeTime, type BoardCard } from "../services/board.js";
import type { ControlRoomClient, Project } from "../services/contracts.js";

export type ProjectSection = "tasks" | "files" | "terminal";

/** `#/projects/:id`, `#/projects/:id/files?directory=…&path=…` or `#/projects/:id/terminal`. */
export function projectRoute(hash: string): ({ projectId: string; section: ProjectSection } & FileExplorerLocation) | null {
  const [route, query = ""] = hash.replace(/^#\/?/, "").split("?");
  const [page, id, section, ...rest] = (route ?? "").split("/");
  if (page !== "projects" || !id || rest.length) return null;
  if (section !== undefined && section !== "files" && section !== "terminal") return null;
  try {
    const params = new URLSearchParams(query);
    const directoryId = params.get("directory"); const path = params.get("path");
    return { projectId: decodeURIComponent(id), section: section ?? "tasks", ...(directoryId ? { directoryId } : {}), ...(path ? { path } : {}) };
  } catch { return null; }
}

export function projectHash(projectId: string, section: ProjectSection = "tasks", location: FileExplorerLocation = {}): string {
  const base = `#/projects/${encodeURIComponent(projectId)}${section === "tasks" ? "" : `/${section}`}`;
  const params = new URLSearchParams();
  if (section === "files" && location.directoryId) params.set("directory", location.directoryId);
  if (section === "files" && location.path) params.set("path", location.path);
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

const sections: ReadonlyArray<{ id: ProjectSection; label: string; icon: typeof ListTodo }> = [
  { id: "tasks", label: "Tarefas", icon: ListTodo },
  { id: "files", label: "Arquivos", icon: FolderTree },
  { id: "terminal", label: "Terminal", icon: TerminalSquare },
];

/** One project: its folders, its tasks, a file explorer over its folders and a terminal in them. */
export function ProjectPage({ client, project, cards, section, location, statusLabel, actions, terminal, taskActions }: {
  client: ControlRoomClient;
  project: Project;
  /** The project's tasks, already placed on the board. */
  cards: BoardCard[];
  section: ProjectSection;
  location: FileExplorerLocation;
  statusLabel(card: BoardCard): string;
  /** Buttons next to the heading (edit, new task). */
  actions?: ReactNode;
  /** Content of the Terminal section. */
  terminal?: ReactNode;
  /** Pin and delete controls for one task row. */
  taskActions?(card: BoardCard): ReactNode;
}) {
  const source = useMemo(() => projectExplorerSource(client, project.id), [client, project.id]);
  const active = pinnedFirst(cards.filter((card) => card.place !== "archive"));
  const archived = cards.filter((card) => card.place === "archive");
  return (
    <section className="project-page" aria-labelledby="project-title">
      <header className="project-page-heading">
        <span className="project-icon purple" aria-hidden="true"><FolderGit2 size={22} /></span>
        <div>
          <span className="eyebrow">PROJETO</span>
          <h1 id="project-title" tabIndex={-1}>{project.name}</h1>
          <ul className="project-page-directories" aria-label={`Diretórios de ${project.name}`}>
            {project.directories.map((directory) => (
              <li key={directory.id} title={directory.path}><strong>{directory.name}</strong> <code>{directory.path}</code>{directory.isGitRepository && <span className="chip">Git</span>}</li>
            ))}
          </ul>
        </div>
        <div className="heading-actions">{actions}</div>
      </header>
      <nav className="task-tabs" aria-label="Seções do projeto">
        {sections.map((item) => (
          <a key={item.id} href={projectHash(project.id, item.id)} className={section === item.id ? "active" : ""} aria-current={section === item.id ? "page" : undefined}>
            <item.icon size={15} aria-hidden="true" /> <span>{item.label}</span>
            {item.id === "tasks" && active.length > 0 && <b className="task-tab-count">{active.length}</b>}
          </a>
        ))}
      </nav>

      {section === "tasks" && (
        <div className="project-task-list">
          {!cards.length && <div className="empty">Nenhuma tarefa neste projeto ainda. <a className="text-button" href="#/tasks/new"><Plus size={14} aria-hidden="true" /> Nova tarefa</a></div>}
          {[...active, ...archived].map((card) => (
            <article key={card.task.id} className={`project-task-row ${card.place === "archive" ? "archived" : ""}`}>
              <span className={`lane-dot lane-${card.place}`} aria-hidden="true" />
              <AgentGlyph provider={card.run?.provider} />
              <a className="project-task-title" href={`#/tasks/${encodeURIComponent(card.task.id)}`}>{card.task.pinnedAt && <Pin size={13} aria-label="Fixada" className="pin-mark" />}{card.task.title}</a>
              <span className="project-task-fact">{card.fact}</span>
              <span className={`status ${card.task.status}`}>{statusLabel(card)}</span>
              <time dateTime={card.at} title={new Date(card.at).toLocaleString("pt-BR")}>{relativeTime(card.at)}</time>
              <span className="project-task-actions">{taskActions?.(card)}</span>
            </article>
          ))}
        </div>
      )}
      {section === "files" && (
        <FileExplorerPage key={project.id} client={client} task={undefined} project={project} embedded source={source}
          initial={{ taskId: project.id, ...location }} onBack={() => undefined} hashFor={(next) => projectHash(project.id, "files", next)} />
      )}
      {section === "terminal" && terminal}
    </section>
  );
}
