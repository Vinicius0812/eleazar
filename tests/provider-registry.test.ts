import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AcpAgentAdapter } from "../src/adapters/acp-agent-adapter.js";
import { isAuthenticationRequired, type AcpSessionInfo } from "../src/adapters/acp-client.js";
import { builtInProviderIds, reportsAccountTier } from "../src/adapters/built-in-providers.js";
import { customProvider, parseCustomProvider, readCustomProviders } from "../src/adapters/custom-providers.js";
import { findOnPath } from "../src/adapters/executable-path.js";
import { createControlRoomServer } from "../src/control-room/local-api.js";
import { createLocalControlRoomService } from "../src/control-room/local-service.js";
import { ProviderStatusService } from "../src/control-room/provider-status.js";
import { ControlRoomTaskExecutor } from "../src/control-room/task-executor.js";
import { taskKinds, type AgentAdapter, type AgentHealth } from "../src/core/contracts.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { ProviderRegistry } from "../src/core/provider-registry.js";
import { readProviderPreferences, SqliteControlRoomStore } from "../src/persistence/sqlite-control-room-store.js";
import { descriptorOf, preferences, registryOf } from "./helpers.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function temporary(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "eleazar-providers-")); directories.push(path);
  return path;
}

const entryPath = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
/** A fourth agent described by data only, backed by a fake ACP process. */
const fourth = {
  id: "quarto", label: "Quarto agente", executable: process.execPath, args: [entryPath], requiredMode: "workspace-write",
  loginCommand: "quarto login", loginHint: "Entre na sua conta.", sessionConfirmsLogin: true, affinity: { implementation: 70 }
};

describe("quarto agente ACP por descritor", () => {
  it("entra no roteador, no executor e na API sem mudar nenhum deles", async () => {
    const store = new SqliteControlRoomStore(join(await temporary(), ".eleazar", "control-room.sqlite"));
    const service = createLocalControlRoomService(store);
    const registry = new ProviderRegistry([customProvider(parseCustomProvider(fourth))], (id) => store.getProviderPreferences(id));
    const orchestrator = new Orchestrator(registry);
    const executor = new ControlRoomTaskExecutor(service, orchestrator, registry);
    const providers = new ProviderStatusService(orchestrator, service, { read: async () => null });
    const server = createControlRoomServer(service, executor, providers);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No address");
    const base = `http://127.0.0.1:${address.port}/api/control-room`;
    const post = (path: string, body: object) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const folder = await temporary();
      const project = service.registerProject({ name: "P", path: folder });
      const before = await (await fetch(`${base}/providers/status`)).json();
      expect(before).toMatchObject([{ provider: "quarto", label: "Quarto agente", available: true, authenticated: null, verification: null,
        login: { command: "quarto login" }, preferences: { enabled: true, automatic: false } }]);

      const verified = await (await post("/providers/quarto/verify", {})).json();
      expect(verified).toMatchObject([{ authenticated: true, verification: { connected: true, authenticated: true, models: [{ id: "base" }, { id: "gpt-6.1-sol" }] } }]);
      const config = await (await fetch(`${base}/providers/quarto/config?directoryId=${project.directories[0]!.id}`)).json();
      expect(config).toMatchObject({ provider: "quarto", defaultModel: "base", models: [{ id: "base" }, { id: "gpt-6.1-sol" }] });

      const task = service.createTask({ projectId: project.id, title: "T", prompt: "Implemente", kind: "implementation" });
      await expect(executor.start(task.id)).rejects.toThrow("Nenhum provedor ativo no modo Automatico");
      expect((await post("/providers/quarto/settings", { automatic: true, defaultModel: "gpt-6.1-sol" })).status).toBe(200);
      expect((await post(`/tasks/${task.id}/execute`, { provider: "auto" })).status).toBe(202);
      const permission = await vi.waitFor(() => {
        const execution = store.listExecutions(task.id)[0]!;
        const pending = store.listExecutionPermissions(execution.id)[0];
        if (!pending) throw new Error("sem permissao");
        return pending;
      }, { timeout: 8_000 });
      executor.respondPermission(permission.executionId, permission.id, "allow");
      await vi.waitFor(() => expect(store.listExecutions(task.id)).toMatchObject([
        { provider: "quarto", transport: "acp", model: "gpt-6.1-sol", status: "completed", output: "parte 1 parte 2 permitiu" }]), { timeout: 8_000 });
      expect((await post("/providers/inexistente/verify", {})).status).toBe(404);
      expect((await fetch(`${base}/providers/inexistente/config?directoryId=${project.directories[0]!.id}`)).status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    }
  }, 20_000);

  it("le o arquivo de provedores, ignorando entradas invalidas com aviso", async () => {
    const path = join(await temporary(), "providers.json");
    expect(await readCustomProviders(path, builtInProviderIds)).toEqual({ specs: [], warnings: [] });
    await writeFile(path, "{");
    expect((await readCustomProviders(path, builtInProviderIds)).warnings).toHaveLength(1);
    await writeFile(path, JSON.stringify({ providers: [fourth, fourth, { ...fourth, id: "codex" }, { ...fourth, id: "Auto" }, { id: "vazio" }] }));
    const { specs, warnings } = await readCustomProviders(path, builtInProviderIds);
    expect(specs).toMatchObject([{ id: "quarto", versionArgs: ["--version"], minimumVersion: null, roles: { implementer: true, reviewer: false } }]);
    expect(warnings).toHaveLength(4);
  });

  it("recusa o que escaparia da politica generica", () => {
    for (const args of [["--yolo"], ["--dangerously-skip-permissions"], ["--approval-mode=auto_edit"], ["--no-sandbox"], ["a\nb"], "x"]) {
      expect(() => parseCustomProvider({ ...fourth, args })).toThrow();
    }
    expect(() => parseCustomProvider({ ...fourth, requiredMode: "bypassPermissions" })).toThrow("bypassPermissions");
    expect(() => parseCustomProvider({ ...fourth, executable: "C:\\tools\\agent.cmd" })).toThrow();
    expect(() => parseCustomProvider({ ...fourth, executable: "./agent && calc" })).toThrow("executable");
    expect(() => parseCustomProvider({ ...fourth, affinity: { implementation: 1_000 } })).toThrow("affinity");
    expect(parseCustomProvider({ ...fourth, sessionConfirmsLogin: "sim" }).sessionConfirmsLogin).toBe(false);
  });

  it("informa quando a versao minima nao e atendida", async () => {
    const { adapter } = customProvider(parseCustomProvider({ ...fourth, minimumVersion: "999.0.0" }));
    expect(await adapter.health()).toMatchObject({ available: false, detail: expect.stringContaining("instale a versao 999.0.0") });
  });

  it("resolve comandos do PATH para um caminho absoluto, sem a pasta atual", async () => {
    const folder = await temporary();
    const file = process.platform === "win32" ? "agente.exe" : "agente";
    await writeFile(join(folder, file), "");
    expect(findOnPath("agente", folder)).toBe(join(folder, file));
    expect(findOnPath("agente", ".")).toBeNull();
    expect(findOnPath(basename(entryPath), "")).toBeNull();
  });
});

describe("registro de provedores", () => {
  it("recusa ids invalidos, repetidos ou de outro adaptador", () => {
    const adapter = { provider: "codex" } as AgentAdapter;
    const registration = { descriptor: descriptorOf("codex"), adapter };
    expect(() => new ProviderRegistry([registration, registration])).toThrow("duas vezes");
    expect(() => new ProviderRegistry([{ descriptor: descriptorOf("claude"), adapter }])).toThrow("registrado como claude");
    expect(() => new ProviderRegistry([{ descriptor: descriptorOf("auto"), adapter: { provider: "auto" } as AgentAdapter }])).toThrow("invalido");
  });

  it("usa os padroes do descritor ate o operador escolher", () => {
    const adapters = [{ provider: "codex" }, { provider: "outro" }] as AgentAdapter[];
    const registry = registryOf(adapters, (id) => id === "codex" ? preferences({ automatic: false }) : null);
    expect(registry.preferences("codex").automatic).toBe(false);
    expect(registry.preferences("outro")).toEqual({ enabled: true, automatic: false, executablePath: null, defaultModel: null });
    expect(registry.label("desconhecido")).toBe("desconhecido");
  });
});

describe("verificacao de conexao", () => {
  const info = { runtime: { path: "agy", version: "1", source: "path" }, protocolVersion: 1, agentName: "x", capabilities: {}, sessionId: "s", modes: null,
    configOptions: [{ id: "model", category: "model", name: "Model", type: "select", currentValue: "a", options: [{ value: "a", name: "A" }] }] } as unknown as AcpSessionInfo;
  const authError = Object.assign(new Error("Authentication required"), { code: -32000 });
  function setup(authenticated: boolean | null, inspect: () => Promise<AcpSessionInfo>, sessionConfirmsLogin = true) {
    let time = 0;
    const health = vi.fn(async (): Promise<AgentHealth> => ({ provider: "agy", available: true, authenticated, version: "1", executablePath: "agy", detail: "cli" }));
    const run = vi.fn<AgentAdapter["run"]>(async () => ({ provider: "agy", status: "success", response: "", durationMs: 1 }));
    const spy = vi.fn(inspect);
    const adapter = new AcpAgentAdapter({ provider: "agy", supportedTasks: new Set(taskKinds), health, run },
      { client: { inspect: spy }, confirmsLogin: () => sessionConfirmsLogin, catalogPolicy: { selectableModes: [] }, now: () => time });
    return { adapter, health, run, inspect: spy, advance: (ms: number) => { time += ms; } };
  }

  it("confirma o login ao abrir a sessao numa pasta vazia e reaproveita o resultado", async () => {
    const { adapter, inspect, advance } = setup(null, async () => info);
    expect((await adapter.health()).authenticated).toBeNull();
    expect(await adapter.verify()).toMatchObject({ connected: true, authenticated: true, models: [{ id: "a" }], defaultModel: "a" });
    expect(inspect).toHaveBeenCalledWith(expect.stringContaining("eleazar-"), undefined, expect.any(Number));
    expect((await adapter.health()).authenticated).toBe(true);
    await adapter.verify();
    expect(inspect).toHaveBeenCalledTimes(1);
    await adapter.verify(true);
    expect(inspect).toHaveBeenCalledTimes(2);
    advance(11 * 60_000);
    expect((await adapter.health()).authenticated).toBeNull();
    await adapter.verify();
    expect(inspect).toHaveBeenCalledTimes(3);
  });

  it("descarta a confirmacao quando o executavel muda ou um turno falha", async () => {
    const { adapter, health, run } = setup(null, async () => info);
    await adapter.verify();
    health.mockResolvedValueOnce({ provider: "agy", available: true, authenticated: null, version: "1", executablePath: "outro", detail: "cli" });
    expect((await adapter.health()).authenticated).toBeNull();
    expect((await adapter.health()).authenticated).toBe(true);
    run.mockResolvedValueOnce({ provider: "agy", status: "error", response: "", durationMs: 1 });
    await adapter.run({ prompt: "x", cwd: "." });
    expect((await adapter.health()).authenticated).toBeNull();
    expect(adapter.lastVerification()).toBeNull();
  });

  it("distingue falta de login, falha de conexao e login desconhecido", async () => {
    expect(await setup(true, async () => { throw authError; }).adapter.verify()).toMatchObject({ connected: true, authenticated: false });
    expect(await setup(null, async () => { throw new Error("spawn ENOENT"); }).adapter.verify()).toMatchObject({ connected: false, authenticated: null, detail: expect.stringContaining("ENOENT") });
    expect(await setup(null, async () => info, false).adapter.verify()).toMatchObject({ connected: true, authenticated: null });
    // A session that opens does not override a CLI that says nobody is signed in.
    expect(await setup(false, async () => info).adapter.verify()).toMatchObject({ connected: true, authenticated: false });
  });

  it("repete cedo uma verificacao que nao confirmou o login", async () => {
    const answers = [async () => { throw authError; }, async () => info];
    const { adapter, advance } = setup(null, () => (answers.shift() ?? (async () => info))());
    expect((await adapter.verify()).authenticated).toBe(false);
    expect((await adapter.verify()).authenticated).toBe(false);
    advance(31_000);
    expect((await adapter.verify()).authenticated).toBe(true);
  });

  it("so aceita o plano da conta como prova de login do Antigravity", () => {
    expect(reportsAccountTier({ meta: { antigravity: { tier: { id: "g1-pro", name: "Pro" } } } })).toBe(true);
    for (const meta of [null, {}, { antigravity: null }, { antigravity: { tier: true } }, { antigravity: { tier: { id: "" } } }]) {
      expect(reportsAccountTier({ meta })).toBe(false);
    }
  });

  it("reconhece somente a resposta de autenticacao do protocolo", () => {
    expect(isAuthenticationRequired(authError)).toBe(true);
    expect(isAuthenticationRequired(new Error("falha", { cause: authError }))).toBe(true);
    expect(isAuthenticationRequired(Object.assign(new Error("Server busy"), { code: -32000 }))).toBe(false);
    expect(isAuthenticationRequired(new Error("Authentication required"))).toBe(false);
  });
});

describe("preferencias do operador", () => {
  it("persistem no SQLite, sem segredos, e podem ser lidas sem escrever no banco", async () => {
    const path = join(await temporary(), ".eleazar", "control-room.sqlite");
    const store = new SqliteControlRoomStore(path);
    expect(store.getProviderPreferences("codex")).toBeNull();
    const saved = preferences({ automatic: false, executablePath: "C:\\codex.exe", defaultModel: "m" });
    store.saveProviderPreferences("codex", preferences(), "2026-01-01T00:00:00.000Z");
    store.saveProviderPreferences("codex", saved, "2026-01-02T00:00:00.000Z");
    store.close();
    expect(readProviderPreferences(path)).toEqual(new Map([["codex", saved]]));
  });

  it("validam executavel e modelo antes de gravar", async () => {
    const folder = await temporary();
    const store = new SqliteControlRoomStore(join(folder, ".eleazar", "control-room.sqlite"));
    const service = createLocalControlRoomService(store);
    const adapter: AgentAdapter = { provider: "codex", supportedTasks: new Set(taskKinds),
      health: async () => ({ provider: "codex", available: true, authenticated: true, detail: "ok" }),
      run: async () => ({ provider: "codex", status: "success", response: "", durationMs: 1 }) };
    const registry = registryOf([adapter], (id) => store.getProviderPreferences(id));
    const status = new ProviderStatusService(new Orchestrator(registry), service, { read: async () => null });
    try {
      const file = process.platform === "win32" ? "codex.exe" : "codex";
      const executable = join(folder, file);
      await expect(status.updatePreferences("codex", { executablePath: executable })).rejects.toThrow("nao existe");
      await writeFile(executable, "");
      await writeFile(join(folder, "cmd.exe"), "");
      await expect(status.updatePreferences("codex", { executablePath: join(folder, "cmd.exe") })).rejects.toThrow("deve se chamar");
      await expect(status.updatePreferences("codex", { executablePath: file })).rejects.toThrow("absoluto");
      await expect(status.updatePreferences("codex", { executablePath: `\\\\servidor\\share\\${file}` })).rejects.toThrow("absoluto");
      await expect(status.updatePreferences("codex", { defaultModel: "inventado" })).rejects.toThrow("Modelo nao anunciado");
      await expect(status.updatePreferences("outro", { enabled: false })).rejects.toThrow("nao registrado");
      expect(store.getProviderPreferences("codex")).toBeNull();
      const [saved] = await status.updatePreferences("codex", { enabled: false, executablePath: executable });
      expect(saved!.preferences).toEqual({ enabled: false, automatic: true, executablePath: executable, defaultModel: null });
      const [cleared] = await status.updatePreferences("codex", { executablePath: null });
      expect(cleared!.preferences).toMatchObject({ enabled: false, executablePath: null });
      await expect(status.verify("codex")).rejects.toThrow("nao oferece verificacao");
    } finally { store.close(); }
  });
});
