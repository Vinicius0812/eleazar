import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import type { ControlRoomTask, LocalProject } from "./control-room.js";
import type { WorktreeProvisioner } from "./control-room-service.js";

/** Creates isolated, local-only worktrees. It never invokes push, merge, or deploy. */
export class GitWorktreeProvisioner implements WorktreeProvisioner {
  async prepare(project: LocalProject, task: ControlRoomTask): Promise<string> {
    const baseDirectory = resolve(project.path, ".eleazar", "worktrees");
    const target = join(baseDirectory, task.id);
    await mkdir(baseDirectory, { recursive: true });
    await runGit(project.path, ["worktree", "add", "--detach", target]);
    return target;
  }
}

function runGit(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], { shell: false, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`git worktree add falhou (codigo ${code ?? "desconhecido"}).`)));
  });
}
