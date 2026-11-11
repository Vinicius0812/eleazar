import { Codex, type ThreadOptions } from "@openai/codex-sdk";
import { createRequire } from "node:module";

import type {
  AgentAdapter,
  AgentHealth,
  AgentRunRequest,
  AgentRunResult,
  TaskKind
} from "../core/contracts.js";
import { runProcess } from "./process-runner.js";
import { CodexAcpClient } from "./codex-acp.js";
import { resolveCodexRuntime } from "./codex-runtime.js";

const require = createRequire(import.meta.url);
const codexCliPath = require.resolve("@openai/codex/bin/codex.js");

const supportedTasks = new Set<TaskKind>([
  "implementation",
  "review",
  "planning",
  "research",
  "testing",
  "documentation",
  "unknown"
]);

const crossReviewThread = {
  sandboxMode: "workspace-write",
  approvalPolicy: "never",
  networkAccessEnabled: false,
  webSearchMode: "disabled"
} satisfies ThreadOptions;

const crossReviewConfig = [
  'model_provider="openai"',
  "mcp_servers={}",
  "features.apps=false",
  "features.plugins=false",
  "features.hooks=false",
  "features.browser_use=false",
  "features.browser_use_external=false",
  "features.in_app_browser=false",
  "features.computer_use=false",
  "features.multi_agent=false",
  "features.multi_agent_v2=false",
  "features.memories=false",
  "features.js_repl=false",
  'shell_environment_policy.inherit="none"',
  "sandbox_workspace_write.writable_roots=[]",
  "sandbox_workspace_write.exclude_tmpdir_env_var=true",
  "sandbox_workspace_write.exclude_slash_tmp=true",
  ...(process.platform === "win32" ? ['windows.sandbox="unelevated"'] : [])
];

export class CodexAdapter implements AgentAdapter {
  readonly provider = "codex" as const;
  readonly supportedTasks = supportedTasks;

  constructor(private readonly mode: "default" | "cross-review" = "default") {}

  async health(): Promise<AgentHealth> {
    try {
      const runtime = this.mode === "cross-review" ? null : await resolveCodexRuntime();
      const executable = runtime?.path ?? codexCliPath;
      const isJs = executable.endsWith(".js");
      const version = await runProcess(isJs ? process.execPath : executable, isJs ? [executable, "--version"] : ["--version"], { timeoutMs: 5_000 });
      if (version.exitCode !== 0) {
        return {
          provider: this.provider,
          available: false,
          authenticated: null,
          detail: version.stderr.trim() || "Codex CLI nao respondeu corretamente."
        };
      }

      const auth = await runProcess(isJs ? process.execPath : executable, isJs ? [executable, "login", "status"] : ["login", "status"], { timeoutMs: 5_000 });
      const authenticated = auth.exitCode === 0;
      const authDetail = auth.stdout.trim() || auth.stderr.trim();

      return {
        provider: this.provider,
        available: true,
        authenticated,
        version: version.stdout.trim(),
        detail: `${runtime ? `ACP ${runtime.source}: ${runtime.path}. ` : "SDK cross-review. "}${authenticated ? authDetail || "Autenticado." : authDetail || "Nao autenticado."}`
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
    const startedAt = Date.now();
    const crossReview = this.mode === "cross-review";

    if (!crossReview) return new CodexAcpClient().run(request);

    try {
      if (crossReview && request.sessionId !== undefined) {
        throw new Error("Revisao cruzada requer uma sessao nova.");
      }
      const codex = crossReview ? new Codex({ configOverrides: crossReviewConfig }) : new Codex();
      const thread = request.sessionId
        ? codex.resumeThread(request.sessionId)
        : codex.startThread({
            workingDirectory: request.cwd,
            skipGitRepoCheck: false,
            ...(crossReview ? crossReviewThread : {}),
            ...(request.model ? { model: request.model } : {})
          });
      const result = crossReview
        ? await thread.run(request.prompt, { signal: AbortSignal.timeout(5 * 60_000) })
        : await thread.run(request.prompt);

      return {
        provider: this.provider,
        status: "success",
        response: result.finalResponse,
        durationMs: Date.now() - startedAt,
        ...(thread.id ? { sessionId: thread.id } : {})
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        provider: this.provider,
        status: "error",
        response: "",
        durationMs: Date.now() - startedAt,
        error: crossReview ? "Falha na execucao restrita do Codex." : message
      };
    }
  }
}
