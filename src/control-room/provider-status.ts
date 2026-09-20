import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import type { ControlRoomService } from "../core/control-room-service.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { ProviderStatus, ProviderUsageStatus } from "../core/control-room.js";

const require = createRequire(import.meta.url);
const codexCliPath = require.resolve("@openai/codex/bin/codex.js");

interface CodexAccountUsage {
  usedPercent: number | null;
  resetAt: string | null;
  windowDurationMins: number | null;
  lifetimeTokens: number | null;
  todayTokens: number | null;
}

export interface CodexUsageReader { read(): Promise<CodexAccountUsage | null>; }

/** Aggregates read-only provider health and locally observed token figures. */
export class ProviderStatusService {
  #cached: ProviderStatus[] | null = null;
  #cachedAt = 0;

  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly controlRoom: ControlRoomService,
    private readonly codexUsage: CodexUsageReader = new CodexAppServerUsageReader()
  ) {}

  async list(force = false): Promise<ProviderStatus[]> {
    if (!force && this.#cached && Date.now() - this.#cachedAt < 60_000) return this.#cached;
    const [health, codexAccount] = await Promise.all([this.orchestrator.health(), this.codexUsage.read().catch(() => null)]);
    const observed = observedTokens(this.controlRoom);
    const fetchedAt = new Date().toISOString();
    this.#cached = health.map((item) => {
      const localTotal = observed.get(item.provider) ?? 0;
      const usage = item.provider === "codex" && codexAccount
        ? codexUsage(codexAccount)
        : observedUsage(localTotal, item.available);
      return { provider: item.provider, available: item.available, authenticated: item.authenticated, version: item.version ?? null, detail: item.detail, fetchedAt, usage };
    });
    this.#cachedAt = Date.now();
    return this.#cached;
  }
}

function observedTokens(controlRoom: ControlRoomService): Map<ProviderStatus["provider"], number> {
  const totals = new Map<ProviderStatus["provider"], number>();
  for (const task of controlRoom.listTasks()) {
    for (const execution of controlRoom.store.listExecutions(task.id)) {
      if (!execution.provider || !execution.usage?.total) continue;
      totals.set(execution.provider, (totals.get(execution.provider) ?? 0) + execution.usage.total);
    }
  }
  return totals;
}

function codexUsage(account: CodexAccountUsage): ProviderUsageStatus {
  return { source: "codex_account", usedPercent: account.usedPercent, resetAt: account.resetAt, windowDurationMins: account.windowDurationMins, totalTokens: null, lifetimeTokens: account.lifetimeTokens, todayTokens: account.todayTokens };
}
function observedUsage(total: number, available: boolean): ProviderUsageStatus {
  return { source: available ? "eleazar_executions" : "unavailable", usedPercent: null, resetAt: null, windowDurationMins: null, totalTokens: available ? total : null, lifetimeTokens: null, todayTokens: null };
}

/** Minimal JSON-RPC client for the official local Codex App Server. It never invokes auth mutations. */
export class CodexAppServerUsageReader implements CodexUsageReader {
  async read(): Promise<CodexAccountUsage | null> {
    const client = new AppServerClient();
    try {
      await client.start();
      await client.request("initialize", { clientInfo: { name: "eleazar", version: "0.1.0" }, capabilities: {} });
      const [limits, usage] = await Promise.all([
        client.request("account/rateLimits/read", {}),
        client.request("account/usage/read", {})
      ]);
      return parseCodexUsage(limits, usage);
    } catch { return null; }
    finally { client.close(); }
  }
}

class AppServerClient {
  #child: ReturnType<typeof spawn> | null = null;
  #nextId = 1;
  #pending = new Map<number, { resolve(value: unknown): void; reject(reason: Error): void }>();
  #buffer = "";
  #timeout: ReturnType<typeof setTimeout> | null = null;

  async start(): Promise<void> {
    const child = spawn(process.execPath, [codexCliPath, "app-server", "--stdio"], { stdio: "pipe", windowsHide: true });
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    child.once("error", (error) => this.failAll(error));
    child.once("close", () => this.failAll(new Error("Codex App Server encerrou antes de responder.")));
    this.#timeout = setTimeout(() => this.failAll(new Error("Tempo esgotado ao consultar o Codex App Server.")), 5_000);
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.#child;
    const stdin = child?.stdin;
    if (!stdin || !stdin.writable) return Promise.reject(new Error("Codex App Server indisponivel."));
    const id = this.#nextId++;
    const request = new Promise<unknown>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return request;
  }

  close(): void {
    if (this.#timeout) clearTimeout(this.#timeout);
    this.#timeout = null;
    this.#child?.kill(); this.#child = null;
  }

  private receive(chunk: string): void {
    this.#buffer += chunk;
    let separator = this.#buffer.indexOf("\n");
    while (separator >= 0) {
      const line = this.#buffer.slice(0, separator).trim(); this.#buffer = this.#buffer.slice(separator + 1);
      if (line) this.handle(line);
      separator = this.#buffer.indexOf("\n");
    }
  }
  private handle(line: string): void {
    try {
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
      if (typeof message.id !== "number") return;
      const pending = this.#pending.get(message.id); if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "Erro no Codex App Server.")); else pending.resolve(message.result);
    } catch { /* Ignore non-protocol output. */ }
  }
  private failAll(error: Error): void { for (const pending of this.#pending.values()) pending.reject(error); this.#pending.clear(); }
}

function parseCodexUsage(limitsResult: unknown, usageResult: unknown): CodexAccountUsage | null {
  const limits = objectValue(limitsResult); const usage = objectValue(usageResult); if (!limits) return null;
  const rateLimits = objectValue(limits.rateLimits) ?? objectValue(objectValue(limits.rateLimitsByLimitId)?.codex);
  const primary = objectValue(rateLimits?.primary); if (!primary) return null;
  const summary = objectValue(usage?.summary); const buckets = Array.isArray(usage?.dailyUsageBuckets) ? usage.dailyUsageBuckets : [];
  const today = new Date().toISOString().slice(0, 10);
  const todayBucket = buckets.map(objectValue).find((item) => item?.startDate === today);
  return {
    usedPercent: numberValue(primary.usedPercent), resetAt: unixDate(primary.resetsAt), windowDurationMins: numberValue(primary.windowDurationMins),
    lifetimeTokens: numberValue(summary?.lifetimeTokens), todayTokens: numberValue(todayBucket?.tokens)
  };
}
function objectValue(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function numberValue(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function unixDate(value: unknown): string | null { const seconds = numberValue(value); return seconds === null ? null : new Date(seconds * 1_000).toISOString(); }
