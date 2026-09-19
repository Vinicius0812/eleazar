import {
  useEffect,
  useState,
  useRef,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowRight,
  Bell,
  Check,
  ChevronRight,
  Clock3,
  Command,
  FolderGit2,
  GitBranch,
  Layers3,
  LayoutDashboard,
  ListTodo,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import { Modal } from "./components/Modal.js";
import type {
  Approval,
  ControlRoomClient,
  ControlRoomSnapshot,
  Priority,
  Task,
} from "./services/contracts.js";
import { priorityOrder } from "./services/contracts.js";
const priorities = { critical: "Crítica", high: "Alta", normal: "Normal", low: "Baixa" };
const statuses = {
  queued: "Na fila",
  planning: "Planejando",
  running: "Em execução",
  waiting_approval: "Aguardando aprovação",
  completed: "Concluída",
  failed: "Falhou",
  cancelled: "Cancelada",
};
const navigation = [
  { id: "overview", label: "Visão geral", icon: LayoutDashboard },
  { id: "projects", label: "Projetos", icon: FolderGit2 },
  { id: "queue", label: "Fila de tarefas", icon: ListTodo },
  { id: "runs", label: "Execuções", icon: Activity },
  { id: "approvals", label: "Aprovações", icon: ShieldCheck },
  { id: "logs", label: "Logs", icon: Terminal },
];
type DialogState =
  | { kind: "project" }
  | { kind: "task" }
  | { kind: "detail"; task: Task }
  | { kind: "approval"; approval: Approval }
  | null;
function Panel({
  id,
  title,
  eyebrow,
  action,
  children,
}: {
  id: string;
  title: string;
  eyebrow?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="panel">
      <div className="panel-heading">
        <div>
          {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          <h2 id={`${id}-title`} tabIndex={-1}>
            {title}
          </h2>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
function message(reason: unknown) {
  return reason instanceof Error
    ? reason.message
    : "Não foi possível concluir a operação.";
}
export function App({ client }: { client: ControlRoomClient }) {
  const [data, setData] = useState<ControlRoomSnapshot | null>(null);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [projectFilter, setProjectFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [logLevel, setLogLevel] = useState("all");
  const [active, setActive] = useState("overview");
  const focusTrigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!dialog && !busy && focusTrigger.current) {
      if (focusTrigger.current.isConnected) focusTrigger.current.focus();
      else document.getElementById("approvals-title")?.focus();
      focusTrigger.current = null;
    }
  }, [dialog, busy]);
  useEffect(() => {
    let alive = true;
    setData(null);
    setError("");
    client
      .getSnapshot()
      .then((snapshot) => {
        if (alive) setData(snapshot);
      })
      .catch((reason) => {
        if (alive) setError(message(reason));
      });
    return () => {
      alive = false;
    };
  }, [client]);
  function open(next: DialogState) {
    focusTrigger.current = document.activeElement as HTMLElement | null;
    setFormError("");
    setDialog(next);
  }
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      setData(await client.getSnapshot());
      setNotice("Painel atualizado.");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  async function mutate(operation: () => Promise<unknown>, success: string) {
    setBusy(true);
    setFormError("");
    setNotice("");
    try {
      await operation();
      setDialog(null);
      setNotice(success);
      try {
        setData(await client.getSnapshot());
        setError("");
      } catch {
        setError(
          "A ação foi concluída, mas o painel não pôde ser atualizado. Use Atualizar para carregar o estado atual.",
        );
      }
    } catch (reason) {
      setFormError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  function submitProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void mutate(
      () =>
        client.registerProject({
          name: String(fields.get("name")),
          path: String(fields.get("path")),
        }),
      "Projeto cadastrado. Ele já está disponível para novas tarefas.",
    );
  }
  function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void mutate(async () => {
      const task = await client.createTask({
        projectId: String(fields.get("projectId")),
        title: String(fields.get("title")),
        prompt: String(fields.get("prompt")),
        priority: String(fields.get("priority")) as Priority,
      });
      setProjectFilter(task.projectId);
      setQuery("");
    }, "Tarefa criada e adicionada à fila.");
  }
  const projects = data?.projects ?? [];
  const tasks = data?.tasks ?? [];
  const approvals = data?.approvals ?? [];
  const filteredTasks = tasks
    .filter(
      (task) =>
        (projectFilter === "all" || task.projectId === projectFilter) &&
        `${task.title} ${task.id}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase()),
    )
    .sort(
      (a, b) =>
        priorityOrder[a.priority] - priorityOrder[b.priority] ||
        a.createdAt.localeCompare(b.createdAt),
    );
  const projectName = (id: string) =>
    projects.find((project) => project.id === id)?.name ??
    "Projeto indisponível";
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Ir para o conteúdo
      </a>
      <aside className="sidebar">
        <a className="brand" href="#overview">
          <span className="brand-symbol">
            <Command size={23} />
          </span>
          <span>
            eleazar<small>CONTROL ROOM</small>
          </span>
        </a>
        <div className="workspace">
          <span className="workspace-icon">E</span>
          <div>
            Workspace local<small>Seu centro de operações</small>
          </div>
          <Layers3 size={15} />
        </div>
        <span className="nav-label">OPERAÇÕES</span>
        <nav aria-label="Navegação principal">
          {navigation.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className={active === item.id ? "active" : ""}
              aria-current={active === item.id ? "location" : undefined}
              onClick={() => setActive(item.id)}
            >
              <item.icon size={19} />
              <span>{item.label}</span>
              {item.id === "approvals" && approvals.length > 0 && (
                <b className="nav-count">{approvals.length}</b>
              )}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-indicator">
            <span className="dot green" />
            Modo local · API loopback
          </div>
          <p>
            Uma meta. Vários agentes.
            <br />
            Uma execução coordenada.
          </p>
          <div className="operator">
            <span>OP</span>
            <div>
              Operador local<small>Você está no controle</small>
            </div>
          </div>
        </div>
      </aside>
      <div className="content">
        <header className="topbar">
          <div>
            Workspace <ChevronRight size={14} />
            <strong>Visão geral</strong>
          </div>
          <span className="local-badge">● API LOCAL</span>
        </header>
        <main id="main">
          <div id="overview" className="page-heading">
            <div>
              <div className="eyebrow">ELEAZAR / OPERAÇÕES</div>
              <h1>
                Sala de controle
                <span className="dot green" />
              </h1>
              <p>Acompanhe o trabalho. Direcione o próximo passo.</p>
            </div>
            <div className="heading-actions">
              <button
                className="secondary"
                onClick={() => void refresh()}
                disabled={busy}
              >
                <RefreshCw size={16} className={busy ? "spinning" : ""} />
                Atualizar
              </button>
              <button
                className="primary"
                onClick={() => open({ kind: "task" })}
                disabled={!data || !projects.length || busy}
              >
                <Plus size={17} />
                Nova tarefa
              </button>
            </div>
          </div>
          <div className="announcement">
            <ShieldCheck size={17} />
            <span>
              <strong>Ambiente local.</strong> Dados são persistidos pelo núcleo
              e a API aceita somente conexões loopback.
            </span>
          </div>
          <div className="feedback" aria-live="polite" role="status">
            {notice}
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          {!data ? (
            <div className="empty">
              {error
                ? "O painel está indisponível. Tente atualizar novamente."
                : "Carregando sala de controle…"}
            </div>
          ) : (
            <>
              <section className="metrics" aria-label="Resumo de operações">
                {[
                  {
                    label: "Projetos locais",
                    value: projects.length,
                    detail: "Cadastrados no workspace",
                    icon: FolderGit2,
                    color: "purple",
                  },
                  {
                    label: "Tarefas na fila",
                    value: tasks.filter((task) => task.status === "queued")
                      .length,
                    detail: "Prontas para o próximo passo",
                    icon: ListTodo,
                    color: "blue",
                  },
                  {
                    label: "Execuções ativas",
                    value: data.runs.filter((run) => run.status === "planned" || run.status === "running").length,
                    detail: "Preparadas ou em execução",
                    icon: Activity,
                    color: "green",
                  },
                  {
                    label: "Aguardando aprovação",
                    value: approvals.length,
                    detail: approvals.length
                      ? "Sua decisão é necessária"
                      : "Nenhuma decisão pendente",
                    icon: ShieldCheck,
                    color: "orange",
                  },
                ].map((metric) => (
                  <div className="metric" key={metric.label}>
                    <div>
                      <span>{metric.label}</span>
                      <metric.icon className={metric.color} size={20} />
                    </div>
                    <strong>{String(metric.value).padStart(2, "0")}</strong>
                    <small>{metric.detail}</small>
                  </div>
                ))}
              </section>
              <div className="dashboard-grid">
                <div className="primary-column">
                  <Panel
                    id="projects"
                    title="Seus projetos"
                    eyebrow="WORKSPACE"
                    action={
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => open({ kind: "project" })}
                      >
                        <Plus size={15} />
                        Cadastrar projeto
                      </button>
                    }
                  >
                    <div className="project-grid">
                      {projects.map((project) => (
                        <button
                          key={project.id}
                          className={`project-card ${projectFilter === project.id ? "selected" : ""}`}
                          aria-pressed={projectFilter === project.id}
                          onClick={() => {
                            setProjectFilter(
                              projectFilter === project.id ? "all" : project.id,
                            );
                            document.getElementById("queue")?.scrollIntoView({
                              block: "start",
                              behavior: "smooth",
                            });
                          }}
                        >
                          <span className="project-icon purple">
                            <FolderGit2 size={22} />
                          </span>
                          <span className="project-name">{project.name}</span>
                          <span className="project-path" title={project.path}>
                            {project.path}
                          </span>
                          <span className="project-footer">
                            <span>
                              <GitBranch size={12} />
                              Local
                            </span>
                            <span>
                              {
                                tasks.filter(
                                  (task) =>
                                    task.projectId === project.id &&
                                    task.status !== "completed",
                                ).length
                              }{" "}
                              tarefas
                              <ArrowRight size={13} />
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                    {!projects.length && (
                      <div className="empty">
                        Cadastre seu primeiro projeto local para começar.
                      </div>
                    )}
                  </Panel>
                  <Panel
                    id="queue"
                    title="Fila de tarefas"
                    eyebrow="PRÓXIMOS PASSOS"
                    action={
                      <span className="count-badge">
                        {filteredTasks.length} tarefas
                      </span>
                    }
                  >
                    <div className="queue-toolbar">
                      <label className="search">
                        <Search size={16} />
                        <input
                          aria-label="Buscar tarefa"
                          placeholder="Buscar por título ou ID…"
                          value={query}
                          onChange={(event) => setQuery(event.target.value)}
                        />
                      </label>
                      <select
                        aria-label="Filtrar por projeto"
                        value={projectFilter}
                        onChange={(event) =>
                          setProjectFilter(event.target.value)
                        }
                      >
                        <option value="all">Todos os projetos</option>
                        {projects.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Tarefa</th>
                            <th>Projeto</th>
                            <th>Prioridade</th>
                            <th>Status</th>
                            <th>
                              <span className="sr-only">Detalhes</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredTasks.map((task) => (
                            <tr key={task.id}>
                              <td>
                                <span className="task-id">{task.id}</span>
                                <button
                                  className="task-title"
                                  onClick={() => open({ kind: "detail", task })}
                                >
                                  {task.title}
                                </button>
                              </td>
                              <td className="project-cell">
                                {projectName(task.projectId)}
                              </td>
                              <td>
                                <span className={`priority ${task.priority}`}>
                                  <span className="dot" />
                                  {priorities[task.priority]}
                                </span>
                              </td>
                              <td>
                                <span className={`status ${task.status}`}>
                                  {task.status === "running" && (
                                    <Activity size={12} />
                                  )}
                                  {statuses[task.status]}
                                </span>
                              </td>
                              <td>
                                <button
                                  className="icon-button"
                                  aria-label={`Ver ${task.title}`}
                                  onClick={() => open({ kind: "detail", task })}
                                >
                                  <ChevronRight size={17} />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {!filteredTasks.length && (
                      <div className="empty">
                        {tasks.length
                          ? "Nenhuma tarefa corresponde aos filtros."
                          : "Sua fila está vazia. Crie uma nova tarefa."}
                      </div>
                    )}
                    <div className="panel-footer">
                      <span>Ordenadas por prioridade e data de criação</span>
                      <span>
                        <Clock3 size={13} /> Estado atual
                      </span>
                    </div>
                  </Panel>
                  <Panel
                    id="runs"
                    title="Execuções ativas"
                    eyebrow="EM ANDAMENTO"
                    action={
                      <span className="live-label">
                        <span className="dot green" />
                        Estado persistido
                      </span>
                    }
                  >
                    <div className="run-grid">
                      {data.runs.map((run) => {
                        const task = tasks.find(
                          (item) => item.id === run.taskId,
                        );
                        return (
                          <article className="run-card" key={run.id}>
                            <div className="run-top">
                              <span>
                                <Activity size={15} />
                                {run.id}
                              </span>
                              <span className="provider-tag">
                                {run.provider ?? "Nenhum provedor"}
                              </span>
                            </div>
                            <h3>{task?.title ?? "Tarefa indisponível"}</h3>
                            <p>
                              {task
                                ? projectName(task.projectId)
                                : "Projeto indisponível"}
                            </p>
                            <div className="progress-caption">
                              <span>{run.status}</span>
                              <strong>{run.status === "completed" ? "100" : "0"}%</strong>
                            </div>
                            <progress
                              aria-label={`Progresso de ${task?.title ?? run.id}`}
                              max={100}
                              value={run.status === "completed" ? 100 : 0}
                            />
                            <small>
                              {run.startedAt
                                ? `Iniciada em ${new Date(run.startedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`
                                : "Ainda não iniciada"}
                            </small>
                          </article>
                        );
                      })}
                    </div>
                    {!data.runs.length && (
                      <div className="empty">Nenhuma execução ativa.</div>
                    )}
                  </Panel>
                  <Panel
                    id="logs"
                    title="Atividade recente"
                    eyebrow="LOGS DO WORKSPACE"
                    action={
                      <select
                        aria-label="Filtrar nível dos logs"
                        value={logLevel}
                        onChange={(event) => setLogLevel(event.target.value)}
                      >
                        <option value="all">Todos os níveis</option>
                        <option value="info">Informação</option>
                        <option value="warn">Aviso</option>
                        <option value="error">Erro</option>
                      </select>
                    }
                  >
                    <div className="log-list">
                      {data.logs
                        .filter(
                          (log) => logLevel === "all" || log.level === logLevel,
                        )
                        .map((log) => (
                          <div key={log.id} className="log-row">
                            <time dateTime={log.createdAt}>
                              {new Date(log.createdAt).toLocaleTimeString("pt-BR")}
                            </time>
                            <span className={`log-level ${log.level}`}>
                              {log.level === "info"
                                ? "INFO"
                                : log.level === "warn"
                                  ? "AVISO"
                                  : "ERRO"}
                            </span>
                            <span>{log.message}</span>
                          </div>
                        ))}
                      {!data.logs.some(
                        (log) => logLevel === "all" || log.level === logLevel,
                      ) && <div className="empty">Nenhum log neste nível.</div>}
                    </div>
                  </Panel>
                </div>
                <div className="secondary-column">
                  <Panel
                    id="approvals"
                    title="Suas aprovações"
                    action={
                      <span className="count-badge amber">
                        {approvals.length}
                      </span>
                    }
                  >
                    {approvals.map((approval) => (
                      <article className="approval-card" key={approval.id}>
                        <span className="approval-label">
                          <ShieldCheck size={14} />
                          DECISÃO PENDENTE
                        </span>
                        <h3>{approval.title}</h3>
                        <p>
                          {projectName(
                            tasks.find((task) => task.id === approval.taskId)
                              ?.projectId ?? "",
                          )}{" "}
                          · {approval.taskId}
                        </p>
                        <div className="approval-action">
                          <GitBranch size={14} />
                          {approval.action}
                        </div>
                        <button
                          className="approval-button"
                          disabled={busy}
                          onClick={() => open({ kind: "approval", approval })}
                        >
                          Revisar proposta
                          <ArrowRight size={16} />
                        </button>
                      </article>
                    ))}
                    {!approvals.length && (
                      <div className="empty success-empty">
                        <Check size={24} />
                        <strong>Tudo revisado</strong>
                        <span>Nenhuma aprovação pendente.</span>
                      </div>
                    )}
                  </Panel>
                  <Panel
                    id="alerts"
                    title="Alertas"
                    action={<Bell size={17} className="muted" />}
                  >
                    <div className="alert-list">
                      {data.alerts.map((alert) => (
                        <article
                          key={alert.id}
                          className={`alert-card ${alert.level}`}
                        >
                          <span className="dot" />
                          <div>
                            <h3>{alert.title}</h3>
                            <p>{alert.message}</p>
                          </div>
                        </article>
                      ))}
                      {!data.alerts.length && (
                        <div className="empty">Nenhum alerta.</div>
                      )}
                    </div>
                  </Panel>
                  <div className="control-note">
                    <span className="note-symbol">
                      <Command size={25} />
                    </span>
                    <h3>Você dirige a orquestra.</h3>
                    <p>
                      Projetos, agentes e decisões em um único lugar. O próximo
                      movimento começa com uma tarefa.
                    </p>
                    <button
                      className="text-button"
                      onClick={() => open({ kind: "task" })}
                      disabled={!projects.length || busy}
                    >
                      Criar uma tarefa
                      <ArrowRight size={15} />
                    </button>
                  </div>
                </div>
              </div>
              <footer className="page-footer">
                <span>ELEAZAR CONTROL ROOM</span>
                <span>Local first · Interface v0.1</span>
              </footer>
            </>
          )}
        </main>
      </div>
      {dialog && (
        <Modal
          title={
            dialog.kind === "project"
              ? "Cadastrar projeto local"
              : dialog.kind === "task"
                ? "Criar tarefa"
                : dialog.kind === "detail"
                  ? "Detalhes da tarefa"
                  : "Revisar aprovação"
          }
          onClose={() => setDialog(null)}
          busy={busy}
        >
          {formError && (
            <div className="error" role="alert">
              {formError}
            </div>
          )}
          {dialog.kind === "project" && (
            <form onSubmit={submitProject}>
              <p className="form-intro">
                Informe o diretório do projeto. O núcleo local valida e
                persiste o cadastro antes de a interface ser atualizada.
              </p>
              <label>
                Nome do projeto
                <input
                  name="name"
                  required
                  maxLength={100}

                  placeholder="Meu projeto"
                />
              </label>
              <label>
                Caminho local absoluto
                <input
                  name="path"
                  required
                  maxLength={500}
                  placeholder="C:\Projetos\meu-projeto"
                />
                <small>
                  O caminho deve ser absoluto. A validação é feita pelo núcleo
                  local.
                </small>
              </label>
              <div className="form-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setDialog(null)}
                  disabled={busy}
                >
                  Cancelar
                </button>
                <button className="primary" disabled={busy}>
                  {busy ? "Cadastrando…" : "Cadastrar projeto"}
                </button>
              </div>
            </form>
          )}
          {dialog.kind === "task" && (
            <form onSubmit={submitTask}>
              <p className="form-intro">
                Defina o próximo trabalho. A tarefa entra na fila persistida;
                o despacho continua sujeito à política do núcleo.
              </p>
              <label>
                Projeto
                <select
                  name="projectId"
                  required
                  defaultValue={
                    projectFilter !== "all" ? projectFilter : projects[0]?.id
                  }
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Título
                <input
                  name="title"
                  required
                  maxLength={160}
                  placeholder="O que precisa ser feito?"
                />
              </label>
              <label>
                Prompt
                <textarea
                  name="prompt"
                  required
                  maxLength={20000}
                  rows={5}
                  placeholder="Descreva o objetivo, o contexto e os critérios de conclusão…"
                />
              </label>
              <label>
                Prioridade
                <select name="priority" defaultValue="normal">
                  <option value="critical">Crítica</option>
                  <option value="high">Alta</option>
                  <option value="normal">Normal</option>
                  <option value="low">Baixa</option>
                </select>
              </label>
              <div className="form-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => setDialog(null)}
                >
                  Cancelar
                </button>
                <button className="primary" disabled={busy}>
                  {busy ? "Criando…" : "Adicionar à fila"}
                </button>
              </div>
            </form>
          )}
          {dialog.kind === "detail" && (
            <div className="task-detail">
              <span className="task-id">
                {dialog.task.id} · {projectName(dialog.task.projectId)}
              </span>
              <h3>{dialog.task.title}</h3>
              <div className="detail-badges">
                <span className={`priority ${dialog.task.priority}`}>
                  {priorities[dialog.task.priority]}
                </span>
                <span className={`status ${dialog.task.status}`}>
                  {statuses[dialog.task.status]}
                </span>
              </div>
              <h4>Prompt</h4>
              <p className="prompt-text">{dialog.task.prompt}</p>
              <small>
                Criada em{" "}
                {new Date(dialog.task.createdAt).toLocaleString("pt-BR")}
              </small>
            </div>
          )}
          {dialog.kind === "approval" && (
            <div className="approval-detail">
              <span className="approval-label">
                {dialog.approval.id} · {dialog.approval.taskId}
              </span>
              <h3>{dialog.approval.title}</h3>
              <p>{dialog.approval.description}</p>
              <div className="approval-action">
                <GitBranch size={16} />
                {dialog.approval.action}
              </div>
              <p className="form-intro">
                Aprovar retoma o planejamento da tarefa. Rejeitar a cancela.
                A decisão é gravada pelo núcleo local antes da atualização.
              </p>
              <div className="form-actions">
                <button
                  className="secondary danger"
                  disabled={busy}
                  onClick={() =>
                    void mutate(
                      () => client.decideApproval(dialog.approval.id, "reject"),
                      "Proposta rejeitada. A tarefa foi cancelada.",
                    )
                  }
                >
                  <X size={16} />
                  Rejeitar
                </button>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void mutate(
                      () =>
                        client.decideApproval(dialog.approval.id, "approve"),
                      "Proposta aprovada. A tarefa voltou ao planejamento.",
                    )
                  }
                >
                  <Check size={16} />
                  {busy ? "Registrando…" : "Aprovar proposta"}
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
