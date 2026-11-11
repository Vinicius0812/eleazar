import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { CodexAcpClient } from "../src/adapters/codex-acp.js";

const entryPath = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
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
