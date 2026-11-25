export const automaticProviderNames = ["codex", "antigravity"] as const;
export const providerNames = [...automaticProviderNames, "claude"] as const;

export type ProviderName = (typeof providerNames)[number];
export type AutomaticProviderName = (typeof automaticProviderNames)[number];

export function isProviderName(value: string): value is ProviderName {
  return providerNames.some((provider) => provider === value);
}

export function isAutomaticProvider(value: string): value is AutomaticProviderName {
  return automaticProviderNames.some((provider) => provider === value);
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

export interface AgentHealth {
  provider: ProviderName;
  available: boolean;
  authenticated: boolean | null;
  version?: string;
  detail: string;
}

export interface AgentRunRequest {
  prompt: string;
  cwd: string;
  model?: string;
  sessionId?: string;
  additionalDirectories?: string[];
  taskKind?: TaskKind;
  signal?: AbortSignal;
  timeoutMs?: number;
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
}

/** Stable provider-neutral catalog returned by the local Control Room API. */
export interface ProviderConfig {
  provider?: ProviderName;
  directoryId: string;
  runtime: { path: string; version: string; source: string };
  protocolVersion: number;
  settings: Array<{ id: string; name: string; category: string | null; type: "select" | "boolean";
    currentValue: string | boolean; options: Array<{ id: string; name: string }> }>;
  models: Array<{ id: string; name: string }>;
  defaultModel: string | null;
  capabilities?: { loadSession?: boolean };
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
