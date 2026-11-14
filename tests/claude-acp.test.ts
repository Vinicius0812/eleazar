import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ClaudeAcpClient } from "../src/adapters/claude-acp.js";
import { CodexAcpClient } from "../src/adapters/codex-acp.js";
import { ControlRoomTaskExecutor, type ControlRoomTaskRunner } from "../src/control-room/task-executor.js";
import type { ControlRoomService } from "../src/core/control-room-service.js";

const entryPath = fileURLToPath(new URL("./fixtures/fake-claude-acp-agent.mjs", import.meta.url));
function client() {
  return new ClaudeAcpClient({ entryPath, resolveRuntime: async () => ({ path: process.execPath, version: "2.1.322", source: "user" }) });
}

describe("Claude ACP stdio", () => {
  it("announces models and load capability with restrictive policy", async () => {
    const info = await client().inspect(process.cwd());
    expect(info).toMatchObject({ agentName: "fake-claude", capabilities: { loadSession: true }, sessionId: "claude-session",
      modes: { currentModeId: "default" } });
    expect(info.configOptions[0]).toMatchObject({ id: "model", currentValue: "sonnet" });
    expect(info.configOptions.find((item) => item.id === "mode")).toMatchObject({ currentValue: "default" });
  });
  it("publishes only the manual Claude mode and safe Codex modes in provider catalogs", async () => {
    const service = { store: { listProjects: () => [{ directories: [{ id: "dir", path: process.cwd() }] }] } } as unknown as ControlRoomService;
    const runner = {} as ControlRoomTaskRunner;
    const inspect = async (provider: "codex" | "claude") => ({
      runtime: { path: provider, version: "1", source: "fixture" }, protocolVersion: 1, agentName: provider,
      capabilities: { loadSession: true }, sessionId: "catalog", modes: null,
      configOptions: [{ id: "mode", category: "mode", name: "Mode", type: "select", currentValue: provider === "claude" ? "default" : "workspace-write",
        options: [{ value: "default", name: "Manual" }, { value: "auto", name: "Auto" },
          { value: "read-only", name: "Read only" }, { value: "workspace-write", name: "Workspace write" }] },
        { id: "model", category: "model", name: "Model", type: "select", currentValue: "model-a", options: [{ value: "model-a", name: "A" }] }]
    });
    const codex = { inspect: () => inspect("codex") } as unknown as CodexAcpClient;
    const claude = { inspect: () => inspect("claude") } as unknown as ClaudeAcpClient;
    const executor = new ControlRoomTaskExecutor(service, runner, undefined, codex, claude);
    const codexConfig = await executor.providerConfig("codex", "dir");
    const claudeConfig = await executor.providerConfig("claude", "dir");
    expect(codexConfig.settings.find((item) => item.id === "mode")?.options.map((item) => item.id)).toEqual(["read-only", "workspace-write"]);
    expect(claudeConfig.settings.find((item) => item.id === "mode")).toMatchObject({ currentValue: "default", options: [{ id: "default" }] });
    expect(claudeConfig).toMatchObject({ defaultModel: "model-a", models: [{ id: "model-a", name: "A" }] });
  });
  it("surfaces a structured ACP startup failure reason without sending a prompt", async () => {
    await expect(client().inspect(process.cwd(), "simulate-startup-error")).rejects.toThrow("startupFailureReason=sandbox_required_unavailable");
  });
  it("sets manual mode, selects an announced model, streams updates and asks for scoped edits", async () => {
    const updates: string[] = [];
    const onPermission = vi.fn(async () => "allow");
    const result = await client().run({ cwd: process.cwd(), prompt: "Edit", model: "opus", sessionId: "prior-session",
      onUpdate: (update) => updates.push(update.kind), onPermission });
    expect(result).toMatchObject({ status: "success", sessionId: "prior-session", response: "Claude partial allowed",
      usage: { input: 12, output: 3, cacheRead: 2, total: 15 } });
    expect(updates).toContain("agent_message_chunk");
    expect(onPermission).toHaveBeenCalledWith(expect.objectContaining({ toolKind: "edit", locations: [expect.stringContaining("sample.txt")] }));
  });
  it("denies without a callback and rejects unannounced models", async () => {
    expect(await client().run({ cwd: process.cwd(), prompt: "Edit" })).toMatchObject({ status: "success", response: "Claude partial denied" });
    expect(await client().run({ cwd: process.cwd(), prompt: "Edit", model: "invented" })).toMatchObject({ status: "error", error: expect.stringContaining("nao anunciado") });
  });
  it("fails closed for an edit outside authorized roots", async () => {
    const onPermission = vi.fn(async () => "allow");
    expect(await client().run({ cwd: process.cwd(), prompt: "OUTSIDE", onPermission })).toMatchObject({ status: "success", response: "Claude partial denied" });
    expect(onPermission).not.toHaveBeenCalled();
  });
  it("reports abort, timeout and premature exit without model calls", async () => {
    const controller = new AbortController();
    const aborted = client().run({ cwd: process.cwd(), prompt: "HANG", signal: controller.signal, timeoutMs: 3000 });
    setTimeout(() => controller.abort(), 100);
    expect(await aborted).toMatchObject({ status: "error", error: expect.stringContaining("cancelada") });
    expect(await client().run({ cwd: process.cwd(), prompt: "HANG", timeoutMs: 100 })).toMatchObject({ status: "error", error: expect.stringContaining("esgotado") });
    expect(await client().run({ cwd: process.cwd(), prompt: "EXIT" })).toMatchObject({ status: "error", error: expect.stringContaining("encerrou") });
  });
});
