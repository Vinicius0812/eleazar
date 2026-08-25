import { Codex } from "@openai/codex-sdk";
import { createRequire } from "node:module";

import type {
  AgentAdapter,
  AgentHealth,
  AgentRunRequest,
  AgentRunResult,
  TaskKind
} from "../core/contracts.js";
import { runProcess } from "./process-runner.js";

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

export class CodexAdapter implements AgentAdapter {
  readonly provider = "codex" as const;
  readonly supportedTasks = supportedTasks;

  async health(): Promise<AgentHealth> {
    try {
      const version = await runProcess(process.execPath, [codexCliPath, "--version"], { timeoutMs: 5_000 });
      if (version.exitCode !== 0) {
        return {
          provider: this.provider,
          available: false,
          authenticated: null,
          detail: version.stderr.trim() || "Codex CLI nao respondeu corretamente."
        };
      }

      const auth = await runProcess(process.execPath, [codexCliPath, "login", "status"], { timeoutMs: 5_000 });
      const authenticated = auth.exitCode === 0;
      const authDetail = auth.stdout.trim() || auth.stderr.trim();

      return {
        provider: this.provider,
        available: true,
        authenticated,
        version: version.stdout.trim(),
        detail: authenticated ? authDetail || "Autenticado." : authDetail || "Nao autenticado."
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

    try {
      const codex = new Codex();
      const thread = request.sessionId
        ? codex.resumeThread(request.sessionId)
        : codex.startThread({
            workingDirectory: request.cwd,
            skipGitRepoCheck: false,
            ...(request.model ? { model: request.model } : {})
          });
      const result = await thread.run(request.prompt);

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
        error: message
      };
    }
  }
}
