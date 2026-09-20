import { ArrowLeft, FileCode2, History, Terminal } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { ExecutionDetail, ExecutionFileChange, Run, Task } from "../services/contracts.js";

const executionStatus: Record<Run["status"], string> = { planned: "Planejada", running: "Em execução", completed: "Concluída", failed: "Falhou", cancelled: "Cancelada" };

export function ExecutionResultPage({ detail, loading, error, onBack, onSelect, onCreateRelated }: {
  detail: ExecutionDetail | null;
  loading: boolean;
  error: string;
  onBack(): void;
  onSelect(executionId: string): void;
  onCreateRelated(task: Task): void;
}) {
  if (loading) return <main className="execution-page"><div className="empty">Carregando resultado da execução…</div></main>;
  if (!detail) return <main className="execution-page"><button className="text-button" onClick={onBack}><ArrowLeft size={16} /> Voltar ao painel</button><div className="error" role="alert">{error || "A execução não foi encontrada."}</div></main>;
  const { execution, task, project, history, files } = detail;
  const directories = new Map(project.directories.map((directory) => [directory.id, directory.name]));
  const grouped = files.reduce<Map<string, ExecutionFileChange[]>>((groups, file) => {
    const key = directories.get(file.directoryId) ?? "Diretório indisponível";
    groups.set(key, [...(groups.get(key) ?? []), file]);
    return groups;
  }, new Map());
  const output = execution.output?.trim() || execution.summary?.trim() || "O provedor não retornou conteúdo para esta execução.";
  return (
    <main className="execution-page" id="main" tabIndex={-1}>
      <header className="execution-page-header">
        <div className="execution-header-actions"><button className="secondary" onClick={onBack}><ArrowLeft size={16} /> Voltar ao painel</button><button className="primary" onClick={() => onCreateRelated(task)}>Criar tarefa relacionada</button></div>
        <div className="execution-heading">
          <span className="eyebrow">RESULTADO DA EXECUÇÃO</span>
          <h1>{task.title}</h1>
          <p>{project.name} · {execution.provider ?? "Provedor não informado"}</p>
        </div>
        <span className={`status ${execution.status}`}>{executionStatus[execution.status]}</span>
      </header>
      <section className="execution-meta" aria-label="Metadados da execução">
        <div><span>Execução</span><strong>{execution.id}</strong></div>
        <div><span>Início</span><strong>{formatDate(execution.startedAt)}</strong></div>
        <div><span>Duração</span><strong>{duration(execution)}</strong></div>
        <div><span>Encerramento</span><strong>{formatDate(execution.finishedAt)}</strong></div>
      </section>
      <div className="execution-layout">
        <article className="result-document">
          <div className="result-document-heading"><Terminal size={17} /><h2>Retorno do agente</h2></div>
          <div className="markdown-output"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{output}</ReactMarkdown></div>
          <section className="affected-files" aria-labelledby="affected-files-title">
            <div className="result-document-heading"><FileCode2 size={17} /><h2 id="affected-files-title">Arquivos afetados</h2></div>
            {grouped.size ? [...grouped].map(([directory, changed]) => <div className="file-group" key={directory}>
              <h3>{directory}</h3>
              {changed.map((file) => <FileChangeCard file={file} key={file.id} />)}
            </div>) : <p className="empty">Nenhum arquivo foi atribuído a esta execução. Alterações preexistentes ou uma coleta Git indisponível ficam registradas nos logs.</p>}
          </section>
        </article>
        <aside className="execution-history" aria-label="Histórico da tarefa">
          <div className="result-document-heading"><History size={17} /><h2>Histórico</h2></div>
          <p>{history.length} tentativa{history.length === 1 ? "" : "s"} desta tarefa</p>
          <div className="history-list">
            {history.map((item) => <button key={item.id} className={`history-item ${item.id === execution.id ? "current" : ""}`} onClick={() => onSelect(item.id)} aria-current={item.id === execution.id ? "page" : undefined}>
              <span className={`status ${item.status}`}>{executionStatus[item.status]}</span>
              <strong>{formatDate(item.finishedAt ?? item.startedAt)}</strong>
              <small>{item.provider ?? "Provedor não informado"}</small>
            </button>)}
          </div>
        </aside>
      </div>
    </main>
  );
}

function FileChangeCard({ file }: { file: ExecutionFileChange }) {
  const total = file.additions === null || file.deletions === null ? null : file.additions + file.deletions;
  return <div className={`file-change ${file.kind}`}><div><strong>{file.path}</strong><span>{label(file.kind)}</span></div><div className="file-counts">{file.additions === null ? <span>Preexistente</span> : <><span className="add">+{file.additions}</span><span className="remove">−{file.deletions}</span><span>{total} linhas</span></>}</div></div>;
}
function label(kind: ExecutionFileChange["kind"]): string { return ({ added: "Adicionado", modified: "Alterado", deleted: "Removido", untracked: "Não rastreado", preexisting: "Preexistente" })[kind]; }
function formatDate(value: string | null): string { return value ? new Date(value).toLocaleString("pt-BR") : "Não informado"; }
function duration(execution: Run): string {
  if (!execution.startedAt || !execution.finishedAt) return "Em andamento";
  const milliseconds = Math.max(0, new Date(execution.finishedAt).getTime() - new Date(execution.startedAt).getTime());
  return `${(milliseconds / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s`;
}
