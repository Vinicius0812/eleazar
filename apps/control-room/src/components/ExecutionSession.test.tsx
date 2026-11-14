import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExecutionSession } from "./ExecutionSession.js";
import type { ControlRoomClient, EventStreamOptions, ExecutionDetail, ExecutionEvent, ExecutionPermission } from "../services/contracts.js";

afterEach(cleanup);

const at = "2026-01-01T00:00:00.000Z";
const task = { id: "task-1", projectId: "p", targetDirectoryId: "d", directoryIds: ["d"], usesWorktree: false, title: "T", prompt: "Mensagem original do operador", priority: "normal" as const, status: "running" as const, kind: "implementation", worktreePath: null, dispatchLease: "lease", createdAt: at, updatedAt: at };
const project = { id: "p", name: "P", path: "C:\\P", directories: [], createdAt: at };
const event = (sequence: number, kind: string, payload: Record<string, unknown>): ExecutionEvent => ({ executionId: "run-1", sequence, id: `run-1:${sequence}`, kind, payload, createdAt: at });
const permission = (over: Partial<ExecutionPermission> = {}): ExecutionPermission => ({ id: "perm-1", executionId: "run-1", leaseId: "x", toolCallId: "t1", title: "Editar arquivo", toolKind: "edit", toolName: "apply_patch", locations: ["C:\\P\\src\\a.ts"], requiresElevation: false, options: [{ id: "allow", name: "Permitir uma vez", kind: "allow_once" }, { id: "always", name: "Sempre permitir", kind: "allow_always" }, { id: "reject", name: "Rejeitar", kind: "reject_once" }], status: "pending", selectedOptionId: null, createdAt: at, resolvedAt: null, ...over } as ExecutionPermission);

function detail(over: Partial<ExecutionDetail> & { status?: "running" | "completed" | "cancelled" | "failed" } = {}): ExecutionDetail {
  const { status = "running", ...rest } = over;
  return { execution: { id: "run-1", taskId: "task-1", provider: "codex", status, startedAt: at, finishedAt: status === "running" ? null : at, summary: null, transport: "acp", model: "gpt-test" }, task, project, logs: [], files: [], history: [], events: [], permissions: [], ...rest };
}

function fakeClient(overrides: Partial<ControlRoomClient>): ControlRoomClient {
  const unused = async () => { throw new Error("unused"); };
  return { getSnapshot: unused, getExecutionDetail: async () => detail(), getProviderStatuses: unused, registerProject: unused, createTask: unused, getProviderConfig: unused, getCodexConfig: unused, executeTask: unused, retryTask: unused, decideApproval: unused, streamExecutionEvents: async () => true, cancelExecution: async () => undefined, respondPermission: async () => undefined, ...overrides } as ControlRoomClient;
}

describe("ExecutionSession", () => {
  it("renders streamed agent text progressively as markdown and shows tool activity without thought content", async () => {
    let emit: (e: ExecutionEvent) => void = () => undefined;
    let finish: (terminal: boolean) => void = () => undefined;
    const client = fakeClient({
      streamExecutionEvents: (_id: string, options: EventStreamOptions) => new Promise<boolean>((resolve) => { emit = options.onEvent; finish = resolve; })
    });
    render(<ExecutionSession client={client} executionId="run-1" />);
    expect(await screen.findByText("Mensagem original do operador")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Conectando ao agente…")).toBeInTheDocument());
    emit(event(1, "agent_message_chunk", { text: "Olá **mundo**" }));
    emit(event(2, "agent_thought_chunk", { text: "pensamento secreto" }));
    emit(event(3, "tool_call", { toolCallId: "t1", title: "Ler arquivo", status: "in_progress", locations: ["C:\\P\\a.ts"] }));
    expect(await screen.findByText("mundo")).toBeInTheDocument();
    expect(screen.getByText("mundo").tagName).toBe("STRONG");
    expect(screen.queryByText(/pensamento secreto/)).not.toBeInTheDocument();
    expect(screen.getByText("Ler arquivo")).toBeInTheDocument();
    emit(event(4, "tool_call_update", { toolCallId: "t1", status: "completed" }));
    expect(await screen.findByText("Concluída")).toBeInTheDocument();
    expect(screen.getAllByText("Ler arquivo")).toHaveLength(1);
    emit(event(5, "agent_message_chunk", { text: " e mais" }));
    expect(await screen.findByText(/e mais/)).toBeInTheDocument();
    finish(true);
  });

  it("replays from the last event id after a dropped stream without duplicating text, and stops after a terminal event", async () => {
    const calls: Array<string | undefined> = [];
    const done = detail({ status: "completed" });
    let detailCalls = 0;
    const stream = vi.fn(async (_id: string, options: EventStreamOptions) => {
      calls.push(options.afterId);
      if (calls.length === 1) { options.onEvent(event(1, "agent_message_chunk", { text: "Parte um. " })); throw new Error("rede caiu"); }
      options.onEvent(event(1, "agent_message_chunk", { text: "Parte um. " })); // replay duplicate
      options.onEvent(event(2, "agent_message_chunk", { text: "Parte dois." }));
      options.onEvent(event(3, "completed", {}));
      return true;
    });
    const onChanged = vi.fn();
    const client = fakeClient({
      streamExecutionEvents: stream,
      getExecutionDetail: async () => { detailCalls += 1; return detailCalls < 3 ? detail() : done; }
    });
    render(<ExecutionSession client={client} executionId="run-1" onChanged={onChanged} retryDelayMs={() => 1} />);
    expect(await screen.findByText("Parte um. Parte dois.")).toBeInTheDocument();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([undefined, "run-1:1"]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stream).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Sessão encerrada")).toBeInTheDocument();
  });

  it("aborts the stream on unmount", async () => {
    let signal: AbortSignal | undefined;
    const client = fakeClient({ streamExecutionEvents: (_id: string, options: EventStreamOptions) => { signal = options.signal; return new Promise<boolean>(() => undefined); } });
    const view = render(<ExecutionSession client={client} executionId="run-1" />);
    await waitFor(() => expect(signal).toBeDefined());
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("does not stream a finished execution and falls back to the legacy output", async () => {
    const stream = vi.fn(async () => true);
    const legacy = detail({ status: "completed" });
    legacy.execution = { ...legacy.execution, transport: "legacy", output: "Resultado **legado**" };
    const client = fakeClient({ getExecutionDetail: async () => legacy, streamExecutionEvents: stream });
    render(<ExecutionSession client={client} executionId="run-1" />);
    expect(await screen.findByText("legado")).toBeInTheDocument();
    expect(stream).not.toHaveBeenCalled();
  });

  it("shows permission context and sends the chosen option, blocking persistent grants", async () => {
    const respondPermission = vi.fn(async () => undefined);
    let current = detail({ permissions: [permission()] });
    const client = fakeClient({ getExecutionDetail: async () => current, respondPermission, streamExecutionEvents: () => new Promise<boolean>(() => undefined) });
    render(<ExecutionSession client={client} executionId="run-1" />);
    expect(await screen.findByText("Editar arquivo")).toBeInTheDocument();
    expect(screen.getByText("C:\\P\\src\\a.ts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sempre permitir" })).toBeDisabled();
    current = detail({ permissions: [permission({ status: "selected", selectedOptionId: "allow" })] });
    await userEvent.click(screen.getByRole("button", { name: "Permitir uma vez" }));
    expect(respondPermission).toHaveBeenCalledWith("run-1", "perm-1", "allow");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Permitir uma vez" })).not.toBeInTheDocument());
    expect(screen.getByText("Decisões de permissão")).toBeInTheDocument();
  });

  it("discards the outcome of an action that finished after the execution changed", async () => {
    let releaseResponse: () => void = () => undefined;
    const respondPermission = vi.fn(() => new Promise<void>((resolve) => { releaseResponse = resolve; }));
    const onChanged = vi.fn();
    const other = detail({ events: [] });
    other.execution = { ...other.execution, id: "run-2" };
    other.task = { ...task, id: "task-2", prompt: "Tarefa B" };
    const client = fakeClient({
      getExecutionDetail: async (id: string) => id === "run-1" ? detail({ permissions: [permission()] }) : other,
      respondPermission, streamExecutionEvents: () => new Promise<boolean>(() => undefined)
    });
    const view = render(<ExecutionSession client={client} executionId="run-1" onChanged={onChanged} />);
    await userEvent.click(await screen.findByRole("button", { name: "Permitir uma vez" }));
    view.rerender(<ExecutionSession client={client} executionId="run-2" onChanged={onChanged} />);
    await screen.findByRole("button", { name: "Cancelar execução" });
    releaseResponse();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.queryByText("Editar arquivo")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelar execução" })).toBeEnabled();
  });

  it("shows the normalized failure reason together with the partial agent text", async () => {
    const failed = detail({ status: "failed", events: [event(1, "agent_message_chunk", { text: "Texto **parcial**" }), event(2, "failed", { summary: "x" })] });
    failed.execution = { ...failed.execution, summary: '{"detail":"Cota do provedor esgotada"}', output: '{"detail":"Cota do provedor esgotada"}' };
    render(<ExecutionSession client={fakeClient({ getExecutionDetail: async () => failed })} executionId="run-1" />);
    expect(await screen.findByText("parcial")).toBeInTheDocument();
    expect(screen.getByText("Motivo da falha")).toBeInTheDocument();
    expect(screen.getByText("Cota do provedor esgotada")).toBeInTheDocument();
    expect(screen.queryByText(/detail/)).not.toBeInTheDocument();
  });

  it("shows a cancellation reason from the terminal event while the detail is still stale", async () => {
    const client = fakeClient({
      getExecutionDetail: async () => detail(), // still "running" and without summary
      streamExecutionEvents: async (_id: string, options: EventStreamOptions) => {
        options.onEvent(event(1, "agent_message_chunk", { text: "Quase lá" }));
        options.onEvent(event(2, "cancelled", { reason: "Cancelada pelo operador" }));
        return true;
      }
    });
    render(<ExecutionSession client={client} executionId="run-1" />);
    expect(await screen.findByText("Motivo do cancelamento")).toBeInTheDocument();
    expect(screen.getByText("Cancelada pelo operador")).toBeInTheDocument();
    expect(screen.getByText("Quase lá")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancelar execução" })).not.toBeInTheDocument();
  });

  it("does not show a failure block for a completed run", async () => {
    const done = detail({ status: "completed", events: [event(1, "agent_message_chunk", { text: "Tudo certo" }), event(2, "completed", {})] });
    render(<ExecutionSession client={fakeClient({ getExecutionDetail: async () => done })} executionId="run-1" />);
    expect(await screen.findByText("Tudo certo")).toBeInTheDocument();
    expect(screen.queryByText(/Motivo|interrompida/)).not.toBeInTheDocument();
  });

  it("says so, without inventing a cause, when a failed run has no recorded reason", async () => {
    const failed = detail({ status: "failed", events: [event(1, "agent_message_chunk", { text: "Parcial" }), event(2, "failed", {})] });
    render(<ExecutionSession client={fakeClient({ getExecutionDetail: async () => failed })} executionId="run-1" />);
    expect(await screen.findByText("A execução falhou e nenhum detalhe foi registrado.")).toBeInTheDocument();
    expect(screen.getByText("Parcial")).toBeInTheDocument();
  });

  it("keeps persisted partial output next to the reason when there are no events, but not a repeated reason", async () => {
    const partial = detail({ status: "failed", events: [] });
    partial.execution = { ...partial.execution, summary: "Erro de rede no provedor", output: "## Análise parcial\n\nAchei **dois** problemas." };
    const view = render(<ExecutionSession client={fakeClient({ getExecutionDetail: async () => partial })} executionId="run-1" />);
    expect(await screen.findByText("Erro de rede no provedor")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Análise parcial" })).toBeInTheDocument();
    expect(screen.getByText("dois")).toBeInTheDocument();
    view.unmount();
    const same = detail({ status: "failed", events: [] });
    same.execution = { ...same.execution, summary: '{"detail":"Cota esgotada"}', output: '{"detail":"Cota esgotada"}' };
    render(<ExecutionSession client={fakeClient({ getExecutionDetail: async () => same })} executionId="run-1" />);
    expect(await screen.findByText("Motivo da falha")).toBeInTheDocument();
    expect(screen.getAllByText("Cota esgotada")).toHaveLength(1);
  });

  it("never hides a fuller output behind a truncated reason", async () => {
    const truncated = detail({ status: "failed", events: [] });
    truncated.execution = { ...truncated.execution, summary: "Falha de conexão...", output: "Falha de conexão: detalhes importantes do servidor" };
    render(<ExecutionSession client={fakeClient({ getExecutionDetail: async () => truncated })} executionId="run-1" />);
    expect(await screen.findByText("Falha de conexão...")).toBeInTheDocument();
    expect(screen.getByText(/detalhes importantes do servidor/)).toBeInTheDocument();
  });

  it("reports a stream failure as a connection problem, not as a failed execution", async () => {
    const stream = vi.fn(async () => { throw new Error("socket fechado"); });
    render(<ExecutionSession client={fakeClient({ streamExecutionEvents: stream })} executionId="run-1" retryDelayMs={() => 0} />);
    expect(await screen.findByText(/Falha na conexão com o fluxo de eventos: socket fechado/)).toBeInTheDocument();
    expect(screen.queryByText("Motivo da falha")).not.toBeInTheDocument();
  });

  it("disables allowing an action that requires elevation", async () => {
    const client = fakeClient({ getExecutionDetail: async () => detail({ permissions: [permission({ requiresElevation: true })] }), streamExecutionEvents: () => new Promise<boolean>(() => undefined) });
    render(<ExecutionSession client={client} executionId="run-1" />);
    expect(await screen.findByRole("button", { name: "Permitir uma vez" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rejeitar" })).toBeEnabled();
  });

  it("cancels only while active and reports a failed cancel", async () => {
    const cancelExecution = vi.fn(async () => { throw new Error("Nao foi possivel cancelar."); });
    const client = fakeClient({ cancelExecution, streamExecutionEvents: () => new Promise<boolean>(() => undefined) });
    render(<ExecutionSession client={client} executionId="run-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Cancelar execução" }));
    expect(cancelExecution).toHaveBeenCalledWith("run-1");
    expect(await screen.findByText("Nao foi possivel cancelar.")).toBeInTheDocument();
    cleanup();
    render(<ExecutionSession client={fakeClient({ getExecutionDetail: async () => detail({ status: "cancelled" }) })} executionId="run-1" />);
    await screen.findByText("Sessão encerrada");
    expect(screen.queryByRole("button", { name: "Cancelar execução" })).not.toBeInTheDocument();
  });

  it("gives up with a visible error and a retry button after repeated failures", async () => {
    const stream = vi.fn(async () => { throw new Error("API offline"); });
    render(<ExecutionSession client={fakeClient({ streamExecutionEvents: stream })} executionId="run-1" retryDelayMs={() => 0} />);
    expect(await screen.findByText("Conexão perdida")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tentar novamente" })).toBeInTheDocument();
    expect(stream).toHaveBeenCalledTimes(8);
  });
});
