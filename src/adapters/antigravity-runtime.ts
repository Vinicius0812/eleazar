import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { findOnPath } from "./executable-path.js";
import { runProcess } from "./process-runner.js";
import { operationalEnvironment } from "./runtime-environment.js";

export interface AntigravityRuntime { path: string; version: string; source: "override" | "user" | "path"; }

/** Oldest agy line accepted for ACP: 1.2.x has no ACP server and 1.5.9 was verified. */
export const minimumAntigravityVersion = "1.5.0";

/** Select the already installed native CLI; Eleazar never installs or updates it. */
export async function resolveAntigravityRuntime(
  runner: typeof runProcess = runProcess,
  candidates: ReadonlyArray<Pick<AntigravityRuntime, "path" | "source">> = antigravityCandidates()
): Promise<AntigravityRuntime> {
  let outdated: string | undefined;
  for (const candidate of candidates) {
    try {
      if (candidate.source !== "path") await access(candidate.path);
      const result = await runner(candidate.path, ["--version"], { timeoutMs: 5_000, env: antigravityAcpEnvironment() });
      const version = /\d+\.\d+\.\d+/.exec(result.stdout)?.[0];
      if (result.exitCode !== 0 || result.timedOut || !version) continue;
      if (isSupported(version)) return { ...candidate, version };
      outdated ??= version;
    } catch { /* Try the next installed path. */ }
  }
  throw new Error(outdated
    ? `Antigravity CLI ${outdated} nao e suportado via ACP; instale a versao ${minimumAntigravityVersion} ou superior.`
    : "Antigravity CLI (`agy`) nao foi encontrado.");
}

/** Operational environment only. Never forward API keys or token variables. */
export function antigravityAcpEnvironment(): NodeJS.ProcessEnv {
  return operationalEnvironment();
}

/** A configured path is authoritative: no other installation is tried. */
export function antigravityCandidates(executablePath?: string | null): Array<Pick<AntigravityRuntime, "path" | "source">> {
  if (executablePath) return [{ path: executablePath, source: "override" }];
  const installed = process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "agy", "bin", "agy.exe")
    : join(homedir(), ".local", "bin", "agy");
  const inPath = findOnPath("agy");
  return [{ path: installed, source: "user" }, ...(inPath ? [{ path: inPath, source: "path" as const }] : [])];
}

function isSupported(version: string): boolean {
  return version.localeCompare(minimumAntigravityVersion, undefined, { numeric: true }) >= 0;
}
