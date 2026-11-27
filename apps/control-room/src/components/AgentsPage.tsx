import { useState, type FormEvent, type ReactNode } from "react";
import { Bot, Plus, Trash2 } from "lucide-react";

import { AgentGlyph } from "./AgentGlyph.js";
import { skillSourceLabel } from "./SkillsPage.js";
import type { AgentProfile, AgentProfileInput, ProviderStatus, Skill } from "../services/contracts.js";

/** Reusable agents: a role, standing instructions and skills, run by the preferred provider or by Automático. */
export function AgentsPage({ agents, skills, providers, busy, onCreate, onUpdate, onDelete, catalogActions }: {
  /** Export and import buttons of the whole catalog. */
  catalogActions?: ReactNode;
  agents: AgentProfile[];
  skills: Skill[];
  providers: ProviderStatus[];
  busy: boolean;
  onCreate(input: AgentProfileInput): void;
  onUpdate(id: string, input: AgentProfileInput): void;
  onDelete(agent: AgentProfile): void;
}) {
  const [selectedId, setSelectedId] = useState<string | "new" | null>(null);
  const selected = selectedId === "new" ? null : agents.find((agent) => agent.id === selectedId) ?? null;
  const providerLabel = (id: string | null) => id ? providers.find((item) => item.provider === id)?.label ?? id : "Automático";
  return (
    <section className="catalog-page" aria-label="Agentes">
      <div className="catalog-intro">
        <p>Um agente reúne função, instruções permanentes e skills. Escolha-o na tarefa: o Eleazar envia o perfil a qualquer provedor e usa o provedor preferido do agente quando você não escolhe outro.</p>
        <div className="catalog-actions">{catalogActions}<button className="primary" disabled={busy} onClick={() => setSelectedId("new")}><Plus size={15} aria-hidden="true" /> Novo agente</button></div>
      </div>
      <div className="catalog-layout">
        <div className="catalog-list">
          {!agents.length && <div className="empty">Nenhum agente ainda. Crie um, como "Revisor" ou "Implementador", e vincule as skills que ele deve seguir.</div>}
          <ul aria-label="Agentes cadastrados">
            {agents.map((agent) => (
              <li key={agent.id}>
                <button className={`catalog-item ${agent.id === selectedId ? "selected" : ""}`} aria-pressed={agent.id === selectedId} onClick={() => setSelectedId(agent.id)}>
                  <span className="catalog-item-title">{agent.provider ? <AgentGlyph provider={agent.provider} /> : <Bot size={14} aria-hidden="true" />} <strong>{agent.name}</strong>
                    <span className="chip">{providerLabel(agent.provider)}{agent.model ? ` · ${agent.model}` : ""}</span></span>
                  {agent.role && <small>{agent.role}</small>}
                  {agent.skillIds.length > 0 && <small>{agent.skillIds.length} skill{agent.skillIds.length === 1 ? "" : "s"}: {agent.skillIds.map((id) => skills.find((skill) => skill.id === id)?.name).filter(Boolean).join(", ")}</small>}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="catalog-editor">
          {selectedId === null ? <div className="empty">Escolha um agente para editar ou crie um novo.</div>
            : <AgentEditor key={selectedId} agent={selected} skills={skills} providers={providers} busy={busy}
                onSave={(input) => selected ? onUpdate(selected.id, input) : onCreate(input)}
                onDelete={selected ? () => { onDelete(selected); setSelectedId(null); } : undefined} />}
        </div>
      </div>
    </section>
  );
}

function AgentEditor({ agent, skills, providers, busy, onSave, onDelete }: {
  agent: AgentProfile | null; skills: Skill[]; providers: ProviderStatus[]; busy: boolean;
  onSave(input: AgentProfileInput): void; onDelete: (() => void) | undefined;
}) {
  const [name, setName] = useState(agent?.name ?? "");
  const [role, setRole] = useState(agent?.role ?? "");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [provider, setProvider] = useState(agent?.provider ?? "");
  const [model, setModel] = useState(agent?.model ?? "");
  const [skillIds, setSkillIds] = useState<string[]>(agent?.skillIds ?? []);
  const [filter, setFilter] = useState("");
  const models = providers.find((item) => item.provider === provider)?.verification?.models ?? [];
  function submit(event: FormEvent) {
    event.preventDefault();
    onSave({ name, role, instructions, skillIds, provider: provider || null, model: provider && model.trim() ? model.trim() : null });
  }
  const term = filter.trim().toLocaleLowerCase();
  return (
    <form className="catalog-form" onSubmit={submit} aria-label={agent ? `Editar ${agent.name}` : "Novo agente"}>
      <h2>{agent ? agent.name : "Novo agente"}</h2>
      <label>Nome<input value={name} required maxLength={80} placeholder="Revisor" onChange={(event) => setName(event.target.value)} /></label>
      <label>Função<input value={role} maxLength={200} placeholder="Revisa código com foco em riscos e testes" onChange={(event) => setRole(event.target.value)} /></label>
      <label>Instruções permanentes<textarea value={instructions} rows={7} maxLength={20000} placeholder="Como este agente trabalha, o que nunca faz, como relata o resultado." onChange={(event) => setInstructions(event.target.value)} /></label>
      <div className="composer-target">
        <label>Provedor preferido
          <select value={provider} onChange={(event) => { setProvider(event.target.value); setModel(""); }}>
            <option value="">Automático</option>
            {providers.map((item) => <option key={item.provider} value={item.provider}>{item.label}</option>)}
          </select>
        </label>
        <label>Modelo
          <input value={model} list="agent-models" disabled={!provider} placeholder={provider ? "Padrão do provedor" : "Escolha um provedor"} onChange={(event) => setModel(event.target.value)} />
          <datalist id="agent-models">{models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</datalist>
        </label>
      </div>
      <fieldset className="task-scope catalog-skills">
        <legend>Skills deste agente ({skillIds.length})</legend>
        {skills.length > 8 && <input className="explorer-filter" type="search" value={filter} placeholder="Filtrar skills…" aria-label="Filtrar skills" onChange={(event) => setFilter(event.target.value)} />}
        {!skills.length && <small>Nenhuma skill cadastrada ainda. Importe ou crie na tela Skills.</small>}
        <div className="catalog-skill-options">
          {skills.filter((skill) => !term || skill.name.toLocaleLowerCase().includes(term) || skillIds.includes(skill.id)).map((skill) => (
            <label key={skill.id} className="scope-option" title={skill.description}>
              <input type="checkbox" checked={skillIds.includes(skill.id)} onChange={(event) => setSkillIds((current) => event.target.checked ? [...current, skill.id] : current.filter((id) => id !== skill.id))} />
              {skill.name} <span className={`chip source-${skill.source}`}>{skillSourceLabel[skill.source]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="form-actions">
        {onDelete && <button type="button" className="secondary danger" disabled={busy} onClick={onDelete}><Trash2 size={15} aria-hidden="true" /> Excluir</button>}
        <button className="primary" disabled={busy || !name.trim()}>{agent ? "Salvar agente" : "Criar agente"}</button>
      </div>
    </form>
  );
}
