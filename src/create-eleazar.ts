import { existsSync } from "node:fs";
import { join } from "node:path";

import { builtInProviderIds, builtInProviders } from "./adapters/built-in-providers.js";
import { customProvider, readCustomProviders, type CustomProviderSpec } from "./adapters/custom-providers.js";
import type { ProviderPreferences } from "./core/contracts.js";
import { Orchestrator } from "./core/orchestrator.js";
import { ProviderRegistry, type ProviderPreferenceReader } from "./core/provider-registry.js";
import { readProviderPreferences } from "./persistence/sqlite-control-room-store.js";

export interface EleazarOptions {
  preferences?: ProviderPreferenceReader;
  customProviders?: readonly CustomProviderSpec[];
}

export function createEleazar(options: EleazarOptions = {}): Orchestrator {
  const executablePath = (id: string) => options.preferences?.(id)?.executablePath ?? null;
  return new Orchestrator(new ProviderRegistry([
    ...builtInProviders(executablePath),
    ...(options.customProviders ?? []).map((spec) => customProvider(spec, () => executablePath(spec.id)))
  ], options.preferences));
}

/** Location of the operator's own ACP agents, next to the local database. */
export function customProvidersPath(root: string): string {
  return join(root, ".eleazar", "providers.json");
}

export async function loadCustomProviders(root: string) {
  return readCustomProviders(customProvidersPath(root), builtInProviderIds);
}

/** Same providers and choices as the Control Room of this folder, for the terminal commands. */
export async function createLocalEleazar(root: string, warn: (message: string) => void): Promise<Orchestrator> {
  const { specs, warnings } = await loadCustomProviders(root);
  warnings.forEach(warn);
  const database = join(root, ".eleazar", "control-room.sqlite");
  const saved = existsSync(database) ? readProviderPreferences(database) : new Map<string, ProviderPreferences>();
  return createEleazar({ customProviders: specs, preferences: (id) => saved.get(id) ?? null });
}
