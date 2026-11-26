import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, File, FileDiff, FileText, Folder, FolderOpen, GitCompare, RefreshCw } from "lucide-react";

import { LoadingOverlay } from "./LoadingOverlay.js";
import type { ControlRoomClient, ExplorerChange, ExplorerChangeKind, ExplorerEntry, ExplorerFile, ExplorerListing, ExplorerRoot, ExplorerSearch, Project, Task } from "../services/contracts.js";

const changeLabel: Record<ExplorerChangeKind, string> = { added: "Adicionado", modified: "Alterado", deleted: "Removido", renamed: "Renomeado", untracked: "Novo, não rastreado" };
const changeLetter: Record<ExplorerChangeKind, string> = { added: "A", modified: "M", deleted: "D", renamed: "R", untracked: "U" };
/** Turns that are still producing changes: the list is re-read while they last. */
const liveStatuses = new Set<Task["status"]>(["planning", "running"]);
const pollMs = 5_000;

type Mode = "changes" | "all";
type View = "diff" | "content";

export interface FileExplorerLocation { directoryId?: string; path?: string; }

/** `#/tasks/:id/files?directory=…&path=…`, or null for any other route. */
export function fileExplorerRoute(hash: string): ({ taskId: string } & FileExplorerLocation) | null {
  const [route, query = ""] = hash.replace(/^#\/?/, "").split("?");
  const [section, id, page, ...rest] = (route ?? "").split("/");
  if (section !== "tasks" || !id || page !== "files" || rest.length) return null;
  try {
    const params = new URLSearchParams(query);
    const directoryId = params.get("directory"); const path = params.get("path");
    return { taskId: decodeURIComponent(id), ...(directoryId ? { directoryId } : {}), ...(path ? { path } : {}) };
  } catch { return null; }
}
export function fileExplorerHash(taskId: string, location: FileExplorerLocation = {}): string {
  const params = new URLSearchParams();
  if (location.directoryId) params.set("directory", location.directoryId);
  if (location.path) params.set("path", location.path);
  const query = params.toString();
  return `#/tasks/${encodeURIComponent(taskId)}/files${query ? `?${query}` : ""}`;
}

export function FileExplorerPage({ client, task, project, initial, onBack, tabs }: {
  client: ControlRoomClient;
  /** Links to the other sides of the task, shown under the heading. */
  tabs?: ReactNode;
  task: Task | undefined;
  project: Project | undefined;
  initial: { taskId: string } & FileExplorerLocation;
  onBack(): void;
}) {
  const taskId = initial.taskId;
  const [roots, setRoots] = useState<ExplorerRoot[] | null>(null);
  const [directoryId, setDirectoryId] = useState<string | undefined>(initial.directoryId);
  const [mode, setMode] = useState<Mode>("changes");
  const [changes, setChanges] = useState<ExplorerChange[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [listings, setListings] = useState<Record<string, ExplorerListing>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string | undefined>(initial.path);
  const [file, setFile] = useState<ExplorerFile | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [view, setView] = useState<View>("diff");
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<ExplorerSearch | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [fileError, setFileError] = useState("");
  const generation = useRef(0);

  const root = roots?.find((item) => item.directoryId === directoryId);

  useEffect(() => {
    let alive = true;
    client.getTaskFileRoots(taskId).then((loaded) => {
      if (!alive) return;
      setRoots(loaded);
      setDirectoryId((current) => current && loaded.some((item) => item.directoryId === current) ? current : loaded[0]?.directoryId);
    }).catch((reason: unknown) => { if (alive) { setRoots([]); setError(message(reason)); } });
    return () => { alive = false; };
  }, [client, taskId]);

  const loadChanges = useCallback(async (quiet = false) => {
    if (!directoryId) return;
    const current = generation.current;
    if (!quiet) setListLoading(true);
    try {
      const result = await client.getTaskChanges(taskId, directoryId);
      if (current !== generation.current) return;
      setChanges(result.changes); setWarnings(result.warnings); setError("");
    } catch (reason) {
      if (current === generation.current) setError(message(reason));
    } finally {
      if (!quiet && current === generation.current) setListLoading(false);
    }
  }, [client, taskId, directoryId]);

  const loadDirectory = useCallback(async (path: string) => {
    if (!directoryId) return;
    const current = generation.current;
    setLoadingDirs((dirs) => new Set(dirs).add(path));
    try {
      const listing = await client.listTaskFiles(taskId, directoryId, path);
      if (current === generation.current) setListings((all) => ({ ...all, [path]: listing }));
    } catch (reason) {
      if (current === generation.current) setError(message(reason));
    } finally {
      if (current === generation.current) setLoadingDirs((dirs) => { const next = new Set(dirs); next.delete(path); return next; });
    }
  }, [client, taskId, directoryId]);

  const loadFile = useCallback(async (path: string, quiet = false) => {
    if (!directoryId) return;
    const current = generation.current;
    if (!quiet) { setFileLoading(true); setFileError(""); }
    try {
      const loaded = await client.getTaskFile(taskId, directoryId, path);
      if (current !== generation.current) return;
      setFile(loaded);
      if (!quiet) setView(loaded.diff !== null ? "diff" : "content");
    } catch (reason) {
      if (current === generation.current) { setFile(null); setFileError(message(reason)); }
    } finally {
      if (!quiet && current === generation.current) setFileLoading(false);
    }
  }, [client, taskId, directoryId]);

  // A new folder starts from a clean state; late answers about the previous one are ignored.
  useEffect(() => {
    if (!directoryId) return;
    generation.current += 1;
    setChanges(null); setListings({}); setExpanded(new Set([""])); setFile(null); setFileError(""); setQuery("");
    void loadChanges();
    void loadDirectory("");
  }, [directoryId, loadChanges, loadDirectory]);

  useEffect(() => { if (selected && directoryId) void loadFile(selected); }, [selected, directoryId, loadFile]);
  // Opens the first change right away, like a review: there is something to read without an extra click.
  useEffect(() => { if (!selected && changes?.[0]) setSelected(changes[0].path); }, [changes, selected]);

  useEffect(() => {
    if (!directoryId) return;
    window.history.replaceState(null, "", fileExplorerHash(taskId, { directoryId, ...(selected ? { path: selected } : {}) }));
  }, [taskId, directoryId, selected]);

  // Project-wide file search, debounced; an answer for an older query or folder is dropped.
  useEffect(() => {
    const term = query.trim();
    if (!directoryId || term.length < 2) { setSearch(null); setSearching(false); return; }
    let alive = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      client.searchTaskFiles(taskId, directoryId, term)
        .then((result) => { if (alive) setSearch(result); })
        .catch((reason: unknown) => { if (alive) setError(message(reason)); })
        .finally(() => { if (alive) setSearching(false); });
    }, 250);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [client, taskId, directoryId, query]);

  const live = task ? liveStatuses.has(task.status) : false;
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => {
      void loadChanges(true);
      if (selected) void loadFile(selected, true);
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [live, loadChanges, loadFile, selected]);

  async function refresh() {
    const open = [...expanded];
    setListings({});
    await Promise.all([loadChanges(), ...open.map((path) => loadDirectory(path)), ...(selected ? [loadFile(selected, true)] : [])]);
  }

  function toggleDirectory(path: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else { next.add(path); if (!listings[path]) void loadDirectory(path); }
      return next;
    });
  }

  function showAll() {
    setMode("all");
    // Opens the folders down to the selected file so it is visible in the tree.
    if (!selected) return;
    const parts = selected.split("/").slice(0, -1);
    const ancestors = parts.map((_, index) => parts.slice(0, index + 1).join("/"));
    setExpanded((current) => new Set([...current, ...ancestors]));
    for (const path of ancestors) if (!listings[path]) void loadDirectory(path);
  }

  const visibleChanges = useMemo(() => {
    const term = filter.trim().toLowerCase();
    return (changes ?? []).filter((change) => !term || change.path.toLowerCase().includes(term));
  }, [changes, filter]);
  const totals = useMemo(() => (changes ?? []).reduce((sum, change) => ({ additions: sum.additions + (change.additions ?? 0), deletions: sum.deletions + (change.deletions ?? 0) }), { additions: 0, deletions: 0 }), [changes]);

  const projectName = project?.name ?? "Projeto";
  return (
    <main className="explorer-page" id="main" tabIndex={-1}>
      <header className="explorer-header">
        <button className="secondary" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" /> Voltar à tarefa</button>
        <div className="explorer-heading">
          <span className="eyebrow">EXPLORADOR DE ARQUIVOS</span>
          <h1>{task?.title ?? "Tarefa"}</h1>
          <p>{projectName}{root ? <> · {root.mode === "worktree" ? <>worktree da branch <code>{root.branch}</code></> : "direto na pasta do projeto"}</> : null}</p>
        </div>
        <button className="secondary" disabled={!root || listLoading} onClick={() => void refresh()}><RefreshCw size={15} aria-hidden="true" /> Atualizar</button>
      </header>
      {tabs}

      {roots && roots.length > 1 && (
        <div className="explorer-roots" role="group" aria-label="Diretórios da tarefa">
          {roots.map((item) => <button key={item.directoryId} className={item.directoryId === directoryId ? "active" : ""} aria-pressed={item.directoryId === directoryId}
            onClick={() => { setSelected(undefined); setDirectoryId(item.directoryId); }}>{item.name}</button>)}
        </div>
      )}
      {root && <p className="explorer-path" title={root.path}><Folder size={14} aria-hidden="true" /> <code>{root.path}</code></p>}
      {error && <div className="error" role="alert">{error}</div>}
      {warnings.map((warning) => <div className="explorer-warning" role="status" key={warning}>{warning}</div>)}

      {roots === null ? <div className="loading-area page"><LoadingOverlay label="Carregando pastas da tarefa…" /></div> : !roots.length ? (
        !error && <div className="empty">Esta tarefa não tem diretórios disponíveis para explorar.</div>
      ) : (
        <div className="explorer-layout">
          <aside className="explorer-sidebar loading-area" aria-label="Arquivos">
            {listLoading && <LoadingOverlay label="Lendo alterações…" />}
            <div className="explorer-tabs" role="tablist" aria-label="O que listar">
              <button role="tab" aria-selected={mode === "changes"} className={mode === "changes" ? "active" : ""} onClick={() => setMode("changes")}>
                <GitCompare size={14} aria-hidden="true" /> Alterações{changes ? ` (${changes.length})` : ""}
              </button>
              <button role="tab" aria-selected={mode === "all"} className={mode === "all" ? "active" : ""} onClick={showAll}>
                <Folder size={14} aria-hidden="true" /> Todos os arquivos
              </button>
            </div>
            {mode === "changes" ? (
              <>
                <input className="explorer-filter" type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filtrar alterações…" aria-label="Filtrar alterações" />
                {changes && changes.length > 0 && <p className="explorer-totals"><span className="add">+{totals.additions}</span> <span className="remove">−{totals.deletions}</span> em {changes.length} arquivo{changes.length === 1 ? "" : "s"}</p>}
                {changes && !changes.length && !warnings.length && <p className="empty">Nenhuma alteração em relação {root?.mode === "worktree" ? "ao commit em que a tarefa começou" : "ao último commit"}.</p>}
                <ul className="explorer-change-list" aria-label="Arquivos alterados" onKeyDown={(event) => {
                  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                  event.preventDefault();
                  const index = visibleChanges.findIndex((change) => change.path === selected);
                  const next = visibleChanges[Math.min(visibleChanges.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))];
                  if (!next) return;
                  setSelected(next.path);
                  const buttons = event.currentTarget.querySelectorAll("button");
                  buttons[visibleChanges.indexOf(next)]?.focus();
                }}>
                  {visibleChanges.map((change) => (
                    <li key={change.path}>
                      <button className={change.path === selected ? "selected" : ""} aria-current={change.path === selected ? "true" : undefined} onClick={() => setSelected(change.path)} title={change.previousPath ? `${change.previousPath} → ${change.path}` : change.path}>
                        <span className={`change-badge ${change.kind}`} aria-label={changeLabel[change.kind]}>{changeLetter[change.kind]}</span>
                        <span className="explorer-change-name"><strong>{baseName(change.path)}</strong><small>{change.preexisting ? <>já alterado antes da tarefa{dirName(change.path) ? ` · ${dirName(change.path)}` : ""}</> : dirName(change.path)}</small></span>
                        {change.additions !== null && <span className="explorer-counts"><span className="add">+{change.additions}</span> <span className="remove">−{change.deletions}</span></span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                <input className="explorer-filter" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar arquivo no projeto…" aria-label="Buscar arquivo no projeto" />
                {query.trim().length >= 2 ? (
                  <div className="explorer-search loading-area">
                    {searching && <LoadingOverlay label="Buscando…" />}
                    {search && !search.paths.length && !searching && <p className="empty">Nenhum arquivo encontrado.</p>}
                    <ul className="explorer-change-list" aria-label="Resultados da busca">
                      {(search?.paths ?? []).map((path) => {
                        const change = changes?.find((item) => item.path === path);
                        return (
                          <li key={path}>
                            <button className={path === selected ? "selected" : ""} aria-current={path === selected ? "true" : undefined} onClick={() => setSelected(path)} title={path}>
                              <File size={14} aria-hidden="true" />
                              <span className="explorer-change-name"><strong>{baseName(path)}</strong><small>{dirName(path)}</small></span>
                              {change && <span className={`change-badge ${change.kind}`} aria-label={changeLabel[change.kind]}>{changeLetter[change.kind]}</span>}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    {search?.truncated && <p className="explorer-tree-empty explorer-search-note">Mostrando os primeiros {search.paths.length} resultados; refine a busca.</p>}
                  </div>
                ) : (
                  <div className="explorer-tree" role="tree" aria-label="Todos os arquivos">
                    <TreeLevel path="" depth={0} listings={listings} expanded={expanded} loadingDirs={loadingDirs} selected={selected}
                      onToggle={toggleDirectory} onSelect={(path) => setSelected(path)} />
                  </div>
                )}
              </>
            )}
          </aside>

          <section className="explorer-viewer loading-area" aria-label="Arquivo selecionado">
            {fileLoading && <LoadingOverlay label="Abrindo arquivo…" />}
            {!selected ? (
              <div className="explorer-placeholder"><FileDiff size={28} aria-hidden="true" /><p>Escolha um arquivo para ver o diff ou o conteúdo.</p><p className="explorer-hint">Na lista de alterações, use <kbd>↑</kbd> e <kbd>↓</kbd> para passar de um arquivo a outro.</p></div>
            ) : fileError ? <div className="error" role="alert">{fileError}</div> : file && file.path === selected ? (
              <>
                <div className="explorer-viewer-heading">
                  <div className="explorer-viewer-title">
                    {file.change && <span className={`change-badge ${file.change.kind}`}>{changeLetter[file.change.kind]}</span>}
                    <code title={file.path}>{file.path}</code>
                    {file.change && <span className="explorer-viewer-kind">{changeLabel[file.change.kind]}{file.change.previousPath ? ` de ${file.change.previousPath}` : ""}</span>}
                  </div>
                  <div className="explorer-view-toggle" role="group" aria-label="Modo de visualização">
                    <button className={view === "diff" ? "active" : ""} aria-pressed={view === "diff"} disabled={file.diff === null} title={file.diff === null ? "O arquivo não mudou" : undefined} onClick={() => setView("diff")}><GitCompare size={14} aria-hidden="true" /> Diff</button>
                    <button className={view === "content" ? "active" : ""} aria-pressed={view === "content"} disabled={!file.exists} title={!file.exists ? "O arquivo foi removido" : undefined} onClick={() => setView("content")}><FileText size={14} aria-hidden="true" /> Conteúdo</button>
                  </div>
                </div>
                {view === "diff" && file.diff !== null ? <DiffView diff={file.diff} truncated={file.diffTruncated} binary={file.binary} />
                  : file.binary ? <p className="explorer-note">Arquivo binário{file.size !== null ? ` (${formatSize(file.size)})` : ""}; o conteúdo não é exibido.</p>
                  : file.tooLarge ? <p className="explorer-note">Arquivo grande demais para a prévia ({formatSize(file.size ?? 0)}). Abra-o no editor.</p>
                  : file.content !== null ? <ContentView content={file.content} />
                  : <p className="explorer-note">O arquivo foi removido nesta tarefa.</p>}
              </>
            ) : null}
          </section>
        </div>
      )}
    </main>
  );
}

function TreeLevel({ path, depth, listings, expanded, loadingDirs, selected, onToggle, onSelect }: {
  path: string; depth: number; listings: Record<string, ExplorerListing>; expanded: Set<string>; loadingDirs: Set<string>; selected: string | undefined;
  onToggle(path: string): void; onSelect(path: string): void;
}) {
  const listing = listings[path];
  if (!listing) return loadingDirs.has(path) ? <p className="explorer-tree-loading" style={{ paddingLeft: indent(depth) }}>Carregando…</p> : null;
  if (!listing.entries.length) return <p className="explorer-tree-empty" style={{ paddingLeft: indent(depth) }}>Pasta vazia</p>;
  return (
    <ul role={depth ? "group" : undefined}>
      {listing.entries.map((entry) => <TreeEntry key={entry.path} entry={entry} depth={depth} listings={listings} expanded={expanded} loadingDirs={loadingDirs} selected={selected} onToggle={onToggle} onSelect={onSelect} />)}
      {listing.truncated && <li className="explorer-tree-empty" style={{ paddingLeft: indent(depth) }}>Lista limitada aos primeiros itens desta pasta.</li>}
    </ul>
  );
}

function TreeEntry({ entry, depth, listings, expanded, loadingDirs, selected, onToggle, onSelect }: {
  entry: ExplorerEntry; depth: number; listings: Record<string, ExplorerListing>; expanded: Set<string>; loadingDirs: Set<string>; selected: string | undefined;
  onToggle(path: string): void; onSelect(path: string): void;
}) {
  const isDirectory = entry.type === "directory";
  const open = isDirectory && expanded.has(entry.path);
  return (
    <li role="treeitem" aria-expanded={isDirectory ? open : undefined} aria-selected={entry.path === selected}>
      <button className={`explorer-tree-row ${entry.path === selected ? "selected" : ""} ${entry.change ? `changed ${entry.change}` : ""}`} style={{ paddingLeft: indent(depth) }}
        onClick={() => isDirectory ? onToggle(entry.path) : onSelect(entry.path)} disabled={entry.type === "other"}>
        {isDirectory ? (open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />) : <span className="explorer-tree-spacer" />}
        {isDirectory ? (open ? <FolderOpen size={15} aria-hidden="true" /> : <Folder size={15} aria-hidden="true" />) : <File size={15} aria-hidden="true" />}
        <span className="explorer-tree-name">{entry.name}</span>
        {entry.change && <span className={`change-badge ${entry.change}`} aria-label={changeLabel[entry.change]}>{changeLetter[entry.change]}</span>}
        {isDirectory && entry.changedBelow > 0 && <span className="explorer-tree-count" title={`${entry.changedBelow} arquivo(s) alterado(s) nesta pasta`}>{entry.changedBelow}</span>}
      </button>
      {open && <TreeLevel path={entry.path} depth={depth + 1} listings={listings} expanded={expanded} loadingDirs={loadingDirs} selected={selected} onToggle={onToggle} onSelect={onSelect} />}
    </li>
  );
}

interface DiffLine { kind: "meta" | "hunk" | "add" | "del" | "context"; text: string; oldNumber: number | null; newNumber: number | null; }

/** Unified diff to rows with old and new line numbers; Git's file headers are dropped. */
export function parseDiff(diff: string): DiffLine[] {
  const rows: DiffLine[] = [];
  let oldLine = 0; let newLine = 0; let inHunk = false;
  for (const text of diff.replace(/\n$/, "").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(text);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; rows.push({ kind: "hunk", text, oldNumber: null, newNumber: null }); continue; }
    if (!inHunk || text.startsWith("diff --git ")) {
      inHunk = false;
      if (/^(Binary files|rename from|rename to|new file|deleted file|similarity index)/.test(text)) rows.push({ kind: "meta", text, oldNumber: null, newNumber: null });
      continue;
    }
    if (text.startsWith("\\")) { rows.push({ kind: "meta", text, oldNumber: null, newNumber: null }); continue; }
    if (text.startsWith("+")) { rows.push({ kind: "add", text: text.slice(1), oldNumber: null, newNumber: newLine++ }); continue; }
    if (text.startsWith("-")) { rows.push({ kind: "del", text: text.slice(1), oldNumber: oldLine++, newNumber: null }); continue; }
    rows.push({ kind: "context", text: text.slice(1), oldNumber: oldLine++, newNumber: newLine++ });
  }
  return rows;
}

export function DiffView({ diff, truncated, binary }: { diff: string; truncated: boolean; binary: boolean }) {
  const rows = useMemo(() => parseDiff(diff), [diff]);
  if (!rows.some((row) => row.kind !== "meta")) {
    return <p className="explorer-note">{binary || rows.some((row) => row.text.startsWith("Binary")) ? "Arquivo binário alterado; não há diff de texto." : rows.length ? rows.map((row) => row.text).join(" · ") : "Sem diferenças de conteúdo (por exemplo, só permissões ou fim de linha)."}</p>;
  }
  return (
    <div className="explorer-code" role="region" aria-label="Diff do arquivo" tabIndex={0}>
      <table className="diff-table">
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className={`diff-${row.kind}`}>
              <td className="diff-number">{row.oldNumber ?? ""}</td>
              <td className="diff-number">{row.newNumber ?? ""}</td>
              <td className="diff-text"><span className="diff-sign" aria-hidden="true">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}</span>{row.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && <p className="explorer-note">Diff truncado: o arquivo tem mais alterações do que a prévia mostra.</p>}
    </div>
  );
}

function ContentView({ content }: { content: string }) {
  const lines = useMemo(() => { const all = content.split(/\r?\n/); if (content.endsWith("\n")) all.pop(); return all; }, [content]);
  if (!lines.length) return <p className="explorer-note">Arquivo vazio.</p>;
  return (
    <div className="explorer-code" role="region" aria-label="Conteúdo do arquivo" tabIndex={0}>
      <table className="diff-table">
        <tbody>
          {lines.map((line, index) => <tr key={index} className="diff-context"><td className="diff-number">{index + 1}</td><td className="diff-text">{line}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

function indent(depth: number): number { return 8 + depth * 14; }
function baseName(path: string): string { return path.slice(path.lastIndexOf("/") + 1); }
function dirName(path: string): string { const index = path.lastIndexOf("/"); return index < 0 ? "" : path.slice(0, index); }
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
}
function message(reason: unknown): string { return reason instanceof Error ? reason.message : "Não foi possível ler os arquivos da tarefa."; }
