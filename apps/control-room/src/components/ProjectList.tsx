import { ArrowRight, Clock3, FolderOpen, GitBranch, ListTodo } from "lucide-react";

import { ProjectIcon } from "./ProjectIcon.js";
import { relativeTime } from "../services/board.js";
import type { ControlRoomClient, Project, Run, Task } from "../services/contracts.js";
import { projectHash } from "./ProjectPage.js";

const activity = (age: string) => age === "agora" ? "Atividade agora" : `Atividade há ${age}`;
const isolationText = { worktree: "Worktree por tarefa", direct: "Direto na pasta" } as const;

/** One card per project with only the general facts; settings live on the project's own screen. */
export function ProjectList({ client, projects, tasks, runs }: { client: ControlRoomClient; projects: Project[]; tasks: Task[]; runs: Run[] }) {
  return (
    <div className="project-grid">
      {projects.map((project) => {
        const own = tasks.filter((task) => task.projectId === project.id);
        const open = own.filter((task) => task.status !== "completed" && task.status !== "cancelled").length;
        const lastActivity = [...own.map((task) => task.updatedAt), ...runs.filter((run) => own.some((task) => task.id === run.taskId)).map((run) => run.finishedAt ?? run.startedAt ?? "")]
          .filter(Boolean).sort().at(-1);
        const git = project.directories.every((directory) => directory.isGitRepository);
        return (
          <a key={project.id} className="project-card" href={projectHash(project.id)} aria-label={`Abrir ${project.name}`}>
            <span className="project-card-heading">
              <ProjectIcon client={client} projectId={project.id} />
              <span className="project-card-title">
                <strong className="project-name">{project.name}</strong>
                <small>{project.directories.map((directory) => directory.name).join(" · ")}</small>
              </span>
              <ArrowRight size={15} aria-hidden="true" className="project-card-arrow" />
            </span>
            <span className="project-card-facts">
              <span><ListTodo size={13} aria-hidden="true" /> {open} em aberto · {own.length} no total</span>
              <span><FolderOpen size={13} aria-hidden="true" /> {project.directories.length} diretório{project.directories.length === 1 ? "" : "s"}{git ? " · Git" : ""}</span>
              {git && <span><GitBranch size={13} aria-hidden="true" /> {isolationText[project.isolation]}</span>}
              <span><Clock3 size={13} aria-hidden="true" /> {lastActivity ? activity(relativeTime(lastActivity)) : "Sem atividade ainda"}</span>
            </span>
          </a>
        );
      })}
    </div>
  );
}
