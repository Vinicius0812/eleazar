import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentAdapter, AgentHealth, AgentRunRequest, AgentRunResult, ProviderName, TaskKind } from "../src/core/contracts.js";
import { ControlRoomService } from "../src/core/control-room-service.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { ProviderStatusService } from "../src/control-room/provider-status.js";
import { SqliteControlRoomStore } from "../src/persistence/sqlite-control-room-store.js";
import { registryOf } from "./helpers.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("provider status service", () => {
  it("prefere limites reais do Codex e usa somente tokens observados para Antigravity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eleazar-provider-status-")); temporaryDirectories.push(directory);
    const store = new SqliteControlRoomStore(join(directory, ".eleazar", "control-room.sqlite"));
    const service = new ControlRoomService(store, undefined, { useWorktrees: false });
    const project = service.registerProject({ name: "Core", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "Tokens", prompt: "Teste" });
    const running = await service.dispatch(task.id, { selectedProvider: "antigravity", reason: "teste", candidates: [], requestedActions: [] });
    service.finishProviderRun(task.id, running.dispatchLease!, { provider: "antigravity", status: "success", response: "ok", durationMs: 1, usage: { total: 42 } });

    const statuses = await new ProviderStatusService(new Orchestrator(registryOf([adapter("codex"), adapter("antigravity")])), service, {
      read: async () => ({ usedPercent: 35, resetAt: "2026-09-21T00:00:00.000Z", windowDurationMins: 300, lifetimeTokens: 500, todayTokens: 120 })
    }).list();

    expect(statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "codex", usage: expect.objectContaining({ source: "codex_account", usedPercent: 35, resetAt: "2026-09-21T00:00:00.000Z" }) }),
      expect.objectContaining({ provider: "antigravity", usage: expect.objectContaining({ source: "eleazar_executions", totalTokens: 42, resetAt: null }) })
    ]));
    store.close();
  });

  it("conta os tokens de hoje contra o orcamento diario salvo e entrega o sinal ao roteador", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eleazar-provider-status-")); temporaryDirectories.push(directory);
    const store = new SqliteControlRoomStore(join(directory, ".eleazar", "control-room.sqlite"));
    const service = new ControlRoomService(store, undefined, { useWorktrees: false });
    const project = service.registerProject({ name: "Core", path: process.cwd() });
    const task = service.createTask({ projectId: project.id, title: "Tokens", prompt: "Teste" });
    const running = await service.dispatch(task.id, { selectedProvider: "antigravity", reason: "teste", candidates: [], requestedActions: [] });
    service.finishProviderRun(task.id, running.dispatchLease!, { provider: "antigravity", status: "success", response: "ok", durationMs: 1, usage: { total: 900 } });
    const registry = registryOf([adapter("codex"), adapter("antigravity")], (id) => store.getProviderPreferences(id));
    const status = new ProviderStatusService(new Orchestrator(registry), service, { read: async () => null });
    expect(status.quotaSignal("antigravity")).toBeNull();
    await status.updatePreferences("antigravity", { dailyTokenBudget: 1_000 });
    expect(store.getProviderPreferences("antigravity")).toMatchObject({ dailyTokenBudget: 1_000 });
    expect(status.quotaSignal("antigravity")).toEqual({ usedPercent: 90, source: "budget" });
    const listed = (await status.list(true)).find((item) => item.provider === "antigravity");
    expect(listed?.usage).toMatchObject({ todayTokens: 900, quota: { usedPercent: 90, state: "low", dailyTokenBudget: 1_000 } });
    await status.updatePreferences("antigravity", { dailyTokenBudget: null });
    expect(store.getProviderPreferences("antigravity")?.dailyTokenBudget).toBeUndefined();
    store.close();
  });

  it("mantem o provider disponivel sem inventar quota quando a leitura de conta falha", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eleazar-provider-status-")); temporaryDirectories.push(directory);
    const store = new SqliteControlRoomStore(join(directory, ".eleazar", "control-room.sqlite"));
    const service = new ControlRoomService(store, undefined, { useWorktrees: false });
    const statuses = await new ProviderStatusService(new Orchestrator(registryOf([adapter("codex"), adapter("antigravity")])), service, { read: async () => null }).list();
    expect(statuses.find((status) => status.provider === "codex")?.usage).toMatchObject({ source: "eleazar_executions", usedPercent: null, resetAt: null, totalTokens: 0 });
    store.close();
  });
});

function adapter(provider: ProviderName): AgentAdapter {
  return {
    provider,
    supportedTasks: new Set<TaskKind>(["unknown"]),
    health: async (): Promise<AgentHealth> => ({ provider, available: true, authenticated: true, version: "test", detail: "Teste" }),
    run: async (_request: AgentRunRequest): Promise<AgentRunResult> => ({ provider, status: "success", response: "ok", durationMs: 1 })
  };
}

describe("quotaFor", () => {
  it("usa o mais apertado entre o limite da conta e o orcamento diario", async () => {
    const { quotaFor } = await import("../src/control-room/provider-status.js");
    expect(quotaFor(null, null, 500)).toBeNull();
    expect(quotaFor(null, 1_000, 850)).toMatchObject({ usedPercent: 85, source: "budget", state: "low", todayTokens: 850 });
    expect(quotaFor(40, 1_000, 1_200)).toMatchObject({ usedPercent: 120, source: "budget", state: "exhausted" });
    expect(quotaFor(90, 1_000, 100)).toMatchObject({ usedPercent: 90, source: "account", state: "low" });
    expect(quotaFor(10, null, 0)).toMatchObject({ usedPercent: 10, source: "account", state: "ok", dailyTokenBudget: null });
  });
});
