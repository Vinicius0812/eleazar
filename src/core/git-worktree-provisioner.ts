import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import type { ControlRoomTask, LocalProject, LocalProjectDirectory, TaskWorktree } from "./control-room.js";
import type { WorktreeProvisioner } from "./control-room-service.js";

/**
 * Creates one local worktree per scope directory, all on a branch dedicated to the task.
 * Worktrees live under `root`, outside the repositories, and are reused by later turns.
 * It never invokes push, merge, or deploy.
 */
export class GitWorktreeProvisioner implements WorktreeProvisioner {
  private readonly root: string;
  constructor(root: string, private readonly run: GitRunner = runGit) { this.root = resolve(root); }

  async prepare(_project: LocalProject, task: ControlRoomTask, directories: readonly LocalProjectDirectory[]): Promise<TaskWorktree[]> {
    const branch = taskBranchName(task);
    const taskRoot = join(this.root, safePathSegment(task.id));
    await mkdir(taskRoot, { recursive: true });
    const worktrees: TaskWorktree[] = [];
    for (const [index, directory] of directories.entries()) {
      const target = join(taskRoot, `${index}-${slug(directory.name, 24)}`);
      let baseCommit: string;
      try { baseCommit = (await this.run(directory.path, ["rev-parse", "HEAD"])).trim(); }
      catch { throw new Error(`O repositorio ${directory.name} ainda nao tem commits; crie um commit inicial para isolar a tarefa em uma branch.`); }
      if (!existsSync(join(target, ".git"))) {
        const branchExists = await this.run(directory.path, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
        const emptyHooksDirectory = await mkdtemp(join(tmpdir(), "eleazar-empty-git-hooks-"));
        try {
          await this.run(directory.path, ["-c", `core.hooksPath=${emptyHooksDirectory}`, "worktree", "add",
            ...(branchExists ? [target, branch] : ["-b", branch, target, baseCommit])]);
        } finally {
          await rm(emptyHooksDirectory, { recursive: true, force: true });
        }
      }
      worktrees.push({ taskId: task.id, directoryId: directory.id, path: target, branch, baseCommit, createdAt: new Date().toISOString() });
    }
    return worktrees;
  }

  /** Git itself refuses to remove a worktree with uncommitted changes; the branch is kept. */
  async remove(worktree: TaskWorktree, sourcePath: string): Promise<void> {
    if (!existsSync(worktree.path)) { await this.run(sourcePath, ["worktree", "prune"]); return; }
    try { await this.run(sourcePath, ["worktree", "remove", worktree.path]); }
    catch { throw new Error("A worktree tem alteracoes sem commit ou esta em uso; faca commit ou descarte as alteracoes antes de remover."); }
  }
}

export type GitRunner = (cwd: string, args: readonly string[]) => Promise<string>;

/** `eleazar/<titulo>-<id curto>`: readable, unique per task and always a valid ref name. */
export function taskBranchName(task: Pick<ControlRoomTask, "id" | "title">): string {
  return `eleazar/${slug(task.title, 40)}-${slug(task.id, 8)}`;
}

const runGit: GitRunner = (cwd, args) => {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], { shell: false, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise(output) : reject(new Error(`git ${args.find((item) => !item.startsWith("-") && !item.includes("=")) ?? ""} falhou (codigo ${code ?? "desconhecido"}).`)));
  });
};

function slug(value: string, maxLength: number): string {
  const text = value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").slice(0, maxLength).replace(/^-+|-+$/g, "");
  return text || "tarefa";
}

function safePathSegment(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Identificador de task invalido para worktree.");
  return value;
}
