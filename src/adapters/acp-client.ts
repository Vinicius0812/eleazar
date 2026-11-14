import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import * as acp from "@agentclientprotocol/sdk";

import { terminateProcessTree } from "./process-tree.js";
import type { AgentRunRequest, AgentRunResult, ProviderName, TokenUsage } from "../core/contracts.js";

export interface AcpRuntime { path: string; version: string; source: string; }
export interface AcpSessionInfo {
  runtime: AcpRuntime;
  protocolVersion: number;
  agentName: string | null;
  capabilities: acp.AgentCapabilities;
  sessionId: string;
  modes: acp.SessionModeState | null;
  configOptions: acp.SessionConfigOption[];
}

/** One process per turn. Policy and runtime selection remain provider-owned. */
export class AcpClient {
  constructor(private readonly provider: ProviderName, private readonly deps: {
    entryPath: string | (() => string);
    resolveRuntime: () => Promise<AcpRuntime>;
    environment: (runtime: AcpRuntime) => NodeJS.ProcessEnv;
    requiredMode: string;
    sessionMeta?: (request: AgentRunRequest) => Record<string, unknown>;
    strictFileScope?: boolean;
  }) {}

  async inspect(cwd: string, sessionId?: string): Promise<AcpSessionInfo> {
    let modeOptions: acp.SessionConfigOption[] | undefined;
    return this.withConnection({ cwd, prompt: "", ...(sessionId ? { sessionId } : {}) }, async (agent, state, setActiveSession) => {
      const session = await openSession(agent, state.capabilities, cwd, sessionId, [], this.deps.sessionMeta?.({ cwd, prompt: "" }));
      setActiveSession(session.sessionId);
      try {
        modeOptions = undefined;
        const ready = await ensureRequiredMode(agent, session, this.provider, this.deps.requiredMode, () => modeOptions);
        return { ...state, sessionId: ready.sessionId, modes: ready.modes ?? null, configOptions: ready.configOptions ?? [] };
      } finally {
        if (!sessionId && state.capabilities.sessionCapabilities?.close) {
          await agent.request(acp.methods.agent.session.close, { sessionId: session.sessionId }).catch(() => {});
        }
      }
    }, (notification) => { modeOptions = configOptionsUpdate(notification) ?? modeOptions; });
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const startedAt = Date.now();
    let sessionId: string | undefined;
    let response = "";
    let modeOptions: acp.SessionConfigOption[] | undefined;
    const turn: TurnState = { active: false };
    try {
      const result = await this.withConnection(request, async (agent, state, setActiveSession) => {
        const session = await openSession(agent, state.capabilities, request.cwd, request.sessionId, request.additionalDirectories, this.deps.sessionMeta?.(request));
        sessionId = session.sessionId;
        setActiveSession(sessionId);
        modeOptions = undefined;
        const ready = await ensureRequiredMode(agent, session, this.provider, this.deps.requiredMode, () => modeOptions);
        let options = ready.configOptions ?? [];
        if (request.model) {
          const model = options.find((item) => item.type === "select" && (item.category === "model" || item.id === "model"));
          if (!model || model.type !== "select" || !flattenOptions(model.options).includes(request.model)) {
            throw new Error(`Modelo nao anunciado pela sessao ACP: ${request.model}`);
          }
          options = (await agent.request(acp.methods.agent.session.setConfigOption, {
            sessionId, configId: model.id, value: request.model
          })).configOptions;
          const selected = options.find((item) => item.id === model.id);
          if (!selected || selected.type !== "select" || selected.currentValue !== request.model) {
            throw new Error(`Agente ACP nao confirmou o modelo solicitado: ${request.model}`);
          }
        }
        request.onUpdate?.({ sessionId, kind: "session_ready", payload: {
          protocolVersion: state.protocolVersion, agentName: state.agentName,
          capabilities: state.capabilities, configOptions: options,
          runtimePath: state.runtime.path, runtimeVersion: state.runtime.version
        } });
        // The turn window is exactly the prompt request: traffic before it (session/load replay, mode/model
        // setup) and after it (late events while the process is being torn down) is not this turn.
        // Text received before a failure stays in `response` as partial output.
        turn.active = true;
        try {
          const prompt = await agent.request(acp.methods.agent.session.prompt, {
            sessionId, prompt: [{ type: "text", text: request.prompt }]
          });
          return { stopReason: prompt.stopReason, usage: parseUsage((prompt as acp.PromptResponse & { usage?: unknown }).usage) };
        } finally {
          turn.active = false;
        }
      }, (notification) => {
        // Configuration updates always feed the mode confirmation; nothing else counts outside the turn.
        modeOptions = configOptionsUpdate(notification) ?? modeOptions;
        if (!turn.active) return;
        if (notification.update.sessionUpdate === "agent_message_chunk" && notification.update.content.type === "text") {
          response += notification.update.content.text;
        }
        request.onUpdate?.({ sessionId: notification.sessionId, kind: notification.update.sessionUpdate,
          payload: notification.update as unknown as Record<string, unknown> });
      }, turn);
      return { provider: this.provider, status: result.stopReason === "end_turn" ? "success" : "error", response,
        durationMs: Date.now() - startedAt, ...(sessionId ? { sessionId } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.stopReason === "end_turn" ? {} : { error: `Turno ACP encerrado: ${result.stopReason}` }) };
    } catch (error) {
      return { provider: this.provider, status: "error", response, durationMs: Date.now() - startedAt,
        ...(sessionId ? { sessionId } : {}), error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async withConnection<T>(
    request: AgentRunRequest,
    operation: (agent: acp.ClientContext, state: Omit<AcpSessionInfo, "sessionId" | "configOptions" | "modes">, setActiveSession: (id: string) => void) => Promise<T>,
    onUpdate?: (notification: acp.SessionNotification) => void,
    turn: TurnState = { active: false }
  ): Promise<T> {
    const runtime = await this.deps.resolveRuntime();
    const entryPath = typeof this.deps.entryPath === "string" ? this.deps.entryPath : this.deps.entryPath();
    const child = spawn(process.execPath, [entryPath], {
      cwd: request.cwd, stdio: "pipe", shell: false, windowsHide: true,
      detached: process.platform !== "win32", env: this.deps.environment(runtime)
    });
    child.stderr.resume();
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    const app = acp.client({ name: "eleazar" })
      .onNotification(acp.methods.client.session.update, ({ params }) => onUpdate?.(params))
      .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
        // A permission asked outside the turn (replayed history, or late during teardown) is not an
        // active tool call: cancel it safely without involving the executor.
        // The turn can end (or the run be aborted) while we await file checks or the operator's choice,
        // so the window is re-validated after every await, and a late decision is never forwarded.
        const cancelled = { outcome: { outcome: "cancelled" as const } };
        const live = () => turn.active && !request.signal?.aborted;
        if (!live()) return cancelled;
        const options = params.options.map((item) => ({ id: item.optionId, name: item.name, kind: item.kind }));
        const rawLocations = params.toolCall.locations ?? [];
        const locations = rawLocations.slice(0, 20).map((item) => item.path.slice(0, 500));
        const roots = [request.cwd, ...(request.additionalDirectories ?? [])];
        if (this.deps.strictFileScope &&
          (rawLocations.length > 20 || rawLocations.some((item) => item.path.length > 500) ||
           (params.toolCall.kind === "edit" && locations.length === 0) ||
           (await Promise.all(locations.map((path) => realPathWithinRoots(path, roots)))).some((inside) => !inside))) {
          return cancelled;
        }
        if (!live()) return cancelled; // ended while checking paths: do not involve the executor
        const requiresElevation = permissionRequiresElevation(params.toolCall, locations,
          roots);
        const choice = await request.onPermission?.({ sessionId: params.sessionId,
          toolCallId: params.toolCall.toolCallId, title: (params.toolCall.title ?? "Ferramenta").slice(0, 300),
          ...(params.toolCall.kind ? { toolKind: params.toolCall.kind } : {}),
          ...(params.toolCall.name ? { toolName: params.toolCall.name } : {}), locations, requiresElevation, options });
        return live() && choice && options.some((item) => item.id === choice)
          ? { outcome: { outcome: "selected" as const, optionId: choice } }
          : cancelled;
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
      child.once("error", (error) => reject(new Error(`Falha ao iniciar ${this.provider} ACP: ${error.message}`)));
      child.once("exit", (code) => reject(new Error(`${this.provider} ACP encerrou antes do resultado (codigo ${code ?? "desconhecido"}).`)));
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
      turn.active = false; // interruption: close the window before cancelling and tearing down
      if (activeSession) await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: activeSession }).catch(() => {});
      if (error instanceof Error && /connection closed/i.test(error.message)) {
        throw new Error(`${this.provider} ACP encerrou antes do resultado (codigo ${child.exitCode ?? "desconhecido"}).`);
      }
      const reason = error instanceof Error && "data" in error && error.data && typeof error.data === "object" &&
        "startupFailureReason" in error.data && typeof error.data.startupFailureReason === "string"
        ? error.data.startupFailureReason : null;
      if (reason) throw new Error(`${error instanceof Error ? error.message : String(error)} [startupFailureReason=${reason}]`);
      throw error;
    } finally {
      turn.active = false;
      if (timer) clearTimeout(timer);
      if (abortListener) request.signal?.removeEventListener("abort", abortListener);
      // The ACP bridge may spawn a native CLI; it was spawned detached (POSIX), so its group is ours.
      await terminateProcessTree(child, { groupIsolated: process.platform !== "win32" });
      connection.close();
      child.stdin.end();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
}

/**
 * Explicit window of the new turn: opened right before `session/prompt` is sent and closed when it
 * settles, or earlier when the connection is interrupted (timeout, abort, exit) or cleaned up.
 */
interface TurnState { active: boolean }

function permissionRequiresElevation(tool: acp.ToolCallUpdate, locations: string[], roots: string[]): boolean {
  if (tool.kind === "fetch") return true;
  if (locations.some((path) => !pathWithinRoots(path, roots))) return true;
  for (const value of [tool.rawInput, tool._meta]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const fields = value as Record<string, unknown>;
    if (fields.sandbox_permissions === "require_escalated" || fields.sandboxPermissions === "require_escalated" ||
      fields.sandboxMode === "danger-full-access" || fields.sandbox_mode === "danger-full-access" ||
      fields.networkAccess === true || fields.network_access === true || fields.requiresElevation === true) return true;
    const policy = fields.sandboxPolicy;
    if (policy && typeof policy === "object" && !Array.isArray(policy) &&
      "type" in policy && (policy.type === "dangerFullAccess" || policy.type === "danger-full-access")) return true;
  }
  return false;
}

function configOptionsUpdate(notification: acp.SessionNotification): acp.SessionConfigOption[] | undefined {
  return notification.update.sessionUpdate === "config_option_update" ? notification.update.configOptions : undefined;
}

async function ensureRequiredMode(
  agent: acp.ClientContext, session: acp.NewSessionResponse, provider: ProviderName,
  requiredMode: string, observedOptions: () => acp.SessionConfigOption[] | undefined
): Promise<acp.NewSessionResponse> {
  if (!session.modes?.availableModes.some((mode) => mode.id === requiredMode)) {
    throw new Error(`${provider} ACP nao anuncia modo ${requiredMode}.`);
  }
  if (session.modes.currentModeId === requiredMode) return session;
  await agent.request(acp.methods.agent.session.setMode, { sessionId: session.sessionId, modeId: requiredMode });
  const options = observedOptions();
  const mode = options?.find((item) => item.type === "select" && (item.category === "mode" || item.id === "mode"));
  if (!options || !mode || mode.type !== "select" || mode.currentValue !== requiredMode) {
    throw new Error(`${provider} ACP nao confirmou modo ${requiredMode}.`);
  }
  return { ...session, modes: { ...session.modes, currentModeId: requiredMode }, configOptions: options };
}

function pathWithinRoots(path: string, roots: string[]): boolean {
  if (!isAbsolute(path)) return false;
  return roots.some((root) => {
    const offset = relative(resolve(root), resolve(path));
    return offset === "" || (offset !== ".." && !offset.startsWith(`..\\`) && !offset.startsWith("../") && !isAbsolute(offset));
  });
}

async function realPathWithinRoots(path: string, roots: string[]): Promise<boolean> {
  if (!pathWithinRoots(path, roots)) return false;
  try {
    const target = await realpath(path).catch(() => realpath(dirname(path)));
    const realRoots = await Promise.all(roots.map((root) => realpath(root)));
    return pathWithinRoots(target, realRoots);
  } catch { return false; }
}

function flattenOptions(options: acp.SessionConfigSelectOptions): string[] {
  return options.flatMap((item) => "value" in item ? [item.value] : item.options.map((choice) => choice.value));
}

function parseUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const count = (name: string) => typeof raw[name] === "number" && Number.isSafeInteger(raw[name]) && (raw[name] as number) >= 0 ? raw[name] as number : undefined;
  const input = count("inputTokens"), output = count("outputTokens"), cacheRead = count("cachedReadTokens"), total = count("totalTokens");
  if ([input, output, cacheRead, total].every((item) => item === undefined)) return undefined;
  return { ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }), ...(total === undefined ? {} : { total }) };
}

async function openSession(agent: acp.ClientContext, capabilities: acp.AgentCapabilities, cwd: string, sessionId?: string, additionalDirectories: string[] = [], sessionMeta?: Record<string, unknown>): Promise<acp.NewSessionResponse> {
  if (additionalDirectories.length && !capabilities.sessionCapabilities?.additionalDirectories) {
    throw new Error("Agente ACP nao suporta escopo com diretorios adicionais.");
  }
  const roots = additionalDirectories.length ? { additionalDirectories } : {};
  const meta = sessionMeta ? { _meta: sessionMeta } : {};
  if (!sessionId) return agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [], ...roots, ...meta });
  if (!capabilities.loadSession) throw new Error("Agente ACP nao suporta session/load.");
  const loaded = await agent.request(acp.methods.agent.session.load, { cwd, sessionId, mcpServers: [], ...roots, ...meta });
  return { ...loaded, sessionId };
}
