import type { AgentAdapter, AgentHealth, ProviderQuotaReader, RouteCandidate, RouteDecision, RouteRequest, TaskKind } from "./contracts.js";
import type { ProviderRegistration, ProviderRegistry } from "./provider-registry.js";

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

/** Weight of a provider whose descriptor declares no affinity at all. */
const neutralScore = 50;
/** From this share of the allowance on, Automatico prefers the other providers. */
export const quotaWarningPercent = 80;

export function classifyTask(prompt: string): TaskKind {
  const normalizedPrompt = prompt.normalize("NFD").replace(/\p{Diacritic}/gu, "");

  for (const [kind, pattern] of taskPatterns) {
    if (pattern.test(normalizedPrompt)) {
      return kind;
    }
  }

  return "unknown";
}

/**
 * Automatico compares every enabled provider that takes part in it and only selects one whose login is confirmed.
 * An explicit choice is never replaced by another provider: the task would go to a company the operator did not pick.
 */
export class Router {
  #quota: ProviderQuotaReader = () => null;

  constructor(private readonly registry: ProviderRegistry) {}

  /** Lets Automatico steer away from providers whose allowance is nearly or fully spent. */
  useQuota(reader: ProviderQuotaReader): void { this.#quota = reader; }

  async route(request: RouteRequest): Promise<RouteDecision> {
    const taskKind = request.taskKind ?? classifyTask(request.prompt);
    const explicit = request.preferredProvider !== undefined;
    const pool = this.registry.list().filter(({ descriptor }) => {
      if (explicit) return descriptor.id === request.preferredProvider;
      const preferences = this.registry.preferences(descriptor.id);
      return preferences.enabled && preferences.automatic && descriptor.roles.implementer;
    });
    const candidates = (await Promise.all(pool.map(async (registration) =>
      this.#score(registration, await this.#health(registration), taskKind, explicit))))
      .sort((left, right) => right.score - left.score);
    const selected = candidates.find((candidate) => {
      const adapter = this.registry.get(candidate.provider)!.adapter;
      return candidate.health.available && adapter.supportedTasks.has(taskKind) && loginAccepted(candidate.health, adapter, explicit)
        && (explicit || !this.#exhausted(candidate.provider));
    });
    return { taskKind, selected: selected?.provider ?? null, candidates };
  }

  #exhausted(provider: string): boolean { return (this.#quota(provider)?.usedPercent ?? 0) >= 100; }

  async #health({ descriptor, adapter }: ProviderRegistration): Promise<AgentHealth> {
    if (!this.registry.preferences(descriptor.id).enabled) {
      return { provider: descriptor.id, available: false, authenticated: null, detail: "Desativado na tela Provedores." };
    }
    const health = await adapter.health();
    if (!health.available || health.authenticated !== null || !adapter.verify) return health;
    // The CLI cannot tell whether it is signed in: opening a session, without a prompt, can.
    const verification = await adapter.verify();
    return { ...health, authenticated: verification.authenticated, detail: verification.detail };
  }

  #score({ descriptor, adapter }: ProviderRegistration, health: AgentHealth, taskKind: TaskKind, explicit: boolean): RouteCandidate {
    const reasons: string[] = [];
    let score = descriptor.affinity[taskKind] ?? descriptor.affinity.unknown ?? neutralScore;
    reasons.push(`afinidade ${taskKind}: ${score}`);

    if (!adapter.supportedTasks.has(taskKind)) {
      score -= 30;
      reasons.push("tarefa fora das capacidades declaradas: -30");
    }

    if (explicit) {
      score += 100;
      reasons.push("preferencia explicita: +100");
    }

    // An explicit choice is honoured even with the allowance spent; the operator decided.
    const quota = explicit ? null : this.#quota(descriptor.id);
    if (quota && quota.usedPercent >= 100) {
      score -= 200;
      reasons.push(`cota esgotada (${Math.round(quota.usedPercent)}% ${quota.source === "account" ? "do limite da conta" : "do orcamento diario"}): fora do Automatico`);
    } else if (quota && quota.usedPercent >= quotaWarningPercent) {
      score -= 40;
      reasons.push(`cota em ${Math.round(quota.usedPercent)}%: -40`);
    }

    if (!health.available) {
      score = -1_000;
      reasons.push("provedor indisponivel");
    } else if (health.authenticated === false) {
      score = -900;
      reasons.push("provedor sem autenticacao");
    } else if (health.authenticated === null && !explicit) {
      score = -800;
      reasons.push("autenticacao nao confirmada");
    }

    return { provider: descriptor.id, score, reasons, health };
  }
}

/** An explicit choice may try a provider whose login only shows up when a session is opened. */
function loginAccepted(health: AgentHealth, adapter: AgentAdapter, explicit: boolean): boolean {
  return health.authenticated === true || (explicit && health.authenticated === null && adapter.verify !== undefined);
}
