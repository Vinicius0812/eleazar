import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Eraser, Power, RotateCcw, TerminalSquare } from "lucide-react";

import type { ControlRoomClient, Project, TerminalEvent, TerminalSession } from "../services/contracts.js";

/** Output kept on screen; the host keeps more for a reload. */
const maxLines = 2_000;
const attaching = new Map<string, Promise<TerminalSession | null>>();

/**
 * A bash shell in one of the project's folders. It is a plain shell without a pseudo terminal:
 * commands run one line at a time, `cd` is kept between them, and programs that wait for
 * keyboard input (editors, interactive prompts) are not supported.
 */
export function ProjectTerminal({ client, project }: { client: ControlRoomClient; project: Project }) {
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [directoryId, setDirectoryId] = useState(project.directories[0]?.id ?? "");
  const [events, setEvents] = useState<TerminalEvent[]>([]);
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(true);
  const output = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const open = useCallback(async (folder: string) => {
    setStarting(true); setError("");
    try { const opened = await client.openTerminal(project.id, folder); setEvents([]); setSession(opened); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível abrir o terminal."); }
    finally { setStarting(false); }
  }, [client, project.id]);

  // Reattaches to a shell left open (for example after a reload); opens one otherwise.
  // The attach is shared per project so a double mount (React's strict mode) never starts two shells.
  const firstDirectory = project.directories[0]?.id;
  useEffect(() => {
    let alive = true;
    const pending = attaching.get(project.id) ?? client.listTerminals(project.id).then((sessions) => sessions[0] ?? (firstDirectory ? client.openTerminal(project.id, firstDirectory) : null));
    attaching.set(project.id, pending);
    pending.then((attached) => {
      if (!alive) return;
      if (attached) { setSession(attached); setDirectoryId(attached.directoryId); }
    }).catch((reason: unknown) => { if (alive) setError(reason instanceof Error ? reason.message : "Terminal indisponível."); })
      .finally(() => { if (alive) setStarting(false); window.setTimeout(() => attaching.delete(project.id), 0); });
    return () => { alive = false; };
  }, [client, project.id, firstDirectory]);

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    let last: string | undefined;
    let stopped = false;
    async function follow() {
      while (!stopped) {
        try {
          const exited = await client.streamTerminalEvents(session!.id, { afterId: last, signal: controller.signal, onEvent: (event) => {
            last = event.id;
            setEvents((current) => [...current, event].slice(-maxLines));
            if (event.kind === "done") setSession((current) => current && { ...current, busy: false, cwd: event.cwd ?? current.cwd });
            if (event.kind === "input") setSession((current) => current && { ...current, busy: true });
            if (event.kind === "exit") setSession((current) => current && { ...current, busy: false, closed: true, exitCode: event.exitCode ?? null });
          } });
          if (exited) return;
        } catch {
          if (controller.signal.aborted) return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      }
    }
    void follow();
    return () => { stopped = true; controller.abort(); };
  }, [client, session?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const element = output.current; if (element) element.scrollTop = element.scrollHeight; }, [events]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const line = command.trim();
    if (!line || !session || session.closed) return;
    setError("");
    try {
      await client.sendTerminalInput(session.id, line);
      setHistory((current) => [...current.filter((item) => item !== line), line].slice(-100));
      setCommand(""); setCursor(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "O comando não foi enviado."); }
  }

  function browseHistory(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (!history.length) return;
    event.preventDefault();
    const next = event.key === "ArrowUp" ? Math.max(0, (cursor ?? history.length) - 1) : (cursor ?? history.length) + 1;
    if (next >= history.length) { setCursor(null); setCommand(""); return; }
    setCursor(next); setCommand(history[next] ?? "");
  }

  async function restart() {
    if (session && !session.closed) await client.closeTerminal(session.id).catch(() => undefined);
    await open(directoryId);
    input.current?.focus();
  }

  const directory = project.directories.find((item) => item.id === (session?.directoryId ?? directoryId));
  return (
    <section className="project-terminal" aria-label="Terminal do projeto">
      <div className="terminal-toolbar">
        <TerminalSquare size={16} aria-hidden="true" />
        {project.directories.length > 1 ? (
          <label className="terminal-folder">
            <span className="sr-only">Pasta do terminal</span>
            <select value={directoryId} onChange={(event) => setDirectoryId(event.target.value)} aria-label="Pasta do terminal">
              {project.directories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
        ) : <strong>{directory?.name}</strong>}
        <code className="terminal-cwd" title={session?.cwd}>{session?.cwd ?? directory?.path}</code>
        <span className={`terminal-state ${session?.closed ? "closed" : session?.busy ? "busy" : "ready"}`}>{starting ? "Abrindo…" : !session ? "Fechado" : session.closed ? "Encerrado" : session.busy ? "Executando…" : "Pronto"}</span>
        <button type="button" className="text-button" onClick={() => setEvents([])} title="Limpa a tela; o histórico do host continua"><Eraser size={14} aria-hidden="true" /> Limpar</button>
        <button type="button" className="text-button" disabled={starting} onClick={() => void restart()} title={directoryId !== session?.directoryId ? "Abre o terminal na pasta escolhida" : "Encerra o comando em andamento e abre outro bash"}><RotateCcw size={14} aria-hidden="true" /> {session && directoryId !== session.directoryId ? "Abrir nesta pasta" : "Reiniciar"}</button>
        {session && !session.closed && <button type="button" className="text-button danger" onClick={() => void client.closeTerminal(session.id).then(setSession).catch(() => undefined)}><Power size={14} aria-hidden="true" /> Fechar</button>}
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="terminal-output" ref={output} role="log" aria-label="Saída do terminal" aria-live="polite" tabIndex={0} onClick={() => input.current?.focus()}>
        {!events.length && !starting && session && !session.closed && <p className="terminal-hint">Bash em <code>{session.root}</code>. Digite um comando e pressione Enter. Programas que pedem interação pelo teclado não funcionam aqui.</p>}
        {events.map((event) => <TerminalLine key={event.id} event={event} />)}
      </div>
      <form className="terminal-input" onSubmit={(event) => void submit(event)}>
        <span aria-hidden="true">$</span>
        <input ref={input} value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={browseHistory} disabled={!session || session.closed}
          aria-label="Comando" placeholder={session?.closed ? "Terminal encerrado. Use Reiniciar." : "npm test, git status, ls…"} autoComplete="off" spellCheck={false} maxLength={10_000} />
        <button className="secondary" disabled={!session || session.closed || !command.trim()}>Executar</button>
      </form>
    </section>
  );
}

function TerminalLine({ event }: { event: TerminalEvent }) {
  if (event.kind === "input") return <div className="terminal-line input"><span aria-hidden="true">$ </span>{event.text}</div>;
  if (event.kind === "stdout") return <pre className="terminal-line">{event.text}</pre>;
  if (event.kind === "stderr") return <pre className="terminal-line stderr">{event.text}</pre>;
  if (event.kind === "done") return event.exitCode ? <div className="terminal-line status failed">saída {event.exitCode}</div> : null;
  return <div className="terminal-line status">Bash encerrado{event.exitCode !== null && event.exitCode !== undefined ? ` (código ${event.exitCode})` : ""}.</div>;
}
