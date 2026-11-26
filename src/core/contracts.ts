/** Stable provider id. Which ids exist is decided by the descriptors registered in the host. */
export type ProviderName = string;

/** Shape of a provider id; `auto` is reserved for the router. */
export function isProviderName(value: string): value is ProviderName {
  return /^[a-z][a-z0-9-]{0,31}$/.test(value) && value !== "auto";
}

export const taskKinds = [
  "implementation",
  "review",
  "planning",
  "research",
  "testing",
  "documentation",
  "unknown"
] as const;

export type TaskKind = (typeof taskKinds)[number];

export const claudeTextTaskKinds: ReadonlySet<TaskKind> = new Set(["review", "planning"]);

export interface TokenUsage {
  input?: number;
  output?: number;
  thinking?: number;
  cacheRead?: number;
  total?: number;
}

/** Everything the core needs to know about a provider; how it is launched stays in the adapters. */
export interface ProviderDescriptor {
  id: ProviderName;
  label: string;
  transport: "acp" | "legacy";
  roles: { implementer: boolean; reviewer: boolean };
  /** Router weight for each task kind; kinds left out use `unknown`. */
  affinity: Readonly<Partial<Record<TaskKind, number>>>;
  /** Whether the provider takes part in Automatico until the operator says otherwise. */
  automaticByDefault: boolean;
  /** Official command the operator runs in their own terminal. Eleazar never runs it. */
  loginCommand: string;
  loginHint: string;
  /** File names accepted when the operator overrides the executable path. */
  executableNames: readonly string[];
}

/** Operator choices for one provider. They never hold credentials. */
export interface ProviderPreferences {
  enabled: boolean;
  automatic: boolean;
  executablePath: string | null;
  defaultModel: string | null;
  /** Tokens per day the operator allows the Automatico mode to spend on this provider; absent means no limit. */
  dailyTokenBudget?: number | null;
}

/**
 * How much of a provider's allowance is spent: the account's own limit when the provider reports it,
 * otherwise the tokens the Eleazar saw today against the operator's daily budget.
 */
export interface ProviderQuotaSignal { usedPercent: number; source: "account" | "budget"; }
export type ProviderQuotaReader = (provider: ProviderName) => ProviderQuotaSignal | null;

export interface AgentHealth {
  provider: ProviderName;
  available: boolean;
  authenticated: boolean | null;
  version?: string;
  detail: string;
  executablePath?: string;
  executableSource?: string;
}

/** Result of opening and closing one agent session. No prompt is ever sent. */
export interface AgentVerification {
  provider: ProviderName;
  /** Whether the agent answered over its protocol. */
  connected: boolean;
  authenticated: boolean | null;
  detail: string;
  models: Array<{ id: string; name: string }>;
  defaultModel: string | null;
  checkedAt: string;
}

export interface AgentRunRequest {
  prompt: string;
  cwd: string;
  model?: string;
  sessionId?: string;
  additionalDirectories?: string[];
  taskKind?: TaskKind;
  signal?: AbortSignal;
  /** Hard limit for the whole turn. */
  timeoutMs?: number;
  /** Ends the turn when the agent sends nothing for this long; time spent waiting for the operator does not count. */
  idleTimeoutMs?: number;
  onUpdate?: (update: AgentUpdate) => void;
  onPermission?: (request: AgentPermissionRequest) => Promise<string | null> | string | null;
}

/** Provider-neutral events for an interactive execution. */
export interface AgentUpdate {
  sessionId: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface AgentPermissionRequest {
  sessionId: string;
  toolCallId: string;
  title: string;
  toolKind?: string;
  toolName?: string;
  locations?: string[];
  requiresElevation?: boolean;
  options: Array<{ id: string; name: string; kind: string }>;
}

export interface AgentRunResult {
  provider: ProviderName;
  status: "success" | "error";
  response: string;
  durationMs: number;
  sessionId?: string;
  usage?: TokenUsage;
  error?: string;
}

export interface AgentAdapter {
  readonly provider: ProviderName;
  readonly supportedTasks: ReadonlySet<TaskKind>;
  health(): Promise<AgentHealth>;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
  /** Opens a session without a prompt to confirm connection and login. */
  verify?(force?: boolean): Promise<AgentVerification>;
  /** Last verification still valid for the current executable. */
  lastVerification?(): AgentVerification | null;
  /** Models and settings announced for a folder. Only agents with selectable sessions implement it. */
  catalog?(cwd: string): Promise<ProviderCatalog>;
}

export interface ProviderCatalog {
  runtime: { path: string; version: string; source: string };
  protocolVersion: number;
  settings: Array<{ id: string; name: string; category: string | null; type: "select" | "boolean";
    currentValue: string | boolean; options: Array<{ id: string; name: string }> }>;
  models: Array<{ id: string; name: string }>;
  defaultModel: string | null;
  capabilities?: { loadSession?: boolean };
}

/** Stable provider-neutral catalog returned by the local Control Room API. */
export interface ProviderConfig extends ProviderCatalog {
  provider?: ProviderName;
  directoryId: string;
}

export interface RouteRequest {
  prompt: string;
  preferredProvider?: ProviderName;
  taskKind?: TaskKind;
}

export interface RouteCandidate {
  provider: ProviderName;
  score: number;
  reasons: string[];
  health: AgentHealth;
}

export interface RouteDecision {
  taskKind: TaskKind;
  selected: ProviderName | null;
  candidates: RouteCandidate[];
}
