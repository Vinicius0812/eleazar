import {
  useCallback,
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
  Kanban,
  List,
  LayoutDashboard,
  ListTodo,
  Moon,
  Plus,
  Play,
  PanelLeftClose,
  PanelLeftOpen,
  PlugZap,
  RefreshCw,
  Search,
  ShieldCheck,
  Terminal,
  Sun,
  X,
} from "lucide-react";
import { LoadingOverlay } from "./components/LoadingOverlay.js";
import { Modal } from "./components/Modal.js";
import { ExecutionResultPage } from "./components/ExecutionResultPage.js";
import { ExecutionLaunchFields } from "./components/ExecutionLaunchFields.js";
import { useExecutionLaunch } from "./components/useExecutionLaunch.js";
import { PendingPermissions } from "./components/PendingPermissions.js";
import { TaskComposer } from "./components/TaskComposer.js";
import { TaskWorkspace } from "./components/TaskWorkspace.js";
import { TaskFollowUp } from "./components/TaskFollowUp.js";
import { TaskPublishing } from "./components/TaskPublishing.js";
import { TaskBoard } from "./components/TaskBoard.js";
import { AgentGlyph } from "./components/AgentGlyph.js";
import { ProvidersPage, providerState } from "./components/ProvidersPage.js";
import { placeTask } from "./services/board.js";
import markUrl from "./assets/icons/eleazar-mark.svg";
import type {
  Approval,
  ControlRoomClient,
  ControlRoomSnapshot,
  CreateTaskInput,
  ExecutionDetail,
  ProjectIsolation,
  ProviderStatus,
  LogEntry,
  Run,
  Task,
} from "./services/contracts.js";
import { priorityOrder } from "./services/contracts.js";
import { failureHint, readableRunSummary } from "./services/run-messages.js";
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
const isolationLabels: Record<ProjectIsolation, string> = { worktree: "Worktree por tarefa", direct: "Direto na pasta" };
const runStatuses = { ...statuses, planned: "Preparando" };
const navigation = [
  { id: "overview", label: "Visão geral", icon: LayoutDashboard },
  { id: "projects", label: "Projetos", icon: FolderGit2 },
  { id: "tasks", label: "Fila de tarefas", icon: ListTodo },
  { id: "executions", label: "Execuções", icon: Activity },
  { id: "approvals", label: "Aprovações", icon: ShieldCheck },
  { id: "providers", label: "Provedores", icon: PlugZap },
  { id: "logs", label: "Logs", icon: Terminal },
];
type DialogState =
  | { kind: "project" }
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
function routeId(hash: string, page: "executions" | "tasks"): string | null {
  const [section, id, ...remaining] = hash.replace(/^#\/?/, "").split("/");
  if (section !== page || !id || remaining.length) return null;
  try {
    return decodeURIComponent(id);
  } catch {
    return null;
  }
}
type PageRoute = "overview" | "projects" | "tasks" | "executions" | "approvals" | "providers" | "logs" | "not-found";
type Theme = "light" | "dark";

const narrowScreen = "(max-width: 760px)";

function preferredTheme(): Theme {
  const saved = window.localStorage.getItem("eleazar.theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function pageFromHash(hash: string): PageRoute {
  const value = hash.replace(/^#\/?/, "").split("/")[0] || "overview";
  return ["overview", "projects", "tasks", "executions", "approvals", "providers", "logs"].includes(value) ? value as PageRoute : "not-found";
}
function ExecutionFeedback({ run, latestLog }: { run: Run; latestLog?: LogEntry | undefined }) {
  const failed = run.status === "failed";
  return (
    <section className={`execution-feedback ${failed ? "error" : ""}`} aria-label="Resultado da última execução">
      <strong>{failed ? "Motivo da falha" : "Resultado da última execução"}</strong>
      <p className="execution-summary">{readableRunSummary(run.summary)}</p>
      {failed && <p className="execution-hint">{failureHint(run.summary, run.transport)}</p>}
      <dl>
        <div><dt>Provedor</dt><dd>{run.provider ?? "Não informado"}</dd></div>
        <div><dt>Encerrada</dt><dd>{run.finishedAt ? new Date(run.finishedAt).toLocaleString("pt-BR") : "Ainda em andamento"}</dd></div>
      </dl>
      {latestLog && <p className="execution-log"><strong>Último log:</strong> {latestLog.message}</p>}
    </section>
  );
}
function ProviderStatusPanel({ providers, loading, error, onRefresh }: { providers: ProviderStatus[]; loading: boolean; error: string; onRefresh(): void }) {
  return <Panel id="provider-summary" title="Provedores" eyebrow="CAPACIDADE LOCAL" action={<button className="text-button" onClick={onRefresh} disabled={loading}><RefreshCw size={14} className={loading ? "spinning" : ""} /> Atualizar status</button>}>
    {error && <div className="provider-note error">{error}</div>}
    <div className="provider-list">
      {providers.map((provider) => <article className="provider-row" key={provider.provider}>
        <span className={`provider-symbol ${provider.available ? "available" : "unavailable"}`}><AgentGlyph provider={provider.provider} /></span>
        <div><strong>{provider.label}</strong><small>{providerState(provider).label}</small></div>
        <div className="provider-usage">
          {provider.usage.usedPercent !== null ? <><strong>{provider.usage.usedPercent}% usado</strong><progress className="provider-progress" max={100} value={provider.usage.usedPercent} aria-label={`Uso do ${provider.label}`} /><small>{provider.usage.resetAt ? `Reset: ${new Date(provider.usage.resetAt).toLocaleString("pt-BR")}` : "Reset não informado"}</small></> : provider.usage.totalTokens !== null ? <><strong>{provider.usage.totalTokens.toLocaleString("pt-BR")} tokens</strong><small>Uso observado no Eleazar</small></> : <><strong>Sem consumo disponível</strong><small>Não informado pelo provedor</small></>}
        </div>
      </article>)}
      {!providers.length && !loading && <div className="empty">Nenhum provedor respondeu ao diagnóstico local.</div>}
    </div>
    <p className="provider-note"><a className="text-button" href="#/providers">Gerenciar provedores <ArrowRight size={14} aria-hidden="true" /></a></p>
    {providers[0] && <p className="provider-note">Dados atualizados em {new Date(providers[0].fetchedAt).toLocaleString("pt-BR")}. O saldo é exibido apenas quando o provedor o informa.</p>}
  </Panel>;
}
export function App({ client }: { client: ControlRoomClient }) {
  const [data, setData] = useState<ControlRoomSnapshot | null>(null);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  // A success notice belongs to the route it was raised on (or navigated to by the same action)
  // and is hidden once the route changes. Errors are separate state and are never hidden by this.
  const [noticeState, setNoticeState] = useState({ text: "", hash: "" });
  const setNotice = (text: string) => setNoticeState({ text, hash: window.location.hash });
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [projectFilter, setProjectFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [logLevel, setLogLevel] = useState("all");
  const [taskView, setTaskView] = useState<"board" | "list">(() => window.localStorage.getItem("eleazar.taskView") === "list" ? "list" : "board");
  useEffect(() => { window.localStorage.setItem("eleazar.taskView", taskView); }, [taskView]);
  const [hash, setHash] = useState(() => window.location.hash);
  const notice = noticeState.hash === hash ? noticeState.text : "";
  // Discard (not just hide) a notice from a previous route so it cannot reappear on return.
  useEffect(() => { setNoticeState((current) => current.hash === hash ? current : { text: "", hash: "" }); }, [hash]);
  const active = pageFromHash(hash);
  const executionRoute = routeId(hash, "executions");
  const taskRoute = routeId(hash, "tasks");
  const [projectDirectories, setProjectDirectories] = useState([{ name: "", path: "" }]);
  const [executionDetail, setExecutionDetail] = useState<ExecutionDetail | null>(null);
  const [executionLoading, setExecutionLoading] = useState(false);
  const [executionError, setExecutionError] = useState("");
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providersError, setProvidersError] = useState("");
  const [providerPending, setProviderPending] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(narrowScreen).matches ?? false);
  const [narrowCollapsed, setNarrowCollapsed] = useState(true);
  const [desktopCollapsed, setDesktopCollapsed] = useState(() => window.localStorage.getItem("eleazar.sidebarCollapsed") === "true");
  const collapsed = narrow ? narrowCollapsed : desktopCollapsed;
  const [theme, setTheme] = useState<Theme>(preferredTheme);
  const focusTrigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!dialog && !busy && focusTrigger.current) {
      if (focusTrigger.current.isConnected) focusTrigger.current.focus();
      else (document.getElementById("task-workspace-title") ?? document.getElementById("approvals-title"))?.focus();
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
    const onHashChange = () => {
      setHash(window.location.hash);
      setNarrowCollapsed(true);
    };
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
  useEffect(() => {
    const media = window.matchMedia?.(narrowScreen);
    function onResize(event: MediaQueryListEvent) {
      setNarrow(event.matches);
      if (event.matches) setNarrowCollapsed(true);
    }
    media?.addEventListener?.("change", onResize);
    return () => media?.removeEventListener?.("change", onResize);
  }, []);
  useEffect(() => { window.localStorage.setItem("eleazar.sidebarCollapsed", String(desktopCollapsed)); }, [desktopCollapsed]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("eleazar.theme", theme);
  }, [theme]);
  useEffect(() => {
    if (active !== "overview" && active !== "providers" && dialog?.kind !== "execute") return;
    let alive = true;
    setProvidersLoading(true); setProvidersError("");
    client.getProviderStatuses().then((items) => { if (alive) setProviders(items); }).catch((reason) => { if (alive) setProvidersError(message(reason)); }).finally(() => { if (alive) setProvidersLoading(false); });
    return () => { alive = false; };
  }, [active, client, dialog?.kind]);
  const launch = useExecutionLaunch(client, data?.runs ?? [], data?.tasks ?? [], dialog?.kind === "execute" ? dialog.task : null, providers);
  const refreshSession = useCallback(() => {
    void client.getSnapshot().then(setData).catch(() => undefined);
    if (executionRoute) void client.getExecutionDetail(executionRoute).then((detail) => setExecutionDetail((current) => current?.execution.id === detail.execution.id ? detail : current)).catch(() => undefined);
  }, [client, executionRoute]);
  const hasLiveTask =data?.tasks.some((task) => task.status === "planning" || task.status === "running") ?? false;
  // The host re-reads open pull requests on its own; a slower poll keeps the board in step with CI and reviews.
  const hasOpenPullRequest = data?.pullRequests?.some((item) => item.state === "open") ?? false;
  const pollMs = hasLiveTask ? 2_000 : 15_000;
  useEffect(() => {
    if (!hasLiveTask && !hasOpenPullRequest) return;
    let alive = true;
    let timer: number;
    async function poll() {
      try {
        const snapshot = await client.getSnapshot();
        if (alive) {
          setData(snapshot);
          setError("");
        }
      } catch (reason) {
        if (alive) setError(message(reason));
      }
      if (alive) timer = window.setTimeout(poll, pollMs);
    }
    timer = window.setTimeout(poll, pollMs);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [client, hasLiveTask, hasOpenPullRequest, pollMs, data?.tasks]);
  function open(next: DialogState) {
    focusTrigger.current = document.activeElement as HTMLElement | null;
    setFormError("");
    if (next?.kind === "project") setProjectDirectories([{ name: "", path: "" }]);
    if (next?.kind === "execute") launch.reset();
    setDialog(next);
  }
  function navigate(next: PageRoute): void { window.location.hash = `/${next === "not-found" ? "overview" : next}`; }
  function openExecution(executionId: string) { window.location.hash = `/executions/${encodeURIComponent(executionId)}`; }
  function openTask(taskId: string) { window.location.hash = `/tasks/${encodeURIComponent(taskId)}`; }
  function backToDashboard() { navigate("overview"); }
  function refreshProviders(): void { setProvidersLoading(true); setProvidersError(""); client.getProviderStatuses(true).then(setProviders).catch((reason) => setProvidersError(message(reason))).finally(() => setProvidersLoading(false)); }
  async function changeProvider(provider: string, operation: () => Promise<ProviderStatus[]>) {
    setProviderPending(provider); setProvidersError("");
    try { setProviders(await operation()); }
    catch (reason) { setProvidersError(message(reason)); }
    finally { setProviderPending(null); }
  }
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      // Pull requests live on GitHub; a manual refresh asks for their current CI and review state too.
      const forge = await client.refreshPullRequests().catch(() => null);
      setData(await client.getSnapshot());
      setNotice(forge?.warnings[0] ? `Painel atualizado. Pull requests não foram lidos: ${forge.warnings[0]}` : "Painel atualizado.");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  async function mutate<Result>(operation: () => Promise<Result>, success: string, onSuccess?: (result: Result) => void) {
    setBusy(true);
    setFormError("");
    setNotice("");
    try {
      const result = await operation();
      setDialog(null);
      try {
        setData(await client.getSnapshot());
        setError("");
      } catch {
        setError(
          "A ação foi concluída, mas o painel não pôde ser atualizado. Use Atualizar para carregar o estado atual.",
        );
      }
      onSuccess?.(result);
      // After onSuccess so a navigation it starts is already in location.hash and keeps the notice.
      setNotice(success);
    } catch (reason) {
      setFormError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  /**
   * Creating a worktree can take minutes. Once the host has claimed the task, its own screen shows the
   * progress and the Cancel button, so the dialog must not stay in front of it.
   */
  async function untilPreparing(taskId: string, request: Promise<unknown>): Promise<void> {
    let settled = false;
    const finished = request.finally(() => { settled = true; });
    const preparing = (async () => {
      while (!settled) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        if (settled) break;
        const snapshot = await client.getSnapshot().catch(() => null);
        if (snapshot?.tasks.find((task) => task.id === taskId)?.status === "planning") return;
      }
      await finished;
    })();
    // A later failure reaches the task screen through the execution itself.
    preparing.catch(() => undefined);
    await Promise.race([finished, preparing]);
  }
  function submitProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void mutate(
      () =>
        client.registerProject({
          name: String(fields.get("name")),
          directories: projectDirectories,
          isolation: fields.get("isolation") === "direct" ? "direct" : "worktree",
        }),
      "Projeto cadastrado. Ele já está disponível para novas tarefas.",
    );
  }
  function submitTask(input: CreateTaskInput) {
    void mutate(() => client.createTask(input), "Tarefa criada.", (task) => {
      setProjectFilter(task.projectId);
      setQuery("");
      openTask(task.id);
    });
  }
  function submitRelatedTask(event: FormEvent<HTMLFormElement>, task: Task) {
    event.preventDefault();
    const targetDirectoryId = task.targetDirectoryId ?? task.directoryIds[0];
    if (!targetDirectoryId) { setFormError("A tarefa original não possui um diretório válido para herdar."); return; }
    const fields = new FormData(event.currentTarget);
    void mutate(
      () => client.createTask({ projectId: task.projectId, targetDirectoryId, directoryIds: task.directoryIds.length ? task.directoryIds : [targetDirectoryId], title: String(fields.get("title")), prompt: String(fields.get("prompt")), priority: task.priority, kind: task.kind }),
      "Tarefa relacionada criada com o mesmo contexto.",
      (related) => openTask(related.id),
    );
  }
  const projects = data?.projects ?? [];
  const tasks = data?.tasks ?? [];
  const approvals = data?.approvals ?? [];
  const selectedTask = tasks.find((task) => task.id === taskRoute);
  const selectedApproval = approvals.find((approval) => approval.taskId === selectedTask?.id);
  const taskViewHeading = useRef<HTMLHeadingElement>(null);
  const taskViewReady = taskRoute !== null && data !== null;
  useEffect(() => {
    if (taskViewReady) taskViewHeading.current?.focus();
  }, [taskRoute, taskViewReady, selectedTask?.id]);
  useEffect(() => { setFormError(""); }, [taskRoute]);
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
  const nextTasks = filteredTasks.filter((task) => task.status === "queued");
  const projectName = (id: string) =>
    projects.find((project) => project.id === id)?.name ??
    "Projeto indisponível";
  const directoryName = (task: Task) => projects.find((project) => project.id === task.projectId)?.directories.find((directory) => directory.id === task.targetDirectoryId)?.name ?? "Diretório indisponível";
  const directoryNames = (task: Task) => projects.find((project) => project.id === task.projectId)?.directories.filter((directory) => task.directoryIds.includes(directory.id)).map((directory) => directory.name).join(", ") ?? "Diretório indisponível";
  const latestRunForTask = (taskId: string) => data?.runs.find((run) => run.taskId === taskId);
  const latestLogForRun = (runId: string) => data?.logs.filter((log) => log.executionId === runId).at(-1);
  const selectedRun = selectedTask && latestRunForTask(selectedTask.id);
  // Runs come newest first; a conversation reads oldest first. The newest one is the turn already on screen.
  const selectedPreviousRuns = selectedTask ? (data?.runs ?? []).filter((run) => run.taskId === selectedTask.id).slice(1).reverse() : [];
  const placed = (task: Task) => placeTask(task, data?.runs ?? [], data?.actions ?? [], data?.pullRequests ?? []);
  const projectsWithTasks = projects.map((project) => ({ project, cards: tasks.filter((task) => task.projectId === project.id).map(placed) }));
  const selectedActions = selectedTask ? (data?.actions ?? []).filter((action) => action.taskId === selectedTask.id) : [];
  const selectedTaskFinished = selectedTask?.status === "completed" || selectedTask?.status === "failed";
  const pageTitle: Record<Exclude<PageRoute, "not-found">, [string, string]> = {
    overview: ["Sala de controle", "Acompanhe o trabalho. Direcione o próximo passo."], projects: ["Projetos", "Cadastre e acompanhe os diretórios do workspace."], tasks: ["Fila de tarefas", "Priorize, execute e acompanhe o próximo trabalho."], executions: ["Execuções", "Consulte as tentativas e seus resultados persistidos."], approvals: ["Aprovações", "Decisões que precisam da sua intervenção."], providers: ["Provedores", "Conecte a sua conta em cada agente e escolha quem participa do Automático."], logs: ["Logs", "Atividade recente registrada pelo núcleo local."]
  };
  return (
    <div className={`shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      <a className="skip-link" href="#main" onClick={(event) => { event.preventDefault(); document.getElementById("main")?.focus(); }}>
        Ir para o conteúdo
      </a>
      <aside className="sidebar">
        <div className="sidebar-heading">
          <a className="brand" href="#/overview" aria-label="Eleazar · Visão geral" title="Eleazar · Visão geral">
            <span className="brand-symbol" style={{ backgroundImage: `url("${markUrl}")` }} aria-hidden="true" />
            <span>Eleazar</span>
          </a>
          <button className="sidebar-toggle" type="button" aria-label={collapsed ? "Expandir menu" : "Recolher menu"} aria-expanded={!collapsed} onClick={() => (narrow ? setNarrowCollapsed : setDesktopCollapsed)((value) => !value)}>{collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</button>
        </div>
        <a className="sidebar-new" href="#/tasks/new" aria-label="Nova tarefa" aria-current={taskRoute === "new" ? "page" : undefined} title="Nova tarefa">
          <Plus size={19} aria-hidden="true" />
          <span>Nova tarefa</span>
        </a>
        <nav aria-label="Navegação principal">
          {navigation.map((item) => (
            <a
              key={item.id}
              href={`#/${item.id}`}
              className={active === item.id ? "active" : ""}
              aria-current={active === item.id ? "location" : undefined}
              aria-label={item.label}
              title={collapsed ? item.label : undefined}
            >
              <item.icon size={17} aria-hidden="true" />
              <span>{item.label}</span>
              {item.id === "approvals" && approvals.length > 0 && (
                <b className="nav-count">{approvals.length}</b>
              )}
            </a>
          ))}
        </nav>
        {projectsWithTasks.length > 0 && (
          <nav className="sidebar-projects" aria-label="Projetos e tarefas">
            <span className="sidebar-section">Projetos</span>
            {projectsWithTasks.map(({ project, cards }) => (
              <div key={project.id} className="sidebar-project">
                <span className="sidebar-project-name" title={project.name}><FolderGit2 size={15} aria-hidden="true" /> <span>{project.name}</span></span>
                {cards.filter((card) => card.place !== "archive").slice(0, 6).map(({ task, place, fact }) => (
                  <a key={task.id} href={`#/tasks/${encodeURIComponent(task.id)}`} aria-current={taskRoute === task.id ? "page" : undefined} title={`${task.title} · ${fact}`}>
                    <span className={`lane-dot lane-${place}`} aria-hidden="true" />
                    <span>{task.title}</span>
                  </a>
                ))}
              </div>
            ))}
          </nav>
        )}
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
        </div>
      </aside>
      <div className="content">
        <header className="topbar">
          <div>
            Workspace <ChevronRight size={14} />
            <strong>{active === "not-found" ? "Página não encontrada" : navigation.find((item) => item.id === active)?.label ?? "Resultado da execução"}</strong>
          </div>
        </header>
        {executionRoute ? <ExecutionResultPage client={client} onSessionChanged={refreshSession} detail={executionDetail} loading={executionLoading} error={executionError} onBack={backToDashboard} onSelect={openExecution} onCreateRelated={(task) => open({ kind: "related", task })} /> : <main id="main" className="loading-host" tabIndex={-1}>
           {busy && !dialog && data && <LoadingOverlay label="Aguarde…" />}
           {taskRoute ? (
             <section className="task-workspace" aria-labelledby="task-workspace-title">
               <header className="task-workspace-heading">
                 <span className="eyebrow">{selectedTask ? projectName(selectedTask.projectId) : "Tarefas"}</span>
                 <h1 id="task-workspace-title" ref={taskViewHeading} tabIndex={-1}>{taskRoute === "new" ? "O que você quer fazer?" : selectedTask?.title ?? "Tarefa"}</h1>
               </header>
               <div className="feedback" role="status">{notice}</div>
               {error && <div className="error" role="alert">{error} <button className="text-button" disabled={busy} onClick={() => void refresh()}>Atualizar</button></div>}
               {!data ? (
                 !error && <div className="loading-area page"><LoadingOverlay label="Carregando tarefas…" /></div>
               ) : taskRoute === "new" ? (
                 <TaskComposer projects={projects} initialProjectId={projectFilter} busy={busy} error={formError} onSubmit={submitTask} onRegisterProject={() => open({ kind: "project" })} />
               ) : selectedTask ? (
                 <TaskWorkspace
                   client={client}
                   onSessionChanged={refreshSession}
                   task={selectedTask}
                   statusLabel={statuses[selectedTask.status]}
                   projectName={projectName(selectedTask.projectId)}
                   directoryName={directoryName(selectedTask)}
                   scopeNames={directoryNames(selectedTask)}
                   run={selectedRun}
                  previousRuns={selectedPreviousRuns}
                   latestLog={selectedRun && latestLogForRun(selectedRun.id)}
                   failure={selectedTask.status === "failed" && selectedRun ? readableRunSummary(selectedRun.summary) : undefined}
                   followUp={selectedTaskFinished && selectedRun ? <TaskFollowUp busy={busy} resumesSession={selectedRun.transport === "acp" && Boolean(selectedRun.sessionId)}
                     onSend={(prompt) => void mutate(() => client.sendTaskMessage(selectedTask.id, prompt), "Mensagem enviada ao agente.")} /> : undefined}
                   publishing={selectedTask.branch ? <TaskPublishing task={selectedTask} actions={selectedActions} busy={busy} pullRequests={(data?.pullRequests ?? []).filter((item) => item.taskId === selectedTask.id)}
                     onRefreshPullRequests={() => void mutate(async () => { const result = await client.refreshPullRequests(selectedTask.id); if (result.warnings[0]) throw new Error(result.warnings[0]); return result; }, "Pull request atualizado.")} locked={!selectedTaskFinished}
                     onRequest={(input) => void mutate(() => client.requestTaskAction(selectedTask.id, input), "Ação registrada. Revise o que será feito e aprove para executar.")}
                     onDecide={(actionId, decision) => void mutate(() => client.decideTaskAction(actionId, decision), decision === "approve" ? "Ação aprovada; confira o resultado abaixo." : "Ação rejeitada.")}
                     onRemoveWorktree={() => void mutate(() => client.removeTaskWorktrees(selectedTask.id), "Worktree removida; a branch foi mantida.")} /> : undefined}
                   actions={<>
                     {selectedRun && <button className="secondary" onClick={() => openExecution(selectedRun.id)}>{selectedTask.status === "queued" ? "Ver última tentativa" : "Ver detalhes da execução"}</button>}
                     {selectedTask.status === "queued" && <button className="primary" disabled={busy} onClick={() => open({ kind: "execute", task: selectedTask })}><Play size={16} aria-hidden="true" /> Executar tarefa</button>}
                     {selectedApproval && selectedTask.status === "waiting_approval" && <button className="primary" disabled={busy} onClick={() => open({ kind: "approval", approval: selectedApproval })}><ShieldCheck size={16} aria-hidden="true" /> Revisar aprovação</button>}
                     {selectedTask.status === "failed" && <button className="primary" disabled={busy} onClick={() => void mutate(() => client.retryTask(selectedTask.id), "Tarefa reenfileirada.")}><RefreshCw size={16} aria-hidden="true" /> {busy ? "Reenfileirando…" : "Reenfileirar tarefa"}</button>}
                     {selectedTask.status === "completed" && <button className="primary" disabled={busy} onClick={() => open({ kind: "related", task: selectedTask })}><Plus size={16} aria-hidden="true" /> Criar tarefa relacionada</button>}
                   </>}
                 />
               ) : (
                 <div className="empty">Tarefa não encontrada. <a className="text-button" href="#/tasks">Voltar à fila</a></div>
               )}
               {formError && !dialog && taskRoute !== "new" && <div className="error" role="alert">{formError}</div>}
             </section>
           ) : active === "not-found" ? <section className="route-not-found"><div className="eyebrow">ROTA LOCAL</div><h1>Página não encontrada</h1><p>Essa rota não faz parte da Control Room.</p><button className="primary" onClick={() => navigate("overview")}>Voltar à visão geral</button></section> : <>
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
            error
              ? <div className="empty">O painel está indisponível. Tente atualizar novamente.</div>
              : <div className="loading-area page"><LoadingOverlay label="Carregando sala de controle…" /></div>
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
              {active === "providers" ? <ProvidersPage providers={providers} loading={providersLoading} error={providersError} pending={providerPending} onRefresh={refreshProviders}
                onVerify={(provider) => void changeProvider(provider, () => client.verifyProvider(provider))}
                onChange={(provider, patch) => void changeProvider(provider, () => client.updateProvider(provider, patch))} /> :
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
                        {nextTasks.slice(0, 4).map((task) => (
                           <button className="executive-row" key={task.id} onClick={() => openTask(task.id)}>
                            <span className={`priority ${task.priority}`}><span className="dot" />{priorities[task.priority]}</span>
                            <span className="executive-row-copy"><strong>{task.title}</strong><small>{projectName(task.projectId)} · {directoryName(task)}</small></span>
                            <span className={`status ${task.status}`}>{statuses[task.status]}</span>
                            <ChevronRight size={17} />
                          </button>
                        ))}
                        {!nextTasks.length && <div className="empty">Nenhuma tarefa pendente. Crie a próxima etapa quando estiver pronto.</div>}
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
                             <span className={`status ${run.status}`}>{runStatuses[run.status]}</span>
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
                        <div className="project-item" key={project.id}>
                        <button
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
                        {project.directories.every((directory) => directory.isGitRepository) && <label className="project-isolation">
                          Onde o agente trabalha
                          <select value={project.isolation} disabled={busy} aria-label={`Onde o agente trabalha em ${project.name}`}
                            onChange={(event) => { const isolation = event.target.value as ProjectIsolation; void mutate(() => client.updateProjectIsolation(project.id, isolation), `${project.name}: as próximas execuções usarão "${isolationLabels[isolation]}".`); }}>
                            <option value="worktree">{isolationLabels.worktree}</option>
                            <option value="direct">{isolationLabels.direct}</option>
                          </select>
                        </label>}
                        </div>
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
                      <div className="view-toggle" role="group" aria-label="Visualização das tarefas">
                        <button type="button" aria-pressed={taskView === "board"} onClick={() => setTaskView("board")}><Kanban size={14} aria-hidden="true" /> Quadro</button>
                        <button type="button" aria-pressed={taskView === "list"} onClick={() => setTaskView("list")}><List size={14} aria-hidden="true" /> Lista</button>
                      </div>
                    </div>
                    {taskView === "board" && filteredTasks.length > 0 && (
                      <TaskBoard cards={filteredTasks.map(placed)} busy={busy} location={(task) => task.branch ?? directoryName(task)}
                        onOpen={openTask} onExecute={(task) => { openTask(task.id); open({ kind: "execute", task }); }} />
                    )}
                    {taskView === "list" && <div className="table-wrap">
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
                                   onClick={() => openTask(task.id)}
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
                                   <button className="text-button" aria-label={`Executar ${task.title}`} disabled={busy} onClick={() => { openTask(task.id); open({ kind: "execute", task }); }}>
                                    <Play size={14} /> Executar
                                  </button>
                                ) : task.status === "failed" ? (
                                   <button className="text-button danger" aria-label={`Ver erro de ${task.title}`} onClick={() => openTask(task.id)}>
                                    Ver erro
                                  </button>
                                ) : task.status === "completed" && latestRunForTask(task.id) ? (
                                  <button className="text-button" aria-label={`Ver resultado de ${task.title}`} onClick={() => openExecution(latestRunForTask(task.id)!.id)}>
                                    Ver resultado
                                  </button>
                                ) : (
                                   <button className="icon-button" aria-label={`Ver ${task.title}`} onClick={() => openTask(task.id)}>
                                    <ChevronRight size={17} />
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>}
                    {!filteredTasks.length && (
                      <div className="empty">
                        {tasks.length
                          ? "Nenhuma tarefa corresponde aos filtros."
                          : "Sua fila está vazia. Crie uma nova tarefa."}
                      </div>
                    )}
                    <div className="panel-footer">
                      <span>{taskView === "board" ? "Raias definidas pelo estado da tarefa, da execução e das publicações" : "Ordenadas por prioridade e data de criação"}</span>
                      <span>
                        <Clock3 size={13} /> Estado atual
                      </span>
                    </div>
                  </Panel>}
                  {active === "executions" &&
                  <Panel
                    id="runs"
                     title="Histórico de execuções"
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
                             <span className={`status ${run.status}`}>{runStatuses[run.status]}</span>
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
                       <div className="empty">Ainda não há execuções registradas.</div>
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
                      <PendingPermissions client={client} runs={data.runs} tasks={tasks} projectName={projectName} onOpen={openExecution} />
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
                        <span>Nenhuma aprovação de escopo pendente.</span>
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
              </div>}
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
               : dialog.kind === "execute"
                 ? "Executar tarefa"
                 : dialog.kind === "related"
                   ? "Criar tarefa relacionada"
                   : "Revisar aprovação"
          }
          onClose={() => setDialog(null)}
          busy={busy}
        >
          {busy && <LoadingOverlay label="Aguarde…" />}
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
              <label>
                Onde o agente trabalha
                {/* A machine tends to work one way, so the last project's choice is the starting point. */}
                <select name="isolation" defaultValue={projects[0]?.isolation ?? "worktree"}>
                  <option value="worktree">{isolationLabels.worktree}</option>
                  <option value="direct">{isolationLabels.direct}</option>
                </select>
                <small>Direto na pasta altera os seus arquivos, sem branch própria, e roda uma tarefa por vez em cada pasta. A worktree só vale para repositórios Git.</small>
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
                A execução usa uma sessão já autenticada do provedor. O resultado e os logs ficarão no histórico desta tarefa.
              </p>
              {providersError && <div className="error" role="alert">Não foi possível consultar os provedores: {providersError}</div>}
              <ExecutionLaunchFields launch={launch} busy={busy} />
              <div className="form-actions">
                <button type="button" className="secondary" disabled={busy} onClick={() => setDialog(null)}>Cancelar</button>
                <button className="primary" disabled={busy} onClick={() => void mutate(() => {
                  const options = launch.options();
                  return untilPreparing(dialog.task.id, Object.keys(options).length ? client.executeTask(dialog.task.id, launch.provider, options) : client.executeTask(dialog.task.id, launch.provider));
                }, "Execução iniciada. O painel atualizará enquanto o provedor trabalha.")}>
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
