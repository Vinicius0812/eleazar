import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import { runProcess } from "./process-runner.js";

const require = createRequire(import.meta.url);
const acpEntry = require.resolve("@agentclientprotocol/codex-acp");
const acpRequire = createRequire(acpEntry);

export interface CodexRuntime { path: string; version: string; source: "override" | "desktop" | "bundled"; }

/** An explicit override is authoritative; an invalid override never silently falls back. */
export async function resolveCodexRuntime(): Promise<CodexRuntime> {
  const override = process.env.ELEAZAR_CODEX_PATH?.trim();
  if (override) {
    if (override.endsWith(".js")) throw new Error("ELEAZAR_CODEX_PATH deve apontar para o executavel nativo, nao para codex.js.");
    const runtime = await probe(override, "override");
    if (!runtime) throw new Error(`ELEAZAR_CODEX_PATH nao aponta para um Codex executavel: ${override}`);
    return runtime;
  }

  for (const path of await desktopCandidates()) {
    const runtime = await probe(path, "desktop");
    if (runtime) return runtime;
  }

  const targets: Record<string, string> = {
    "win32-x64": "@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
    "win32-arm64": "@openai/codex-win32-arm64/vendor/aarch64-pc-windows-msvc/bin/codex.exe",
    "linux-x64": "@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex",
    "linux-arm64": "@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex",
    "darwin-x64": "@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/bin/codex",
    "darwin-arm64": "@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex"
  };
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) throw new Error(`Plataforma Codex sem binario ACP: ${process.platform}-${process.arch}`);
  const bundled = acpRequire.resolve(target);
  const runtime = await probe(bundled, "bundled");
  if (!runtime) throw new Error(`Runtime Codex bundled indisponivel: ${bundled}`);
  return runtime;
}

async function desktopCandidates(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const root = join(process.env.ProgramFiles ?? "C:\\Program Files", "WindowsApps");
  try {
    const entries = await readdir(root);
    return entries.filter((name) => /^OpenAI\.Codex_\d.*_(x64|arm64)__/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((name) => join(root, name, "app", "resources", "codex.exe"));
  } catch { return []; }
}

async function probe(path: string, source: CodexRuntime["source"]): Promise<CodexRuntime | null> {
  try {
    const isJs = path.endsWith(".js");
    const result = await runProcess(isJs ? process.execPath : path, isJs ? [path, "--version"] : ["--version"], { timeoutMs: 5_000 });
    const version = /(?:codex(?:-cli)?\s+)?\d+\.\d+\.\d+(?:[-.][\w.]+)?/i.exec(result.stdout)?.[0];
    if (result.exitCode !== 0 || !version) return null;
    return { path, version: result.stdout.trim(), source };
  } catch { return null; }
}

/** Allow only operational environment values; do not copy credential variables to subprocesses. */
export function acpEnvironment(runtimePath: string): NodeJS.ProcessEnv {
  const allowed = ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "LANG", "LC_ALL"];
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowed) if (process.env[name] !== undefined) env[name] = process.env[name];
  env.CODEX_PATH = runtimePath;
  return env;
}

export const codexAcpEntry = acpEntry;
