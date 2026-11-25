import { AcpAgentAdapter } from "../src/adapters/acp-agent-adapter.js";
import { builtInProviders } from "../src/adapters/built-in-providers.js";
import type { AcpClient } from "../src/adapters/acp-client.js";
import { taskKinds, type AgentAdapter, type ProviderDescriptor, type ProviderPreferences } from "../src/core/contracts.js";
import { ProviderRegistry, type ProviderPreferenceReader } from "../src/core/provider-registry.js";

const builtIn = new Map(builtInProviders().map(({ descriptor }) => [descriptor.id, descriptor]));

/** The real descriptor of a built-in provider, or a minimal one for an id the product does not know. */
export function descriptorOf(id: string, fields: Partial<ProviderDescriptor> = {}): ProviderDescriptor {
  return { ...(builtIn.get(id) ?? { id, label: id, transport: "acp", roles: { implementer: true, reviewer: false }, affinity: {}, automaticByDefault: false,
    loginCommand: id, loginHint: "Entre na sua conta.", executableNames: [id] }), ...fields };
}

export function registryOf(adapters: readonly AgentAdapter[], stored?: ProviderPreferenceReader): ProviderRegistry {
  return new ProviderRegistry(adapters.map((adapter) => ({ descriptor: descriptorOf(adapter.provider), adapter })), stored);
}

/** Built-in providers whose sessions come from fake ACP clients; nothing real is ever started. */
export function acpRegistry(clients: Record<string, Pick<AcpClient, "inspect">> = {}, stored?: ProviderPreferenceReader): ProviderRegistry {
  const modes: Record<string, string[]> = { codex: ["read-only", "workspace-write"] };
  const refuse = async () => { throw new Error("Cliente ACP falso nao configurado."); };
  return registryOf([...builtIn.keys()].map((id) => new AcpAgentAdapter({
    provider: id, supportedTasks: new Set(taskKinds),
    health: async () => ({ provider: id, available: true, authenticated: true, version: "test", executablePath: id, detail: "teste" }),
    run: async () => ({ provider: id, status: "success", response: "ok", durationMs: 1 })
  }, { client: clients[id] ?? { inspect: refuse }, sessionConfirmsLogin: false,
    catalogPolicy: { selectableModes: modes[id] ?? ["default"], allSettings: id === "claude" } })), stored);
}

export const preferences = (fields: Partial<ProviderPreferences> = {}): ProviderPreferences =>
  ({ enabled: true, automatic: true, executablePath: null, defaultModel: null, ...fields });
