import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import { terminateProcessTree } from "../adapters/process-tree.js";

export interface ManagedCommand {
  name: string;
  /** Executable, normally `process.execPath`. Never run through a shell. */
  command: string;
  /** Fixed arguments; nothing user-provided is interpolated. */
  args: string[];
  cwd: string;
}

export interface SignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface SupervisorOptions {
  commands: ManagedCommand[];
  log?: (line: string) => void;
  signals?: SignalSource;
  /** Injection points for tests. */
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  terminate?: typeof terminateProcessTree;
  /** stdio for children; `inherit` for the real launcher. */
  stdio?: SpawnOptions["stdio"];
}

const ignoreLateError = () => undefined;

/**
 * Runs the given commands together and stops them together. A signal, a startup failure or the
 * exit of any child stops only the processes spawned here, and the returned promise resolves with
 * the exit code after every cleanup has settled.
 *
 * Signal handlers stay installed (and idempotent) until the cleanup is finished, so a second
 * Ctrl+C cannot fall back to Node's default action and kill the launcher mid-cleanup. If a child
 * cannot be confirmed as stopped, the exit code is non-zero and the PID is logged.
 *
 * Scope of the tree guarantee: children that are alive when the shutdown starts are stopped with
 * their descendants. Descendants left behind by a child that had already exited on its own are
 * not tracked or killed (no PID enumeration is attempted).
 */
export function superviseProcesses(options: SupervisorOptions): Promise<number> {
  const log = options.log ?? ((line: string) => console.error(line));
  const signals: SignalSource = options.signals ?? process;
  const launch = options.spawnProcess ?? spawn;
  const terminate = options.terminate ?? terminateProcessTree;
  const isolated = process.platform !== "win32";
  const children: Array<{ name: string; child: ChildProcess; detach(): void }> = [];

  return new Promise<number>((resolve) => {
    let stopping: Promise<void> | null = null;
    let exitCode = 0;
    const onInterrupt = () => { void stop(0, "Encerrando por sinal do operador (SIGINT)."); };
    const onTerminate = () => { void stop(0, "Encerrando por SIGTERM."); };

    function stop(code: number, reason: string): Promise<void> {
      if (stopping) return stopping; // idempotent: later signals and exits share the same cleanup
      exitCode = code;
      log(`[control-room] ${reason}`);
      stopping = Promise.allSettled(children.map(({ child }) => terminate(child, { groupIsolated: isolated })))
        .then((results) => {
          results.forEach((result, index) => {
            if (result.status === "rejected") {
              const reasonText = result.reason instanceof Error ? result.reason.message : String(result.reason);
              log(`[control-room] ${children[index]?.name ?? "processo"}: falha ao encerrar: ${reasonText}`);
              if (exitCode === 0) exitCode = 1;
            }
          });
        })
        .finally(() => {
          signals.off("SIGINT", onInterrupt);
          signals.off("SIGTERM", onTerminate);
          for (const entry of children) entry.detach();
          resolve(exitCode);
        });
      return stopping;
    }

    signals.on("SIGINT", onInterrupt);
    signals.on("SIGTERM", onTerminate);

    for (const spec of options.commands) {
      let child: ChildProcess;
      try {
        child = launch(spec.command, spec.args, { cwd: spec.cwd, stdio: options.stdio ?? "inherit", shell: false, windowsHide: true, detached: isolated });
      } catch (error) {
        void stop(1, `${spec.name} nao pode ser iniciado: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      const onError = (error: Error) => { void stop(1, `${spec.name} falhou ao iniciar: ${error.message}`); };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (stopping) return;
        const failed = code !== 0 || signal !== null;
        void stop(code ?? 1, `${spec.name} encerrou ${failed ? `com falha (${signal ?? `codigo ${code}`})` : "inesperadamente"}; parando os demais processos.`);
      };
      child.on("error", onError);
      child.once("exit", onExit);
      children.push({
        name: spec.name,
        child,
        // After cleanup our listeners go away; a no-op error listener keeps a late error from crashing the launcher.
        detach: () => { child.off("error", onError); child.off("exit", onExit); child.on("error", ignoreLateError); }
      });
    }
  });
}
