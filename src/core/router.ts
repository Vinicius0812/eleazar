import type {
  AgentAdapter,
  AgentHealth,
  ProviderName,
  RouteCandidate,
  RouteDecision,
  RouteRequest,
  TaskKind
} from "./contracts.js";

const taskPatterns: ReadonlyArray<readonly [TaskKind, RegExp]> = [
  ["review", /\b(review|revis(?:ar|e|ao)|auditar|avaliar|code review)\b/i],
  ["testing", /\b(test(?:e|es|ar|ando|ing)?|vitest|jest|pytest|spec|coverage|cobertura)\b/i],
  [
    "research",
    /\b(pesquis(?:a|ar|e|ando)|research|compar(?:ar|e|acao)|investig(?:ar|ue|acao))\b/i
  ],
  ["planning", /\b(plan(?:o|ejar|eje|ning)?|arquitetura|architecture|design|roadmap)\b/i],
  ["documentation", /\b(document(?:ar|e|acao|ation)?|readme|docs?|manual)\b/i],
  [
    "implementation",
    /\b(implement(?:ar|e|acao)?|cri(?:ar|e)|build|fix|corrigir|refactor|refator(?:ar|acao)|codigo|code)\b/i
  ]
];

const baseScores: Record<TaskKind, Record<ProviderName, number>> = {
  implementation: { codex: 90, antigravity: 72 },
  review: { codex: 86, antigravity: 80 },
  planning: { codex: 78, antigravity: 84 },
  research: { codex: 65, antigravity: 90 },
  testing: { codex: 92, antigravity: 70 },
  documentation: { codex: 78, antigravity: 78 },
  unknown: { codex: 75, antigravity: 75 }
};

export function classifyTask(prompt: string): TaskKind {
  const normalizedPrompt = prompt.normalize("NFD").replace(/\p{Diacritic}/gu, "");

  for (const [kind, pattern] of taskPatterns) {
    if (pattern.test(normalizedPrompt)) {
      return kind;
    }
  }

  return "unknown";
}

export class Router {
  readonly #adapters: ReadonlyMap<ProviderName, AgentAdapter>;

  constructor(adapters: readonly AgentAdapter[]) {
    this.#adapters = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
  }

  async route(request: RouteRequest): Promise<RouteDecision> {
    const taskKind = request.taskKind ?? classifyTask(request.prompt);
    const healthEntries = await Promise.all(
      [...this.#adapters.values()].map(async (adapter) => [adapter, await adapter.health()] as const)
    );

    const candidates = healthEntries
      .map(([adapter, health]) => this.#score(adapter, health, taskKind, request.preferredProvider))
      .sort((left, right) => right.score - left.score);

    return {
      taskKind,
      selected: candidates.find((candidate) => candidate.health.available && candidate.health.authenticated !== false)
        ?.provider ?? null,
      candidates
    };
  }

  #score(
    adapter: AgentAdapter,
    health: AgentHealth,
    taskKind: TaskKind,
    preferredProvider?: ProviderName
  ): RouteCandidate {
    const reasons: string[] = [];
    let score = baseScores[taskKind][adapter.provider];

    reasons.push(`afinidade ${taskKind}: ${score}`);

    if (!adapter.supportedTasks.has(taskKind) && taskKind !== "unknown") {
      score -= 30;
      reasons.push("tarefa fora das capacidades declaradas: -30");
    }

    if (preferredProvider === adapter.provider) {
      score += 100;
      reasons.push("preferencia explicita: +100");
    }

    if (!health.available) {
      score = -1_000;
      reasons.push("provedor indisponivel");
    } else if (health.authenticated === false) {
      score = -900;
      reasons.push("provedor sem autenticacao");
    }

    return { provider: adapter.provider, score, reasons, health };
  }
}
