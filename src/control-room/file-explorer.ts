import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { runProcess } from "../adapters/process-runner.js";
import { gitEnvironment } from "../core/git-environment.js";
import type { ControlRoomService } from "../core/control-room-service.js";
import type { LocalProjectDirectory } from "../core/control-room.js";

/** Git's well-known empty tree: the base of a repository that has no commit yet. */
const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** Larger repositories (thousands of files) need more than the few seconds a status usually takes. */
const gitTimeoutMs = 60_000;
const maxGitOutputBytes = 16 * 1024 * 1024;
export const maxExplorerEntries = 2_000;
export const maxPreviewBytes = 512 * 1024;
export const maxDiffChars = 400_000;

export type ExplorerChangeKind = "added" | "modified" | "deleted" | "renamed" | "untracked";

export interface ExplorerRoot {
  directoryId: string;
  name: string;
  /** Folder the agent works in: the task's worktree, or the project folder when it runs in place. */
  path: string;
  mode: "worktree" | "direct";
  branch: string | null;
  isGitRepository: boolean;
  /** What the diff compares against: the commit the task branch started from, or HEAD in place. */
  base: string | null;
}

export interface ExplorerEntry {
  name: string;
  /** Relative to the root, always with `/`. */
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number | null;
  change: ExplorerChangeKind | null;
  /** For a directory: how many changed files are below it. */
  changedBelow: number;
}

export interface ExplorerListing { root: ExplorerRoot; path: string; entries: ExplorerEntry[]; truncated: boolean; }

export interface ExplorerChange {
  path: string;
  previousPath: string | null;
  kind: ExplorerChangeKind;
  additions: number | null;
  deletions: number | null;
  /** Already changed before the task's first run (the folder is shared with the user in direct mode). */
  preexisting?: boolean;
}

export interface ExplorerSearch { root: ExplorerRoot; query: string; paths: string[]; truncated: boolean; }
export const maxSearchResults = 200;
const maxWalkedEntries = 50_000;
/** Folders a walk of a plain folder skips: dependencies and build output are rarely what one looks for. */
const skippedFolders = new Set([".git", "node_modules", "dist", "build", ".next", "target", "bin", "obj", ".venv", "__pycache__"]);

/** A task id, or the project itself: its own folders, as they are on disk. */
export type ExplorerScope = string | { projectId: string };

export interface ExplorerChanges { root: ExplorerRoot; changes: ExplorerChange[]; warnings: string[]; }

export interface ExplorerFile {
  root: ExplorerRoot;
  path: string;
  exists: boolean;
  size: number | null;
  binary: boolean;
  /** Text of the file, or null for binary, missing or too large files. */
  content: string | null;
  tooLarge: boolean;
  change: ExplorerChange | null;
  /** Unified diff against the base, or null when the file did not change. */
  diff: string | null;
  diffTruncated: boolean;
}

/**
 * Read-only view of the files a task works on. It never writes to the folder or to Git, and only
 * serves paths inside the task's scope directories (symbolic links pointing outside are refused).
 */
export class TaskFileExplorer {
  /** A tree expansion asks for the same status many times in a row; a short cache keeps large repositories responsive. */
  readonly #cache = new Map<string, { expires: number; value: Promise<ExplorerChanges> }>();

  constructor(private readonly service: ControlRoomService, private readonly cacheMs = 2_000) {}

  /** The project's own folders, compared with their HEAD, independently of any task. */
  projectRoots(projectId: string): ExplorerRoot[] {
    const project = this.service.getProject(projectId);
    if (!project) throw notFound("Projeto local nao encontrado.");
    return project.directories.map((directory) => ({ directoryId: directory.id, name: directory.name, path: directory.path, mode: "direct" as const,
      branch: null, isGitRepository: directory.isGitRepository, base: directory.isGitRepository ? "HEAD" : null }));
  }

  roots(taskId: string): ExplorerRoot[] {
    const task = this.service.getTask(taskId);
    if (!task) throw notFound("Tarefa nao encontrada.");
    const project = this.service.getProject(task.projectId);
    if (!project) throw notFound("Projeto local nao encontrado.");
    const worktrees = this.service.store.listTaskWorktrees(taskId);
    return task.directoryIds
      .map((id) => project.directories.find((directory) => directory.id === id))
      .filter((directory): directory is LocalProjectDirectory => Boolean(directory))
      .map((directory) => {
        const worktree = worktrees.find((item) => item.directoryId === directory.id);
        return worktree
          ? { directoryId: directory.id, name: directory.name, path: worktree.path, mode: "worktree" as const, branch: worktree.branch, isGitRepository: true, base: worktree.baseCommit ?? "HEAD" }
          : { directoryId: directory.id, name: directory.name, path: directory.path, mode: "direct" as const, branch: null, isGitRepository: directory.isGitRepository, base: directory.isGitRepository ? "HEAD" : null };
      });
  }

  async list(taskId: ExplorerScope, directoryId: string, path = ""): Promise<ExplorerListing> {
    const root = this.root(taskId, directoryId);
    const segments = safeSegments(path);
    const absolute = await insideRoot(root.path, segments, true);
    const info = await lstat(absolute).catch(() => null);
    if (!info?.isDirectory()) throw notFound("Pasta nao encontrada.");
    const changes = root.isGitRepository ? (await this.collect(root)).changes : [];
    const prefix = segments.length ? `${segments.join("/")}/` : "";
    const dirents = (await readdir(absolute, { withFileTypes: true }))
      .filter((item) => !(segments.length === 0 && item.name === ".git"));
    dirents.sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name, "pt-BR", { sensitivity: "base" }));
    const truncated = dirents.length > maxExplorerEntries;
    const entries = await Promise.all(dirents.slice(0, maxExplorerEntries).map(async (item): Promise<ExplorerEntry> => {
      const relativePath = `${prefix}${item.name}`;
      const type = item.isDirectory() ? "directory" : item.isFile() ? "file" : item.isSymbolicLink() ? "symlink" : "other";
      const size = type === "file" ? await lstat(join(absolute, item.name)).then((stat) => stat.size, () => null) : null;
      const change = changes.find((candidate) => candidate.path === relativePath)?.kind ?? null;
      const changedBelow = type === "directory" ? changes.filter((candidate) => candidate.path.startsWith(`${relativePath}/`)).length : 0;
      return { name: item.name, path: relativePath, type, size, change, changedBelow };
    }));
    // Deleted files no longer exist on disk; list them so the diff stays reachable from the tree.
    const present = new Set(entries.map((entry) => entry.name));
    for (const change of changes) {
      if (change.kind !== "deleted" || !change.path.startsWith(prefix)) continue;
      const rest = change.path.slice(prefix.length);
      if (rest.includes("/") || present.has(rest)) continue;
      entries.push({ name: rest, path: change.path, type: "file", size: null, change: "deleted", changedBelow: 0 });
    }
    const isDirectory = (entry: ExplorerEntry) => Number(entry.type === "directory");
    entries.sort((left, right) => isDirectory(right) - isDirectory(left) || left.name.localeCompare(right.name, "pt-BR", { sensitivity: "base" }));
    return { root, path: segments.join("/"), entries, truncated };
  }

  async changes(taskId: ExplorerScope, directoryId: string): Promise<ExplorerChanges> {
    const root = this.root(taskId, directoryId);
    if (!root.isGitRepository) {
      return { root, changes: [], warnings: [`${root.name} nao e um repositorio Git; o explorador mostra os arquivos, mas nao ha diff para comparar.`] };
    }
    const collected = await this.collect(root);
    if (root.mode !== "direct" || typeof taskId !== "string") return collected;
    // In place, the diff against HEAD also shows what the user had already changed: mark it.
    const first = this.service.store.listExecutions(taskId).filter((execution) => execution.startedAt !== null)
      .sort((left, right) => (left.startedAt ?? "").localeCompare(right.startedAt ?? ""))[0];
    if (!first) return collected;
    const before = new Set(this.service.store.listExecutionFiles(first.id).filter((file) => file.directoryId === directoryId && file.kind === "preexisting").map((file) => file.path));
    if (!before.size) return collected;
    return { ...collected, changes: collected.changes.map((change) => before.has(change.path) ? { ...change, preexisting: true } : change) };
  }

  /** Finds files by name or path fragment across the whole folder, not only the expanded part of the tree. */
  async search(taskId: ExplorerScope, directoryId: string, query: string): Promise<ExplorerSearch> {
    const root = this.root(taskId, directoryId);
    const term = query.trim().toLowerCase().replaceAll("\\", "/");
    if (!term) return { root, query, paths: [], truncated: false };
    let all: string[] | null = null;
    if (root.isGitRepository) {
      const listed = await git(root.path, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
      if (listed.ok) all = [...new Set(listed.stdout.split("\0").filter(Boolean))];
    }
    all ??= await walk(root.path);
    const matches = all.filter((path) => path.toLowerCase().includes(term));
    // Name matches first, then shorter paths.
    matches.sort((left, right) => Number(!baseName(left).toLowerCase().includes(term)) - Number(!baseName(right).toLowerCase().includes(term)) || left.length - right.length || left.localeCompare(right));
    return { root, query, paths: matches.slice(0, maxSearchResults), truncated: matches.length > maxSearchResults };
  }

  async file(taskId: ExplorerScope, directoryId: string, path: string): Promise<ExplorerFile> {
    const root = this.root(taskId, directoryId);
    const segments = safeSegments(path);
    if (!segments.length) throw new Error("Informe o caminho do arquivo.");
    const relativePath = segments.join("/");
    const absolute = await insideRoot(root.path, segments, false);
    const info = await lstat(absolute).catch(() => null);
    if (info && !info.isFile()) throw new Error("O caminho informado nao e um arquivo.");
    const change = root.isGitRepository ? (await this.collect(root)).changes.find((item) => item.path === relativePath) ?? null : null;
    if (!info && !change) throw notFound("Arquivo nao encontrado.");

    let content: string | null = null;
    let binary = false;
    const tooLarge = Boolean(info && info.size > maxPreviewBytes);
    if (info && !tooLarge) {
      const bytes = await readHead(absolute, maxPreviewBytes);
      binary = looksBinary(bytes);
      if (!binary) content = bytes.toString("utf8");
    } else if (info) {
      binary = looksBinary(await readHead(absolute, 8_000));
    }

    let diff: string | null = null;
    let diffTruncated = false;
    if (change) {
      if (change.kind === "untracked") {
        diff = binary ? null : content !== null ? addedFileDiff(relativePath, content) : null;
      } else {
        const result = await git(root.path, ["diff", "--no-color", "--no-ext-diff", "-M", root.base ?? "HEAD", "--", ...(change.previousPath ? [change.previousPath] : []), relativePath]);
        diff = result.ok ? result.stdout : null;
      }
      if (diff !== null && diff.length > maxDiffChars) { diff = diff.slice(0, maxDiffChars); diffTruncated = true; }
    }
    return { root, path: relativePath, exists: Boolean(info), size: info?.size ?? null, binary, content, tooLarge, change, diff, diffTruncated };
  }

  private root(scope: ExplorerScope, directoryId: string): ExplorerRoot {
    const roots = typeof scope === "string" ? this.roots(scope) : this.projectRoots(scope.projectId);
    const root = roots.find((item) => item.directoryId === directoryId);
    if (!root) throw notFound(typeof scope === "string" ? "Diretorio fora do escopo da tarefa." : "Diretorio nao pertence ao projeto.");
    return root;
  }

  private collect(root: ExplorerRoot): Promise<ExplorerChanges> {
    const key = `${root.path}\0${root.base ?? ""}`;
    const cached = this.#cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    const value = this.readChanges(root);
    this.#cache.set(key, { expires: Date.now() + this.cacheMs, value });
    if (this.#cache.size > 50) for (const [stale, entry] of this.#cache) if (entry.expires <= Date.now()) this.#cache.delete(stale);
    return value;
  }

  private async readChanges(root: ExplorerRoot): Promise<ExplorerChanges> {
    let base = root.base ?? "HEAD";
    if (!(await git(root.path, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`])).ok) {
      if (base !== "HEAD") return { root, changes: [], warnings: [`O commit base ${base.slice(0, 12)} nao existe mais em ${root.name}.`] };
      base = emptyTree;
    }
    const [names, numbers, untracked] = await Promise.all([
      git(root.path, ["diff", "--name-status", "-z", "-M", base, "--"]),
      git(root.path, ["diff", "--numstat", "-z", "-M", base, "--"]),
      git(root.path, ["ls-files", "--others", "--exclude-standard", "-z"])
    ]);
    if (!names.ok || !numbers.ok || !untracked.ok) {
      return { root, changes: [], warnings: [`Nao foi possivel ler as alteracoes Git de ${root.name}${[names, numbers, untracked].some((item) => item.timedOut) ? " (tempo esgotado)" : ""}.`] };
    }
    const counts = parseNumstat(numbers.stdout);
    const changes = parseNameStatus(names.stdout).map((item) => ({ ...item, ...(counts.get(item.path) ?? { additions: null, deletions: null }) }));
    for (const path of untracked.stdout.split("\0").filter(Boolean)) {
      changes.push({ path, previousPath: null, kind: "untracked", additions: null, deletions: null });
    }
    changes.sort((left, right) => left.path.localeCompare(right.path));
    return { root, changes, warnings: [] };
  }
}

function baseName(path: string): string { return path.slice(path.lastIndexOf("/") + 1); }

async function walk(rootPath: string): Promise<string[]> {
  const found: string[] = [];
  const pending: string[] = [""];
  let visited = 0;
  while (pending.length && visited < maxWalkedEntries) {
    const current = pending.shift()!;
    const items = await readdir(current ? join(rootPath, ...current.split("/")) : rootPath, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      visited += 1;
      const path = current ? `${current}/${item.name}` : item.name;
      if (item.isDirectory()) { if (!skippedFolders.has(item.name)) pending.push(path); }
      else if (item.isFile()) found.push(path);
    }
  }
  return found;
}

/** Splits a client path (with `/` or `\`) and refuses anything that could leave the root. */
export function safeSegments(path: string): string[] {
  if (typeof path !== "string" || path.includes("\0") || path.length > 4_096) throw new Error("Caminho invalido.");
  if (isAbsolute(path) || /^[a-zA-Z]:/.test(path) || path.startsWith("\\\\")) throw new Error("Use um caminho relativo a pasta da tarefa.");
  const segments = path.split(/[\\/]+/).filter((segment) => segment && segment !== ".");
  if (segments.some((segment) => segment === "..")) throw new Error("Caminho fora da pasta da tarefa.");
  if (segments[0]?.toLowerCase() === ".git") throw new Error("Os metadados do Git nao sao exibidos pelo explorador.");
  return segments;
}

/** Resolves inside the root and checks the real path, so a symbolic link cannot point outside it. */
async function insideRoot(rootPath: string, segments: string[], mustExist: boolean): Promise<string> {
  const absolute = resolve(rootPath, ...segments);
  const realRoot = await realpath(rootPath).catch(() => { throw notFound("A pasta da tarefa nao esta acessivel."); });
  const real = await realpath(absolute).catch(() => null);
  if (!real && mustExist) throw notFound("Caminho nao encontrado.");
  const checked = real ?? resolve(realRoot, ...segments);
  const rest = relative(realRoot, checked);
  if (rest === ".." || rest.startsWith(`..${sep}`) || isAbsolute(rest)) throw new Error("Caminho fora da pasta da tarefa.");
  return absolute;
}

async function readHead(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
function looksBinary(bytes: Buffer): boolean { return bytes.subarray(0, 8_000).includes(0); }

export function addedFileDiff(path: string, content: string): string {
  const lines = content ? content.split(/\r?\n/) : [];
  if (content.endsWith("\n")) lines.pop();
  const header = `diff --git a/${path} b/${path}\nnew file\n--- /dev/null\n+++ b/${path}\n`;
  if (!lines.length) return header;
  return `${header}@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
}

export function parseNameStatus(stdout: string): Array<{ path: string; previousPath: string | null; kind: ExplorerChangeKind }> {
  const parts = stdout.split("\0");
  const result: Array<{ path: string; previousPath: string | null; kind: ExplorerChangeKind }> = [];
  for (let index = 0; index < parts.length; index += 1) {
    const code = parts[index];
    if (!code) continue;
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const previousPath = parts[index + 1] ?? ""; const path = parts[index + 2] ?? "";
      index += 2;
      if (path) result.push({ path, previousPath: letter === "R" ? previousPath : null, kind: letter === "R" ? "renamed" : "added" });
      continue;
    }
    const path = parts[index + 1] ?? "";
    index += 1;
    if (!path) continue;
    result.push({ path, previousPath: null, kind: letter === "A" ? "added" : letter === "D" ? "deleted" : "modified" });
  }
  return result;
}

/** `--numstat -z`: `added\tremoved\tpath\0`, or `added\tremoved\t\0old\0new\0` for a rename. */
export function parseNumstat(stdout: string): Map<string, { additions: number | null; deletions: number | null }> {
  const parts = stdout.split("\0");
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (!entry) continue;
    const [added, removed, path] = entry.split("\t");
    let target = path ?? "";
    if (!target) { target = parts[index + 2] ?? ""; index += 2; }
    if (!target) continue;
    counts.set(target, { additions: count(added), deletions: count(removed) });
  }
  return counts;
}
function count(value: string | undefined): number | null { return value && /^\d+$/.test(value) ? Number(value) : null; }

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; timedOut: boolean }> {
  try {
    const result = await runProcess("git", ["-c", "core.quotepath=off", ...args], { cwd, timeoutMs: gitTimeoutMs, env: gitEnvironment(), maxOutputBytes: maxGitOutputBytes });
    return { ok: result.exitCode === 0 && !result.timedOut, stdout: result.stdout, timedOut: result.timedOut };
  } catch { return { ok: false, stdout: "", timedOut: false }; }
}

function notFound(message: string): Error {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = 404;
  return error;
}
