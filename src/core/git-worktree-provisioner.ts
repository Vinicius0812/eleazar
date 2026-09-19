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
    if (!task.dispatchLease) throw new Error("Uma worktree exige uma tentativa com lease.");
    const baseDirectory = resolve(project.path, ".eleazar", "worktrees");
    const target = join(baseDirectory, `${safePathSegment(task.id)}-${safePathSegment(task.dispatchLease)}`);
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

function safePathSegment(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Identificador de task ou lease invalido para worktree.");
  return value;
}
