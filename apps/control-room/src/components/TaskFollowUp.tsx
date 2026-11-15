import { useState, type FormEvent } from "react";
import { ArrowUp } from "lucide-react";

/** Sends another message to a task whose last turn finished, keeping its folder or worktree. */
export function TaskFollowUp({ busy, resumesSession, onSend }: {
  busy: boolean;
  /** True when the previous turn left an ACP session the agent may resume. */
  resumesSession: boolean;
  onSend(prompt: string): void;
}) {
  const [prompt, setPrompt] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text) return;
    onSend(text);
    setPrompt("");
  }
  return (
    <form className="task-follow-up" onSubmit={submit}>
      <label>
        Nova mensagem para o agente
        <textarea value={prompt} rows={3} required placeholder="Peça um ajuste, uma correção ou o próximo passo" onChange={(event) => setPrompt(event.target.value)} />
      </label>
      <div className="task-follow-up-footer">
        <small>{resumesSession
          ? "Continua no mesmo diretório e retoma a sessão anterior quando o agente permite."
          : "Continua no mesmo diretório; o agente recebe o pedido original junto com esta mensagem."}</small>
        <button className="primary" disabled={busy || !prompt.trim()}><ArrowUp size={16} aria-hidden="true" /> {busy ? "Enviando…" : "Enviar"}</button>
      </div>
    </form>
  );
}
