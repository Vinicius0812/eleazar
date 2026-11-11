import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  constructor: vi.fn(),
  startThread: vi.fn(),
  resumeThread: vi.fn(),
  run: vi.fn()
}));

vi.mock("@openai/codex-sdk", () => ({
  Codex: class {
    startThread = sdk.startThread;
    resumeThread = sdk.resumeThread;

    constructor(options: unknown) {
      sdk.constructor(options);
    }
  }
}));

import { CodexAdapter } from "../src/adapters/codex.js";

beforeEach(() => {
  vi.resetAllMocks();
  sdk.startThread.mockReturnValue({ run: sdk.run });
  sdk.run.mockResolvedValue({ finalResponse: "ok" });
});

describe("Codex SDK restrictions for cross-review", () => {
  it("starts one restricted turn with an abort signal and no session resume", async () => {
    const request = { cwd: process.cwd(), prompt: "Escopo permitido.", taskKind: "implementation" as const };
    const adapter = new CodexAdapter("cross-review");
    expect((await adapter.run(request)).status).toBe("success");
    expect(sdk.constructor).toHaveBeenCalledWith({ configOverrides: expect.arrayContaining([
      "mcp_servers={}", "features.hooks=false", "features.plugins=false",
      'shell_environment_policy.inherit="none"', "sandbox_workspace_write.writable_roots=[]"
    ]) });
    expect(sdk.startThread).toHaveBeenCalledWith({
      workingDirectory: request.cwd, skipGitRepoCheck: false, sandboxMode: "workspace-write",
      approvalPolicy: "never", networkAccessEnabled: false, webSearchMode: "disabled"
    });
    expect(sdk.run).toHaveBeenCalledWith(request.prompt, { signal: expect.any(AbortSignal) });
    expect(sdk.resumeThread).not.toHaveBeenCalled();
    await expect(adapter.run({ ...request, sessionId: "anterior" })).resolves.toMatchObject({ status: "error" });
    expect(sdk.constructor).toHaveBeenCalledTimes(1);
  });

  it("preserves the ordinary adapter options for existing calls", async () => {
    await new CodexAdapter().run({ cwd: process.cwd(), prompt: "Pedido comum." });
    expect(sdk.constructor).toHaveBeenCalledWith(undefined);
    expect(sdk.startThread).toHaveBeenCalledWith({ workingDirectory: process.cwd(), skipGitRepoCheck: false });
    expect(sdk.run).toHaveBeenCalledWith("Pedido comum.");
  });
});
