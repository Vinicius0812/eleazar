import { spawn } from "node:child_process";

import { gitEnvironment } from "../core/git-environment.js";
import type { GitRunner } from "../core/git-worktree-provisioner.js";
import { withoutCredentials } from "./git-publisher.js";
import { terminateProcessTree } from "./process-tree.js";

const maxStderr = 64_000;
const maxDetail = 400;

/** Runs Git without a shell or a time limit: a large checkout may take minutes, and the operator can abort it. */
export const runGit: GitRunner = (cwd, args, signal) => new Promise((resolve, reject) => {
  const cancelled = () => new Error("Preparacao cancelada.");
  if (signal?.aborted) return reject(cancelled());
  const groupIsolated = process.platform !== "win32";
  const child = spawn("git", ["-C", cwd, ...args], {
    shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: groupIsolated, env: gitEnvironment()
  });
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  // Keeps the beginning, where the first error is, and the end, where the fatal one is.
  child.stderr.on("data", (chunk: string) => {
    errors += chunk;
    if (errors.length > maxStderr) errors = `${errors.slice(0, maxStderr / 2)}\n${errors.slice(-maxStderr / 2)}`;
  });
  // `git worktree add` does the checkout in a child Git, so the whole tree has to stop.
  // A descendant that escaped may still hold the pipes open, so the cancellation does not wait for them.
  const abort = () => {
    void terminateProcessTree(child, { groupIsolated }).catch(() => undefined).then(() => {
      child.stdout.destroy();
      child.stderr.destroy();
      reject(cancelled());
    });
  };
  signal?.addEventListener("abort", abort, { once: true });
  child.once("error", (error) => { signal?.removeEventListener("abort", abort); reject(error); });
  child.once("close", (code) => {
    signal?.removeEventListener("abort", abort);
    if (signal?.aborted) return reject(cancelled());
    if (code === 0) return resolve(output);
    const detail = gitFailureDetail(errors);
    const command = args.find((item, index) => !item.startsWith("-") && args[index - 1] !== "-c") ?? "";
    reject(new Error(`git ${command} falhou (codigo ${code ?? "desconhecido"})${detail ? `: ${detail}` : "."}`));
  });
});

/** The cause Git reported, without progress lines, repetition or credentials. */
export function gitFailureDetail(stderr: string): string {
  const lines = stderr.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean);
  const cause = lines.find((line) => /^(error|fatal):/i.test(line)) ?? lines.at(-1) ?? "";
  const shown = withoutCredentials(cause);
  const text = shown.length > maxDetail ? `${shown.slice(0, maxDetail / 2)} … ${shown.slice(-maxDetail / 2)}` : shown;
  return /file ?name too long/i.test(stderr)
    ? `${text} O caminho passa do limite do Windows; use um caminho mais curto ou o modo direto na pasta.`
    : text;
}
