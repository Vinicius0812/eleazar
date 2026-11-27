import { useRef, useState, type ChangeEvent } from "react";
import { FileArchive, FolderOpen, Info } from "lucide-react";

import type { CatalogConflictChoice, CatalogImportPreview, CatalogImportSource, CatalogImportStatus, ControlRoomClient } from "../services/contracts.js";

const statusLabel: Record<CatalogImportStatus, string> = { new: "Nova", same: "Igual", conflict: "Conflito" };
const maxTextBytes = 2 * 1024 * 1024;
const maxZipBytes = 25 * 1024 * 1024;

/** FileReader works in every browser (and in tests), unlike Blob.text in older engines. */
function readAs(file: File, kind: "text" | "buffer"): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result ?? "");
    reader.onerror = () => reject(reader.error ?? new Error(`Nao foi possivel ler ${file.name}.`));
    if (kind === "text") reader.readAsText(file, "utf-8"); else reader.readAsArrayBuffer(file);
  });
}

/** Reads what the operator attached: a .zip as base64, or the .md and .json files of a folder as text. */
export async function readCatalogFiles(files: readonly File[]): Promise<CatalogImportSource> {
  const zip = files.find((file) => file.name.toLowerCase().endsWith(".zip"));
  if (zip) {
    if (files.length > 1) throw new Error("Anexe um .zip sozinho, ou então a pasta e os arquivos sem o .zip.");
    if (zip.size > maxZipBytes) throw new Error("O .zip passa de 25 MB.");
    const bytes = new Uint8Array(await readAs(zip, "buffer") as ArrayBuffer);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return { zipBase64: btoa(binary) };
  }
  const wanted = files.filter((file) => /\.(md|json)$/i.test(file.name));
  if (!wanted.length) throw new Error("Nenhum SKILL.md ou .json de agente nos arquivos escolhidos.");
  const oversized = wanted.find((file) => file.size > maxTextBytes);
  if (oversized) throw new Error(`${oversized.name} passa de 2 MB.`);
  return { files: await Promise.all(wanted.map(async (file) => ({ path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, text: await readAs(file, "text") as string }))) };
}

/**
 * Import in three steps: the expected format comes first, then the operator attaches a folder,
 * files or a .zip, sees what would change and decides what to do with conflicts.
 */
export function CatalogImportDialog({ client, busy, onCancel, onImport }: {
  client: ControlRoomClient;
  busy: boolean;
  onCancel(): void;
  onImport(source: CatalogImportSource, conflicts: CatalogConflictChoice): void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [source, setSource] = useState<CatalogImportSource | null>(null);
  const [preview, setPreview] = useState<CatalogImportPreview | null>(null);
  const [conflicts, setConflicts] = useState<CatalogConflictChoice>("skip");
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);

  async function attach(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (!files.length) return;
    setError(""); setReading(true); setPreview(null);
    try {
      const read = await readCatalogFiles(files);
      setSource(read);
      setPreview(await client.previewCatalogImport(read));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Não foi possível ler os arquivos.");
    } finally { setReading(false); }
  }

  const items = preview ? [...preview.skills.map((item) => ({ ...item, kind: "Skill" })), ...preview.agents.map((item) => ({ ...item, kind: "Agente" }))] : [];
  const conflictCount = items.filter((item) => item.status === "conflict").length;
  const changes = items.filter((item) => item.status !== "same").length;

  if (!acknowledged) {
    return (
      <div className="catalog-import">
        <div className="catalog-import-notice" role="note">
          <strong><Info size={15} aria-hidden="true" /> Antes de anexar: formato esperado</strong>
          <p>Anexe uma pasta, arquivos soltos ou um <code>.zip</code> (como o que o botão Exportar gera). O Eleazar lê apenas:</p>
          <ul>
            <li><code>skills/&lt;nome&gt;/SKILL.md</code>: uma skill por pasta. O cabeçalho opcional entre <code>---</code> aceita <code>name</code>, <code>description</code> e <code>origin</code>; sem <code>name</code>, vale o nome da pasta. Uma pasta de skills do Claude ou do Codex funciona como está.</li>
            <li><code>agents/&lt;nome&gt;.json</code>: <code>{"{"} "name", "role", "instructions", "skills": ["nomes das skills"], "provider", "model" {"}"}</code>.</li>
          </ul>
          <p>Outros arquivos (scripts, imagens) são ignorados e nada é executado. Antes de gravar, você vê o que entraria e decide o que fazer com nomes que já existem.</p>
        </div>
        <div className="form-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancelar</button>
          <button type="button" className="primary" onClick={() => setAcknowledged(true)}>Entendi, escolher arquivos</button>
        </div>
      </div>
    );
  }

  return (
    <div className="catalog-import">
      <div className="catalog-import-pickers">
        <button type="button" className="secondary" disabled={reading || busy} onClick={() => folderInput.current?.click()}><FolderOpen size={15} aria-hidden="true" /> Escolher pasta</button>
        <button type="button" className="secondary" disabled={reading || busy} onClick={() => filesInput.current?.click()}><FileArchive size={15} aria-hidden="true" /> Escolher arquivos ou .zip</button>
        {/* The folder picker is a browser extension of the file input, so React does not know its attribute. */}
        <input ref={folderInput} type="file" hidden multiple aria-label="Pasta do catálogo" onChange={(event) => void attach(event)} {...{ webkitdirectory: "", directory: "" }} />
        <input ref={filesInput} type="file" hidden multiple accept=".zip,.md,.json" aria-label="Arquivos ou .zip do catálogo" onChange={(event) => void attach(event)} />
      </div>
      {reading && <p className="catalog-import-hint" role="status">Lendo os arquivos…</p>}
      {error && <div className="error" role="alert">{error}</div>}
      {preview && (
        <>
          {!items.length ? <div className="empty">Nada para importar: nenhum SKILL.md ou agente válido foi encontrado.</div> : (
            <ul className="catalog-import-list" aria-label="Prévia da importação">
              {items.map((item) => (
                <li key={`${item.kind}-${item.path}`}>
                  <span className={`chip status-${item.status}`}>{statusLabel[item.status]}</span>
                  <span><strong>{item.name}</strong> <small>{item.kind}{"missingSkills" in item && item.missingSkills.length ? ` · sem as skills ${item.missingSkills.join(", ")}` : ""}</small></span>
                </li>
              ))}
            </ul>
          )}
          {preview.warnings.map((warning) => <p key={warning} className="catalog-import-warning">{warning}</p>)}
          {preview.ignored.length > 0 && <p className="catalog-import-hint">{preview.ignored.length} arquivo(s) fora do formato foram ignorados.</p>}
          {conflictCount > 0 && (
            <fieldset className="task-scope">
              <legend>{conflictCount} item(ns) já existem com outro conteúdo</legend>
              <label className="scope-option"><input type="radio" name="conflicts" checked={conflicts === "skip"} onChange={() => setConflicts("skip")} /> Manter os atuais</label>
              <label className="scope-option"><input type="radio" name="conflicts" checked={conflicts === "replace"} onChange={() => setConflicts("replace")} /> Substituir pelos importados</label>
              <label className="scope-option"><input type="radio" name="conflicts" checked={conflicts === "duplicate"} onChange={() => setConflicts("duplicate")} /> Manter os dois (o importado ganha "(importada)" no nome)</label>
            </fieldset>
          )}
        </>
      )}
      <div className="form-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancelar</button>
        <button type="button" className="primary" disabled={busy || reading || !source || !preview || !changes} onClick={() => source && onImport(source, conflicts)}>
          {busy ? "Importando…" : changes ? `Importar ${changes} item(ns)` : "Nada a importar"}
        </button>
      </div>
    </div>
  );
}
