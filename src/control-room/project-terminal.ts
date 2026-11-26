import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { findOnPath } from "../adapters/executable-path.js";
import { terminateProcessTree } from "../adapters/process-tree.js";
import type { ControlRoomService } from "../core/control-room-service.js";

export interface TerminalSessionInfo {
  id: string;
  projectId: string;
  directoryId: string;
  /** Folder the shell started in. */
  root: string;
  /** Last working directory the shell reported, after `cd`. */
  cwd: string;
  shell: string;
  startedAt: string;
  /** True while a command sent by the operator has not reported back yet. */
  busy: boolean;
  exitCode: number | null;
  closed: boolean;
}

export type TerminalEventKind = "input" | "stdout" | "stderr" | "done" | "exit";
export interface TerminalEvent { sessionId: string; sequence: number; id: string; kind: TerminalEventKind; text?: string; exitCode?: number | null; cwd?: string; createdAt: string; }

/** Kept for a reload of the page; older output is dropped. */
const maxEvents = 4_000;
const maxBufferedChars = 1_000_000;
export const maxCommandChars = 10_000;
const maxSessions = 6;
/** Separates the operator's output from the line each command writes when it ends: exit code and directory. */
const marker = "\u001eELEAZAR";

type Listener = (event: TerminalEvent) => void;

interface Session {
  info: TerminalSessionInfo;
  child: ChildProcess;
  events: TerminalEvent[];
  chars: number;
  sequence: number;
  pending: string;
  listeners: Set<Listener>;
}

/**
 * A bash shell per open terminal, started in one of the project's folders with the operator's own
 * environment. Commands typed in the Control Room are written to the shell's input as they are
 * (never pasted into another command line) and the output is streamed back. There is no pseudo
 * terminal: programs that need an interactive TTY do not work, and the shell keeps its directory
 * between commands. Nothing is persisted; closing the host closes every shell.
 */
export class ProjectTerminals {
  readonly #sessions = new Map<string, Session>();

  constructor(private readonly service: ControlRoomService, private readonly shell: () => string = resolveBash) {}

  list(projectId: string): TerminalSessionInfo[] {
    return [...this.#sessions.values()].filter((session) => session.info.projectId === projectId && !session.info.closed).map((session) => ({ ...session.info }));
  }

  get(sessionId: string): TerminalSessionInfo {
    return { ...this.#require(sessionId).info };
  }

  open(projectId: string, directoryId: string): TerminalSessionInfo {
    const project = this.service.getProject(projectId);
    if (!project) throw Object.assign(new Error("Projeto local nao encontrado."), { statusCode: 404 });
    const directory = project.directories.find((item) => item.id === directoryId);
    if (!directory) throw Object.assign(new Error("Diretorio nao pertence ao projeto."), { statusCode: 404 });
    const open = [...this.#sessions.values()].filter((session) => !session.info.closed);
    if (open.length >= maxSessions) throw Object.assign(new Error(`Feche um terminal antes de abrir outro (limite de ${maxSessions}).`), { statusCode: 409 });
    const shell = this.shell();
    const child = spawn(shell, ["--noprofile", "--norc", "-s"], {
      cwd: directory.path, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "dumb", NO_COLOR: "1", PS1: "" },
      detached: process.platform !== "win32"
    });
    const info: TerminalSessionInfo = { id: randomUUID(), projectId, directoryId, root: directory.path, cwd: directory.path, shell, startedAt: new Date().toISOString(), busy: false, exitCode: null, closed: false };
    const session: Session = { info, child, events: [], chars: 0, sequence: 0, pending: "", listeners: new Set() };
    this.#sessions.set(info.id, session);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.#stdout(session, chunk));
    child.stderr?.on("data", (chunk: string) => this.#emit(session, { kind: "stderr", text: chunk }));
    child.once("error", (error) => { this.#emit(session, { kind: "stderr", text: `Nao foi possivel iniciar o bash (${shell}): ${error.message}\n` }); this.#exit(session, null); });
    child.once("exit", (code) => this.#exit(session, code));
    return { ...info };
  }

  write(sessionId: string, command: string): void {
    const session = this.#require(sessionId);
    if (session.info.closed || !session.child.stdin?.writable) throw Object.assign(new Error("O terminal foi encerrado; abra outro."), { statusCode: 409 });
    if (command.length > maxCommandChars) throw new Error(`Comando maior que ${maxCommandChars} caracteres.`);
    if (/[\r\n]/.test(command.trim())) throw new Error("Envie um comando por vez, em uma linha.");
    const line = command.trim();
    this.#emit(session, { kind: "input", text: line });
    session.info.busy = true;
    // The marker line runs after the command and reports its exit code and the shell's directory.
    session.child.stdin.write(`${line}\nprintf '\\n${marker}:%s:%s\\n' "$?" "$(pwd -W 2>/dev/null || pwd)"\n`);
  }

  async close(sessionId: string): Promise<TerminalSessionInfo> {
    const session = this.#require(sessionId);
    if (!session.info.closed) {
      session.child.stdin?.end();
      await terminateProcessTree(session.child, { groupIsolated: process.platform !== "win32" }).catch(() => undefined);
      this.#exit(session, session.child.exitCode);
    }
    return { ...session.info };
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((id) => this.close(id)));
  }

  /** Replays what happened after `afterSequence`, then follows the session until it closes. */
  subscribe(sessionId: string, afterSequence: number, listener: Listener): () => void {
    const session = this.#require(sessionId);
    for (const event of session.events) if (event.sequence > afterSequence) listener(event);
    session.listeners.add(listener);
    return () => { session.listeners.delete(listener); };
  }

  #stdout(session: Session, chunk: string): void {
    const text = session.pending + chunk;
    const lines = text.split("\n");
    // A partial last line may be the start of a marker; hold it until the rest arrives.
    const last = lines.pop() ?? "";
    const holdLast = last.startsWith(marker.slice(0, Math.min(last.length, marker.length)));
    session.pending = holdLast ? last : "";
    let visible = "";
    for (const line of lines) {
      const done = line.startsWith(`${marker}:`) ? /^\u001eELEAZAR:(\d+):(.*)$/.exec(line.replace(/\r$/, "")) : null;
      if (done) {
        // printf starts with a newline so the marker never shares a line with the command's output; drop it.
        if (visible.endsWith("\n")) visible = visible.slice(0, -1);
        if (visible) { this.#emit(session, { kind: "stdout", text: visible }); visible = ""; }
        session.info.busy = false;
        session.info.cwd = done[2]?.trim() || session.info.cwd;
        this.#emit(session, { kind: "done", exitCode: Number(done[1]), cwd: session.info.cwd });
        continue;
      }
      visible += `${line}\n`;
    }
    if (!holdLast) visible += last;
    if (visible) this.#emit(session, { kind: "stdout", text: visible });
  }

  #exit(session: Session, code: number | null): void {
    if (session.info.closed) return;
    session.info.closed = true;
    session.info.busy = false;
    session.info.exitCode = code;
    this.#emit(session, { kind: "exit", exitCode: code });
  }

  #emit(session: Session, event: Omit<TerminalEvent, "sessionId" | "sequence" | "id" | "createdAt">): void {
    session.sequence += 1;
    const full: TerminalEvent = { ...event, sessionId: session.info.id, sequence: session.sequence, id: `${session.info.id}:${session.sequence}`, createdAt: new Date().toISOString() };
    session.events.push(full);
    session.chars += full.text?.length ?? 0;
    while (session.events.length > maxEvents || session.chars > maxBufferedChars) session.chars -= session.events.shift()?.text?.length ?? 0;
    for (const listener of session.listeners) listener(full);
  }

  #require(sessionId: string): Session {
    const session = this.#sessions.get(sessionId);
    if (!session) throw Object.assign(new Error("Terminal nao encontrado."), { statusCode: 404 });
    return session;
  }
}

/** Git for Windows' bash on Windows (never the WSL launcher in System32); the system bash elsewhere. */
export function resolveBash(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ELEAZAR_BASH) return env.ELEAZAR_BASH;
  if (process.platform !== "win32") return findOnPath("bash") ?? "/bin/bash";
  const candidates = [env.ProgramFiles, env.ProgramW6432, env["ProgramFiles(x86)"]].filter(Boolean).map((base) => join(base!, "Git", "bin", "bash.exe"));
  if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  const git = findOnPath("git.exe") ?? findOnPath("git");
  if (git) candidates.push(join(git, "..", "..", "bin", "bash.exe"));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Bash nao encontrado. Instale o Git for Windows ou defina ELEAZAR_BASH com o caminho do bash.exe.");
  return found;
}
