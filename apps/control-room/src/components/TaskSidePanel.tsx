import { Bot, Coins, FolderOpen, GitBranch, GitPullRequest, Info, Send, Sparkles } from "lucide-react";

import { AgentGlyph } from "./AgentGlyph.js";
import type { AgentProfile, Project, ProviderStatus, Run, Skill, Task, TaskOutboundAction, TaskPullRequest } from "../services/contracts.js";

const kindLabel: Record<string, string> = {
  implementation: "Implementação", review: "Revisão", planning: "Planejamento", research: "Pesquisa",
  testing: "Testes", documentation: "Documentação", unknown: "Geral",
};
const priorityLabel: Record<Task["priority"], string> = { critical: "Crítica", high: "Alta", normal: "Normal", low: "Baixa" };
const runLabel: Record<Run["status"], string> = { planned: "Preparando", running: "Trabalhando", completed: "Concluiu", failed: "Falhou", cancelled: "Cancelado" };

export interface RecruitedAgent {
  key: string;
  provider: string;
  label: string;
  /** What the agent does in this task, in the operator's words. */
  role: string;
  model: string | null;
  transport: Run["transport"];
  turns: number;
  tokens: number;
  last: Run;
  /** Set for an agent that works on a sibling attempt of a comparison. */
  taskId?: string;
}

/**
 * The agents a task brought in, from its turns (oldest first): the first one implements, a later
 * different one continues, and the attempts of a comparison run side by side.
 */
export function recruitedAgents(task: Task, runs: readonly Run[], siblings: ReadonlyArray<{ task: Task; runs: readonly Run[] }>, providers: readonly ProviderStatus[]): RecruitedAgent[] {
  const label = (id: string) => providers.find((item) => item.provider === id)?.label ?? id.charAt(0).toUpperCase() + id.slice(1);
  const agents: RecruitedAgent[] = [];
  const add = (run: Run, role: string, taskId?: string) => {
    if (!run.provider) return;
    const key = `${taskId ?? task.id}:${run.provider}:${run.model ?? ""}`;
    const existing = agents.find((agent) => agent.key === key);
    const tokens = run.usage?.total ?? 0;
    if (existing) { existing.turns += 1; existing.tokens += tokens; existing.last = run; return; }
    agents.push({ key, provider: run.provider, label: label(run.provider), role, model: run.model ?? null, transport: run.transport ?? null, turns: 1, tokens, last: run, ...(taskId ? { taskId } : {}) });
  };
  const ordered = [...runs].filter((run) => run.taskId === task.id).reverse();
  const first = ordered.find((run) => run.provider)?.provider;
  for (const run of ordered) add(run, run.provider === first ? (task.comparisonId ? "Executor nesta tentativa" : "Executor principal") : "Continuou a tarefa");
  for (const sibling of siblings) for (const run of [...sibling.runs].reverse()) add(run, "Tentativa concorrente na comparação", sibling.task.id);
  return agents;
}

/** Side panel of a task, in the style of the agent apps: who works on it, where, and what is pending. */
export function TaskSidePanel({ task, project, runs, siblings = [], providers, actions = [], pullRequests = [], profile, skills = [] }: {
  /** The Eleazar agent profile chosen for the task. */
  profile?: AgentProfile | undefined;
  skills?: Skill[];
  task: Task;
  project: Project | undefined;
  /** The task's runs, newest first. */
  runs: Run[];
  siblings?: Array<{ task: Task; runs: Run[] }>;
  providers: ProviderStatus[];
  actions?: TaskOutboundAction[];
  pullRequests?: TaskPullRequest[];
}) {
  const agents = recruitedAgents(task, runs, siblings, providers);
  const directories = project?.directories.filter((directory) => task.directoryIds.includes(directory.id)) ?? [];
  const tokens = runs.reduce((total, run) => total + (run.usage?.total ?? 0), 0);
  const pending = actions.filter((action) => action.status === "pending");
  return (
    <aside className="task-side" aria-label="Detalhes da tarefa">
      <section>
        <h2><Bot size={15} aria-hidden="true" /> Agentes</h2>
        {!agents.length && <p className="task-side-empty">Nenhum agente trabalhou nesta tarefa ainda. Ao executar, o Eleazar escolhe ou usa o provedor que você indicar.</p>}
        <ul className="task-side-agents">
          {agents.map((agent) => (
            <li key={agent.key}>
              <AgentGlyph provider={agent.provider} />
              <div>
                <strong>{agent.label}</strong>
                <span className="task-side-role">{agent.role}</span>
                <dl>
                  <div><dt>Modelo</dt><dd>{agent.model ?? "Padrão do provedor"}</dd></div>
                  <div><dt>Provedor</dt><dd>{agent.provider}{agent.transport ? ` · ${agent.transport === "acp" ? "ACP" : "CLI"}` : ""}</dd></div>
                  <div><dt>Turnos</dt><dd>{agent.turns} · {runLabel[agent.last.status]}</dd></div>
                  {agent.tokens > 0 && <div><dt>Tokens</dt><dd>{agent.tokens.toLocaleString("pt-BR")}</dd></div>}
                </dl>
                {agent.taskId && <a className="text-button" href={`#/tasks/${encodeURIComponent(agent.taskId)}`}>Abrir tentativa</a>}
              </div>
            </li>
          ))}
        </ul>
        {task.comparisonId && <a className="text-button" href={`#/comparisons/${encodeURIComponent(task.comparisonId)}`}>Comparar as tentativas</a>}
      </section>

      {(profile || (task.skillIds?.length ?? 0) > 0) && (
        <section>
          <h2><Sparkles size={15} aria-hidden="true" /> Perfil e skills</h2>
          {profile && <p className="task-side-profile"><strong>{profile.name}</strong>{profile.role ? ` · ${profile.role}` : ""}<br /><small>Prefere {profile.provider ?? "o Automático"}{profile.model ? ` · ${profile.model}` : ""}</small></p>}
          <ul className="task-side-skills">
            {[...new Set([...(profile?.skillIds ?? []), ...(task.skillIds ?? [])])].map((id) => skills.find((skill) => skill.id === id)).filter((skill): skill is Skill => Boolean(skill))
              .map((skill) => <li key={skill.id} title={skill.description}>{skill.name}</li>)}
          </ul>
        </section>
      )}

      <section>
        <h2><Info size={15} aria-hidden="true" /> Tarefa</h2>
        <dl className="task-side-facts">
          <div><dt>Tipo</dt><dd>{kindLabel[task.kind] ?? task.kind}</dd></div>
          <div><dt>Prioridade</dt><dd>{priorityLabel[task.priority]}</dd></div>
          <div><dt>Criada</dt><dd>{new Date(task.createdAt).toLocaleString("pt-BR")}</dd></div>
          <div><dt>Atualizada</dt><dd>{new Date(task.updatedAt).toLocaleString("pt-BR")}</dd></div>
          {tokens > 0 && <div><dt><Coins size={12} aria-hidden="true" /> Tokens</dt><dd>{tokens.toLocaleString("pt-BR")}</dd></div>}
        </dl>
      </section>

      <section>
        <h2>{task.branch ? <GitBranch size={15} aria-hidden="true" /> : <FolderOpen size={15} aria-hidden="true" />} Onde trabalha</h2>
        <dl className="task-side-facts">
          <div><dt>Modo</dt><dd>{task.branch ? "Worktree própria" : "Direto na pasta"}</dd></div>
          {task.branch && <div><dt>Branch</dt><dd><code>{task.branch}</code></dd></div>}
          <div><dt>Diretórios</dt><dd>{directories.map((directory) => directory.name).join(", ") || "Indisponível"}</dd></div>
        </dl>
      </section>

      {(pending.length > 0 || pullRequests.length > 0) && (
        <section>
          <h2><Send size={15} aria-hidden="true" /> Publicação</h2>
          {pending.length > 0 && <a className="text-button" href={`#/tasks/${encodeURIComponent(task.id)}/publish`}>{pending.length} ação aguardando aprovação</a>}
          {pullRequests.map((pullRequest) => (
            <a key={`${pullRequest.directoryId}-${pullRequest.number}`} className="task-side-pr" href={pullRequest.url} target="_blank" rel="noreferrer">
              <GitPullRequest size={13} aria-hidden="true" /> #{pullRequest.number} · {pullRequest.state === "open" ? "aberto" : pullRequest.state === "merged" ? "mesclado" : "fechado"}
            </a>
          ))}
        </section>
      )}
    </aside>
  );
}
