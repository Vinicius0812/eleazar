import { AcpClient, nodeAcpLaunch, type AcpSessionInfo } from "./acp-client.js";
import { acpEnvironment, codexAcpEntry, resolveCodexRuntime, type CodexRuntime } from "./codex-runtime.js";

export type CodexAcpSessionInfo = AcpSessionInfo & { runtime: CodexRuntime };

/** Codex policy: workspace write with explicit approval and no network. */
export class CodexAcpClient extends AcpClient {
  constructor(deps: { entryPath: string; resolveRuntime: () => Promise<CodexRuntime> } = {
    entryPath: codexAcpEntry, resolveRuntime: resolveCodexRuntime
  }) {
    super("codex", {
      resolveRuntime: deps.resolveRuntime,
      launch: () => nodeAcpLaunch(deps.entryPath),
      requiredMode: "workspace-write",
      environment: (runtime) => acpEnvironment(runtime.path)
    });
  }
}
