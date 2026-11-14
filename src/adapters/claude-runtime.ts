import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { runProcess } from "./process-runner.js";
import { operationalEnvironment } from "./runtime-environment.js";

const require = createRequire(import.meta.url);
export function claudeAcpEntry(): string {
  return join(dirname(require.resolve("@agentclientprotocol/claude-agent-acp/package.json")), "dist", "index.js");
}
export interface ClaudeRuntime { path: string; version: string; source: "user" | "path"; }

/** Select the already installed native CLI; never fall back to a bundled, separately authenticated copy. */
export async function resolveClaudeRuntime(): Promise<ClaudeRuntime> {
  const candidates = process.platform === "win32"
    ? [{ path: join(homedir(), ".local", "bin", "claude.exe"), source: "user" as const }, { path: "claude.exe", source: "path" as const }]
    : [{ path: join(homedir(), ".local", "bin", "claude"), source: "user" as const }, { path: "claude", source: "path" as const }];
  for (const candidate of candidates) {
    try {
      if (candidate.source === "user") await access(candidate.path);
      const result = await runProcess(candidate.path, ["--version"], { timeoutMs: 5_000 });
      const version = /\d+\.\d+\.\d+/.exec(result.stdout)?.[0];
      if (result.exitCode === 0 && version) return { ...candidate, version };
    } catch { /* Try the next installed path. */ }
  }
  throw new Error("Claude Code CLI nativo nao encontrado.");
}

/** Operational environment only. Never forward API keys or token variables. */
export function claudeAcpEnvironment(runtimePath: string): NodeJS.ProcessEnv {
  const env = operationalEnvironment();
  env.CLAUDE_CODE_EXECUTABLE = runtimePath;
  env.CLAUDE_AGENT_ACP_PROTOCOL = "v1";
  env.DISABLE_AUTOUPDATER = "1";
  return env;
}
