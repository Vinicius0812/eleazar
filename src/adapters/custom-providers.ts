import { access, readFile } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

import { isProviderName, taskKinds, type AgentAdapter, type AgentHealth, type ProviderDescriptor, type TaskKind } from "../core/contracts.js";
import type { ProviderRegistration } from "../core/provider-registry.js";
import { AcpAgentAdapter } from "./acp-agent-adapter.js";
import { AcpClient, type AcpRuntime } from "./acp-client.js";
import { findOnPath } from "./executable-path.js";
import { runProcess } from "./process-runner.js";
import { operationalEnvironment } from "./runtime-environment.js";

/**
 * An agent that already speaks ACP, described by data only. It always runs with the generic policy: fixed
 * arguments without a shell, no credential variables, a required permission mode and edits limited to the
 * task's folders. Anything looser needs a reviewed adapter in code.
 */
export interface CustomProviderSpec {
  id: string;
  label: string;
  /** Command in PATH or absolute path of a native executable. */
  executable: string;
  args: readonly string[];
  versionArgs: readonly string[];
  minimumVersion: string | null;
  /** Permission mode the session must confirm, the one in which the agent asks before editing. */
  requiredMode: string;
  loginCommand: string;
  loginHint: string;
  /** Set only for agents known to refuse session/new without a login. */
  sessionConfirmsLogin: boolean;
  roles: ProviderDescriptor["roles"];
  affinity: ProviderDescriptor["affinity"];
}

const bypass = /yolo|danger|bypass|skip[-_]?perm|full[-_]?(?:access|auto)|auto[-_]?(?:edit|approve|accept)|no[-_]?sandbox|(?:allow|trust)[-_]?all/i;
const safeText = /^[^\p{Cc}]+$/u;

export function customProvider(spec: CustomProviderSpec, executablePath: () => string | null = () => null): ProviderRegistration {
  const resolveRuntime = () => resolveCustomRuntime(spec, executablePath());
  const client = new AcpClient(spec.id, {
    resolveRuntime,
    launch: (runtime) => ({ command: runtime.path, args: spec.args }),
    environment: () => operationalEnvironment(),
    requiredMode: spec.requiredMode,
    strictFileScope: true
  });
  const base: AgentAdapter = {
    provider: spec.id,
    supportedTasks: new Set<TaskKind>(taskKinds),
    health: async (): Promise<AgentHealth> => {
      try {
        const runtime = await resolveRuntime();
        return { provider: spec.id, available: true, authenticated: null, version: runtime.version, executablePath: runtime.path,
          executableSource: runtime.source, detail: `ACP ${runtime.source}: ${runtime.path}.` };
      } catch (error) {
        return { provider: spec.id, available: false, authenticated: null, detail: error instanceof Error ? error.message : String(error) };
      }
    },
    run: (request) => client.run(request)
  };
  return {
    descriptor: {
      id: spec.id, label: spec.label, transport: "acp", roles: spec.roles, affinity: spec.affinity,
      // An agent without a reviewed policy only joins Automatico when the operator turns it on.
      automaticByDefault: false,
      loginCommand: spec.loginCommand, loginHint: spec.loginHint,
      executableNames: [executableName(spec.executable)]
    },
    adapter: new AcpAgentAdapter(base, {
      client, sessionConfirmsLogin: spec.sessionConfirmsLogin, catalogPolicy: { selectableModes: [spec.requiredMode] }
    })
  };
}

/** Reads `.eleazar/providers.json`. A missing file means no extra providers; a bad entry is reported and left out. */
export async function readCustomProviders(path: string, reserved: readonly string[]): Promise<{ specs: CustomProviderSpec[]; warnings: string[] }> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT"
      ? { specs: [], warnings: [] }
      : { specs: [], warnings: [`Nao foi possivel ler ${path}.`] };
  }
  let entries: unknown;
  try { entries = (JSON.parse(text.replace(/^﻿/, "")) as { providers?: unknown } | null)?.providers; } catch { entries = null; }
  if (!Array.isArray(entries)) return { specs: [], warnings: [`${path} deve ser um JSON com a lista "providers".`] };
  const specs: CustomProviderSpec[] = [];
  const warnings: string[] = [];
  entries.forEach((entry: unknown, index) => {
    try {
      const spec = parseCustomProvider(entry);
      if (reserved.includes(spec.id) || specs.some((item) => item.id === spec.id)) throw new Error(`id ja usado: ${spec.id}`);
      specs.push(spec);
    } catch (error) {
      warnings.push(`Provedor ${index + 1} de ${path} ignorado: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return { specs, warnings };
}

export function parseCustomProvider(value: unknown): CustomProviderSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("deve ser um objeto");
  const raw = value as Record<string, unknown>;
  const text = (name: string, limit: number): string => {
    const field = raw[name];
    if (typeof field !== "string" || !field.trim() || field.length > limit || !safeText.test(field)) throw new Error(`campo ${name} invalido`);
    return field.trim();
  };
  const list = (name: string): string[] => {
    const field = raw[name] ?? [];
    if (!Array.isArray(field) || field.length > 20 || !field.every((item) => typeof item === "string" && item.length <= 500 && safeText.test(item))) {
      throw new Error(`campo ${name} invalido`);
    }
    return field as string[];
  };
  const id = text("id", 32);
  if (!isProviderName(id)) throw new Error("id deve usar letras minusculas, numeros e hifens");
  const executable = text("executable", 500);
  if (!isAbsolute(executable) && !/^[\w.-]+$/.test(executable)) throw new Error("executable deve ser um comando do PATH ou um caminho absoluto");
  if (/\.(?:cmd|bat|ps1|sh)$/i.test(executable)) throw new Error("executable deve ser um binario nativo, nunca um script de shell");
  const args = list("args");
  const requiredMode = text("requiredMode", 64);
  const blocked = [...args, requiredMode].find((item) => bypass.test(item));
  if (blocked) throw new Error(`a politica generica nao aceita "${blocked}"`);
  const roles = (raw.roles ?? {}) as Record<string, unknown>;
  const affinity: Partial<Record<TaskKind, number>> = {};
  for (const [kind, weight] of Object.entries((raw.affinity ?? {}) as Record<string, unknown>)) {
    if (!(taskKinds as readonly string[]).includes(kind) || typeof weight !== "number" || !(weight >= 0 && weight <= 100)) {
      throw new Error("affinity deve dar de 0 a 100 a tipos de tarefa conhecidos");
    }
    affinity[kind as TaskKind] = weight;
  }
  const versionArgs = list("versionArgs");
  return {
    id, label: text("label", 60), executable, args, requiredMode, affinity,
    versionArgs: versionArgs.length ? versionArgs : ["--version"],
    minimumVersion: raw.minimumVersion === undefined ? null : text("minimumVersion", 32),
    loginCommand: text("loginCommand", 200), loginHint: text("loginHint", 300),
    sessionConfirmsLogin: raw.sessionConfirmsLogin === true,
    roles: { implementer: roles.implementer !== false, reviewer: roles.reviewer === true }
  };
}

async function resolveCustomRuntime(spec: CustomProviderSpec, override: string | null): Promise<AcpRuntime> {
  const path = override ?? (isAbsolute(spec.executable) ? spec.executable : findOnPath(spec.executable));
  if (!path) throw new Error(`${spec.label}: o comando ${spec.executable} nao foi encontrado no PATH.`);
  const source = override ? "override" : isAbsolute(spec.executable) ? "descriptor" : "path";
  let version: string | undefined;
  try {
    await access(path);
    const result = await runProcess(path, spec.versionArgs, { timeoutMs: 5_000, env: operationalEnvironment(), maxOutputBytes: 64 * 1024 });
    if (result.exitCode === 0 && !result.timedOut) version = /\d+\.\d+\.\d+/.exec(result.stdout)?.[0];
  } catch { /* Reported below. */ }
  if (!version) throw new Error(`${spec.label}: ${path} nao informou uma versao.`);
  if (spec.minimumVersion && version.localeCompare(spec.minimumVersion, undefined, { numeric: true }) < 0) {
    throw new Error(`${spec.label} ${version} nao e suportado; instale a versao ${spec.minimumVersion} ou superior.`);
  }
  return { path, version, source };
}

function executableName(executable: string): string {
  const name = basename(executable);
  return process.platform === "win32" && !/\.exe$/i.test(name) ? `${name}.exe` : name;
}
