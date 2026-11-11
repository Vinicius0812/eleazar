import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { devNull } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";

import { runProcess } from "./adapters/process-runner.js";

const maxPatchBytes = 32 * 1024;
const maxGitOutputBytes = 1024 * 1024;
const unsafePath = /[\\:\p{Cc}\p{Cf}\uFFFD]/u;
const worktreeStatus = ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=none"];
const diffOptions = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--no-relative", "--ignore-submodules=none"];

export async function openCrossReviewCheckout(directory: string, files: readonly string[]) {
  if (!files.length || files.length > 100 || new Set(files).size !== files.length || files.some(invalidPath)) {
    throw new Error("Informe de um a cem caminhos relativos distintos em --file. Use / como separador.");
  }
  const cwd = await realpath(resolve(directory));
  const git = await localGit(cwd);
  const root = (await git(["rev-parse", "--show-toplevel"])).replace(/\r?\n$/, "");
  if (await realpath(root) !== cwd) throw new Error("Informe a raiz fisica do checkout Git em --cwd.");
  const readHead = async () => {
    const head = (await git(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) throw new Error("HEAD Git nao reconhecido.");
    return head;
  };
  const head = await readHead();
  const allowed = new Set(files);
  const cleanFilterFlags = await neutralizeCleanFilters(git);
  const readStatus = async () => {
    if (await readHead() !== head) throw new Error("O HEAD mudou durante a revisao cruzada.");
    if (await neutralizeCleanFilters(git).then((flags) => flags.join("\0")) !== cleanFilterFlags.join("\0")) {
      throw new Error("A configuracao de filtros Git mudou durante a revisao cruzada.");
    }
    const tracked = nulRecords(await git(["ls-files", "-v", "-z"]));
    if (tracked.some((entry) => !entry.startsWith("H "))) {
      throw new Error("O checkout tem arquivos omitidos do status Git ou indice invalido.");
    }
    const status = nulRecords(await git([...cleanFilterFlags, ...worktreeStatus]));
    const changed = status.map((entry) => {
      const file = entry.slice(3);
      if (!entry.startsWith(" M ") || !allowed.has(file)) {
        throw new Error("Ha mudancas fora do escopo ou mudancas no indice, inclusoes, exclusoes ou renomeacoes.");
      }
      return file;
    });
    return new Set(changed);
  };

  await assertRegularFiles(cwd, files, git);
  if ((await readStatus()).size > 0) throw new Error("A revisao cruzada exige um checkout inicialmente limpo.");
  return {
    cwd,
    async collect(): Promise<string> {
      const changed = await readStatus();
      if (!changed.size) return "";
      await assertRegularFiles(cwd, files, git);
      const args = [...cleanFilterFlags, ...diffOptions];
      const stats = nulRecords(await git([...args, "--numstat", "-z", head, "--", ...files]));
      const statsPaths = new Set(stats.map((entry) => {
        const stat = /^\d+\t\d+\t(.+)$/.exec(entry);
        if (!stat?.[1]) throw new Error("A revisao cruzada aceita apenas diffs de texto.");
        return stat[1];
      }));
      if (!samePaths(changed, statsPaths)) throw new Error("O diff nao explica todas as alteracoes Git.");
      const patch = await git([...args, "--patch", "--full-index", "--src-prefix=a/", "--dst-prefix=b/", head, "--", ...files], maxPatchBytes);
      if (!patch || /[\0\uFFFD]|^(?:GIT binary patch|Binary files .* differ|old mode |new mode )/m.test(patch)) {
        throw new Error("O Git nao produziu um diff de texto completo e seguro para revisao.");
      }
      if (!samePaths(changed, await readStatus())) throw new Error("O checkout mudou durante a coleta.");
      return patch;
    },
  };
}

function invalidPath(file: string): boolean {
  return !file || isAbsolute(file) || unsafePath.test(file) || file.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git");
}

type Git = (args: readonly string[], maxOutputBytes?: number, allowNoMatches?: boolean) => Promise<string>;

async function localGit(cwd: string): Promise<Git> {
  const executable = process.platform === "win32" ? "git.exe" : "git";
  let command: string | undefined;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try {
      const candidate = await realpath(join(directory, executable));
      const fromCheckout = relative(cwd, candidate);
      if (fromCheckout === "" || (!isAbsolute(fromCheckout) && fromCheckout !== ".." && !fromCheckout.startsWith(`..${sep}`))) continue;
      await access(candidate, constants.X_OK);
      command = candidate;
      break;
    } catch { /* Procura o proximo caminho absoluto no PATH. */ }
  }
  if (!command) throw new Error("Nao foi encontrado um Git executavel fora do checkout no PATH.");
  const gitCommand = command;
  const localEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  const isolatedEnv = { ...localEnv, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : devNull };
  async function inspect(env: NodeJS.ProcessEnv, args: readonly string[], maxOutputBytes = maxGitOutputBytes, allowNoMatches = false) {
    try {
      const result = await runProcess(gitCommand, [
        "--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args
      ], { cwd, env, timeoutMs: 5_000, maxOutputBytes });
      if (!result.timedOut && (result.exitCode === 0 || (allowNoMatches && result.exitCode === 1 && !result.stdout && !result.stderr))) {
        return result.stdout;
      }
    } catch { /* A saida Git bruta nunca e exibida ou enviada. */ }
    throw new Error("A inspecao Git falhou ou excedeu o limite de tamanho ou tempo.");
  }

  const autocrlf = (await inspect(localEnv, ["config", "--type=bool-or-str", "--get", "core.autocrlf"], 512, true)).trim();
  const eol = (await inspect(localEnv, ["config", "--get", "core.eol"], 512, true)).trim();
  if ((autocrlf && !["true", "false", "input"].includes(autocrlf)) || (eol && !["native", "lf", "crlf"].includes(eol))) {
    throw new Error("A configuracao Git de fim de linha nao e reconhecida.");
  }
  const eolFlags = [
    ...(autocrlf ? ["-c", `core.autocrlf=${autocrlf}`] : []),
    ...(eol ? ["-c", `core.eol=${eol}`] : [])
  ];
  return (args, maxOutputBytes, allowNoMatches) => inspect(isolatedEnv, [...eolFlags, ...args], maxOutputBytes, allowNoMatches);
}

async function neutralizeCleanFilters(git: Git): Promise<string[]> {
  const keys = nulRecords(await git(["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process|required)$"], maxGitOutputBytes, true));
  const drivers = new Set(keys.map((key) => {
    const driver = /^filter\.([\w.-]+)\.(?:clean|process|required)$/.exec(key)?.[1];
    if (!driver) throw new Error("O checkout usa uma configuracao de filtro Git nao reconhecida.");
    return driver;
  }));
  return [...drivers].sort().flatMap((name) => ["-c", `filter.${name}.clean=`, "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`]);
}

function nulRecords(output: string): string[] {
  if (!output) return [];
  if (!output.endsWith("\0") || output.includes("\uFFFD")) throw new Error("O Git retornou nomes de arquivos que nao podem ser verificados.");
  return output.slice(0, -1).split("\0");
}

async function assertRegularFiles(cwd: string, files: readonly string[], git: Git): Promise<void> {
  const entries = nulRecords(await git(["ls-files", "--stage", "-z", "--", ...files]));
  const tracked = new Set(entries.map((entry) => /^100(?:644|755) [a-f0-9]+ 0\t(.+)$/.exec(entry)?.[1]));
  if (entries.length !== files.length || !files.every((file) => tracked.has(file))) {
    throw new Error("Todos os caminhos em --file precisam ser arquivos regulares rastreados.");
  }
  for (const file of files) {
    const absolute = resolve(cwd, file);
    if (!(await lstat(absolute)).isFile() || await realpath(absolute) !== absolute) {
      throw new Error("O escopo nao pode atravessar links simbolicos ou redirecionamentos do sistema de arquivos.");
    }
  }
}

function samePaths(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((file) => right.has(file));
}
