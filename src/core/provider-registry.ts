import { isProviderName, type AgentAdapter, type ProviderDescriptor, type ProviderName, type ProviderPreferences } from "./contracts.js";

export interface ProviderRegistration {
  descriptor: ProviderDescriptor;
  adapter: AgentAdapter;
}

/** Where the operator's choices are stored. Missing providers use the descriptor's defaults. */
export type ProviderPreferenceReader = (id: ProviderName) => ProviderPreferences | null;

/** The only list of providers. Router, executor, API and screens read it instead of naming providers. */
export class ProviderRegistry {
  readonly #entries: ReadonlyMap<ProviderName, ProviderRegistration>;

  constructor(registrations: readonly ProviderRegistration[], private readonly stored: ProviderPreferenceReader = () => null) {
    const entries = new Map<ProviderName, ProviderRegistration>();
    for (const registration of registrations) {
      const { id } = registration.descriptor;
      if (!isProviderName(id)) throw new Error(`Identificador de provedor invalido: ${id}`);
      if (registration.adapter.provider !== id) throw new Error(`Adaptador de ${registration.adapter.provider} registrado como ${id}.`);
      if (entries.has(id)) throw new Error(`Provedor registrado duas vezes: ${id}`);
      entries.set(id, registration);
    }
    this.#entries = entries;
  }

  list(): ProviderRegistration[] { return [...this.#entries.values()]; }
  ids(): ProviderName[] { return [...this.#entries.keys()]; }
  get(id: ProviderName): ProviderRegistration | null { return this.#entries.get(id) ?? null; }
  label(id: ProviderName): string { return this.get(id)?.descriptor.label ?? id; }

  preferences(id: ProviderName): ProviderPreferences {
    return this.stored(id) ?? {
      enabled: true, automatic: this.get(id)?.descriptor.automaticByDefault ?? false, executablePath: null, defaultModel: null
    };
  }
}
