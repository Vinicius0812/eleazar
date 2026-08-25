import type {
  AgentAdapter,
  AgentHealth,
  AgentRunRequest,
  AgentRunResult,
  TaskKind,
  TokenUsage
} from "../core/contracts.js";
import { runProcess } from "./process-runner.js";

const supportedTasks = new Set<TaskKind>([
  "implementation",
  "review",
  "planning",
  "research",
  "testing",
  "documentation",
  "unknown"
]);

interface AntigravityEnvelope {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  duration_seconds?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
  };
}

export class AntigravityAdapter implements AgentAdapter {
  readonly provider = "antigravity" as const;
  readonly supportedTasks = supportedTasks;

  async health(): Promise<AgentHealth> {
    try {
      const version = await runProcess("agy", ["--version"], { timeoutMs: 5_000 });
      if (version.exitCode !== 0) {
        return {
          provider: this.provider,
          available: false,
          authenticated: null,
          detail: version.stderr.trim() || "Antigravity CLI nao respondeu corretamente."
        };
      }

      return {
        provider: this.provider,
        available: true,
        authenticated: null,
        version: version.stdout.trim(),
        detail: "Instalado; a autenticacao sera confirmada na primeira execucao."
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        provider: this.provider,
        available: false,
        authenticated: null,
        detail: message.includes("ENOENT")
          ? "Antigravity CLI (`agy`) nao foi encontrado no PATH."
          : message
      };
    }
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const args = ["-p", request.prompt, "--output-format", "json", "--sandbox", "--print-timeout", "15m"];

    if (request.model) {
      args.push("--model", request.model);
    }
    if (request.sessionId) {
      args.push("--conversation", request.sessionId);
    }

    try {
      const processResult = await runProcess("agy", args, {
        cwd: request.cwd,
        timeoutMs: 16 * 60 * 1_000
      });

      if (processResult.timedOut) {
        return {
          provider: this.provider,
          status: "error",
          response: "",
          durationMs: processResult.durationMs,
          error: "Antigravity excedeu o limite local de 16 minutos."
        };
      }

      let envelope: AntigravityEnvelope;
      try {
        envelope = JSON.parse(processResult.stdout) as AntigravityEnvelope;
      } catch {
        return {
          provider: this.provider,
          status: "error",
          response: "",
          durationMs: processResult.durationMs,
          error: processResult.stderr.trim() || "Antigravity retornou JSON invalido."
        };
      }

      const succeeded = processResult.exitCode === 0 && envelope.status === "SUCCESS";
      return {
        provider: this.provider,
        status: succeeded ? "success" : "error",
        response: envelope.response ?? "",
        durationMs: envelope.duration_seconds
          ? Math.round(envelope.duration_seconds * 1_000)
          : processResult.durationMs,
        ...(envelope.conversation_id ? { sessionId: envelope.conversation_id } : {}),
        ...(envelope.usage ? { usage: toTokenUsage(envelope.usage) } : {}),
        ...(!succeeded
          ? {
              error:
                envelope.error ??
                (processResult.stderr.trim() || `Antigravity encerrou com codigo ${processResult.exitCode}.`)
            }
          : {})
      };
    } catch (error) {
      return {
        provider: this.provider,
        status: "error",
        response: "",
        durationMs: 0,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

function toTokenUsage(usage: NonNullable<AntigravityEnvelope["usage"]>): TokenUsage {
  return {
    ...(usage.input_tokens !== undefined ? { input: usage.input_tokens } : {}),
    ...(usage.output_tokens !== undefined ? { output: usage.output_tokens } : {}),
    ...(usage.thinking_tokens !== undefined ? { thinking: usage.thinking_tokens } : {}),
    ...(usage.cache_read_tokens !== undefined ? { cacheRead: usage.cache_read_tokens } : {}),
    ...(usage.total_tokens !== undefined ? { total: usage.total_tokens } : {})
  };
}
