import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ClaudeAcpClient } from "../src/adapters/claude-acp.js";
import { CodexAcpClient } from "../src/adapters/codex-acp.js";
import { ControlRoomTaskExecutor, type ControlRoomTaskRunner } from "../src/control-room/task-executor.js";
import type { ControlRoomService } from "../src/core/control-room-service.js";
import { acpRegistry } from "./helpers.js";

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

const entryPath =fileURLToPath(new URL("./fixtures/fake-claude-acp-agent.mjs", import.meta.url));
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
    const executor = new ControlRoomTaskExecutor(service, runner, acpRegistry({ codex: codex, claude: claude }));
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
  it("does not attribute history re-emitted by session/load to the new turn, and still confirms the manual mode", async () => {
    const updates: Array<{ kind: string; payload: unknown }> = [];
    const onPermission = vi.fn(async () => "allow");
    const result = await client().run({ cwd: process.cwd(), prompt: "Edit", sessionId: "replay-session",
      onUpdate: (update) => updates.push({ kind: update.kind, payload: update.payload }), onPermission });
    expect(result).toMatchObject({ status: "success", sessionId: "replay-session", response: "Claude partial allowed pre:cancelled",
      usage: { input: 12, output: 3, cacheRead: 2, total: 15 } });
    expect(JSON.stringify(updates)).not.toContain("OLD_");
    expect(updates.map((item) => item.kind)).not.toContain("usage_update");
    expect(updates[0]).toMatchObject({ kind: "session_ready", payload: { configOptions: expect.arrayContaining([expect.objectContaining({ id: "mode", currentValue: "default" })]) } });
    expect(onPermission).toHaveBeenCalledTimes(1);
    expect(onPermission).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: "edit-1" }));
  });
  it("ignores a message, tool and permission that arrive after the turn's terminal response", async () => {
    await withTempCwd("late-report.json", async (cwd, report) => {
      const updates: string[] = [];
      const onPermission = vi.fn(async () => "allow");
      const result = await client().run({ cwd, prompt: "LATE", onUpdate: (update) => updates.push(JSON.stringify(update)), onPermission });
      expect(result).toMatchObject({ status: "success", response: "Claude partial allowed" });
      expect(JSON.stringify([result, updates])).not.toContain("LATE_");
      expect(onPermission).toHaveBeenCalledTimes(1); // the active turn's permission only
      expect(onPermission).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: "edit-1" }));
      expect(readReport(report)).toEqual({ outcome: "cancelled" }); // positive proof: the late request was received and cancelled
    });
  });
  it("cancels a choice that was still pending when the run was aborted and ended", async () => {
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
      expect(result).toMatchObject({ status: "error", error: expect.stringContaining("cancelada"), response: "Claude partial " }); // partial output kept
      expect(readReport(report)).toEqual({ outcome: "cancelled" }); // the late "allow" was never sent as a selection
    });
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
