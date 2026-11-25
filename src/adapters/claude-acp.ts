import { AcpClient, nodeAcpLaunch, type AcpSessionInfo } from "./acp-client.js";
import { claudeAcpEntry, claudeAcpEnvironment, resolveClaudeRuntime, type ClaudeRuntime } from "./claude-runtime.js";

export type ClaudeAcpSessionInfo = AcpSessionInfo & { runtime: ClaudeRuntime };

/** Claude's manual permission mode with no inherited user/project tool grants. */
export class ClaudeAcpClient extends AcpClient {
  constructor(deps: { entryPath: string | (() => string); resolveRuntime: () => Promise<ClaudeRuntime> } = {
    entryPath: claudeAcpEntry, resolveRuntime: resolveClaudeRuntime
  }) {
    super("claude", {
      resolveRuntime: deps.resolveRuntime,
      launch: () => nodeAcpLaunch(deps.entryPath),
      requiredMode: "default",
      strictFileScope: true,
      environment: (runtime) => claudeAcpEnvironment(runtime.path),
      sessionMeta: () => ({ claudeCode: { options: {
        allowDangerouslySkipPermissions: false,
        settingSources: [],
        settings: { disableClaudeAiConnectors: true, permissions: {
          defaultMode: "default", disableBypassPermissionsMode: "disable", disableAutoMode: "disable",
          blockReadsOutsideWorkingDirectories: true,
          blockWritesOutsideWorkingDirectories: true,
          ask: ["Edit", "Write"]
        } },
        tools: ["Read", "Glob", "Grep", "Edit", "Write"]
      } } })
    });
  }
}
