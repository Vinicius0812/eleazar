import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { runProcess } from "../adapters/process-runner.js";
import type { ExecutionFileChange, LocalProjectDirectory } from "../core/control-room.js";

type CapturedDirectory = {
  directory: LocalProjectDirectory;
  tracked: boolean;
  preexisting: Set<string>;
};

type CollectedChanges = {
  files: ExecutionFileChange[];
  warnings: string[];
};

/** Captures Git state around an agent run without ever changing the repository. */
export class GitChangeCollector {
  async capture(directories: readonly LocalProjectDirectory[]): Promise<GitChangeSnapshot> {
    const captured = await Promise.all(directories.map(async (directory) => {
      const status = await git(directory.path, ["status", "--porcelain=v1", "-z"]);
      if (!status.ok) return { directory, tracked: false, preexisting: new Set<string>() } satisfies CapturedDirectory;
      return { directory, tracked: true, preexisting: parseStatus(status.stdout).paths } satisfies CapturedDirectory;
    }));
    return new GitChangeSnapshot(captured);
  }
}

export class GitChangeSnapshot {
  constructor(private readonly directories: readonly CapturedDirectory[]) {}

  async collect(executionId: string): Promise<CollectedChanges> {
    const groups = await Promise.all(this.directories.map((captured) => this.collectDirectory(captured, executionId)));
    return { files: groups.flatMap((group) => group.files), warnings: groups.flatMap((group) => group.warnings) };
  }

  private async collectDirectory(captured: CapturedDirectory, executionId: string): Promise<CollectedChanges> {
    if (!captured.tracked) {
      return { files: [], warnings: [`Nao foi possivel coletar mudancas Git em ${captured.directory.name}; o diretorio nao e um repositorio Git acessivel.`] };
    }
    const statusResult = await git(captured.directory.path, ["status", "--porcelain=v1", "-z"]);
    const diffResult = await git(captured.directory.path, ["diff", "--numstat", "HEAD", "--"]);
    if (!statusResult.ok || !diffResult.ok) {
      return { files: [], warnings: [`Nao foi possivel coletar o diff Git de ${captured.directory.name}; a execucao foi concluida sem atribuir arquivos.`] };
    }

    const status = parseStatus(statusResult.stdout);
    const changes = new Map<string, Omit<ExecutionFileChange, "id" | "executionId">>();
    for (const line of diffResult.stdout.split(/\r?\n/)) {
      if (!line) continue;
      const [added, removed, ...parts] = line.split("\t");
      const path = parts.join("\t");
      if (!path) continue;
      if (captured.preexisting.has(path)) {
        changes.set(path, change(captured.directory.id, path, "preexisting", null, null));
        continue;
      }
      const code = status.codes.get(path) ?? "";
      const kind = code.includes("D") ? "deleted" : code.includes("A") ? "added" : "modified";
      changes.set(path, change(captured.directory.id, path, kind, numberOrNull(added), numberOrNull(removed)));
    }
    for (const path of status.untracked) {
      if (captured.preexisting.has(path)) {
        changes.set(path, change(captured.directory.id, path, "preexisting", null, null));
      } else {
        changes.set(path, change(captured.directory.id, path, "untracked", await lineCount(captured.directory.path, path), 0));
      }
    }
    for (const path of captured.preexisting) {
      if (status.paths.has(path) && !changes.has(path)) changes.set(path, change(captured.directory.id, path, "preexisting", null, null));
    }
    return { files: [...changes.values()].map((item) => ({ ...item, id: randomUUID(), executionId })), warnings: [] };
  }
}

function change(directoryId: string, path: string, kind: ExecutionFileChange["kind"], additions: number | null, deletions: number | null): Omit<ExecutionFileChange, "id" | "executionId"> {
  return { directoryId, path, kind, additions, deletions };
}
function numberOrNull(value: string | undefined): number | null { return value && /^\d+$/.test(value) ? Number(value) : null; }
async function lineCount(directory: string, path: string): Promise<number | null> {
  try {
    const contents = await readFile(`${directory}/${path}`);
    if (contents.includes(0)) return null;
    if (!contents.length) return 0;
    return contents.toString("utf8").split(/\r?\n/).length - (contents.toString("utf8").endsWith("\n") ? 1 : 0);
  } catch { return null; }
}
async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const result = await runProcess("git", args, { cwd, timeoutMs: 5_000 });
    return { ok: result.exitCode === 0 && !result.timedOut, stdout: result.stdout };
  } catch { return { ok: false, stdout: "" }; }
}
function parseStatus(stdout: string): { paths: Set<string>; untracked: Set<string>; codes: Map<string, string> } {
  const paths = new Set<string>(); const untracked = new Set<string>(); const codes = new Map<string, string>();
  for (const entry of stdout.split("\0")) {
    if (!entry || entry.length < 4) continue;
    const code = entry.slice(0, 2); const path = entry.slice(3);
    paths.add(path); codes.set(path, code);
    if (code === "??") untracked.add(path);
  }
  return { paths, untracked, codes };
}
