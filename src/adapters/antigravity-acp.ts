import { AcpClient, type AcpLaunch, type AcpSessionInfo } from "./acp-client.js";
import { antigravityAcpEnvironment, resolveAntigravityRuntime, type AntigravityRuntime } from "./antigravity-runtime.js";
import type { AgentRunRequest, AgentRunResult } from "../core/contracts.js";

export type AntigravityAcpSessionInfo = AcpSessionInfo & { runtime: AntigravityRuntime };

/** `agy acp` is the ACP server itself: no bridge package, and never `--dangerously-skip-permissions`. */
export function antigravityAcpLaunch(runtime: { path: string }): AcpLaunch {
  return { command: runtime.path, args: ["acp", "--sandbox"] };
}

/** Same limit as the previous headless transport. */
const turnTimeoutMs = 16 * 60_000;

/**
 * Antigravity policy: `default` mode (asks before edits) and the terminal sandbox. agy 1.5.9 was observed
 * editing without a permission request when the workspace is inside the system temporary directory.
 */
export class AntigravityAcpClient extends AcpClient {
  constructor(deps: {
    launch: (runtime: { path: string }) => AcpLaunch;
    resolveRuntime: () => Promise<AntigravityRuntime>;
  } = { launch: antigravityAcpLaunch, resolveRuntime: () => resolveAntigravityRuntime() }) {
    super("antigravity", { ...deps, requiredMode: "default", strictFileScope: true, environment: () => antigravityAcpEnvironment() });
  }

  override run(request: AgentRunRequest): Promise<AgentRunResult> {
    return super.run({ ...request, timeoutMs: request.timeoutMs ?? turnTimeoutMs });
  }
}
