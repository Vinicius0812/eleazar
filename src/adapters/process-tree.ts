import { spawn, type ChildProcess } from "node:child_process";

export interface TerminateOptions {
  /**
   * True only when the child was spawned with `detached: true` on POSIX, so it leads its own
   * process group and the whole group can be signalled. Otherwise only the child itself is killed.
   */
  groupIsolated?: boolean;
  /** Upper bound for taskkill and for waiting on the child's exit. Defaults to 3 seconds. */
  timeoutMs?: number;
  /** Test seam: replaces the platform kill action. Production code uses the default. */
  killTree?: (child: ChildProcess, pid: number, groupIsolated: boolean, timeoutMs: number) => Promise<void>;
}

const defaultTimeoutMs = 3_000;

export function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Stops a child this process spawned, together with its descendants, and resolves only once that
 * child has really exited. If it is still alive after the bounded wait, it rejects with an error
 * naming the PID instead of reporting success.
 *
 * It only ever targets `child.pid`: `taskkill /PID <pid> /T /F` on Windows, or the child's own
 * isolated process group on POSIX. It never kills by name or port. Calling it again is harmless.
 *
 * Limits (deliberate, no PID enumeration is attempted):
 * - A child that already exited is a no-op. Descendants it left behind are NOT reached: Windows
 *   `/T` needs the parent to exist, and on POSIX the group may outlive its leader.
 * - Success is confirmed for the child itself. Descendants are covered by `/T` or the group kill
 *   issued while the child was alive, not verified one by one.
 */
export async function terminateProcessTree(child: ChildProcess, options: TerminateOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const pid = child.pid;
  if (hasExited(child) || !pid) return;
  const exited = waitForExit(child);
  let limit: ReturnType<typeof setTimeout> | undefined;
  try {
    await (options.killTree ?? killTree)(child, pid, options.groupIsolated === true, timeoutMs);
    if (!hasExited(child)) child.kill();
    await Promise.race([exited.promise, new Promise<void>((resolve) => { limit = setTimeout(resolve, timeoutMs); })]);
    if (!hasExited(child)) throw new Error(`O processo filho PID ${pid} nao encerrou em ${timeoutMs} ms.`);
  } finally {
    if (limit) clearTimeout(limit);
    exited.dispose();
  }
}

async function killTree(child: ChildProcess, pid: number, groupIsolated: boolean, timeoutMs: number): Promise<void> {
  if (process.platform === "win32") return runTaskkill(pid, timeoutMs);
  if (groupIsolated) {
    try { process.kill(-pid, "SIGKILL"); return; } catch { /* fall back to the child alone */ }
  }
  child.kill("SIGKILL");
}

function waitForExit(child: ChildProcess): { promise: Promise<void>; dispose(): void } {
  let listener = () => {};
  const promise = new Promise<void>((resolve) => { listener = resolve; child.once("exit", listener); });
  return { promise, dispose: () => { child.off("exit", listener); } };
}

function runTaskkill(pid: number, timeoutMs: number): Promise<void> {
  return new Promise<void>((done) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", shell: false, windowsHide: true });
    const timer = setTimeout(() => { killer.kill(); finish(); }, timeoutMs);
    function finish() { clearTimeout(timer); killer.off("exit", finish); done(); }
    killer.on("error", finish); // stays attached so a late error never becomes an unhandled event
    killer.once("exit", finish);
  });
}
