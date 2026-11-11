import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

import type { AgentRunRequest, AgentRunResult } from "../core/contracts.js";
import { acpEnvironment, codexAcpEntry, resolveCodexRuntime, type CodexRuntime } from "./codex-runtime.js";

export interface CodexAcpSessionInfo {
  runtime: CodexRuntime;
  protocolVersion: number;
  agentName: string | null;
  capabilities: acp.AgentCapabilities;
  sessionId: string;
  configOptions: acp.SessionConfigOption[];
}

/** One process per turn. The returned session ID can be loaded by a later turn. */
export class CodexAcpClient {
  constructor(private readonly deps: {
    entryPath: string;
    resolveRuntime: () => Promise<CodexRuntime>;
  } = { entryPath: codexAcpEntry, resolveRuntime: resolveCodexRuntime }) {}

  async inspect(cwd: string, sessionId?: string): Promise<CodexAcpSessionInfo> {
    return this.withConnection({ cwd, prompt: "", ...(sessionId ? { sessionId } : {}) }, async (agent, state, setActiveSession) => {
      const session = await openSession(agent, state.capabilities, cwd, sessionId);
      setActiveSession(session.sessionId);
      return { ...state, sessionId: session.sessionId, configOptions: session.configOptions ?? [] };
    });
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const startedAt = Date.now();
    let sessionId: string | undefined;
    let response = "";
    try {
      const result = await this.withConnection(request, async (agent, state, setActiveSession) => {
        const session = await openSession(agent, state.capabilities, request.cwd, request.sessionId);
        sessionId = session.sessionId;
        setActiveSession(sessionId);
        let options = session.configOptions ?? [];
        if (request.model) {
          const model = options.find((item) => item.type === "select" && (item.category === "model" || item.id === "model"));
          if (!model || model.type !== "select" || !flattenOptions(model.options).includes(request.model)) {
            throw new Error(`Modelo nao anunciado pela sessao ACP: ${request.model}`);
          }
          options = (await agent.request(acp.methods.agent.session.setConfigOption, {
            sessionId, configId: model.id, value: request.model
          })).configOptions;
        }
        request.onUpdate?.({ sessionId, kind: "session_ready", payload: {
          protocolVersion: state.protocolVersion, agentName: state.agentName,
          capabilities: state.capabilities, configOptions: options,
          runtimePath: state.runtime.path, runtimeVersion: state.runtime.version
        } });
        const prompt = await agent.request(acp.methods.agent.session.prompt, {
          sessionId, prompt: [{ type: "text", text: request.prompt }]
        });
        return prompt.stopReason;
      }, (notification) => {
        if (notification.update.sessionUpdate === "agent_message_chunk" && notification.update.content.type === "text") {
          response += notification.update.content.text;
        }
        request.onUpdate?.({ sessionId: notification.sessionId, kind: notification.update.sessionUpdate,
          payload: notification.update as unknown as Record<string, unknown> });
      });
      return { provider: "codex", status: result === "end_turn" ? "success" : "error", response,
        durationMs: Date.now() - startedAt, ...(sessionId ? { sessionId } : {}),
        ...(result === "end_turn" ? {} : { error: `Turno ACP encerrado: ${result}` }) };
    } catch (error) {
      return { provider: "codex", status: "error", response, durationMs: Date.now() - startedAt,
        ...(sessionId ? { sessionId } : {}), error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async withConnection<T>(
    request: AgentRunRequest,
    operation: (agent: acp.ClientContext, state: Omit<CodexAcpSessionInfo, "sessionId" | "configOptions">, setActiveSession: (id: string) => void) => Promise<T>,
    onUpdate?: (notification: acp.SessionNotification) => void
  ): Promise<T> {
    const runtime = await this.deps.resolveRuntime();
    const child = spawn(process.execPath, [this.deps.entryPath], {
      cwd: request.cwd, stdio: "pipe", shell: false, windowsHide: true, env: acpEnvironment(runtime.path)
    });
    child.stderr.resume();
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    const app = acp.client({ name: "eleazar" })
      .onNotification(acp.methods.client.session.update, ({ params }) => onUpdate?.(params))
      .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
        const options = params.options.map((item) => ({ id: item.optionId, name: item.name, kind: item.kind }));
        const choice = await request.onPermission?.({ sessionId: params.sessionId,
          toolCallId: params.toolCall.toolCallId, title: params.toolCall.title ?? "Ferramenta", options });
        return choice && options.some((item) => item.id === choice)
          ? { outcome: { outcome: "selected" as const, optionId: choice } }
          : { outcome: { outcome: "cancelled" as const } };
      });
    const connection = app.connect(stream);
    const timeoutMs = request.timeoutMs ?? 5 * 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    let activeSession: string | undefined;
    const interruption = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Tempo ACP esgotado apos ${timeoutMs} ms.`)), timeoutMs);
      abortListener = () => reject(new Error("Execucao ACP cancelada."));
      request.signal?.addEventListener("abort", abortListener, { once: true });
      if (request.signal?.aborted) abortListener();
      child.once("error", (error) => reject(new Error(`Falha ao iniciar Codex ACP: ${error.message}`)));
      child.once("exit", (code) => reject(new Error(`Codex ACP encerrou antes do resultado (codigo ${code ?? "desconhecido"}).`)));
    });
    try {
      return await Promise.race([interruption, (async () => {
        const init = await connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { configOptions: { boolean: {} } },
          clientInfo: { name: "eleazar", version: "0.1.0" }
        }) as acp.InitializeResponse;
        if (init.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error(`Versao ACP incompativel: ${init.protocolVersion}`);
        return operation(connection.agent, { runtime, protocolVersion: init.protocolVersion,
          agentName: init.agentInfo?.name ?? null, capabilities: init.agentCapabilities ?? {} }, (id) => { activeSession = id; });
      })()]);
    } catch (error) {
      if (activeSession) await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: activeSession }).catch(() => {});
      if (error instanceof Error && /connection closed/i.test(error.message)) {
        throw new Error(`Codex ACP encerrou antes do resultado (codigo ${child.exitCode ?? "desconhecido"}).`);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (abortListener) request.signal?.removeEventListener("abort", abortListener);
      connection.close();
      child.stdin.end();
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.exitCode === null) child.kill();
    }
  }
}

function flattenOptions(options: acp.SessionConfigSelectOptions): string[] {
  return options.flatMap((item) => "value" in item ? [item.value] : item.options.map((choice) => choice.value));
}

async function openSession(agent: acp.ClientContext, capabilities: acp.AgentCapabilities, cwd: string, sessionId?: string): Promise<acp.NewSessionResponse> {
  if (!sessionId) return agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
  if (!capabilities.loadSession) throw new Error("Agente ACP nao suporta session/load.");
  const loaded = await agent.request(acp.methods.agent.session.load, { cwd, sessionId, mcpServers: [] });
  return { ...loaded, sessionId };
}
