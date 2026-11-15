import type { RepositoryPublisher, TaskWorktree } from "../core/control-room.js";
import { runProcess, type ProcessResult } from "./process-runner.js";

export type CommandRunner = (command: string, args: readonly string[], cwd: string, timeoutMs: number) => Promise<ProcessResult>;

const maxListedFiles = 50;

/**
 * Commit, push and pull request through the user's own `git` and `gh`. Authentication stays
 * with those tools: this adapter never reads tokens and strips credentials from anything it returns.
 */
export class GitRepositoryPublisher implements RepositoryPublisher {
  constructor(private readonly run: CommandRunner = runCommand) {}

  async inspect(worktree: TaskWorktree): Promise<{ remote: string | null; changedFiles: number; files: string[]; commitsAhead: number }> {
    const status = await this.git(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], "ler o estado");
    const files = status.split("\0").filter((entry) => entry.length > 3).map((entry) => entry.slice(3));
    const remote = await this.run("git", ["remote", "get-url", "origin"], worktree.path, 10_000)
      .then((result) => result.exitCode === 0 && result.stdout.trim() ? withoutCredentials(result.stdout.trim()) : null, () => null);
    let commitsAhead = 0;
    if (worktree.baseCommit) {
      commitsAhead = Number((await this.git(worktree, ["rev-list", "--count", `${worktree.baseCommit}..HEAD`], "contar commits")).trim()) || 0;
    }
    return { remote, changedFiles: files.length, files: files.slice(0, maxListedFiles), commitsAhead };
  }

  async commit(worktree: TaskWorktree, message: string): Promise<string> {
    await this.git(worktree, ["add", "--all"], "preparar os arquivos");
    await this.git(worktree, ["commit", "--message", message], "criar o commit", 120_000);
    const hash = (await this.git(worktree, ["rev-parse", "--short", "HEAD"], "ler o commit")).trim();
    return `commit ${hash} em ${worktree.branch}`;
  }

  async push(worktree: TaskWorktree): Promise<string> {
    await this.git(worktree, ["push", "--set-upstream", "origin", worktree.branch], "enviar a branch", 180_000);
    return `branch ${worktree.branch} enviada para origin`;
  }

  async openPullRequest(worktree: TaskWorktree, title: string, body: string): Promise<string> {
    let result: ProcessResult;
    try { result = await this.run("gh", ["pr", "create", "--head", worktree.branch, "--title", title, "--body", body], worktree.path, 120_000); }
    catch { throw new Error("GitHub CLI (gh) nao encontrado. Instale e autentique o gh para abrir pull requests."); }
    if (result.exitCode !== 0 || result.timedOut) throw new Error(`Nao foi possivel abrir o pull request: ${failureDetail(result)}`);
    return withoutCredentials(result.stdout.trim().split(/\r?\n/).at(-1) ?? "pull request aberto");
  }

  private async git(worktree: TaskWorktree, args: readonly string[], purpose: string, timeoutMs = 30_000): Promise<string> {
    const result = await this.run("git", args, worktree.path, timeoutMs);
    if (result.exitCode !== 0 || result.timedOut) throw new Error(`Nao foi possivel ${purpose}: ${failureDetail(result)}`);
    return result.stdout;
  }
}

/** Never lets Git or gh wait on a terminal prompt the Control Room cannot answer. */
const runCommand: CommandRunner = (command, args, cwd, timeoutMs) =>
  runProcess(command, args, { cwd, timeoutMs, maxOutputBytes: 1_000_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" } });

function failureDetail(result: ProcessResult): string {
  if (result.timedOut) return "tempo esgotado.";
  const text = withoutCredentials((result.stderr.trim() || result.stdout.trim()).slice(-600));
  return text || `codigo ${result.exitCode ?? "desconhecido"}.`;
}

/** Remote URLs may embed `user:token@`; that part must never be stored or shown. */
export function withoutCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1");
}
