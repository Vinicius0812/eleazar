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
  BellOff,
  Keyboard,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  FolderGit2,
  FolderTree,
  GitBranch,
  GitCompare,
  Inbox,
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
  RotateCcw,
  Search,
  ShieldCheck,
  Terminal,
  Sun,
  X,
} from "lucide-react";
import { LoadingOverlay } from "./components/LoadingOverlay.js";
import { Modal } from "./components/Modal.js";
import { ExecutionResultPage } from "./components/ExecutionResultPage.js";
import { FileExplorerPage, fileExplorerHash, fileExplorerRoute } from "./components/FileExplorerPage.js";
import { ExecutionLaunchFields } from "./components/ExecutionLaunchFields.js";
import { useExecutionLaunch } from "./components/useExecutionLaunch.js";
import { PendingPermissions } from "./components/PendingPermissions.js";
import { TaskComposer } from "./components/TaskComposer.js";
import { TaskWorkspace } from "./components/TaskWorkspace.js";
import { TaskTabs, taskPublishRoute } from "./components/TaskTabs.js";
import { ComparisonPage, comparisonRoute } from "./components/ComparisonPage.js";
import { ProjectPage, projectHash, projectRoute } from "./components/ProjectPage.js";
import { TaskFollowUp } from "./components/TaskFollowUp.js";
import { TaskPublishing } from "./components/TaskPublishing.js";
import { TaskBoard } from "./components/TaskBoard.js";
import { AgentGlyph } from "./components/AgentGlyph.js";
import { CommandPalette, type CommandItem } from "./components/CommandPalette.js";
import { ProvidersPage, providerState, quotaStateLabel } from "./components/ProvidersPage.js";
import { placeTask } from "./services/board.js";
import { needsYou } from "./services/inbox.js";
import { NeedsYouInbox } from "./components/NeedsYouInbox.js";
import { resolveShortcut, shortcutList, type ShortcutAction } from "./services/shortcuts.js";
import { notificationSupport, notificationsBetween, showNotifications } from "./services/notifications.js";
import markUrl from "./assets/icons/eleazar-mark.svg";
import type {
  Approval,
  ControlRoomClient,
  ControlRoomSnapshot,
  CreateTaskInput,
  ExecutionDetail,
  ProjectIsolation,
  ProviderStatus,
  TaskTemplate,
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
// Grouped by what the operator came to do: act on work, look back at it, or set things up.
const navigation = [
  { id: "inbox", label: "Precisa de você", icon: Inbox, group: "Trabalho" },
  { id: "overview", label: "Visão geral", icon: LayoutDashboard, group: "Trabalho" },
  { id: "tasks", label: "Fila de tarefas", icon: ListTodo, group: "Trabalho" },
  { id: "approvals", label: "Aprovações", icon: ShieldCheck, group: "Trabalho" },
  { id: "executions", label: "Execuções", icon: Activity, group: "Histórico" },
  { id: "logs", label: "Logs", icon: Terminal, group: "Histórico" },
  { id: "projects", label: "Projetos", icon: FolderGit2, group: "Configuração" },
  { id: "providers", label: "Provedores", icon: PlugZap, group: "Configuração" },
];
const navigationGroups = [...new Set(navigation.map((item) => item.group))];
const sidebarTaskLimit = 6;
type Crumb = { label: string; href?: string; onClick?: () => void };
function readCollapsedProjects(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem("eleazar.collapsedProjects") ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
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
type PageRoute = "overview" | "inbox" | "projects" | "tasks" | "executions" | "approvals" | "providers" | "logs" | "not-found";
type Theme = "light" | "dark";

const narrowScreen = "(max-width: 760px)";

function preferredTheme(): Theme {
  const saved = window.localStorage.getItem("eleazar.theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function pageFromHash(hash: string): PageRoute {
  const value = hash.replace(/^#\/?/, "").split("/")[0] || "overview";
  return ["overview", "inbox", "projects", "tasks", "executions", "approvals", "providers", "logs"].includes(value) ? value as PageRoute : "not-found";
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
          {provider.usage.quota ? <><strong>{provider.usage.quota.usedPercent.toLocaleString("pt-BR")}% da cota</strong><progress className={`provider-progress ${provider.usage.quota.state}`} max={100} value={Math.min(provider.usage.quota.usedPercent, 100)} aria-label={`Cota do ${provider.label}`} /><small>{quotaStateLabel[provider.usage.quota.state]}</small></> : provider.usage.usedPercent !== null ? <><strong>{provider.usage.usedPercent}% usado</strong><progress className="provider-progress" max={100} value={provider.usage.usedPercent} aria-label={`Uso do ${provider.label}`} /><small>{provider.usage.resetAt ? `Reset: ${new Date(provider.usage.resetAt).toLocaleString("pt-BR")}` : "Reset não informado"}</small></> : provider.usage.totalTokens !== null ? <><strong>{provider.usage.totalTokens.toLocaleString("pt-BR")} tokens</strong><small>Uso observado no Eleazar</small></> : <><strong>Sem consumo disponível</strong><small>Não informado pelo provedor</small></>}
        </div>
      </article>)}
      {!providers.length && !loading && <div className="empty">Nenhum provedor respondeu ao diagnóstico local.</div>}
    </div>
    <p className="provider-note">O Automático evita quem passou de 80% da cota e pula quem a esgotou. <a className="text-button" href="#/providers">Gerenciar provedores <ArrowRight size={14} aria-hidden="true" /></a></p>
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
  const publishRoute = taskPublishRoute(hash);
  const taskRoute = routeId(hash, "tasks") ?? publishRoute;
  const filesRoute = fileExplorerRoute(hash);
  const comparisonId = comparisonRoute(hash);
  const projectView = projectRoute(hash);
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>(readCollapsedProjects);
  useEffect(() => { window.localStorage.setItem("eleazar.collapsedProjects", JSON.stringify(collapsedProjects)); }, [collapsedProjects]);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [notificationsOn, setNotificationsOn] = useState(() => window.localStorage.getItem("eleazar.notifications") === "on" && notificationSupport() === "granted");
  useEffect(() => { window.localStorage.setItem("eleazar.notifications", notificationsOn ? "on" : "off"); }, [notificationsOn]);
  // Rebuilt every render so the handler sees the current route; the listener itself is added once.
  const onShortcut = useRef<(action: ShortcutAction) => void>(() => undefined);
  const blocksShortcuts = useRef(false);
  useEffect(() => {
    let pending = false;
    let pendingTimer: number | undefined;
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((value) => !value);
        return;
      }
      if (event.defaultPrevented || blocksShortcuts.current) { pending = false; return; }
      const resolved = resolveShortcut(event, pending);
      pending = resolved.pending;
      window.clearTimeout(pendingTimer);
      // A "G" that is not followed by another key soon is forgotten.
      if (pending) pendingTimer = window.setTimeout(() => { pending = false; }, 1_500);
      if (!resolved.action) return;
      event.preventDefault();
      onShortcut.current(resolved.action);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); window.clearTimeout(pendingTimer); };
  }, []);
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
    if (active !== "overview" && active !== "providers" && dialog?.kind !== "execute" && taskRoute !== "new") return;
    let alive = true;
    setProvidersLoading(true); setProvidersError("");
    client.getProviderStatuses().then((items) => { if (alive) setProviders(items); }).catch((reason) => { if (alive) setProvidersError(message(reason)); }).finally(() => { if (alive) setProvidersLoading(false); });
    return () => { alive = false; };
  }, [active, client, dialog?.kind, taskRoute === "new"]);
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const composing = taskRoute === "new";
  useEffect(() => {
    if (!composing) return;
    let alive = true;
    client.listTemplates().then((items) => { if (alive) setTemplates(items); }).catch(() => undefined);
    return () => { alive = false; };
  }, [client, composing]);
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
  const previousFacts = useRef<ControlRoomSnapshot | null>(null);
  useEffect(() => {
    if (!data) return;
    const previous = previousFacts.current;
    previousFacts.current = data;
    // Only while the operator is elsewhere: on screen, the page itself already shows the change.
    if (!notificationsOn || (document.visibilityState === "visible" && document.hasFocus())) return;
    showNotifications(notificationsBetween(previous, data));
  }, [data, notificationsOn]);
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
  function showProjectTasks(projectId: string) { setProjectFilter(projectId); setQuery(""); navigate("tasks"); }
  function toggleProject(projectId: string) { setCollapsedProjects((current) => current.includes(projectId) ? current.filter((id) => id !== projectId) : [...current, projectId]); }
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
  function submitComparison(input: CreateTaskInput, rivals: string[]) {
    void mutate(() => client.startComparison(input, rivals), "Os agentes estão trabalhando, cada um na própria branch. Acompanhe a comparação aqui.", (started) => {
      setProjectFilter(input.projectId);
      window.location.hash = `/comparisons/${encodeURIComponent(started.comparisonId)}`;
      if (started.errors[0]) setError(`Uma das tentativas não começou e ficou na fila: ${started.errors[0].error}`);
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
  const inbox = data ? needsYou(data) : [];
  const pendingPublications = (taskId: string) => (data?.actions ?? []).filter((action) => action.taskId === taskId && action.status === "pending").length;
  const selectedActions = selectedTask ? (data?.actions ?? []).filter((action) => action.taskId === selectedTask.id) : [];
  const selectedTaskFinished = selectedTask?.status === "completed" || selectedTask?.status === "failed";
  const pageTitle: Record<Exclude<PageRoute, "not-found">, [string, string]> = {
    overview: ["Sala de controle", "Acompanhe o trabalho. Direcione o próximo passo."], inbox: ["Precisa de você", "Tudo o que espera uma decisão sua, em todos os projetos."], projects: ["Projetos", "Cadastre e acompanhe os diretórios do workspace."], tasks: ["Fila de tarefas", "Priorize, execute e acompanhe o próximo trabalho."], executions: ["Execuções", "Consulte as tentativas e seus resultados persistidos."], approvals: ["Aprovações", "Decisões que precisam da sua intervenção."], providers: ["Provedores", "Conecte a sua conta em cada agente e escolha quem participa do Automático."], logs: ["Logs", "Atividade recente registrada pelo núcleo local."]
  };
  const commandItems: CommandItem[] = [
    { id: "action-new-task", group: "Ações", label: "Nova tarefa", hint: "Descrever o que fazer", icon: Plus, run: () => { window.location.hash = "/tasks/new"; } },
    { id: "action-new-project", group: "Ações", label: "Cadastrar projeto", hint: "Adicionar pastas do workspace", icon: FolderGit2, run: () => open({ kind: "project" }) },
    { id: "action-shortcuts", group: "Ações", label: "Atalhos de teclado", hint: "?", keywords: "teclado ajuda", icon: Keyboard, run: () => setShortcutsOpen(true) },
    { id: "action-notifications", group: "Ações", label: notificationsOn ? "Desativar notificações" : "Ativar notificações do navegador", keywords: "avisos alerta", icon: notificationsOn ? BellOff : Bell, run: () => void toggleNotifications() },
    { id: "action-theme", group: "Ações", label: theme === "dark" ? "Ativar modo claro" : "Ativar modo escuro", keywords: "tema cores", icon: theme === "dark" ? Sun : Moon, run: () => setTheme((value) => value === "dark" ? "light" : "dark") },
    ...navigation.map((item) => ({ id: `page-${item.id}`, group: "Ir para", label: item.label, keywords: item.group, icon: item.icon, run: () => navigate(item.id as PageRoute) })),
    ...projects.map((project) => ({ id: `project-${project.id}`, group: "Projetos", label: project.name, hint: `${tasks.filter((task) => task.projectId === project.id).length} tarefa(s)`, keywords: project.directories.map((directory) => `${directory.name} ${directory.path}`).join(" "), icon: FolderGit2, run: () => showProjectTasks(project.id) })),
    ...[...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((task) => ({ id: `task-${task.id}`, group: "Tarefas", label: task.title, hint: `${projectName(task.projectId)} · ${statuses[task.status]}`, keywords: task.id, icon: ListTodo, run: () => openTask(task.id) })),
  ];
  // Where the operator is, from the workspace down to the current screen; every level but the last is a link.
  const tasksCrumb: Crumb = { label: "Tarefas", href: "#/tasks" };
  const projectCrumb = (projectId: string): Crumb => ({ label: projectName(projectId), href: "#/tasks", onClick: () => setProjectFilter(projectId) });
  const taskCrumbs = (task: Task | undefined, title: string | undefined, current: boolean): Crumb[] => task
    ? [tasksCrumb, projectCrumb(task.projectId), current ? { label: task.title } : { label: task.title, href: `#/tasks/${encodeURIComponent(task.id)}` }]
    : [tasksCrumb, { label: title ?? "Tarefa" }];
  const filesTask = filesRoute ? tasks.find((task) => task.id === filesRoute.taskId) : undefined;
  const viewedProject = projectView ? projects.find((project) => project.id === projectView.projectId) : undefined;
  const crumbs: Crumb[] = projectView ? [{ label: "Projetos", href: "#/projects" }, viewedProject ? { label: viewedProject.name, href: projectHash(viewedProject.id) } : { label: "Projeto" },
      ...(projectView.section === "files" ? [{ label: "Arquivos" }] : projectView.section === "terminal" ? [{ label: "Terminal" }] : [])]
    : comparisonId ? [tasksCrumb, { label: "Comparação de agentes" }]
    : filesRoute ? [...taskCrumbs(filesTask, undefined, false), { label: "Arquivos" }]
    : publishRoute ? [...taskCrumbs(selectedTask, undefined, false), { label: "Publicação" }]
    : executionRoute ? [...(executionDetail ? taskCrumbs(tasks.find((task) => task.id === executionDetail.task.id) ?? executionDetail.task, undefined, false) : [{ label: "Execuções", href: "#/executions" }]), { label: "Execução" }]
    : taskRoute === "new" ? [tasksCrumb, { label: "Nova tarefa" }]
    : taskRoute ? taskCrumbs(selectedTask, undefined, true)
    : active === "not-found" ? [{ label: "Página não encontrada" }]
    : active === "overview" ? [{ label: "Visão geral" }]
    : [{ label: navigation.find((item) => item.id === active)?.label ?? "" }];
  blocksShortcuts.current = Boolean(dialog) || paletteOpen || shortcutsOpen;
  onShortcut.current = (action) => {
    const taskId = taskRoute && taskRoute !== "new" ? taskRoute : filesRoute?.taskId;
    switch (action) {
      case "help": setShortcutsOpen(true); break;
      case "palette": setPaletteOpen(true); break;
      case "new-task": window.location.hash = "/tasks/new"; break;
      case "go-overview": navigate("overview"); break;
      case "go-inbox": navigate("inbox"); break;
      case "go-tasks": navigate("tasks"); break;
      case "go-executions": navigate("executions"); break;
      case "go-projects": navigate("projects"); break;
      case "go-providers": navigate("providers"); break;
      case "tab-conversation": if (taskId) openTask(taskId); break;
      case "tab-files": if (taskId) window.location.hash = fileExplorerHash(taskId).slice(1); break;
      case "tab-publish": if (taskId) window.location.hash = `/tasks/${encodeURIComponent(taskId)}/publish`; break;
    }
  };
  async function toggleNotifications() {
    if (notificationsOn) { setNotificationsOn(false); setNotice("Notificações do navegador desativadas."); return; }
    const support = notificationSupport();
    if (support === "unsupported") { setNotice("Este navegador não oferece notificações."); return; }
    const permission = support === "granted" ? support : await window.Notification.requestPermission();
    if (permission === "granted") { setNotificationsOn(true); setNotice("Notificações ativadas: avisaremos quando algo precisar de você ou um turno terminar."); }
    else setNotice("O navegador bloqueou as notificações. Libere-as nas configurações do site para ativar.");
  }
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
          {navigationGroups.map((group) => <div key={group} className="sidebar-group" role="group" aria-label={group}>
          <span className="sidebar-section" aria-hidden="true">{group}</span>
          {navigation.filter((item) => item.group === group).map((item) => (
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
              {item.id === "inbox" && inbox.length > 0 && (
                <b className="nav-count" aria-label={`${inbox.length} item(ns)`}>{inbox.length}</b>
              )}
            </a>
          ))}
          </div>)}
        </nav>
        {projectsWithTasks.length > 0 && (
          <nav className="sidebar-projects" aria-label="Projetos e tarefas">
            <span className="sidebar-section">Projetos</span>
            {projectsWithTasks.map(({ project, cards }) => {
              const open = !collapsedProjects.includes(project.id);
              const visible = cards.filter((card) => card.place !== "archive");
              const listId = `sidebar-project-${project.id}`;
              return (
                <div key={project.id} className="sidebar-project">
                  <div className="sidebar-project-row">
                    <button type="button" className="sidebar-project-toggle" aria-expanded={open} aria-controls={listId} aria-label={`${open ? "Recolher" : "Expandir"} ${project.name}`} onClick={() => toggleProject(project.id)}>
                      {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                    </button>
                    <a className="sidebar-project-name" href={projectHash(project.id)} title={`Abrir ${project.name}`} aria-current={projectView?.projectId === project.id ? "page" : undefined} onClick={() => setProjectFilter(project.id)}>
                      <FolderGit2 size={15} aria-hidden="true" /> <span>{project.name}</span>
                    </a>
                  </div>
                  {open && <div id={listId} className="sidebar-project-tasks">
                    {visible.slice(0, sidebarTaskLimit).map(({ task, place, fact }) => (
                      <a key={task.id} href={`#/tasks/${encodeURIComponent(task.id)}`} aria-current={taskRoute === task.id || filesRoute?.taskId === task.id || executionDetail?.task.id === task.id && executionRoute ? "page" : undefined} title={`${task.title} · ${fact}`}>
                        <span className={`lane-dot lane-${place}`} aria-hidden="true" />
                        <span>{task.title}</span>
                      </a>
                    ))}
                    {visible.length > sidebarTaskLimit && <a className="sidebar-more" href={projectHash(project.id)} onClick={() => setProjectFilter(project.id)}><span>Ver todas ({visible.length})</span></a>}
                    {visible.length === 0 && <span className="sidebar-empty">Nenhuma tarefa ativa</span>}
                  </div>}
                </div>
              );
            })}
          </nav>
        )}
        <div className="sidebar-actions">
          <button className="theme-toggle" type="button" aria-pressed={notificationsOn} onClick={() => void toggleNotifications()}
            aria-label={notificationsOn ? "Desativar notificações" : "Ativar notificações"} title={collapsed ? (notificationsOn ? "Desativar notificações" : "Ativar notificações") : undefined}>
            {notificationsOn ? <Bell size={17} aria-hidden="true" /> : <BellOff size={17} aria-hidden="true" />}
            <span>{notificationsOn ? "Notificações ativas" : "Notificações"}</span>
          </button>
          <button className="theme-toggle" type="button" onClick={() => setShortcutsOpen(true)} aria-keyshortcuts="Shift+?" aria-label="Atalhos de teclado" title={collapsed ? "Atalhos de teclado (?)" : undefined}>
            <Keyboard size={17} aria-hidden="true" />
            <span>Atalhos <kbd>?</kbd></span>
          </button>
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
          <nav aria-label="Você está em" className="breadcrumbs">
            <ol>
              <li><a href="#/overview">Workspace</a></li>
              {crumbs.map((crumb, index) => (
                <li key={`${index}-${crumb.label}`}>
                  <ChevronRight size={14} aria-hidden="true" />
                  {crumb.href && index < crumbs.length - 1
                    ? <a href={crumb.href} onClick={crumb.onClick}>{crumb.label}</a>
                    : <strong aria-current="location">{crumb.label}</strong>}
                </li>
              ))}
            </ol>
          </nav>
          <button type="button" className="command-trigger" onClick={() => setPaletteOpen(true)} aria-keyshortcuts="Control+K" title="Buscar tarefas, projetos e telas (Ctrl+K)">
            <Search size={15} aria-hidden="true" />
            <span>Buscar ou ir para…</span>
            <kbd>Ctrl K</kbd>
          </button>
        </header>
        {paletteOpen && <CommandPalette items={commandItems} onClose={() => setPaletteOpen(false)} />}
        {filesRoute ? <FileExplorerPage key={filesRoute.taskId} client={client} initial={filesRoute}
          task={tasks.find((task) => task.id === filesRoute.taskId)}
          project={projects.find((project) => project.id === tasks.find((task) => task.id === filesRoute.taskId)?.projectId)}
          tabs={<TaskTabs taskId={filesRoute.taskId} active="files" pendingPublications={pendingPublications(filesRoute.taskId)} />}
          onBack={() => openTask(filesRoute.taskId)} /> : executionRoute ? <ExecutionResultPage client={client} onSessionChanged={refreshSession} detail={executionDetail} loading={executionLoading} error={executionError} onBack={() => executionDetail ? openTask(executionDetail.task.id) : backToDashboard()} onSelect={openExecution} onCreateRelated={(task) => open({ kind: "related", task })} /> : <main id="main" className="loading-host" tabIndex={-1}>
           {busy && !dialog && data && <LoadingOverlay label="Aguarde…" />}
           {projectView ? (
             <section className="task-workspace project-workspace">
               <div className="feedback" role="status">{notice}</div>
               {error && <div className="error" role="alert">{error}</div>}
               {formError && !dialog && <div className="error" role="alert">{formError}</div>}
               {!data ? <div className="loading-area page"><LoadingOverlay label="Carregando projeto…" /></div>
                 : viewedProject ? <ProjectPage client={client} project={viewedProject} section={projectView.section}
                     location={{ ...(projectView.directoryId ? { directoryId: projectView.directoryId } : {}), ...(projectView.path ? { path: projectView.path } : {}) }}
                     cards={tasks.filter((task) => task.projectId === viewedProject.id).map(placed)} statusLabel={(card) => statuses[card.task.status]}
                     actions={<a className="primary" href="#/tasks/new" onClick={() => setProjectFilter(viewedProject.id)}><Plus size={16} aria-hidden="true" /> Nova tarefa</a>}
                     terminal={<div className="empty">O terminal do projeto ainda não está disponível neste host.</div>} />
                 : <div className="empty">Projeto não encontrado. <a className="text-button" href="#/projects">Voltar aos projetos</a></div>}
             </section>
           ) : comparisonId ? (
             <section className="task-workspace comparison-workspace" aria-labelledby="comparison-title">
               <header className="task-workspace-heading">
                 <span className="eyebrow">Comparação de agentes</span>
                 <h1 id="comparison-title" tabIndex={-1}>{tasks.find((task) => task.comparisonId === comparisonId)?.title.replace(/ · [^·]+$/, "") ?? "Comparação"}</h1>
               </header>
               <div className="feedback" role="status">{notice}</div>
               {error && <div className="error" role="alert">{error}</div>}
               {formError && <div className="error" role="alert">{formError}</div>}
               {!data ? <div className="loading-area page"><LoadingOverlay label="Carregando comparação…" /></div>
                 : <ComparisonPage client={client} comparisonId={comparisonId} tasks={tasks} runs={data.runs} busy={busy} statusLabel={(task) => statuses[task.status]}
                     onChoose={(taskId) => void mutate(() => client.chooseComparisonAttempt(comparisonId, taskId), "Versão escolhida. As outras tentativas foram deixadas de lado, com as branches preservadas.", () => openTask(taskId))} />}
             </section>
           ) : taskRoute ? (
             <section className="task-workspace" aria-labelledby="task-workspace-title">
               <header className="task-workspace-heading">
                 <span className="eyebrow">{selectedTask ? projectName(selectedTask.projectId) : "Tarefas"}</span>
                 <h1 id="task-workspace-title" ref={taskViewHeading} tabIndex={-1}>{taskRoute === "new" ? "O que você quer fazer?" : selectedTask?.title ?? "Tarefa"}</h1>
               </header>
               {selectedTask && <TaskTabs taskId={selectedTask.id} active={publishRoute ? "publish" : "conversation"} pendingPublications={pendingPublications(selectedTask.id)} />}
               <div className="feedback" role="status">{notice}</div>
               {error && <div className="error" role="alert">{error} <button className="text-button" disabled={busy} onClick={() => void refresh()}>Atualizar</button></div>}
               {!data ? (
                 !error && <div className="loading-area page"><LoadingOverlay label="Carregando tarefas…" /></div>
               ) : taskRoute === "new" ? (
                 <TaskComposer projects={projects} initialProjectId={projectFilter} busy={busy} error={formError} onSubmit={submitTask} onRegisterProject={() => open({ kind: "project" })}
                   agents={providers.filter((provider) => provider.preferences.enabled && provider.available && provider.authenticated !== false && provider.roles.implementer).map((provider) => ({ id: provider.provider, label: provider.label }))}
                   onCompare={submitComparison} templates={templates}
                   onSaveTemplate={(input) => void mutate(() => client.createTemplate(input), `Modelo "${input.name}" salvo. Ele aparece em "Começar de um modelo".`, (saved) => setTemplates((current) => [...current, saved].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))))}
                   onDeleteTemplate={(template) => { if (window.confirm(`Excluir o modelo "${template.name}"? As tarefas já criadas com ele não mudam.`)) void mutate(() => client.deleteTemplate(template.id), "Modelo excluído.", setTemplates); }} />
               ) : selectedTask ? (
                 <TaskWorkspace
                   view={publishRoute ? "publish" : "conversation"}
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
                     <a className="secondary" href={fileExplorerHash(selectedTask.id)}><FolderTree size={16} aria-hidden="true" /> Explorar arquivos</a>
                     {selectedTask.comparisonId && <a className="secondary" href={`#/comparisons/${encodeURIComponent(selectedTask.comparisonId)}`}><GitCompare size={16} aria-hidden="true" /> Comparar agentes</a>}
                     {selectedRun && <button className="secondary" onClick={() => openExecution(selectedRun.id)}>{selectedTask.status === "queued" ? "Ver última tentativa" : "Ver detalhes da execução"}</button>}
                     {selectedTask.status === "queued" && <button className="primary" disabled={busy} onClick={() => open({ kind: "execute", task: selectedTask })}><Play size={16} aria-hidden="true" /> Executar tarefa</button>}
                     {selectedApproval && selectedTask.status === "waiting_approval" && <button className="primary" disabled={busy} onClick={() => open({ kind: "approval", approval: selectedApproval })}><ShieldCheck size={16} aria-hidden="true" /> Revisar aprovação</button>}
                     {selectedTask.status === "failed" && selectedRun?.provider && <button className="primary" disabled={busy} title="Continua com o mesmo agente; retoma a sessão quando o agente permite, ou envia o que foi registrado do turno perdido"
                       onClick={() => void mutate(() => untilPreparing(selectedTask.id, client.resumeTask(selectedTask.id)), "Execução retomada de onde parou.")}><RotateCcw size={16} aria-hidden="true" /> Retomar de onde parou</button>}
                     {selectedTask.status === "failed" && <button className={selectedRun?.provider ? "secondary" : "primary"} disabled={busy} onClick={() => void mutate(() => client.retryTask(selectedTask.id), "Tarefa reenfileirada.")}><RefreshCw size={16} aria-hidden="true" /> {busy ? "Reenfileirando…" : "Reenfileirar tarefa"}</button>}
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
                  {active === "inbox" && <Panel id="inbox" title="Decisões pendentes" eyebrow="PRECISA DE VOCÊ" action={<span className="count-badge amber">{inbox.length}</span>}>
                    <NeedsYouInbox items={inbox} projectName={projectName} />
                  </Panel>}
                  {active === "overview" && <div className="executive-column">
                    {inbox.length > 0 && <Panel id="needs-you" title="Precisa de você" eyebrow="SUA DECISÃO" action={<a className="text-button" href="#/inbox">Ver tudo ({inbox.length}) <ArrowRight size={15} aria-hidden="true" /></a>}>
                      <NeedsYouInbox items={inbox} projectName={projectName} limit={4} />
                    </Panel>}
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
                          aria-label={`Abrir ${project.name}`}
                          onClick={() => { window.location.hash = projectHash(project.id).slice(1); }}
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
      {shortcutsOpen && (
        <Modal title="Atalhos de teclado" onClose={() => setShortcutsOpen(false)}>
          <p className="form-intro">Os atalhos de uma tecla não agem enquanto você digita em um campo.</p>
          <dl className="shortcut-list">
            {shortcutList.map((item) => (
              <div key={item.label}>
                <dt>{item.keys.map((key, index) => <span key={key}>{index > 0 && <span className="shortcut-then">{item.keys[0] === "G" ? " depois " : " + "}</span>}<kbd>{key}</kbd></span>)}</dt>
                <dd>{item.label}</dd>
              </div>
            ))}
          </dl>
          <div className="form-actions"><button type="button" className="primary" onClick={() => setShortcutsOpen(false)}>Entendi</button></div>
        </Modal>
      )}
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
