import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { CodexAcpClient } from "../src/adapters/codex-acp.js";

// Test seam: before the real process termination, optionally wait (bounded) for a report file that the fixture
// writes after it receives the client's response to a permission request. That proves the late traffic was
// processed and which outcome was sent; the real termination still runs afterwards, so nothing is left behind.
const cleanup = vi.hoisted(() => ({ waitForReport: "", entered: undefined as (() => void) | undefined }));
vi.mock("../src/adapters/process-tree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/adapters/process-tree.js")>();
  const { existsSync } = await import("node:fs");
  return { ...actual, terminateProcessTree: async (...args: Parameters<typeof actual.terminateProcessTree>) => {
    cleanup.entered?.();
    for (let waited = 0; cleanup.waitForReport && !existsSync(cleanup.waitForReport) && waited < 3_000; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return actual.terminateProcessTree(...args);
  } };
});

async function withTempCwd<T>(report: string, body: (cwd: string, reportPath: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "eleazar-acp-late-"));
  const reportPath = join(cwd, report);
  cleanup.waitForReport = reportPath;
  try { return await body(cwd, reportPath); } finally {
    cleanup.waitForReport = ""; cleanup.entered = undefined;
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
const readReport = (path: string) => JSON.parse(readFileSync(path, "utf8")) as { outcome: string };

const entryPath =fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
function client() {
  return new CodexAcpClient({ entryPath, resolveRuntime: async () => ({ path: process.execPath, version: "codex-cli 0.167.0", source: "override" }) });
}

describe("Codex ACP stdio", () => {
  it("negocia versao, capacidades e modelos sem enviar prompt", async () => {
    const info = await client().inspect(process.cwd());
    expect(info).toMatchObject({ agentName: "fake-acp", sessionId: "fake-session", capabilities: { loadSession: true } });
    expect(info.configOptions[0]).toMatchObject({ id: "model", category: "model" });
  });

  it("recebe mensagens fragmentadas e updates, seleciona modelo anunciado e encaminha permissao", async () => {
    const updates: string[] = [];
    const onPermission = vi.fn(async () => "allow");
    const result = await client().run({ cwd: process.cwd(), prompt: "Fazer", model: "gpt-6.1-sol", sessionId: "anterior",
      onUpdate: (update) => updates.push(update.kind), onPermission });
    expect(result).toMatchObject({ status: "success", response: "parte 1 parte 2 permitiu", sessionId: "anterior" });
    expect(updates).toEqual(expect.arrayContaining(["session_ready", "agent_message_chunk", "tool_call", "tool_call_update"]));
    expect(onPermission).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: "tool-1", sessionId: "anterior" }));
  });

  it("nao atribui ao novo turno o historico reemitido por session/load", async () => {
    const updates: Array<{ kind: string; payload: unknown }> = [];
    const onPermission = vi.fn(async () => "allow");
    const result = await client().run({ cwd: process.cwd(), prompt: "Fazer", sessionId: "replay-session",
      onUpdate: (update) => updates.push({ kind: update.kind, payload: update.payload }), onPermission });
    expect(result).toMatchObject({ status: "success", sessionId: "replay-session", response: "parte 1 parte 2 permitiu pre:cancelled" });
    expect(result.response).not.toContain("OLD_HISTORY");
    expect(result.usage).toBeUndefined();
    const seen = JSON.stringify(updates);
    expect(seen).not.toContain("OLD_");
    expect(updates.map((item) => item.kind)).not.toContain("usage_update");
    expect(updates[0]?.kind).toBe("session_ready"); // the turn's visible events start after the ready marker
    // Only the new turn's permission reaches the executor; the pre-prompt one was cancelled by the client.
    expect(onPermission).toHaveBeenCalledTimes(1);
    expect(onPermission).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: "tool-1" }));
  });

  it("ignora mensagem, ferramenta e permissao que chegam depois da resposta terminal do turno", async () => {
    await withTempCwd("late-report.json", async (cwd, report) => {
      const updates: string[] = [];
      const onPermission = vi.fn(async () => "allow");
      const result = await client().run({ cwd, prompt: "LATE", onUpdate: (update) => updates.push(JSON.stringify(update)), onPermission });
      expect(result).toMatchObject({ status: "success", response: "parte 1 parte 2 permitiu" });
      expect(JSON.stringify([result, updates])).not.toContain("LATE_");
      expect(onPermission).toHaveBeenCalledTimes(1); // the active turn's permission only
      expect(onPermission).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: "tool-1" }));
      expect(readReport(report)).toEqual({ outcome: "cancelled" }); // positive proof: the late request was received and cancelled
    });
  });

  it("cancela uma escolha que ainda estava pendente quando a execucao foi abortada e encerrada", async () => {
    await withTempCwd("slow-report.json", async (cwd, report) => {
      const controller = new AbortController();
      let release: (choice: string) => void = () => undefined;
      const onPermission = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
      const inTeardown = new Promise<void>((resolve) => { cleanup.entered = resolve; });
      const running = client().run({ cwd, prompt: "SLOW", signal: controller.signal, timeoutMs: 10_000, onPermission });
      await vi.waitFor(() => expect(onPermission).toHaveBeenCalledTimes(1));
      controller.abort();
      await inTeardown; // the turn window is closed and the connection is still open
      release("allow"); // the executor answers only now, after the run ended
      const result = await running;
      expect(result).toMatchObject({ status: "error", error: expect.stringContaining("cancelada"), response: "parte 1 parte 2" }); // partial output kept
      expect(readReport(report)).toEqual({ outcome: "cancelled" }); // the late "allow" was never sent as a selection
    });
  });

  it("nega permissao sem callback e rejeita modelo nao anunciado", async () => {
    expect(await client().run({ cwd: process.cwd(), prompt: "Fazer" })).toMatchObject({ status: "success", response: "parte 1 parte 2 negou" });
    expect(await client().run({ cwd: process.cwd(), prompt: "Fazer", model: "inventado" })).toMatchObject({ status: "error", error: expect.stringContaining("nao anunciado") });
  });

  it("cancela, expira e informa encerramento prematuro", async () => {
    const controller = new AbortController();
    const cancelled = client().run({ cwd: process.cwd(), prompt: "HANG", signal: controller.signal, timeoutMs: 3000 });
    setTimeout(() => controller.abort(), 100);
    expect(await cancelled).toMatchObject({ status: "error", error: expect.stringContaining("cancelada") });
    expect(await client().run({ cwd: process.cwd(), prompt: "HANG", timeoutMs: 100 })).toMatchObject({ status: "error", error: expect.stringContaining("esgotado") });
    expect(await client().run({ cwd: process.cwd(), prompt: "EXIT", timeoutMs: 2000 })).toMatchObject({ status: "error", error: expect.stringContaining("encerrou") });
  });
});
