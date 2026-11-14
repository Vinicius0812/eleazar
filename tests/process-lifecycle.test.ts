import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { hasExited, terminateProcessTree } from "../src/adapters/process-tree.js";
import { superviseProcesses, type ManagedCommand, type SupervisorOptions } from "../src/control-room/dev-supervisor.js";

// Real subprocesses (parent + descendant) from a provider-free fixture. They cover the platform the
// tests run on: taskkill /T on Windows, the isolated process group on POSIX.
const isolated = process.platform !== "win32";
const fixture = resolve(import.meta.dirname, "fixtures", "process-tree-parent.mjs");

// Teardown never kills a raw PID: a number read from a file may already belong to someone else.
// It only stops (a) fixtures this file spawned, through their ChildProcess handle while still alive,
// (b) supervisors it started, through their own handlers, and (c) waits for the intentionally
// orphaned descendant to end by its own short TTL. Each wait is bounded and failures are reported.
const fixtures: ChildProcess[] = [];
const supervised: Array<{ emitter: EventEmitter; done: Promise<number> }> = [];
const selfEnding: number[] = [];
const roots: string[] = [];

afterEach(async () => {
  const problems: string[] = [];
  for (const { emitter, done } of supervised.splice(0)) {
    emitter.emit("SIGINT"); // no-op when the supervisor already finished (its handlers are gone)
    await done.catch((error: unknown) => problems.push(`supervisor: ${String(error)}`));
  }
  for (const child of fixtures.splice(0)) {
    if (hasExited(child)) continue;
    await terminateProcessTree(child, { groupIsolated: isolated }).catch((error: unknown) => problems.push(String(error)));
  }
  for (const pid of selfEnding.splice(0)) {
    // Liveness probe only (signal 0 sends nothing); the fixture's own 1.5 s TTL ends it.
    await until(() => !alive(pid), 6_000).catch(() => problems.push(`descendente ${pid} nao terminou pelo proprio TTL`));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (problems.length) throw new Error(`Falha de limpeza dos testes: ${problems.join("; ")}`);
}, 20_000);

function workDir(): string {
  const root = mkdtempSync(join(tmpdir(), "eleazar proc "));
  roots.push(root);
  return root;
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function until(check: () => boolean, ms = 8_000): Promise<void> {
  const limit = Date.now() + ms;
  while (!check()) {
    if (Date.now() > limit) throw new Error("condicao nao atingida a tempo");
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}
interface Pids { parent: number; descendant: number }
async function readPids(file: string): Promise<Pids> {
  await until(() => existsSync(file) && readFileSync(file, "utf8").endsWith("}"));
  return JSON.parse(readFileSync(file, "utf8")) as Pids;
}
function startFixture(script: string, mode: "run" | "exit" | "orphan", pidFile: string): ChildProcess {
  const child = spawn(process.execPath, [script, mode, pidFile], { stdio: "ignore", shell: false, detached: isolated, windowsHide: true });
  fixtures.push(child);
  return child;
}
function track(emitter: EventEmitter, done: Promise<number>): Promise<number> {
  supervised.push({ emitter, done });
  return done;
}
const command = (name: string, mode: "run" | "exit", pidFile: string, script = fixture): ManagedCommand =>
  ({ name, command: process.execPath, args: [script, mode, pidFile], cwd: tmpdir() });

describe("terminateProcessTree", () => {
  it("stops the child and its descendant, waits for the real exit, and is idempotent", async () => {
    const pidFile = join(workDir(), "pids.json");
    const child = startFixture(fixture, "run", pidFile);
    const pids = await readPids(pidFile);
    expect(alive(pids.descendant)).toBe(true);

    await terminateProcessTree(child, { groupIsolated: isolated });
    expect(hasExited(child)).toBe(true); // already exited when the promise resolves
    await until(() => !alive(pids.descendant));
    expect(alive(pids.parent)).toBe(false);

    await expect(terminateProcessTree(child, { groupIsolated: isolated })).resolves.toBeUndefined();
    await expect(Promise.all([terminateProcessTree(child), terminateProcessTree(child)])).resolves.toBeDefined();
  });

  it("works from a path containing spaces and leaves no exit listener behind", async () => {
    const dir = join(workDir(), "pasta com espaços");
    mkdirSync(dir);
    const script = join(dir, "process-tree-parent.mjs");
    copyFileSync(fixture, script);
    const pidFile = join(dir, "pids.json");
    const child = startFixture(script, "run", pidFile);
    const pids = await readPids(pidFile);
    const before = child.listenerCount("exit");
    await terminateProcessTree(child, { groupIsolated: isolated });
    await until(() => !alive(pids.descendant));
    expect(child.listenerCount("exit")).toBe(before);
  });

  it("rejects with the PID instead of reporting success when the child is still alive", async () => {
    const stuck = Object.assign(new EventEmitter(), { pid: 424242, exitCode: null, signalCode: null, kill: () => true }) as unknown as ChildProcess;
    await expect(terminateProcessTree(stuck, { timeoutMs: 40, killTree: async () => undefined })).rejects.toThrow(/PID 424242 nao encerrou/);
    expect(stuck.listenerCount("exit")).toBe(0);
  });

  it("documented limit: for a parent that already exited on its own, no kill is attempted at all", async () => {
    const pidFile = join(workDir(), "orphan.json");
    const child = startFixture(fixture, "orphan", pidFile);
    selfEnding.push((await readPids(pidFile)).descendant); // teardown waits for its own 1.5 s TTL; it is never killed by PID
    await until(() => hasExited(child));
    const killTree = vi.fn(async () => undefined);
    await terminateProcessTree(child, { groupIsolated: isolated, killTree });
    // Descendants it left behind are not tracked or enumerated; whether the OS reaped them is
    // platform-dependent and deliberately not asserted here.
    expect(killTree).not.toHaveBeenCalled();
  });

  it("does nothing for a child that never started or already exited", async () => {
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise((done) => dead.once("exit", done));
    await expect(terminateProcessTree(dead)).resolves.toBeUndefined();
    const missing = spawn(join(tmpdir(), "nao-existe-eleazar.exe"), [], { stdio: "ignore" });
    missing.once("error", () => undefined);
    await expect(terminateProcessTree(missing)).resolves.toBeUndefined();
  });
});

describe("superviseProcesses", () => {
  function signalSource() {
    const emitter = new EventEmitter();
    return { emitter, source: { emitter, on: (s: "SIGINT" | "SIGTERM", l: () => void) => emitter.on(s, l), off: (s: "SIGINT" | "SIGTERM", l: () => void) => emitter.off(s, l) } };
  }
  // Every supervisor started by a test is registered, so teardown can stop it even if an assertion failed.
  function supervise(options: SupervisorOptions & { signals: { emitter: EventEmitter } }): Promise<number> {
    return track(options.signals.emitter, superviseProcesses(options));
  }

  it("stops every owned process tree on SIGINT, exits 0, removes its listeners, and ignores a duplicate signal", async () => {
    const dir = workDir();
    const files = [join(dir, "a.json"), join(dir, "b.json")];
    const { emitter, source } = signalSource();
    const bystanderFile = join(dir, "bystander.json");
    const bystander = startFixture(fixture, "run", bystanderFile); // not launched by the supervisor
    const terminate = vi.fn(terminateProcessTree);
    const done = supervise({ commands: [command("A", "run", files[0]!), command("B", "run", files[1]!)], signals: source, log: () => undefined, stdio: "ignore", terminate });
    const [a, b, outside] = await Promise.all([readPids(files[0]!), readPids(files[1]!), readPids(bystanderFile)]);

    emitter.emit("SIGINT");
    emitter.emit("SIGTERM"); // duplicate while stopping
    expect(await done).toBe(0);
    expect(terminate).toHaveBeenCalledTimes(2);
    for (const pids of [a, b]) await until(() => !alive(pids.parent) && !alive(pids.descendant));
    expect(alive(outside.parent)).toBe(true); // only processes it spawned were touched
    expect(alive(outside.descendant)).toBe(true);
    expect(emitter.listenerCount("SIGINT") + emitter.listenerCount("SIGTERM")).toBe(0);
    expect(bystander.exitCode).toBeNull();
  });

  it("keeps the signal handlers until cleanup finishes and never cleans up twice", async () => {
    const dir = workDir();
    const files = [join(dir, "a.json"), join(dir, "b.json")];
    const { emitter, source } = signalSource();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const terminate = vi.fn(async (child: ChildProcess, options?: Parameters<typeof terminateProcessTree>[1]) => { await gate; await terminateProcessTree(child, options); });
    const done = supervise({ commands: [command("A", "run", files[0]!), command("B", "run", files[1]!)], signals: source, log: () => undefined, stdio: "ignore", terminate });
    await Promise.all(files.map(readPids));

    emitter.emit("SIGINT");
    expect(emitter.listenerCount("SIGINT")).toBe(1); // still installed while cleanup is pending
    expect(emitter.listenerCount("SIGTERM")).toBe(1);
    emitter.emit("SIGINT"); // second Ctrl+C
    emitter.emit("SIGTERM");
    expect(terminate).toHaveBeenCalledTimes(2);
    release();
    expect(await done).toBe(0);
    expect(emitter.listenerCount("SIGINT") + emitter.listenerCount("SIGTERM")).toBe(0);
    expect(terminate).toHaveBeenCalledTimes(2);
  });

  it("waits for every cleanup even if one fails, and exits non-zero naming the failure", async () => {
    const dir = workDir();
    const files = [join(dir, "a.json"), join(dir, "b.json")];
    const { emitter, source } = signalSource();
    const logs: string[] = [];
    let secondFinished = false;
    const terminate = vi.fn(async (child: ChildProcess, options?: Parameters<typeof terminateProcessTree>[1]) => {
      if (terminate.mock.calls.length === 1) {
        await terminateProcessTree(child, options); // really stops A, so nothing leaks; only the report fails
        throw new Error("O processo filho PID 1 nao encerrou em 3000 ms.");
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      await terminateProcessTree(child, options);
      secondFinished = true;
    });
    const done = supervise({ commands: [command("A", "run", files[0]!), command("B", "run", files[1]!)], signals: source, log: (line) => logs.push(line), stdio: "ignore", terminate });
    const [a, b] = await Promise.all(files.map(readPids));

    emitter.emit("SIGINT");
    expect(await done).toBe(1);
    expect(secondFinished).toBe(true); // the supervisor did not finish before the other cleanup
    for (const pids of [a!, b!]) await until(() => !alive(pids.parent) && !alive(pids.descendant));
    expect(logs.join("\n")).toMatch(/A: falha ao encerrar: .*PID 1/);
  });

  it("stops the sibling tree and reports the failing exit code when one child exits unexpectedly", async () => {
    const dir = workDir();
    const pidFile = join(dir, "long.json");
    const logs: string[] = [];
    const { emitter, source } = signalSource();
    const done = supervise({ commands: [command("API", "run", pidFile), command("Vite", "exit", join(dir, "unused.json"))], signals: source, log: (line) => logs.push(line), stdio: "ignore" });
    const pids = await readPids(pidFile);
    expect(await done).toBe(3);
    await until(() => !alive(pids.parent) && !alive(pids.descendant));
    expect(logs.join("\n")).toMatch(/Vite encerrou com falha/);
    expect(emitter.listenerCount("SIGINT")).toBe(0);
  });

  it("reports a startup failure clearly and stops what already started", async () => {
    const dir = workDir();
    const pidFile = join(dir, "ok.json");
    const logs: string[] = [];
    const { source } = signalSource();
    const done = supervise({
      commands: [command("API", "run", pidFile), { name: "Vite", command: join(dir, "binario-inexistente"), args: [], cwd: dir }],
      signals: source, log: (line) => logs.push(line), stdio: "ignore"
    });
    const pids = await readPids(pidFile);
    expect(await done).toBe(1);
    await until(() => !alive(pids.parent) && !alive(pids.descendant));
    expect(logs.join("\n")).toMatch(/Vite falhou ao iniciar/);
  });
});
