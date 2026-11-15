import { Archive, FolderOpen, GitBranch, GitPullRequest, Play } from "lucide-react";

import { AgentGlyph } from "./AgentGlyph.js";
import { lanes, relativeTime, type BoardCard } from "../services/board.js";
import type { Task } from "../services/contracts.js";

/**
 * Kanban of tasks placed by live facts. One card per task: agent, title, branch or folder,
 * the fact that put it in the lane and how long ago. Cancelled tasks collapse into the archive.
 */
export function TaskBoard({ cards, busy, location, onOpen, onExecute }: {
  cards: BoardCard[];
  busy: boolean;
  /** Branch of an isolated task, or the name of the folder it runs in. */
  location(task: Task): string;
  onOpen(taskId: string): void;
  onExecute(task: Task): void;
}) {
  const archived = cards.filter((card) => card.place === "archive");
  return (
    <div className="board">
      <div className="board-lanes">
        {lanes.map((lane) => {
          const items = cards.filter((card) => card.place === lane.id);
          return (
            <section key={lane.id} className={`board-lane lane-${lane.id}`} aria-labelledby={`lane-${lane.id}`}>
              <header>
                <span className="lane-dot" aria-hidden="true" />
                <h3 id={`lane-${lane.id}`}>{lane.label}</h3>
                <span className="lane-count" aria-label={`${items.length} tarefa(s)`}>{items.length}</span>
              </header>
              {items.map(({ task, fact, run, at, pullRequest }) => (
                <article key={task.id} className="board-card">
                  <div className="board-card-title">
                    <AgentGlyph provider={run?.provider} />
                    <button className="task-title" onClick={() => onOpen(task.id)}>{task.title}</button>
                  </div>
                  <p className="board-card-location">
                    {task.branch ? <GitBranch size={12} aria-hidden="true" /> : <FolderOpen size={12} aria-hidden="true" />}
                    <span>{location(task)}</span>
                  </p>
                  {pullRequest && (
                    <p className="board-card-location">
                      <GitPullRequest size={12} aria-hidden="true" />
                      <a href={pullRequest.url} target="_blank" rel="noreferrer" aria-label={`Abrir pull request ${pullRequest.number} no GitHub`}>#{pullRequest.number}</a>
                      {pullRequest.checks.total > 0 && <span>{pullRequest.checks.passed}/{pullRequest.checks.total} checks</span>}
                    </p>
                  )}
                  <footer>
                    <span className="board-card-fact">{fact}</span>
                    {lane.id === "queued"
                      ? <button className="text-button" aria-label={`Executar ${task.title}`} disabled={busy} onClick={() => onExecute(task)}><Play size={13} aria-hidden="true" /> Executar</button>
                      : <time dateTime={at} title={new Date(at).toLocaleString("pt-BR")}>{relativeTime(at)}</time>}
                  </footer>
                </article>
              ))}
              {!items.length && <p className="lane-empty">{lane.empty}</p>}
            </section>
          );
        })}
      </div>
      {archived.length > 0 && (
        <details className="board-archive">
          <summary><Archive size={13} aria-hidden="true" /> ARQUIVO <span>{archived.length}</span></summary>
          <ul>
            {archived.map(({ task, at }) => (
              <li key={task.id}>
                <button className="task-title" onClick={() => onOpen(task.id)}>{task.title}</button>
                <time dateTime={at}>{relativeTime(at)}</time>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
