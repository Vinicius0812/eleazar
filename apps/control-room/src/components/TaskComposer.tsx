import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, BookmarkPlus, FolderGit2, Trash2 } from "lucide-react";

import type { CreateTaskInput, Priority, Project, TaskTemplate, TaskTemplateInput } from "../services/contracts.js";

export function TaskComposer({ projects, initialProjectId, busy, error, onSubmit, onRegisterProject, agents = [], onCompare, templates = [], onSaveTemplate, onDeleteTemplate }: {
  projects: Project[];
  /** Saved requests the operator can start from. */
  templates?: TaskTemplate[];
  onSaveTemplate?(input: TaskTemplateInput): void;
  onDeleteTemplate?(template: TaskTemplate): void;
  /** Agents that can take part in a comparison: enabled and not signed out. */
  agents?: Array<{ id: string; label: string }>;
  /** Runs the request with several agents at once, each in its own worktree. */
  onCompare?(input: CreateTaskInput, providers: string[]): void;
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
  const [compare, setCompare] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [naming, setNaming] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const template = templates.find((item) => item.id === templateId);
  const available = templates.filter((item) => !item.projectId || projects.some((candidate) => candidate.id === item.projectId));

  function chooseProject(nextId: string) {
    const next = projects.find((item) => item.id === nextId);
    const directoryId = next?.directories[0]?.id ?? "";
    setProjectId(nextId);
    setTargetDirectoryId(directoryId);
    setDirectoryIds(directoryId ? [directoryId] : []);
  }
  function chooseTemplate(id: string) {
    setTemplateId(id);
    const chosen = templates.find((item) => item.id === id);
    if (chosen?.projectId && chosen.projectId !== project?.id && projects.some((item) => item.id === chosen.projectId)) chooseProject(chosen.projectId);
  }
  function saveTemplate() {
    if (!form.current || !onSaveTemplate || !templateName.trim()) return;
    const fields = new FormData(form.current);
    const prompt = String(fields.get("prompt") ?? "").trim();
    const title = String(fields.get("title") ?? "").trim();
    const kind = fields.get("kind");
    onSaveTemplate({ name: templateName.trim(), prompt, priority: String(fields.get("priority")) as Priority,
      ...(title ? { title } : {}), ...(kind === "review" || kind === "planning" ? { kind } : {}), ...(project ? { projectId: project.id } : {}) });
    setNaming(false); setTemplateName("");
  }
  const [picked, setRivals] = useState<[string, string]>(["", ""]);
  // The agents arrive after the first render; until the operator picks, the first two are used.
  const rivals: [string, string] = [picked[0] || agents[0]?.id || "", picked[1] || agents[1]?.id || ""];
  const comparable = Boolean(onCompare) && agents.length >= 2 && project?.isolation !== "direct" && Boolean(target?.isGitRepository);
  const comparing = compare && comparable;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project || !target || busy) return;
    const fields = new FormData(event.currentTarget);
    const kind = fields.get("kind");
    const input: CreateTaskInput = {
      projectId: project.id,
      targetDirectoryId: target.id,
      directoryIds: [target.id, ...directoryIds.filter((id) => id !== target.id && project.directories.some((directory) => directory.id === id))],
      title: String(fields.get("title") ?? "").trim() || titleFrom(String(fields.get("prompt") ?? "")),
      prompt: String(fields.get("prompt")),
      priority: String(fields.get("priority")) as Priority,
      ...(kind === "review" || kind === "planning" ? { kind } : {}),
    };
    if (comparing && onCompare) onCompare({ ...input, directoryIds: [target.id] }, rivals);
    else onSubmit(input);
  }

  if (!project) return (
    <div className="composer-empty">
      <p>Cadastre um projeto local para indicar onde a tarefa será executada.</p>
      <button className="primary" type="button" disabled={busy} onClick={onRegisterProject}><FolderGit2 size={17} /> Cadastrar projeto</button>
    </div>
  );

  return (
    // Choosing a template remounts the fields so they start from its text.
    <form className="task-composer" onSubmit={submit} ref={form} key={templateId || "blank"}>
      {available.length > 0 && (
        <div className="composer-template">
          <label>
            Começar de um modelo
            <select value={templateId} onChange={(event) => chooseTemplate(event.target.value)}>
              <option value="">Em branco</option>
              {available.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          {template && onDeleteTemplate && <button type="button" className="text-button danger" disabled={busy} onClick={() => { onDeleteTemplate(template); setTemplateId(""); }}><Trash2 size={14} aria-hidden="true" /> Excluir modelo</button>}
        </div>
      )}
      <label className="composer-prompt">
        Solicitação
        <textarea name="prompt" required maxLength={20000} rows={6} autoFocus onKeyDown={submitOnShortcut} defaultValue={template?.prompt}
          placeholder="Descreva o que o agente deve fazer: o objetivo, o contexto e como saber que ficou pronto." />
      </label>
      <label>
        Título
        <input name="title" maxLength={160} defaultValue={template?.title} placeholder="Opcional: usamos a primeira linha da solicitação" />
      </label>
      <div className="composer-target">
        <label>
          Projeto
          <select value={project.id} required onChange={(event) => chooseProject(event.target.value)}>
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
          <select name="kind" defaultValue={template?.kind === "review" || template?.kind === "planning" ? template.kind : "auto"}>
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
        {comparable && (
          <fieldset className="task-scope composer-compare">
            <legend>Comparar agentes</legend>
            <label className="scope-option">
              <input type="checkbox" checked={compare} onChange={(event) => setCompare(event.target.checked)} />
              Rodar com dois agentes ao mesmo tempo e comparar as alterações
            </label>
            {compare && <div className="composer-target">
              {([0, 1] as const).map((index) => (
                <label key={index}>
                  {index === 0 ? "Primeiro agente" : "Segundo agente"}
                  <select value={rivals[index]} onChange={(event) => { const value = event.target.value; setRivals(index === 0 ? [value, rivals[1]] : [rivals[0], value]); }}>
                    {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}
                  </select>
                </label>
              ))}
            </div>}
            <small>Cada agente trabalha na própria branch e worktree. Os dois começam assim que a tarefa é criada, e você escolhe qual versão manter.</small>
            {compare && rivals[0] === rivals[1] && <small className="error-text">Escolha dois agentes diferentes.</small>}
          </fieldset>
        )}
        <label>
          Prioridade
          <select name="priority" defaultValue={template?.priority ?? "normal"}>
            <option value="critical">Crítica</option>
            <option value="high">Alta</option>
            <option value="normal">Normal</option>
            <option value="low">Baixa</option>
          </select>
        </label>
      </details>
      {error && <div className="error" role="alert">{error}</div>}
      {onSaveTemplate && (naming ? (
        <div className="composer-save-template">
          <label>
            Nome do modelo
            <input value={templateName} maxLength={100} autoFocus placeholder="Ex.: Revisar pull request" onChange={(event) => setTemplateName(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); saveTemplate(); } }} />
          </label>
          <button type="button" className="secondary" disabled={busy || !templateName.trim()} onClick={saveTemplate}>Salvar modelo</button>
          <button type="button" className="text-button" onClick={() => setNaming(false)}>Cancelar</button>
        </div>
      ) : (
        <button type="button" className="text-button composer-save-trigger" disabled={busy} onClick={() => { setNaming(true); setTemplateName(template?.name ? `${template.name} (cópia)` : ""); }}>
          <BookmarkPlus size={14} aria-hidden="true" /> Salvar como modelo
        </button>
      ))}
      <div className="composer-footer">
        <small>{comparing ? "Os dois agentes começam a trabalhar assim que você criar." : "Você confirma a execução depois de criar a tarefa."} <kbd>Ctrl</kbd> + <kbd>Enter</kbd> cria.</small>
        <button className="primary" disabled={busy || !target || (comparing && rivals[0] === rivals[1])}><ArrowUp size={16} /> {busy ? "Criando…" : comparing ? "Criar e comparar" : "Criar tarefa"}</button>
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
