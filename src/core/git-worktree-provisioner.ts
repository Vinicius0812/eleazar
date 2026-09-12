import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

import type { ControlRoomTask, LocalProject } from "./control-room.js";
import type { WorktreeProvisioner } from "./control-room-service.js";

/** Creates isolated, local-only worktrees. It never invokes push, merge, or deploy. */
export class GitWorktreeProvisioner implements WorktreeProvisioner {
  constructor(private readonly run: GitRunner = runGit) {}

  async prepare(project: LocalProject, task: ControlRoomTask): Promise<string> {
    if (!task.dispatchLease) throw new Error("Uma worktree exige uma tentativa com lease.");
    const baseDirectory = resolve(project.path, ".eleazar", "worktrees");
    const target = join(baseDirectory, task.id);
    await mkdir(baseDirectory, { recursive: true });
    const emptyHooksDirectory = await mkdtemp(join(tmpdir(), "eleazar-empty-git-hooks-"));
    try {
      await this.reconcileOrphan(project.path, target, task, emptyHooksDirectory);
      await this.run(project.path, ["-c", `core.hooksPath=${emptyHooksDirectory}`, "worktree", "add", "--detach", target]);
      await writeFile(leaseMarkerPath(target), JSON.stringify({ taskId: task.id, leaseId: task.dispatchLease }), "utf8");
    } finally {
      await rm(emptyHooksDirectory, { recursive: true, force: true });
    }
    return target;
  }

  private async reconcileOrphan(projectPath: string, target: string, task: ControlRoomTask, emptyHooksDirectory: string): Promise<void> {
    try {
      await readFile(leaseMarkerPath(target), "utf8");
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    const marker = await readLeaseMarker(target);
    if (!marker || marker.taskId !== task.id || marker.leaseId === task.dispatchLease) {
      throw new Error("A worktree existente esta ativa ou nao pode ser validada como orfa.");
    }
    const gitConfig = ["-c", `core.hooksPath=${emptyHooksDirectory}`] as const;
    const listed = await this.run(projectPath, [...gitConfig, "worktree", "list", "--porcelain"]);
    if (!worktreeListContains(listed, target) || !isInside(target, resolve(projectPath, ".eleazar", "worktrees"))) {
      throw new Error("A worktree existente nao pertence ao projeto; a remocao foi bloqueada.");
    }
    await this.run(projectPath, [...gitConfig, "worktree", "remove", "--force", target]);
  }
}

export type GitRunner = (cwd: string, args: readonly string[]) => Promise<string>;

const runGit: GitRunner = (cwd, args) => {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], { shell: false, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise(output) : reject(new Error(`git worktree falhou (codigo ${code ?? "desconhecido"}).`)));
  });
};

interface LeaseMarker { taskId: string; leaseId: string; }
function leaseMarkerPath(target: string): string { return join(target, ".eleazar-control-room-lease.json"); }
async function readLeaseMarker(target: string): Promise<LeaseMarker | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(leaseMarkerPath(target), "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const marker = parsed as Partial<LeaseMarker>;
    return typeof marker.taskId === "string" && typeof marker.leaseId === "string" ? { taskId: marker.taskId, leaseId: marker.leaseId } : null;
  } catch { return null; }
}
function worktreeListContains(output: string, target: string): boolean {
  return output.split(/\r?\n/).some((line) => line.startsWith("worktree ") && samePath(line.slice("worktree ".length), target));
}
function samePath(left: string, right: string): boolean { return resolve(left).toLowerCase() === resolve(right).toLowerCase(); }
function isInside(candidate: string, parent: string): boolean { const path = relative(parent, candidate); return path !== "" && !path.startsWith("..") && !path.includes(":"); }
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
