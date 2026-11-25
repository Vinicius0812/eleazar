import type { AgentAdapter, AgentHealth, AgentRunRequest, AgentRunResult, TaskKind } from "../core/contracts.js";
import { AntigravityAcpClient } from "./antigravity-acp.js";
import { resolveAntigravityRuntime } from "./antigravity-runtime.js";

const supportedTasks = new Set<TaskKind>([
  "implementation",
  "review",
  "planning",
  "research",
  "testing",
  "documentation",
  "unknown"
]);

export class AntigravityAdapter implements AgentAdapter {
  readonly provider = "antigravity" as const;
  readonly supportedTasks = supportedTasks;

  constructor(
    private readonly resolveRuntime: () => ReturnType<typeof resolveAntigravityRuntime> = () => resolveAntigravityRuntime(),
    private readonly client: Pick<AntigravityAcpClient, "run"> = new AntigravityAcpClient()
  ) {}

  /** The login is not probed here, so `authenticated` stays unknown until a session is opened. */
  async health(): Promise<AgentHealth> {
    try {
      const runtime = await this.resolveRuntime();
      return {
        provider: this.provider,
        available: true,
        authenticated: null,
        version: runtime.version,
        executablePath: runtime.path,
        executableSource: runtime.source,
        detail: `ACP ${runtime.source}: ${runtime.path}. O login sera confirmado ao abrir a primeira sessao.`
      };
    } catch (error) {
      return {
        provider: this.provider,
        available: false,
        authenticated: null,
        detail: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    return this.client.run(request);
  }
}
