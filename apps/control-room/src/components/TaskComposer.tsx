import { useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, FolderGit2 } from "lucide-react";

import type { CreateTaskInput, Priority, Project } from "../services/contracts.js";

export function TaskComposer({ projects, initialProjectId, busy, error, onSubmit, onRegisterProject }: {
  projects: Project[];
  initialProjectId: string;
  busy: boolean;
  error: string;
  onSubmit(input: CreateTaskInput): void;
  onRegisterProject(): void;
}) {
  const initialProject = projects.find((project) => project.id === initialProjectId) ?? projects[0];
  const initialDirectoryId = initialProject?.directories[0]?.id ?? "";
  const [projectId, setProjectId] = useState(initialProject?.id ?? "");
  const [targetDirectoryId, setTargetDirectoryId] = useState(initialDirectoryId);
  const [directoryIds, setDirectoryIds] = useState(initialDirectoryId ? [initialDirectoryId] : []);
  const project = projects.find((item) => item.id === projectId) ?? initialProject;
  const target = project?.directories.find((directory) => directory.id === targetDirectoryId) ?? project?.directories[0];
  const additional = project?.directories.filter((directory) => directory.id !== target?.id) ?? [];

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project || !target || busy) return;
    const fields = new FormData(event.currentTarget);
    const kind = fields.get("kind");
    onSubmit({
      projectId: project.id,
      targetDirectoryId: target.id,
      directoryIds: [target.id, ...directoryIds.filter((id) => id !== target.id && project.directories.some((directory) => directory.id === id))],
      title: String(fields.get("title") ?? "").trim() || titleFrom(String(fields.get("prompt") ?? "")),
      prompt: String(fields.get("prompt")),
      priority: String(fields.get("priority")) as Priority,
      ...(kind === "review" || kind === "planning" ? { kind } : {}),
    });
  }

  if (!project) return (
    <div className="composer-empty">
      <p>Cadastre um projeto local para indicar onde a tarefa será executada.</p>
      <button className="primary" type="button" disabled={busy} onClick={onRegisterProject}><FolderGit2 size={17} /> Cadastrar projeto</button>
    </div>
  );

  return (
    <form className="task-composer" onSubmit={submit}>
      <label className="composer-prompt">
        Solicitação
        <textarea name="prompt" required maxLength={20000} rows={6} autoFocus onKeyDown={submitOnShortcut}
          placeholder="Descreva o que o agente deve fazer: o objetivo, o contexto e como saber que ficou pronto." />
      </label>
      <label>
        Título
        <input name="title" maxLength={160} placeholder="Opcional: usamos a primeira linha da solicitação" />
      </label>
      <div className="composer-target">
        <label>
          Projeto
          <select value={project.id} required onChange={(event) => {
            const next = projects.find((item) => item.id === event.target.value);
            const directoryId = next?.directories[0]?.id ?? "";
            setProjectId(event.target.value);
            setTargetDirectoryId(directoryId);
            setDirectoryIds(directoryId ? [directoryId] : []);
          }}>
            {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label>
          Diretório-alvo
          <select value={target?.id ?? ""} required onChange={(event) => {
            const directoryId = event.target.value;
            setTargetDirectoryId(directoryId);
            setDirectoryIds((current) => [directoryId, ...current.filter((item) => item !== directoryId)]);
          }}>
            {project.directories.map((directory) => <option key={directory.id} value={directory.id}>{directory.name} · {directory.path}</option>)}
          </select>
        </label>
      </div>
      <details className="composer-options">
        <summary>Tipo, prioridade e escopo</summary>
        <label>
          Tipo de tarefa
          <select name="kind" defaultValue="auto">
            <option value="auto">Classificar pela solicitação</option>
            <option value="review">Revisão</option>
            <option value="planning">Planejamento</option>
          </select>
          <small>Revisão e planejamento podem ser executados pelo Claude Code usando somente o texto informado.</small>
        </label>
        {additional.length > 0 && (
          <fieldset className="task-scope">
            <legend>Diretórios adicionais afetados</legend>
            {additional.map((directory) => (
              <label key={directory.id} className="scope-option">
                <input type="checkbox" checked={directoryIds.includes(directory.id)} onChange={(event) => {
                  const checked = event.target.checked;
                  setDirectoryIds((current) => checked ? [...current, directory.id] : current.filter((id) => id !== directory.id));
                }} />
                {directory.name}
              </label>
            ))}
            <small>Mais de um diretório exige aprovação antes do despacho.</small>
          </fieldset>
        )}
        <label>
          Prioridade
          <select name="priority" defaultValue="normal">
            <option value="critical">Crítica</option>
            <option value="high">Alta</option>
            <option value="normal">Normal</option>
            <option value="low">Baixa</option>
          </select>
        </label>
      </details>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="composer-footer">
        <small>Você confirma a execução depois de criar a tarefa. <kbd>Ctrl</kbd> + <kbd>Enter</kbd> cria.</small>
        <button className="primary" disabled={busy || !target}><ArrowUp size={16} /> {busy ? "Criando…" : "Criar tarefa"}</button>
      </div>
    </form>
  );
}

/** Ctrl+Enter (or Cmd+Enter) submits the form, as in a chat composer. */
export function submitOnShortcut(event: KeyboardEvent<HTMLTextAreaElement>): void {
  if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

/** A title from the first meaningful line of the request, without Markdown marks, up to 80 characters. */
export function titleFrom(prompt: string): string {
  const line = prompt.split(/\r?\n/).map((item) => item.replace(/^[\s#>*\-\d.)]+/, "").replace(/[*_`]/g, "").trim()).find(Boolean) ?? "Nova tarefa";
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}
