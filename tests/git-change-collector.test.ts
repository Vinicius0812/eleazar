import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runProcess } from "../src/adapters/process-runner.js";
import { GitChangeCollector } from "../src/control-room/git-change-collector.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("Git change collector", () => {
  it("atribui arquivos novos e alterados, mas preserva mudancas preexistentes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eleazar-git-changes-")); temporaryDirectories.push(directory);
    await git(directory, ["init"]); await git(directory, ["config", "user.email", "test@example.invalid"]); await git(directory, ["config", "user.name", "Eleazar Test"]);
    await writeFile(join(directory, "modified.txt"), "antes\n"); await writeFile(join(directory, "deleted.txt"), "remover\n"); await writeFile(join(directory, "preexisting.txt"), "original\n");
    await git(directory, ["add", "."]); await git(directory, ["commit", "-m", "initial"]);
    await writeFile(join(directory, "preexisting.txt"), "mudanca do usuario\n");
    const snapshot = await new GitChangeCollector().capture([{ id: "directory-1", name: "Temporário", path: directory, isGitRepository: true, createdAt: "now" }]);
    await writeFile(join(directory, "modified.txt"), "depois\nmais uma linha\n"); await unlink(join(directory, "deleted.txt"));
    await writeFile(join(directory, "added.txt"), "novo\n"); await git(directory, ["add", "added.txt"]);
    await writeFile(join(directory, "untracked.txt"), "sem stage\nmais\n");

    const collected = await snapshot.collect("execution-1");
    expect(collected.warnings).toEqual([]);
    expect(collected.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "modified.txt", kind: "modified", additions: 2, deletions: 1 }),
      expect.objectContaining({ path: "deleted.txt", kind: "deleted", additions: 0, deletions: 1 }),
      expect.objectContaining({ path: "added.txt", kind: "added", additions: 1, deletions: 0 }),
      expect.objectContaining({ path: "untracked.txt", kind: "untracked", additions: 2, deletions: 0 }),
      expect.objectContaining({ path: "preexisting.txt", kind: "preexisting", additions: null, deletions: null })
    ]));
  });

  it("registra aviso quando o diretorio nao oferece Git", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eleazar-no-git-")); temporaryDirectories.push(directory);
    const snapshot = await new GitChangeCollector().capture([{ id: "directory-1", name: "Sem Git", path: directory, isGitRepository: false, createdAt: "now" }]);
    const collected = await snapshot.collect("execution-1");
    expect(collected.files).toEqual([]);
    expect(collected.warnings[0]).toContain("nao e um repositorio Git");
  });
});

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || `git ${args.join(" ")} falhou`);
}
