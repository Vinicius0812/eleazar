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
  FolderGit2,
  GitBranch,
  Layers3,
  LayoutDashboard,
  ListTodo,
  Moon,
  Plus,
  Play,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  ShieldCheck,
  Terminal,
  Sun,
  X,
} from "lucide-react";
import { Modal } from "./components/Modal.js";
import { ExecutionResultPage } from "./components/ExecutionResultPage.js";
import type {
  Approval,
  ControlRoomClient,
  ControlRoomSnapshot,
  ExecutionDetail,
  ProviderStatus,
  LogEntry,
  Priority,
  Run,
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
  { id: "tasks", label: "Fila de tarefas", icon: ListTodo },
  { id: "executions", label: "Execuções", icon: Activity },
  { id: "approvals", label: "Aprovações", icon: ShieldCheck },
  { id: "logs", label: "Logs", icon: Terminal },
];
type DialogState =
  | { kind: "project" }
  | { kind: "task" }
  | { kind: "detail"; task: Task }
  | { kind: "execute"; task: Task }
  | { kind: "related"; task: Task }
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
function executionIdFromHash(): string | null {
  const match = /^#\/executions\/([^/]+)$/.exec(window.location.hash);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}
type PageRoute = "overview" | "projects" | "tasks" | "executions" | "approvals" | "logs" | "not-found";
type Theme = "light" | "dark";

function preferredTheme(): Theme {
  const saved = window.localStorage.getItem("eleazar.theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function pageFromHash(): PageRoute {
  const value = window.location.hash.replace(/^#\/?/, "").split("/")[0] || "overview";
  return ["overview", "projects", "tasks", "executions", "approvals", "logs"].includes(value) ? value as PageRoute : "not-found";
}
function readableRunSummary(summary: string | null) {
  if (!summary) return "O provedor não retornou detalhes adicionais.";
  try {
    const parsed: unknown = JSON.parse(summary);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const item = parsed as Record<string, unknown>;
      for (const key of ["detail", "error", "message"]) {
        if (typeof item[key] === "string" && item[key].trim()) return item[key].trim();
      }
    }
  } catch { /* Entradas legadas podem conter texto simples. */ }
  return summary;
}
function failureHint(summary: string | null) {
  const detail = readableRunSummary(summary);
  if (/requires a newer version of codex|vers[aã]o mais nova.*codex/i.test(detail)) {
    return "Atualize o pacote @openai/codex-sdk usado pelo Eleazar e reinicie o Control Room; atualizar apenas o CLI global pode não atualizar o binário chamado pelo SDK.";
  }
  return "Consulte a mensagem e o log abaixo antes de reenfileirar a tarefa.";
}
function ExecutionFeedback({ run, latestLog }: { run: Run; latestLog?: LogEntry | undefined }) {
  const failed = run.status === "failed";
  return (
    <section className={`execution-feedback ${failed ? "error" : ""}`} aria-label="Resultado da última execução">
      <strong>{failed ? "Motivo da falha" : "Resultado da última execução"}</strong>
      <p className="execution-summary">{readableRunSummary(run.summary)}</p>
      {failed && <p className="execution-hint">{failureHint(run.summary)}</p>}
      <dl>
        <div><dt>Provedor</dt><dd>{run.provider ?? "Não informado"}</dd></div>
        <div><dt>Encerrada</dt><dd>{run.finishedAt ? new Date(run.finishedAt).toLocaleString("pt-BR") : "Ainda em andamento"}</dd></div>
      </dl>
      {latestLog && <p className="execution-log"><strong>Último log:</strong> {latestLog.message}</p>}
    </section>
  );
}
function ProviderStatusPanel({ providers, loading, error, onRefresh }: { providers: ProviderStatus[]; loading: boolean; error: string; onRefresh(): void }) {
  return <Panel id="providers" title="Provedores" eyebrow="CAPACIDADE LOCAL" action={<button className="text-button" onClick={onRefresh} disabled={loading}><RefreshCw size={14} className={loading ? "spinning" : ""} /> Atualizar status</button>}>
    {error && <div className="provider-note error">{error}</div>}
    <div className="provider-list">
      {providers.map((provider) => <article className="provider-row" key={provider.provider}>
        <span className={`provider-symbol ${provider.available ? "available" : "unavailable"}`}>{provider.provider === "codex" ? "C" : "A"}</span>
        <div><strong>{provider.provider === "codex" ? "Codex" : "Antigravity"}</strong><small>{provider.detail}</small></div>
        <div className="provider-usage">
          {provider.usage.usedPercent !== null ? <><strong>{provider.usage.usedPercent}% usado</strong><progress className="provider-progress" max={100} value={provider.usage.usedPercent} aria-label={`Uso do ${provider.provider}`} /><small>{provider.usage.resetAt ? `Reset: ${new Date(provider.usage.resetAt).toLocaleString("pt-BR")}` : "Reset não informado"}</small></> : provider.usage.totalTokens !== null ? <><strong>{provider.usage.totalTokens.toLocaleString("pt-BR")} tokens</strong><small>Uso observado no Eleazar</small></> : <><strong>Sem consumo disponível</strong><small>Não informado pelo provedor</small></>}
        </div>
        <span className={`dot ${provider.available ? "green" : ""}`} title={provider.available ? "Disponível" : "Indisponível"} />
      </article>)}
      {!providers.length && !loading && <div className="empty">Nenhum provedor respondeu ao diagnóstico local.</div>}
    </div>
    {providers[0] && <p className="provider-note">Dados atualizados em {new Date(providers[0].fetchedAt).toLocaleString("pt-BR")}. O saldo é exibido apenas quando o provedor o informa.</p>}
  </Panel>;
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
  const [active, setActive] = useState<PageRoute>(pageFromHash());
  const [projectDirectories, setProjectDirectories] = useState([{ name: "", path: "" }]);
  const [taskProjectId, setTaskProjectId] = useState("");
  const [taskDirectoryId, setTaskDirectoryId] = useState("");
  const [taskDirectoryIds, setTaskDirectoryIds] = useState<string[]>([]);
  const [executionProvider, setExecutionProvider] = useState<"auto" | "codex" | "antigravity">("auto");
  const [executionRoute, setExecutionRoute] = useState<string | null>(executionIdFromHash());
  const [executionDetail, setExecutionDetail] = useState<ExecutionDetail | null>(null);
  const [executionLoading, setExecutionLoading] = useState(false);
  const [executionError, setExecutionError] = useState("");
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providersError, setProvidersError] = useState("");
  const [collapsed, setCollapsed] = useState(() => window.localStorage.getItem("eleazar.sidebarCollapsed") === "true");
  const [theme, setTheme] = useState<Theme>(preferredTheme);
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
  useEffect(() => {
    const onHashChange = () => { setExecutionRoute(executionIdFromHash()); setActive(pageFromHash()); };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  useEffect(() => {
    if (!executionRoute) { setExecutionDetail(null); return; }
    let alive = true;
    setExecutionLoading(true); setExecutionError(""); setExecutionDetail(null);
    client.getExecutionDetail(executionRoute).then((detail) => { if (alive) setExecutionDetail(detail); })
      .catch((reason) => { if (alive) setExecutionError(message(reason)); })
      .finally(() => { if (alive) setExecutionLoading(false); });
    return () => { alive = false; };
  }, [client, executionRoute]);
  useEffect(() => { window.localStorage.setItem("eleazar.sidebarCollapsed", String(collapsed)); }, [collapsed]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("eleazar.theme", theme);
  }, [theme]);
  useEffect(() => {
    if (active !== "overview") return;
    let alive = true;
    setProvidersLoading(true); setProvidersError("");
    client.getProviderStatuses().then((items) => { if (alive) setProviders(items); }).catch((reason) => { if (alive) setProvidersError(message(reason)); }).finally(() => { if (alive) setProvidersLoading(false); });
    return () => { alive = false; };
  }, [active, client]);
  const hasLiveTask = data?.tasks.some((task) => task.status === "planning" || task.status === "running") ?? false;
  useEffect(() => {
    if (!hasLiveTask) return;
    const timer = window.setTimeout(() => {
      client.getSnapshot().then(setData).catch((reason) => setError(message(reason)));
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, [client, hasLiveTask, data?.tasks]);
  function open(next: DialogState) {
    focusTrigger.current = document.activeElement as HTMLElement | null;
    setFormError("");
    if (next?.kind === "project") setProjectDirectories([{ name: "", path: "" }]);
    if (next?.kind === "task") {
      const projectId = projectFilter !== "all" ? projectFilter : projects[0]?.id ?? "";
      setTaskProjectId(projectId);
      const directoryId = projects.find((project) => project.id === projectId)?.directories[0]?.id ?? "";
      setTaskDirectoryId(directoryId);
      setTaskDirectoryIds(directoryId ? [directoryId] : []);
    }
    if (next?.kind === "execute") setExecutionProvider("auto");
    setDialog(next);
  }
  function navigate(next: PageRoute): void { window.location.hash = `/${next === "not-found" ? "overview" : next}`; }
  function openExecution(executionId: string) { window.location.hash = `/executions/${encodeURIComponent(executionId)}`; }
  function backToDashboard() { navigate("overview"); }
  function refreshProviders(): void { setProvidersLoading(true); setProvidersError(""); client.getProviderStatuses(true).then(setProviders).catch((reason) => setProvidersError(message(reason))).finally(() => setProvidersLoading(false)); }
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
          directories: projectDirectories,
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
        targetDirectoryId: String(fields.get("targetDirectoryId")),
        directoryIds: taskDirectoryIds,
        title: String(fields.get("title")),
        prompt: String(fields.get("prompt")),
        priority: String(fields.get("priority")) as Priority,
      });
      setProjectFilter(task.projectId);
      setQuery("");
    }, "Tarefa criada e adicionada à fila.");
  }
  function submitRelatedTask(event: FormEvent<HTMLFormElement>, task: Task) {
    event.preventDefault();
    const targetDirectoryId = task.targetDirectoryId ?? task.directoryIds[0];
    if (!targetDirectoryId) { setFormError("A tarefa original não possui um diretório válido para herdar."); return; }
    const fields = new FormData(event.currentTarget);
    void mutate(async () => {
      await client.createTask({ projectId: task.projectId, targetDirectoryId, directoryIds: task.directoryIds.length ? task.directoryIds : [targetDirectoryId], title: String(fields.get("title")), prompt: String(fields.get("prompt")), priority: task.priority, kind: task.kind });
      navigate("tasks");
    }, "Tarefa relacionada criada com o mesmo contexto.");
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
  const projectForTask = projects.find((project) => project.id === taskProjectId);
  const directoryName = (task: Task) => projects.find((project) => project.id === task.projectId)?.directories.find((directory) => directory.id === task.targetDirectoryId)?.name ?? "Diretório indisponível";
  const directoryNames = (task: Task) => projects.find((project) => project.id === task.projectId)?.directories.filter((directory) => task.directoryIds.includes(directory.id)).map((directory) => directory.name).join(", ") ?? "Diretório indisponível";
  const latestRunForTask = (taskId: string) => data?.runs.find((run) => run.taskId === taskId);
  const latestLogForRun = (runId: string) => data?.logs.filter((log) => log.executionId === runId).at(-1);
  const pageTitle: Record<Exclude<PageRoute, "not-found">, [string, string]> = {
    overview: ["Sala de controle", "Acompanhe o trabalho. Direcione o próximo passo."], projects: ["Projetos", "Cadastre e acompanhe os diretórios do workspace."], tasks: ["Fila de tarefas", "Priorize, execute e acompanhe o próximo trabalho."], executions: ["Execuções", "Consulte as tentativas e seus resultados persistidos."], approvals: ["Aprovações", "Decisões que precisam da sua intervenção."], logs: ["Logs", "Atividade recente registrada pelo núcleo local."]
  };
  return (
    <div className={`shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      <a className="skip-link" href="#main" onClick={(event) => { event.preventDefault(); document.getElementById("main")?.focus(); }}>
        Ir para o conteúdo
      </a>
      <aside className="sidebar">
        <a className="brand" href="#/overview" title="Eleazar · Visão geral">
          <span className="brand-symbol">
            <Terminal size={23} />
          </span>
          <span>
            Eleazar<small>CONTROL ROOM</small>
          </span>
        </a>
        <button className="sidebar-toggle" aria-label={collapsed ? "Expandir menu" : "Recolher menu"} aria-pressed={collapsed} onClick={() => setCollapsed((value) => !value)}>{collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</button>
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
              href={`#/${item.id}`}
              className={active === item.id ? "active" : ""}
              aria-current={active === item.id ? "location" : undefined}
              title={collapsed ? item.label : undefined}
            >
              <item.icon size={19} />
              <span>{item.label}</span>
              {item.id === "approvals" && approvals.length > 0 && (
                <b className="nav-count">{approvals.length}</b>
              )}
            </a>
          ))}
        </nav>
        <div className="sidebar-actions">
          <button
            className="theme-toggle"
            type="button"
            aria-label={theme === "dark" ? "Ativar modo claro" : "Ativar modo escuro"}
            aria-pressed={theme === "dark"}
            onClick={() => setTheme((value) => value === "dark" ? "light" : "dark")}
            title={collapsed ? (theme === "dark" ? "Ativar modo claro" : "Ativar modo escuro") : undefined}
          >
            {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            <span>{theme === "dark" ? "Modo claro" : "Modo escuro"}</span>
          </button>
        </div>
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
            <strong>{active === "not-found" ? "Página não encontrada" : navigation.find((item) => item.id === active)?.label ?? "Resultado da execução"}</strong>
          </div>
        </header>
        {executionRoute ? <ExecutionResultPage detail={executionDetail} loading={executionLoading} error={executionError} onBack={backToDashboard} onSelect={openExecution} onCreateRelated={(task) => open({ kind: "related", task })} /> : <main id="main" tabIndex={-1}>
          {active === "not-found" ? <section className="route-not-found"><div className="eyebrow">ROTA LOCAL</div><h1>Página não encontrada</h1><p>Essa rota não faz parte da Control Room.</p><button className="primary" onClick={() => navigate("overview")}>Voltar à visão geral</button></section> : <>
          <div className="page-heading">
            <div>
              <div className="eyebrow">ELEAZAR / OPERAÇÕES</div>
              <h1>
                {pageTitle[active as Exclude<PageRoute, "not-found">]?.[0] ?? "Sala de controle"}
                <span className="dot green" />
              </h1>
              <p>{pageTitle[active as Exclude<PageRoute, "not-found">]?.[1] ?? "Acompanhe o trabalho. Direcione o próximo passo."}</p>
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
              {active === "overview" && <section className="metrics" aria-label="Resumo de operações">
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
              </section>}
              <div className={`dashboard-grid page-${active}`}>
                <div className="primary-column">
                  {active === "overview" && <div className="executive-column">
                    <Panel
                      id="next-tasks"
                      title="Próximas tarefas"
                      eyebrow="FILA PRIORITÁRIA"
                      action={<button className="text-button" onClick={() => navigate("tasks")}>Ver fila <ArrowRight size={15} /></button>}
                    >
                      <div className="executive-list">
                        {filteredTasks.slice(0, 4).map((task) => (
                          <button className="executive-row" key={task.id} onClick={() => latestRunForTask(task.id) ? openExecution(latestRunForTask(task.id)!.id) : open({ kind: "detail", task })}>
                            <span className={`priority ${task.priority}`}><span className="dot" />{priorities[task.priority]}</span>
                            <span className="executive-row-copy"><strong>{task.title}</strong><small>{projectName(task.projectId)} · {directoryName(task)}</small></span>
                            <span className={`status ${task.status}`}>{statuses[task.status]}</span>
                            <ChevronRight size={17} />
                          </button>
                        ))}
                        {!filteredTasks.length && <div className="empty">Nenhuma tarefa pendente. Crie a próxima etapa quando estiver pronto.</div>}
                      </div>
                    </Panel>
                    <Panel
                      id="recent-executions"
                      title="Execuções recentes"
                      eyebrow="HISTÓRICO"
                      action={<button className="text-button" onClick={() => navigate("executions")}>Ver execuções <ArrowRight size={15} /></button>}
                    >
                      <div className="executive-list">
                        {[...data.runs].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "")).slice(0, 4).map((run) => {
                          const task = tasks.find((item) => item.id === run.taskId);
                          return <button className="executive-row" key={run.id} onClick={() => openExecution(run.id)}>
                            <span className={`status ${run.status}`}>{statuses[run.status as keyof typeof statuses] ?? run.status}</span>
                            <span className="executive-row-copy"><strong>{task?.title ?? "Tarefa indisponível"}</strong><small>{run.provider ?? "Provedor não informado"} · {run.finishedAt ? new Date(run.finishedAt).toLocaleString("pt-BR") : "Em andamento"}</small></span>
                            <ChevronRight size={17} />
                          </button>;
                        })}
                        {!data.runs.length && <div className="empty">Ainda não há execuções registradas.</div>}
                      </div>
                    </Panel>
                  </div>}
                  {active === "projects" &&
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
                            setProjectFilter(project.id);
                            navigate("tasks");
                          }}
                        >
                          <span className="project-icon purple">
                            <FolderGit2 size={22} />
                          </span>
                          <span className="project-name">{project.name}</span>
                          <span className="project-path" title={project.path}>
                            {project.directories.length} diretório{project.directories.length === 1 ? "" : "s"}
                          </span>
                          <span className="project-directories" aria-label={`Diretórios de ${project.name}`}>
                            {project.directories.map((directory) => (
                              <span key={directory.id} title={directory.path}>
                                {directory.name}{directory.isGitRepository ? " · Git" : ""}
                              </span>
                            ))}
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
                  </Panel>}
                  {active === "tasks" &&
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
                            <th>Diretório</th>
                            <th>Prioridade</th>
                            <th>Status</th>
                            <th>
                              <span className="sr-only">Ações</span>
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
                                  onClick={() => latestRunForTask(task.id) ? openExecution(latestRunForTask(task.id)!.id) : open({ kind: "detail", task })}
                                >
                                  {task.title}
                                </button>
                              </td>
                              <td className="project-cell">
                                {projectName(task.projectId)}
                              </td>
                              <td>{directoryName(task)}</td>
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
                                {task.status === "queued" ? (
                                  <button className="text-button" aria-label={`Executar ${task.title}`} disabled={busy} onClick={() => open({ kind: "execute", task })}>
                                    <Play size={14} /> Executar
                                  </button>
                                ) : task.status === "failed" ? (
                                  <button className="text-button danger" aria-label={`Ver erro de ${task.title}`} onClick={() => latestRunForTask(task.id) && openExecution(latestRunForTask(task.id)!.id)}>
                                    Ver erro
                                  </button>
                                ) : task.status === "completed" && latestRunForTask(task.id) ? (
                                  <button className="text-button" aria-label={`Ver resultado de ${task.title}`} onClick={() => openExecution(latestRunForTask(task.id)!.id)}>
                                    Ver resultado
                                  </button>
                                ) : (
                                  <button className="icon-button" aria-label={`Ver ${task.title}`} onClick={() => open({ kind: "detail", task })}>
                                    <ChevronRight size={17} />
                                  </button>
                                )}
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
                  </Panel>}
                  {active === "executions" &&
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
                          <article className={`run-card ${run.status === "failed" ? "failed" : ""}`} key={run.id}>
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
                            {run.status === "failed" && (
                              <ExecutionFeedback run={run} latestLog={latestLogForRun(run.id)} />
                            )}
                            {(run.status === "completed" || run.status === "failed") && <button className={`text-button ${run.status === "failed" ? "danger" : ""}`} onClick={() => openExecution(run.id)}>{run.status === "failed" ? "Ver erro detalhado" : "Abrir resultado"}</button>}
                          </article>
                        );
                      })}
                    </div>
                    {!data.runs.length && (
                      <div className="empty">Nenhuma execução ativa.</div>
                    )}
                  </Panel>}
                  {active === "logs" &&
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
                  </Panel>}
                </div>
                {(active === "overview" || active === "approvals") && <div className="secondary-column">
                  {active === "overview" && <ProviderStatusPanel providers={providers} loading={providersLoading} error={providersError} onRefresh={refreshProviders} />}
                  {active === "approvals" &&
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
                  </Panel>}
                  {active === "overview" &&
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
                  </Panel>}
                </div>}
              </div>
              <footer className="page-footer">
                <span>ELEAZAR CONTROL ROOM</span>
                <span>Local first · Interface v0.1</span>
              </footer>
            </>
          )}
          </>}
        </main>}
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
                : dialog.kind === "execute"
                    ? "Executar tarefa"
                  : dialog.kind === "related"
                    ? "Criar tarefa relacionada"
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
                Informe um ou mais diretórios do projeto. O núcleo local valida e
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
              <fieldset className="directory-fields">
                <legend>Diretórios locais</legend>
                {projectDirectories.map((directory, index) => (
                  <div className="directory-field" key={index}>
                    <label>
                      Rótulo do diretório
                      <input
                        value={directory.name}
                        maxLength={100}
                        placeholder={`Diretório ${index + 1}`}
                        onChange={(event) => setProjectDirectories((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))}
                      />
                    </label>
                    <label>
                      Caminho local absoluto
                      <input
                        required
                        value={directory.path}
                        maxLength={500}
                        placeholder="C:\Projetos\meu-projeto"
                        onChange={(event) => setProjectDirectories((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, path: event.target.value } : item))}
                      />
                    </label>
                    <div className="directory-actions" aria-label={`Ações para diretório ${index + 1}`}>
                      <button type="button" className="secondary" disabled={busy || index === 0} onClick={() => setProjectDirectories((current) => current.map((item, itemIndex) => itemIndex === index - 1 ? current[index]! : itemIndex === index ? current[index - 1]! : item))}>Subir</button>
                      <button type="button" className="secondary" disabled={busy || index === projectDirectories.length - 1} onClick={() => setProjectDirectories((current) => current.map((item, itemIndex) => itemIndex === index + 1 ? current[index]! : itemIndex === index ? current[index + 1]! : item))}>Descer</button>
                      <button type="button" className="secondary danger" disabled={busy || projectDirectories.length === 1} onClick={() => setProjectDirectories((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remover</button>
                    </div>
                  </div>
                ))}
                <button type="button" className="text-button" disabled={busy} onClick={() => setProjectDirectories((current) => [...current, { name: "", path: "" }])}><Plus size={15} /> Adicionar diretório</button>
                <small>Os caminhos devem existir, ser absolutos e não podem se repetir.</small>
              </fieldset>
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
                  value={taskProjectId}
                  onChange={(event) => {
                    const projectId = event.target.value;
                    setTaskProjectId(projectId);
                    const directoryId = projects.find((project) => project.id === projectId)?.directories[0]?.id ?? "";
                    setTaskDirectoryId(directoryId);
                    setTaskDirectoryIds(directoryId ? [directoryId] : []);
                  }}
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Diretório-alvo
                <select name="targetDirectoryId" required value={taskDirectoryId} onChange={(event) => {
                  const directoryId = event.target.value;
                  setTaskDirectoryId(directoryId);
                  setTaskDirectoryIds((current) => [directoryId, ...current.filter((item) => item !== directoryId)]);
                }}>
                  {projectForTask?.directories.map((directory) => (
                    <option key={directory.id} value={directory.id}>{directory.name} · {directory.path}</option>
                  ))}
                </select>
                <small>Toda tarefa é vinculada a um diretório específico.</small>
              </label>
              <fieldset className="task-scope">
                <legend>Diretórios adicionais afetados</legend>
                {projectForTask?.directories.filter((directory) => directory.id !== taskDirectoryId).map((directory) => (
                  <label key={directory.id} className="scope-option">
                    <input type="checkbox" checked={taskDirectoryIds.includes(directory.id)} onChange={(event) => setTaskDirectoryIds((current) => event.target.checked ? [...current, directory.id] : current.filter((item) => item !== directory.id))} />
                    {directory.name}
                  </label>
                ))}
                <small>Mais de um diretório exige aprovação antes do despacho.</small>
              </fieldset>
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
              <h4>Diretório-alvo</h4>
              <p>{directoryNames(dialog.task)}{dialog.task.directoryIds.length > 1 ? " · Escopo composto" : ""}</p>
              {latestRunForTask(dialog.task.id) && <div className="form-actions"><button className="secondary" onClick={() => openExecution(latestRunForTask(dialog.task.id)!.id)}>Abrir resultado da última execução</button></div>}
              <small>
                Criada em{" "}
                {new Date(dialog.task.createdAt).toLocaleString("pt-BR")}
              </small>
              {dialog.task.status === "queued" && (
                <div className="form-actions">
                  <button className="primary" disabled={busy} onClick={() => open({ kind: "execute", task: dialog.task })}>
                    <Play size={16} /> Executar tarefa
                  </button>
                </div>
              )}
              {dialog.task.status === "failed" && (
                <div className="form-actions">
                  <button className="secondary" disabled={busy} onClick={() => void mutate(() => client.retryTask(dialog.task.id), "Tarefa reenfileirada. Revise o erro e execute novamente quando estiver pronto.")}>
                    <RefreshCw size={16} /> {busy ? "Reenfileirando…" : "Reenfileirar tarefa"}
                  </button>
                </div>
              )}
            </div>
          )}
          {dialog.kind === "related" && (
            <form onSubmit={(event) => submitRelatedTask(event, dialog.task)}>
              <p className="form-intro">Esta tarefa herdará projeto, diretório, escopo, prioridade e tipo de <strong>{dialog.task.title}</strong>.</p>
              <label>
                Título
                <input name="title" required maxLength={160} placeholder="Próximo passo relacionado" autoFocus />
              </label>
              <label>
                Prompt
                <textarea name="prompt" required maxLength={20000} rows={6} placeholder="Descreva o trabalho que deve continuar neste mesmo contexto…" />
              </label>
              <div className="form-actions">
                <button type="button" className="secondary" disabled={busy} onClick={() => setDialog(null)}>Cancelar</button>
                <button className="primary" disabled={busy}>{busy ? "Criando…" : "Criar tarefa"}</button>
              </div>
            </form>
          )}
          {dialog.kind === "execute" && (
            <div className="task-detail">
              <span className="task-id">{dialog.task.id} · {projectName(dialog.task.projectId)}</span>
              <h3>{dialog.task.title}</h3>
              <p className="form-intro">
                Esta ação usa uma sessão já autenticada do provedor selecionado e executa o prompt no diretório-alvo. O resultado e os logs ficarão no histórico desta tarefa.
              </p>
              <label>
                Provedor
                <select value={executionProvider} onChange={(event) => setExecutionProvider(event.target.value as "auto" | "codex" | "antigravity")} disabled={busy}>
                  <option value="auto">Automático (recomendado)</option>
                  <option value="codex">Codex</option>
                  <option value="antigravity">Antigravity</option>
                </select>
              </label>
              <small>Push, merge, deploy, publicação e manipulação de credenciais continuam bloqueados neste fluxo.</small>
              <div className="form-actions">
                <button type="button" className="secondary" disabled={busy} onClick={() => setDialog(null)}>Cancelar</button>
                <button className="primary" disabled={busy} onClick={() => void mutate(() => client.executeTask(dialog.task.id, executionProvider), "Execução iniciada. O painel atualizará enquanto o provedor trabalha.")}>
                  <Play size={16} /> {busy ? "Iniciando…" : "Executar agora"}
                </button>
              </div>
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
                Aprovar devolve a tarefa à fila. Rejeitar a cancela.
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
                      "Proposta aprovada. A tarefa voltou à fila.",
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
