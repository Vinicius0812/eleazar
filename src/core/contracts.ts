export const providerNames = ["codex", "antigravity"] as const;

export type ProviderName = (typeof providerNames)[number];

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
  taskKind?: TaskKind;
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
