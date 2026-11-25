import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { AntigravityAcpClient, antigravityAcpLaunch } from "../src/adapters/antigravity-acp.js";
import { antigravityAcpEnvironment, resolveAntigravityRuntime } from "../src/adapters/antigravity-runtime.js";
import { AntigravityAdapter } from "../src/adapters/antigravity.js";
import { localPath, nodeAcpLaunch, ResponseText } from "../src/adapters/acp-client.js";
import type { ProcessResult } from "../src/adapters/process-runner.js";
import { ControlRoomTaskExecutor, type ControlRoomTaskRunner } from "../src/control-room/task-executor.js";
import type { ControlRoomService } from "../src/core/control-room-service.js";
import { acpRegistry } from "./helpers.js";

const entryPath = fileURLToPath(new URL("./fixtures/fake-antigravity-acp-agent.mjs", import.meta.url));
const runtime = { path: process.execPath, version: "1.5.9", source: "user" as const };
const client = () => new AntigravityAcpClient({ launch: () => nodeAcpLaunch(entryPath), resolveRuntime: async () => runtime });

describe("Antigravity ACP stdio", () => {
  it("launches the native agy server in the sandbox and never skips permissions", () => {
    expect(antigravityAcpLaunch({ path: "C:/agy.exe" })).toEqual({ command: "C:/agy.exe", args: ["acp", "--sandbox"] });
  });
  it("announces models, load capability and the asking mode", async () => {
    const info = await client().inspect(process.cwd());
    expect(info).toMatchObject({ agentName: "Antigravity ACP Server", capabilities: { loadSession: true },
      sessionId: "agy-session", modes: { currentModeId: "default" } });
    expect(info.configOptions.map((item) => item.id)).toEqual(["model", "thought_level", "mode"]);
  });
  it("selects an announced model, streams the answer and asks for scoped edits", async () => {
    const updates: string[] = [];
    const onPermission = vi.fn(async () => "allow");
    const result = await client().run({ cwd: process.cwd(), prompt: "Edit", model: "gemini-4-carbon",
      onUpdate: (update) => updates.push(update.kind), onPermission });
    expect(result).toMatchObject({ provider: "antigravity", status: "success", sessionId: "agy-session", response: "allowed",
      usage: { input: 10, output: 4, thinking: 2, cacheRead: 3, total: 17 } });
    expect(updates).toEqual(["session_ready", "agent_message_chunk"]);
    expect(onPermission).toHaveBeenCalledWith(expect.objectContaining({ toolKind: "edit", requiresElevation: false }));
  });
  it("keeps the messages before and after a tool call apart in the saved response", async () => {
    expect(await client().run({ cwd: process.cwd(), prompt: "TWO_MESSAGES" })).toMatchObject({ status: "success", response: "Vou ler.\n\nSão 3." });
  });
  it("separates messages by id, without splitting one message or doubling existing breaks", () => {
    const join = (...steps: Array<[string, string | null] | "tool">) => {
      const response = new ResponseText();
      for (const step of steps) { if (step === "tool") response.toolCall(); else response.append(step[0], step[1]); }
      return response.text;
    };
    expect(join(["lista.", "m1"], "tool", ["Não consegui", "m2"])).toBe("lista.\n\nNão consegui");
    expect(join(["uma ", "m1"], "tool", ["frase", "m1"])).toBe("uma frase");
    expect(join(["um.\n", "m1"], ["dois", "m2"])).toBe("um.\n\ndois");
    expect(join(["um.\n", null], "tool", ["\ndois", null])).toBe("um.\n\ndois");
    expect(join(["um.", null], "tool", ["\n\n", null], ["dois", null])).toBe("um.\n\ndois");
    expect(join("tool", ["só uma", "m1"])).toBe("só uma");
  });
  it("returns a resumed session to the asking mode even when the confirmation arrives after the response", async () => {
    const result = await client().run({ cwd: process.cwd(), prompt: "Edit", sessionId: "plan-late", onPermission: () => "allow" });
    expect(result).toMatchObject({ status: "success", sessionId: "plan-late", response: "allowed" });
  });
  it("never prompts when the asking mode is not confirmed", async () => {
    const result = await client().run({ cwd: process.cwd(), prompt: "Edit", sessionId: "plan-unconfirmed" });
    expect(result).toMatchObject({ status: "error", response: "", error: "antigravity ACP nao confirmou modo default." });
  });
  it("denies without a callback, and fails closed for edits outside the scope or without a location", async () => {
    expect(await client().run({ cwd: process.cwd(), prompt: "Edit" })).toMatchObject({ response: "denied" });
    for (const prompt of ["OUTSIDE", "NO_LOCATION"]) {
      const onPermission = vi.fn(async () => "allow");
      expect(await client().run({ cwd: process.cwd(), prompt, onPermission })).toMatchObject({ response: "denied" });
      expect(onPermission).not.toHaveBeenCalled();
    }
  });
  it("accepts an edit whose Windows path comes in URI form", async () => {
    const onPermission = vi.fn(async () => "allow");
    expect(await client().run({ cwd: process.cwd(), prompt: "URI_PATH", onPermission })).toMatchObject({ response: "allowed" });
    expect(onPermission).toHaveBeenCalledWith(expect.objectContaining({ requiresElevation: false }));
  });
  it("normalizes URI-form paths only on Windows", () => {
    expect(localPath("/C:/dir/file.txt", "win32")).toBe("C:/dir/file.txt");
    expect(localPath("/C:/dir/file.txt", "linux")).toBe("/C:/dir/file.txt");
    expect(localPath("C:\\dir\\file.txt", "win32")).toBe("C:\\dir\\file.txt");
  });
  it("rejects an unannounced model", async () => {
    expect(await client().run({ cwd: process.cwd(), prompt: "Edit", model: "other" }))
      .toMatchObject({ status: "error", error: "Modelo nao anunciado pela sessao ACP: other" });
  });
  it("reports a missing login, abort, timeout and premature exit", async () => {
    expect(await client().run({ cwd: process.cwd(), prompt: "Edit", sessionId: "no-login" }))
      .toMatchObject({ status: "error", error: expect.stringContaining("Authentication required") });
    expect(await client().run({ cwd: process.cwd(), prompt: "HANG", signal: AbortSignal.abort() })).toMatchObject({ status: "error", error: "Execucao ACP cancelada." });
    expect(await client().run({ cwd: process.cwd(), prompt: "HANG", timeoutMs: 1_000 })).toMatchObject({ status: "error", error: expect.stringContaining("Tempo ACP esgotado") });
    expect(await client().run({ cwd: process.cwd(), prompt: "EXIT" })).toMatchObject({ status: "error", error: expect.stringContaining("encerrou antes do resultado") });
  });
});

describe("Antigravity runtime", () => {
  const answer = (stdout: string, exitCode = 0): ProcessResult => ({ stdout, stderr: "", exitCode, durationMs: 1, timedOut: false });

  it("accepts a supported agy and asks only for its version", async () => {
    const runner = vi.fn(async () => answer("1.5.9\n"));
    await expect(resolveAntigravityRuntime(runner, [{ path: "agy", source: "path" }])).resolves.toEqual({ path: "agy", source: "path", version: "1.5.9" });
    expect(runner).toHaveBeenCalledExactlyOnceWith("agy", ["--version"], expect.objectContaining({ timeoutMs: 5_000 }));
  });
  it("skips an outdated install when a newer one is on the PATH", async () => {
    const runner = vi.fn(async (command: string) => answer(command === "agy-new" ? "1.10.0" : "1.2.7"));
    await expect(resolveAntigravityRuntime(runner, [{ path: "agy-old", source: "path" }, { path: "agy-new", source: "path" }]))
      .resolves.toMatchObject({ path: "agy-new", version: "1.10.0" });
  });
  it("explains an outdated or missing agy", async () => {
    await expect(resolveAntigravityRuntime(async () => answer("1.2.7"), [{ path: "agy", source: "path" }])).rejects.toThrow("Antigravity CLI 1.2.7");
    await expect(resolveAntigravityRuntime(async () => { throw new Error("ENOENT"); }, [{ path: "agy", source: "path" }])).rejects.toThrow("nao foi encontrado");
  });
  it("does not forward credential variables", () => {
    vi.stubEnv("GEMINI_API_KEY", "secret");
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "secret");
    try { expect(Object.values(antigravityAcpEnvironment())).not.toContain("secret"); } finally { vi.unstubAllEnvs(); }
  });
});

describe("Antigravity adapter", () => {
  it("reports the ACP runtime without claiming a login, and runs through ACP", async () => {
    const run = vi.fn(async () => ({ provider: "antigravity" as const, status: "success" as const, response: "ok", durationMs: 1 }));
    const adapter = new AntigravityAdapter(async () => runtime, { run });
    expect(await adapter.health()).toMatchObject({ available: true, authenticated: null, version: "1.5.9", detail: expect.stringContaining("ACP user") });
    const request = { cwd: process.cwd(), prompt: "x" };
    expect(await adapter.run(request)).toMatchObject({ response: "ok" });
    expect(run).toHaveBeenCalledWith(request);
  });
  it("reports an unavailable runtime", async () => {
    const adapter = new AntigravityAdapter(async () => { throw new Error("Antigravity CLI (`agy`) nao foi encontrado."); }, { run: vi.fn() });
    expect(await adapter.health()).toMatchObject({ available: false, authenticated: null, detail: expect.stringContaining("nao foi encontrado") });
  });
  it("publishes only the asking mode in the Control Room catalog", async () => {
    const service = { store: { listProjects: () => [{ directories: [{ id: "dir", path: process.cwd() }] }] } } as unknown as ControlRoomService;
    const executor = new ControlRoomTaskExecutor(service, {} as ControlRoomTaskRunner, acpRegistry({ antigravity: client() }));
    const config = await executor.providerConfig("antigravity", "dir");
    expect(config).toMatchObject({ provider: "antigravity", defaultModel: "gemini-4-neon", capabilities: { loadSession: true },
      models: [{ id: "gemini-4-neon" }, { id: "gemini-4-carbon" }] });
    expect(config.settings.find((item) => item.id === "mode")?.options.map((item) => item.id)).toEqual(["default"]);
  });
});
