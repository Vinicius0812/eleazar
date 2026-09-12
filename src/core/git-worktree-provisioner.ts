import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import type { ControlRoomTask, LocalProject } from "./control-room.js";
import type { WorktreeProvisioner } from "./control-room-service.js";

/** Creates isolated, local-only worktrees. It never invokes push, merge, or deploy. */
export class GitWorktreeProvisioner implements WorktreeProvisioner {
  constructor(private readonly run: GitRunner = runGit) {}

  async prepare(project: LocalProject, task: ControlRoomTask): Promise<string> {
    const baseDirectory = resolve(project.path, ".eleazar", "worktrees");
    const target = join(baseDirectory, task.id);
    await mkdir(baseDirectory, { recursive: true });
    const emptyHooksDirectory = await mkdtemp(join(tmpdir(), "eleazar-empty-git-hooks-"));
    try {
      await this.run(project.path, ["-c", `core.hooksPath=${emptyHooksDirectory}`, "worktree", "add", "--detach", target]);
    } finally {
      await rm(emptyHooksDirectory, { recursive: true, force: true });
    }
    return target;
  }
}

export type GitRunner = (cwd: string, args: readonly string[]) => Promise<void>;

const runGit: GitRunner = (cwd, args) => {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], { shell: false, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`git worktree add falhou (codigo ${code ?? "desconhecido"}).`)));
  });
};
