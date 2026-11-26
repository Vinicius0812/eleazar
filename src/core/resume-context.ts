import type { ExecutionEvent, TaskExecution } from "./control-room.js";

/** Caps keep the resumed prompt small: the agent re-reads the files, it only needs the thread. */
const maxAgentText = 4_000;
const maxTools = 15;

/**
 * The message that continues a turn that died (host restart, crash, provider error).
 * With the ACP session reloaded the agent still remembers everything, so a short note is enough.
 * Without it, the note carries what the Eleazar recorded of the lost turn: the message that
 * started it, the plan, the tools it ran and the last things the agent said.
 */
export function buildResumeMessage(execution: TaskExecution, events: readonly ExecutionEvent[], sessionResumed: boolean): string {
  const reason = execution.summary?.trim() || "a execucao anterior terminou antes de concluir.";
  const intro = [
    `A execucao anterior desta tarefa foi interrompida (${reason}).`,
    "Continue de onde parou: confira o estado atual dos arquivos no diretorio autorizado, nao refaca o que ja estiver feito e conclua o pedido.",
  ];
  if (sessionResumed) return intro.join("\n");

  const lines = [...intro, "", "Contexto registrado do turno interrompido:"];
  if (execution.prompt?.trim()) lines.push("", "Mensagem do operador que iniciou o turno:", execution.prompt.trim());
  const plan = [...events].reverse().find((event) => event.kind === "plan");
  const entries = Array.isArray(plan?.payload.entries) ? plan.payload.entries as Array<{ content?: unknown; status?: unknown }> : [];
  if (entries.length) {
    lines.push("", "Plano do agente:");
    for (const entry of entries) if (typeof entry.content === "string") lines.push(`- [${typeof entry.status === "string" ? entry.status : "pending"}] ${entry.content}`);
  }
  const tools = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== "tool_call" && event.kind !== "tool_call_update") continue;
    const id = typeof event.payload.toolCallId === "string" && event.payload.toolCallId ? event.payload.toolCallId : event.id;
    const title = typeof event.payload.title === "string" ? event.payload.title : tools.get(id)?.split(" (")[0] ?? "ferramenta";
    const status = typeof event.payload.status === "string" ? event.payload.status : null;
    tools.set(id, status ? `${title} (${status})` : title);
  }
  if (tools.size) {
    lines.push("", "Ultimas ferramentas usadas:");
    for (const tool of [...tools.values()].slice(-maxTools)) lines.push(`- ${tool}`);
  }
  const said = events.filter((event) => event.kind === "agent_message_chunk" && typeof event.payload.text === "string")
    .map((event) => event.payload.text as string).join("");
  if (said.trim()) {
    const tail = said.length > maxAgentText ? `…${said.slice(-maxAgentText)}` : said;
    lines.push("", "Ultimas mensagens do agente:", tail.trim());
  }
  if (!execution.prompt?.trim() && !entries.length && !tools.size && !said.trim()) lines.push("", "(Nenhuma atividade foi registrada antes da interrupcao.)");
  return lines.join("\n");
}
