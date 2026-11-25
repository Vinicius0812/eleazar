import type {
  AgentAdapter, AgentHealth, AgentRunRequest, AgentRunResult, AgentVerification, ProviderCatalog, ProviderName, TaskKind
} from "../core/contracts.js";
import { isAuthenticationRequired, type AcpClient, type AcpSessionInfo } from "./acp-client.js";
import { inTemporaryDirectory } from "./temporary-directory.js";

/** What a provider lets the catalog publish. Modes outside the list never reach the operator's screen. */
export interface AcpCatalogPolicy {
  selectableModes: readonly string[];
  /** Publish every announced setting instead of only the known safe categories. */
  allSettings?: boolean;
}

/** A confirmed login is trusted for this long; a failed or undecided check is retried much sooner. */
const confirmedForMs = 10 * 60_000;
const retryAfterMs = 30_000;
const verificationTimeoutMs = 45_000;

const publishedCategories = ["mode", "model", "thought_level", "model_config", "collaboration_mode"];

/**
 * Gives any ACP provider the same connection check and catalog. The wrapped adapter keeps owning
 * the CLI diagnostics and the runs; nothing here depends on which provider it is.
 */
export class AcpAgentAdapter implements AgentAdapter {
  readonly provider: ProviderName;
  readonly supportedTasks: ReadonlySet<TaskKind>;
  #verification: { key: string; value: AgentVerification } | null = null;
  #verifying: Promise<AgentVerification> | null = null;

  constructor(private readonly base: Pick<AgentAdapter, "provider" | "supportedTasks" | "health" | "run">, private readonly deps: {
    client: Pick<AcpClient, "inspect">;
    catalogPolicy: AcpCatalogPolicy;
    /** Whether an opened session proves that someone is signed in; opening one is not proof for every agent. */
    confirmsLogin: (session: AcpSessionInfo) => boolean;
    now?: () => number;
  }) {
    this.provider = base.provider;
    this.supportedTasks = base.supportedTasks;
  }

  async health(): Promise<AgentHealth> {
    const health = await this.base.health();
    const verified = this.#current(runtimeKey(health.executablePath, health.version));
    return health.available && health.authenticated === null && verified && verified.authenticated !== null
      ? { ...health, authenticated: verified.authenticated, detail: verified.detail }
      : health;
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const result = await this.base.run(request);
    // A failed turn may mean an expired login, so the next routing decision checks it again.
    if (result.status === "error") this.#verification = null;
    return result;
  }

  lastVerification(): AgentVerification | null {
    return this.#verification?.value ?? null;
  }

  async verify(force = false): Promise<AgentVerification> {
    if (this.#verifying) return this.#verifying;
    this.#verifying = this.#verify(force).finally(() => { this.#verifying = null; });
    return this.#verifying;
  }

  async catalog(cwd: string): Promise<ProviderCatalog> {
    return toProviderCatalog(await this.deps.client.inspect(cwd), this.deps.catalogPolicy);
  }

  async #verify(force: boolean): Promise<AgentVerification> {
    const health = await this.base.health();
    const key = runtimeKey(health.executablePath, health.version);
    const known = force ? null : this.#current(key);
    if (known) return known;
    const value = await this.#check(health);
    this.#verification = { key, value };
    return value;
  }

  async #check(health: AgentHealth): Promise<AgentVerification> {
    const result = (fields: Omit<AgentVerification, "provider" | "checkedAt" | "models" | "defaultModel">, catalog?: ProviderCatalog): AgentVerification => ({
      provider: this.provider, ...fields, models: catalog?.models ?? [], defaultModel: catalog?.defaultModel ?? null,
      checkedAt: new Date(this.#now()).toISOString()
    });
    if (!health.available) return result({ connected: false, authenticated: health.authenticated, detail: health.detail });
    try {
      const info = await inTemporaryDirectory((cwd) => this.deps.client.inspect(cwd, undefined, verificationTimeoutMs));
      const authenticated = health.authenticated ?? (this.deps.confirmsLogin(info) ? true : null);
      return result({
        connected: true, authenticated,
        detail: authenticated ? "Conexao ACP e login confirmados."
          : authenticated === false ? "A conexao ACP responde, mas a CLI informa que nao ha login."
          : "A conexao ACP responde, mas o agente nao confirmou o login."
      }, toProviderCatalog(info, this.deps.catalogPolicy));
    } catch (error) {
      if (isAuthenticationRequired(error)) {
        return result({ connected: true, authenticated: false, detail: "O agente respondeu que falta autenticacao." });
      }
      return result({ connected: false, authenticated: health.authenticated,
        detail: `A conexao ACP falhou: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  #current(key: string): AgentVerification | null {
    if (!this.#verification || this.#verification.key !== key) return null;
    const { value } = this.#verification;
    const validFor = value.connected && value.authenticated === true ? confirmedForMs : retryAfterMs;
    return this.#now() - Date.parse(value.checkedAt) < validFor ? value : null;
  }

  #now(): number { return this.deps.now?.() ?? Date.now(); }
}

export function toProviderCatalog(info: AcpSessionInfo, policy: AcpCatalogPolicy): ProviderCatalog {
  const modelOption = info.configOptions.find((item) => item.type === "select" && (item.category === "model" || item.id === "model"));
  const model = modelOption?.type === "select" ? modelOption : null;
  return {
    runtime: info.runtime, protocolVersion: info.protocolVersion,
    capabilities: { loadSession: info.capabilities.loadSession === true },
    settings: info.configOptions.filter((item) => policy.allSettings || publishedCategories.includes(item.category ?? item.id))
      .map((item) => item.type === "select"
        ? { id: item.id, name: item.name, category: item.category ?? null, type: "select" as const, currentValue: item.currentValue,
          options: choices(item).filter((choice) => (item.category !== "mode" && item.id !== "mode") || policy.selectableModes.includes(choice.id)) }
        : { id: item.id, name: item.name, category: item.category ?? null, type: "boolean" as const, currentValue: item.currentValue, options: [] }),
    models: model ? choices(model) : [],
    defaultModel: model?.currentValue ?? null
  };
}

type SessionOption = AcpSessionInfo["configOptions"][number];
function choices(option: Extract<SessionOption, { type: "select" }>): Array<{ id: string; name: string }> {
  return option.options.flatMap((item) => "value" in item
    ? [{ id: item.value, name: item.name }]
    : item.options.map((choice) => ({ id: choice.value, name: choice.name })));
}

function runtimeKey(path: string | undefined, version: string | undefined): string {
  return `${path ?? ""}\0${version ?? ""}`;
}
