import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { terminalEventKinds, type ControlRoomClient, type ExecutionDetail, type ExecutionEvent, type ExecutionPermission } from "../services/contracts.js";

export type ConnectionState = "loading" | "connecting" | "live" | "reconnecting" | "closed" | "error";
export interface ToolActivity { toolCallId: string; title: string; status: string | null; locations: string[]; }
export interface PlanEntry { content: string; status: string; }
/** One step of the conversation, in the order the agent produced it. Consecutive tool calls share a step. */
export type ConversationItem =
  | { kind: "message"; id: string; messageId: string | null; text: string }
  | { kind: "tools"; id: string; tools: ToolActivity[] };
export interface ExecutionSessionState {
  detail: ExecutionDetail | null;
  events: ExecutionEvent[];
  permissions: ExecutionPermission[];
  items: ConversationItem[];
  plan: PlanEntry[];
  connection: ConnectionState;
  error: string;
  actionError: string;
  pendingAction: boolean;
  respond(permissionId: string, optionId: string): Promise<void>;
  cancel(): Promise<void>;
  retry(): void;
}

const maxConsecutiveFailures = 8;
const defaultRetryDelay = (attempt: number) => Math.min(1_000 * attempt, 5_000);
const activeStatuses = new Set(["planned", "running"]);
const reason = (error: unknown) => error instanceof Error ? error.message : "Falha inesperada.";

/** Merges by event id so a replay after reconnecting never duplicates streamed text. */
export function mergeEvents(current: ExecutionEvent[], incoming: ExecutionEvent[]): ExecutionEvent[] {
  const known = new Set(current.map((event) => event.id));
  const fresh: ExecutionEvent[] = [];
  for (const event of incoming) { if (!known.has(event.id)) { known.add(event.id); fresh.push(event); } }
  if (!fresh.length) return current;
  return [...current, ...fresh].sort((a, b) => a.sequence - b.sequence);
}

/**
 * Rebuilds the conversation from the ordered events. Only `payload.text` is ever shown as agent
 * output. A tool update changes its call where it first appeared, and the latest plan replaces the previous one.
 */
export function deriveSession(events: ExecutionEvent[]): { items: ConversationItem[]; plan: PlanEntry[] } {
  const items: ConversationItem[] = [];
  let plan: PlanEntry[] = [];
  const tools = new Map<string, ToolActivity>();
  for (const event of events) {
    if (event.kind === "agent_message_chunk" && typeof event.payload.text === "string") {
      const text = event.payload.text;
      const messageId = typeof event.payload.messageId === "string" ? event.payload.messageId : null;
      const last = items.at(-1);
      if (last?.kind === "message" && last.messageId === messageId) last.text += text;
      // Blank chunks between tool calls are separators, not messages.
      else if (text.trim()) items.push({ kind: "message", id: event.id, messageId, text });
    }
    if (event.kind === "plan" && Array.isArray(event.payload.entries)) {
      plan = event.payload.entries.flatMap((item) => {
        const entry = item as { content?: unknown; status?: unknown } | null;
        return entry && typeof entry.content === "string" ? [{ content: entry.content, status: typeof entry.status === "string" ? entry.status : "pending" }] : [];
      });
    }
    if (event.kind === "tool_call" || event.kind === "tool_call_update") {
      const payload = event.payload;
      const id = typeof payload.toolCallId === "string" && payload.toolCallId ? payload.toolCallId : event.id;
      const previous = tools.get(id);
      const title = typeof payload.title === "string" && payload.title ? payload.title : typeof payload.name === "string" && payload.name ? payload.name : previous?.title ?? "Ferramenta";
      const locations = Array.isArray(payload.locations) ? payload.locations.filter((item): item is string => typeof item === "string") : [];
      const status = typeof payload.status === "string" ? payload.status : previous?.status ?? null;
      // An update that carries no locations keeps the ones already known.
      if (previous) { Object.assign(previous, { title, status, locations: locations.length ? locations : previous.locations }); continue; }
      const tool: ToolActivity = { toolCallId: id, title, status, locations };
      tools.set(id, tool);
      const last = items.at(-1);
      if (last?.kind === "tools") last.tools.push(tool);
      else items.push({ kind: "tools", id: event.id, tools: [tool] });
    }
  }
  return { items, plan };
}

export function useExecutionSession(client: ControlRoomClient, executionId: string, onChanged?: () => void, retryDelayMs: (attempt: number) => number = defaultRetryDelay): ExecutionSessionState {
  const [detail, setDetail] = useState<ExecutionDetail | null>(null);
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [permissions, setPermissions] = useState<ExecutionPermission[]>([]);
  const [connection, setConnection] = useState<ConnectionState>("loading");
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pendingAction, setPendingAction] = useState(false);
  const [attemptKey, setAttemptKey] = useState(0);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const delay = useRef(retryDelayMs);
  delay.current = retryDelayMs;
  const activeSession = useRef<object | null>(null);
  const refreshRef =useRef<() => Promise<ExecutionDetail | null>>(async () => null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let lastId: string | undefined;
    let seen: ExecutionEvent[] = [];
    activeSession.current = {};
    setDetail(null); setEvents([]); setPermissions([]); setError(""); setActionError(""); setPendingAction(false); setConnection("loading");

    const absorb = (incoming: ExecutionEvent[]) => {
      const next = mergeEvents(seen, incoming);
      if (next === seen) return;
      seen = next;
      lastId = next[next.length - 1]?.id;
      setEvents(next);
    };
    const refresh = async (): Promise<ExecutionDetail | null> => {
      const next = await client.getExecutionDetail(executionId);
      if (signal.aborted) return null;
      setDetail(next);
      setPermissions(next.permissions ?? []);
      absorb(next.events ?? []);
      return next;
    };
    refreshRef.current = refresh;
    const wait = (ms: number) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    const finish = async () => {
      try { await refresh(); } catch { /* The stream result is already persisted; a later manual refresh recovers it. */ }
      if (signal.aborted) return;
      setConnection("closed");
      changed.current?.();
    };

    async function run() {
      let initial: ExecutionDetail | null;
      try { initial = await refresh(); } catch (failure) { if (!signal.aborted) { setError(reason(failure)); setConnection("error"); } return; }
      if (!initial) return;
      const settled = (item: ExecutionDetail) => terminalEventKinds.some((kind) => seen.some((event) => event.kind === kind)) || !activeStatuses.has(item.execution.status);
      if (settled(initial)) { setConnection("closed"); return; }
      let failures = 0;
      while (!signal.aborted) {
        setConnection(failures ? "reconnecting" : "connecting");
        try {
          const terminal = await client.streamExecutionEvents(executionId, {
            afterId: lastId, signal,
            onEvent: (event) => {
              if (signal.aborted) return;
              failures = 0; setError(""); setConnection("live");
              absorb([event]);
              if (event.kind.startsWith("permission_")) void refresh().catch(() => undefined);
            }
          });
          if (signal.aborted) return;
          if (terminal) { await finish(); return; }
          const current = await refresh();
          if (!current) return;
          if (settled(current)) { await finish(); return; }
        } catch (failure) {
          if (signal.aborted) return;
          setError(reason(failure));
        }
        failures += 1;
        if (failures >= maxConsecutiveFailures) { setConnection("error"); return; }
        setConnection("reconnecting");
        await wait(delay.current(failures));
      }
    }
    void run();
    return () => { controller.abort(); activeSession.current = null; refreshRef.current = async () => null; };
  }, [client, executionId, attemptKey]);

  // Respond/cancel results belong to the session that started them: if the execution or the
  // route changed while the request was in flight, the outcome must not touch the new screen.
  const act = useCallback(async (operation: () => Promise<void>) => {
    const session = activeSession.current;
    const stale = () => session === null || session !== activeSession.current;
    setPendingAction(true); setActionError("");
    try {
      await operation();
      if (stale()) return;
      await refreshRef.current().catch(() => undefined);
      if (!stale()) changed.current?.();
    } catch (failure) {
      if (stale()) return;
      setActionError(reason(failure));
      await refreshRef.current().catch(() => undefined);
    } finally { if (!stale()) setPendingAction(false); }
  }, []);

  const { items, plan } = useMemo(() => deriveSession(events), [events]);
  return {
    detail, events, permissions, items, plan, connection, error, actionError, pendingAction,
    respond: (permissionId, optionId) => act(() => client.respondPermission(executionId, permissionId, optionId)),
    cancel: () => act(() => client.cancelExecution(executionId)),
    retry: () => setAttemptKey((value) => value + 1)
  };
}
