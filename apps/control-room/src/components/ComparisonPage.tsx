import { useEffect, useMemo, useState } from "react";
import { Check, GitCompare, RefreshCw } from "lucide-react";

import { AgentGlyph } from "./AgentGlyph.js";
import { DiffView } from "./FileExplorerPage.js";
import { LoadingOverlay } from "./LoadingOverlay.js";
import { readableRunSummary } from "../services/run-messages.js";
import type { ControlRoomClient, ExplorerChange, ExplorerFile, Run, Task } from "../services/contracts.js";

/** `#/comparisons/:id` → the comparison id; null for any other route. */
export function comparisonRoute(hash: string): string | null {
  const [section, id, ...rest] = (hash.replace(/^#\/?/, "").split("?")[0] ?? "").split("/");
  if (section !== "comparisons" || !id || rest.length) return null;
  try { return decodeURIComponent(id); } catch { return null; }
}

interface Attempt { task: Task; run: Run | undefined; directoryId: string | null; changes: ExplorerChange[] | null; error: string; }

const working = new Set<Task["status"]>(["planning", "running", "waiting_approval"]);

/**
 * The attempts of one request side by side: what each agent said, which files each one
 * changed and, for a chosen file, both diffs next to each other.
 */
export function ComparisonPage({ client, comparisonId, tasks, runs, busy, statusLabel, onChoose }: {
  client: ControlRoomClient;
  comparisonId: string;
  /** Every task of the snapshot; the attempts are the ones sharing `comparisonId`. */
  tasks: Task[];
  runs: Run[];
  busy: boolean;
  statusLabel(task: Task): string;
  onChoose(taskId: string): void;
}) {
  const members = useMemo(() => tasks.filter((task) => task.comparisonId === comparisonId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)), [tasks, comparisonId]);
  const statusKey = members.map((task) => `${task.id}:${task.status}`).join("|");
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, ExplorerFile | null>>({});
  const [filesLoading, setFilesLoading] = useState(false);

  // The changed files are re-read whenever an attempt changes status, so a finished turn shows up.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void Promise.all(members.map(async (task): Promise<Attempt> => {
      const run = runs.find((item) => item.taskId === task.id);
      try {
        const root = (await client.getTaskFileRoots(task.id))[0];
        if (!root) return { task, run, directoryId: null, changes: [], error: "" };
        const { changes } = await client.getTaskChanges(task.id, root.directoryId);
        return { task, run, directoryId: root.directoryId, changes, error: "" };
      } catch (reason) {
        return { task, run, directoryId: null, changes: null, error: reason instanceof Error ? reason.message : "Não foi possível ler as alterações." };
      }
    })).then((loaded) => { if (alive) setAttempts(loaded); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // `members` and `runs` are read through `statusKey`, which changes when an attempt does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, statusKey, reload]);

  const paths = useMemo(() => [...new Set(attempts.flatMap((attempt) => (attempt.changes ?? []).map((change) => change.path)))].sort(), [attempts]);

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setFilesLoading(true);
    void Promise.all(attempts.map(async (attempt) => {
      const changed = attempt.changes?.some((change) => change.path === selected);
      if (!changed || !attempt.directoryId) return [attempt.task.id, null] as const;
      const file = await client.getTaskFile(attempt.task.id, attempt.directoryId, selected).catch(() => null);
      return [attempt.task.id, file] as const;
    })).then((entries) => { if (alive) setFiles(Object.fromEntries(entries)); }).finally(() => { if (alive) setFilesLoading(false); });
    return () => { alive = false; };
  }, [client, selected, attempts]);

  if (!members.length) return <div className="empty">Comparação não encontrada. <a className="text-button" href="#/tasks">Voltar à fila</a></div>;
  const allFinished = members.every((task) => !working.has(task.status) && task.status !== "queued");
  const kept = members.filter((task) => task.status !== "cancelled");
  const shared = paths.filter((path) => attempts.filter((attempt) => attempt.changes?.some((change) => change.path === path)).length > 1).length;

  return (
    <section className="comparison" aria-label="Comparação entre agentes">
      <div className="comparison-attempts" style={{ gridTemplateColumns: `repeat(${members.length}, minmax(0, 1fr))` }}>
        {members.map((task) => {
          const attempt = attempts.find((item) => item.task.id === task.id);
          const run = runs.find((item) => item.taskId === task.id);
          const changes = attempt?.changes ?? [];
          const additions = changes.reduce((total, change) => total + (change.additions ?? 0), 0);
          const deletions = changes.reduce((total, change) => total + (change.deletions ?? 0), 0);
          return (
            <article key={task.id} className={`comparison-attempt ${task.status === "cancelled" ? "set-aside" : ""}`} aria-label={`Tentativa ${task.title}`}>
              <header>
                <AgentGlyph provider={run?.provider} />
                <a href={`#/tasks/${encodeURIComponent(task.id)}`}><strong>{run?.provider ?? task.title}</strong></a>
                <span className={`status ${task.status}`}>{statusLabel(task)}</span>
              </header>
              {task.branch && <p className="comparison-branch"><code>{task.branch}</code></p>}
              <p className="comparison-summary">{run?.summary ? readableRunSummary(run.summary) : working.has(task.status) ? "O agente ainda está trabalhando." : "Ainda não executada."}</p>
              {attempt?.error ? <p className="error">{attempt.error}</p> : <p className="comparison-totals"><span className="add">+{additions}</span> <span className="remove">−{deletions}</span> em {changes.length} arquivo{changes.length === 1 ? "" : "s"}</p>}
              {allFinished && kept.length > 1 && task.status !== "cancelled" && (
                <button className="secondary" disabled={busy} onClick={() => onChoose(task.id)}><Check size={15} aria-hidden="true" /> Ficar com esta versão</button>
              )}
              {task.status === "cancelled" && <p className="comparison-note">Deixada de lado; a branch continua disponível.</p>}
            </article>
          );
        })}
      </div>

      <div className="comparison-files loading-area">
        {loading && <LoadingOverlay label="Lendo alterações…" />}
        <div className="comparison-files-heading">
          <h2><GitCompare size={16} aria-hidden="true" /> Arquivos alterados</h2>
          <span>{paths.length} no total · {shared} alterado{shared === 1 ? "" : "s"} por mais de um agente</span>
          <button className="text-button" onClick={() => setReload((value) => value + 1)} disabled={loading}><RefreshCw size={14} aria-hidden="true" /> Atualizar</button>
        </div>
        {!paths.length && !loading && <p className="empty">Nenhum arquivo alterado {allFinished ? "pelos agentes" : "até agora"}.</p>}
        {paths.length > 0 && (
          <table className="comparison-table">
            <thead><tr><th>Arquivo</th>{members.map((task) => <th key={task.id}>{runs.find((run) => run.taskId === task.id)?.provider ?? task.title}</th>)}</tr></thead>
            <tbody>
              {paths.map((path) => (
                <tr key={path} className={path === selected ? "selected" : ""}>
                  <td><button className="task-title" aria-pressed={path === selected} onClick={() => setSelected(path)}>{path}</button></td>
                  {members.map((task) => {
                    const change = attempts.find((attempt) => attempt.task.id === task.id)?.changes?.find((item) => item.path === path);
                    return <td key={task.id}>{change ? <span className="explorer-counts"><span className="add">+{change.additions ?? 0}</span> <span className="remove">−{change.deletions ?? 0}</span></span> : <span className="muted">sem alteração</span>}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected && (
        <div className="comparison-diffs loading-area" style={{ gridTemplateColumns: `repeat(${members.length}, minmax(0, 1fr))` }} aria-label={`Diffs de ${selected}`} role="group">
          {filesLoading && <LoadingOverlay label="Abrindo diffs…" />}
          {members.map((task) => {
            const file = files[task.id];
            return (
              <div key={task.id} className="comparison-diff">
                <h3>{runs.find((run) => run.taskId === task.id)?.provider ?? task.title}</h3>
                {file?.diff ? <DiffView diff={file.diff} truncated={file.diffTruncated} binary={file.binary} /> : <p className="explorer-note">Este agente não alterou <code>{selected}</code>.</p>}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
