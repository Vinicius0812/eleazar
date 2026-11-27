import { useState, type FormEvent } from "react";
import { Download, FileText, Plus, Search, Trash2 } from "lucide-react";

import type { Skill, SkillInput, SkillSource } from "../services/contracts.js";

export const skillSourceLabel: Record<SkillSource, string> = { eleazar: "Eleazar", claude: "Claude", codex: "Codex" };

/**
 * The Eleazar's skill catalog. Imported skills are copies: editing one here never touches the
 * original in Claude's or Codex's folder, and a later import keeps the edit.
 */
export function SkillsPage({ skills, busy, onImport, onCreate, onUpdate, onDelete }: {
  skills: Skill[];
  busy: boolean;
  onImport(): void;
  onCreate(input: SkillInput): void;
  onUpdate(id: string, input: SkillInput): void;
  onDelete(skill: Skill): void;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | "new" | null>(null);
  const term = query.trim().toLocaleLowerCase();
  const visible = skills.filter((skill) => !term || `${skill.name} ${skill.description} ${skill.source}`.toLocaleLowerCase().includes(term));
  const selected = selectedId === "new" ? null : skills.find((skill) => skill.id === selectedId) ?? null;
  return (
    <section className="catalog-page" aria-label="Skills">
      <div className="catalog-intro">
        <p>Skills são instruções no formato SKILL.md. O Eleazar as envia junto com o pedido, então funcionam com qualquer provedor: escolha-as na tarefa ou vincule-as a um agente.</p>
        <div className="catalog-actions">
          <button className="secondary" disabled={busy} onClick={onImport} title="Copia ~/.claude/skills e ~/.codex/skills; os originais não mudam"><Download size={15} aria-hidden="true" /> Importar do Claude e do Codex</button>
          <button className="primary" disabled={busy} onClick={() => setSelectedId("new")}><Plus size={15} aria-hidden="true" /> Nova skill</button>
        </div>
      </div>
      <div className="catalog-layout">
        <div className="catalog-list">
          <label className="search"><Search size={16} aria-hidden="true" /><input aria-label="Buscar skill" placeholder="Buscar por nome, descrição ou origem…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          {!skills.length && <div className="empty">Nenhuma skill ainda. Importe as suas do Claude e do Codex ou crie uma.</div>}
          <ul aria-label="Skills cadastradas">
            {visible.map((skill) => (
              <li key={skill.id}>
                <button className={`catalog-item ${skill.id === selectedId ? "selected" : ""}`} aria-pressed={skill.id === selectedId} onClick={() => setSelectedId(skill.id)}>
                  <span className="catalog-item-title"><FileText size={14} aria-hidden="true" /> <strong>{skill.name}</strong><span className={`chip source-${skill.source}`}>{skillSourceLabel[skill.source]}</span></span>
                  {skill.description && <small>{skill.description}</small>}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="catalog-editor">
          {selectedId === null ? <div className="empty">Escolha uma skill para ver e editar o conteúdo.</div>
            : <SkillEditor key={selectedId} skill={selected} busy={busy} onSave={(input) => selected ? onUpdate(selected.id, input) : onCreate(input)}
                onDelete={selected ? () => { onDelete(selected); setSelectedId(null); } : undefined} />}
        </div>
      </div>
    </section>
  );
}

function SkillEditor({ skill, busy, onSave, onDelete }: { skill: Skill | null; busy: boolean; onSave(input: SkillInput): void; onDelete: (() => void) | undefined }) {
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [content, setContent] = useState(skill?.content ?? "");
  function submit(event: FormEvent) {
    event.preventDefault();
    onSave({ name, description, content });
  }
  return (
    <form className="catalog-form" onSubmit={submit} aria-label={skill ? `Editar ${skill.name}` : "Nova skill"}>
      <h2>{skill ? skill.name : "Nova skill"}</h2>
      {skill?.sourcePath && <p className="catalog-origin">Cópia de <code>{skill.sourcePath}</code>{skill.supportFiles.length > 0 && <> · arquivos de apoio: {skill.supportFiles.join(", ")}</>}. Editar aqui não altera o original.</p>}
      <label>Nome<input value={name} required maxLength={120} onChange={(event) => setName(event.target.value)} /></label>
      <label>Descrição<input value={description} maxLength={1000} placeholder="Quando usar esta skill" onChange={(event) => setDescription(event.target.value)} /></label>
      <label>Conteúdo<textarea className="catalog-content" value={content} required rows={18} spellCheck={false} onChange={(event) => setContent(event.target.value)} placeholder="# Nome da skill&#10;&#10;Passos, regras e exemplos que o agente deve seguir." /></label>
      <div className="form-actions">
        {onDelete && <button type="button" className="secondary danger" disabled={busy} onClick={onDelete}><Trash2 size={15} aria-hidden="true" /> Excluir</button>}
        <button className="primary" disabled={busy || !name.trim() || !content.trim()}>{skill ? "Salvar skill" : "Criar skill"}</button>
      </div>
    </form>
  );
}
