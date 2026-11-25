import type { ProviderName } from "../core/contracts.js";
import type { ProviderRegistration } from "../core/provider-registry.js";
import { AcpAgentAdapter } from "./acp-agent-adapter.js";
import { AntigravityAcpClient, antigravityAcpLaunch } from "./antigravity-acp.js";
import { antigravityCandidates, resolveAntigravityRuntime } from "./antigravity-runtime.js";
import { AntigravityAdapter } from "./antigravity.js";
import { ClaudeAcpClient } from "./claude-acp.js";
import { claudeAcpEntry, resolveClaudeRuntime } from "./claude-runtime.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAcpClient } from "./codex-acp.js";
import { codexAcpEntry, resolveCodexRuntime } from "./codex-runtime.js";
import { CodexAdapter } from "./codex.js";

export const builtInProviderIds: readonly ProviderName[] = ["codex", "claude", "antigravity"];

/** Codex, Claude Code and Antigravity with their reviewed policies. Each uses the account already signed in to its CLI. */
export function builtInProviders(executablePath: (id: ProviderName) => string | null = () => null): ProviderRegistration[] {
  return [codex(() => executablePath("codex")), claude(() => executablePath("claude")), antigravity(() => executablePath("antigravity"))];
}

function codex(executablePath: () => string | null): ProviderRegistration {
  const resolveRuntime = () => resolveCodexRuntime(executablePath());
  const client = new CodexAcpClient({ entryPath: codexAcpEntry, resolveRuntime });
  return {
    descriptor: {
      id: "codex", label: "Codex", transport: "acp", roles: { implementer: true, reviewer: true }, automaticByDefault: true,
      affinity: { implementation: 90, review: 86, planning: 78, research: 65, testing: 92, documentation: 78, unknown: 75 },
      loginCommand: "codex login", loginHint: "Entre com a sua conta ChatGPT no Codex.",
      executableNames: ["codex.exe", "codex"]
    },
    adapter: new AcpAgentAdapter(new CodexAdapter("default", resolveRuntime, client), {
      client, sessionConfirmsLogin: false, catalogPolicy: { selectableModes: ["read-only", "workspace-write"] }
    })
  };
}

function claude(executablePath: () => string | null): ProviderRegistration {
  const resolveRuntime = () => resolveClaudeRuntime(executablePath());
  const client = new ClaudeAcpClient({ entryPath: claudeAcpEntry, resolveRuntime });
  return {
    descriptor: {
      id: "claude", label: "Claude Code", transport: "acp", roles: { implementer: true, reviewer: true }, automaticByDefault: true,
      // No terminal is exposed to Claude, so it cannot run the tests it writes.
      affinity: { implementation: 82, review: 90, planning: 86, research: 72, testing: 60, documentation: 84, unknown: 74 },
      loginCommand: "claude auth login", loginHint: "Entre com a sua conta Claude no Claude Code.",
      executableNames: ["claude.exe", "claude"]
    },
    adapter: new AcpAgentAdapter(new ClaudeAdapter(undefined, "default", resolveRuntime, client), {
      client, sessionConfirmsLogin: false, catalogPolicy: { selectableModes: ["default"], allSettings: true }
    })
  };
}

function antigravity(executablePath: () => string | null): ProviderRegistration {
  const resolveRuntime = () => resolveAntigravityRuntime(undefined, antigravityCandidates(executablePath()));
  const client = new AntigravityAcpClient({ launch: antigravityAcpLaunch, resolveRuntime });
  return {
    descriptor: {
      id: "antigravity", label: "Antigravity", transport: "acp", roles: { implementer: true, reviewer: true }, automaticByDefault: true,
      affinity: { implementation: 72, review: 80, planning: 84, research: 90, testing: 70, documentation: 78, unknown: 73 },
      loginCommand: "agy", loginHint: "Abra o agy uma vez e entre com a sua conta Google.",
      executableNames: ["agy.exe", "agy"]
    },
    // The agy CLI has no login status command; it refuses session/new when nobody is signed in.
    adapter: new AcpAgentAdapter(new AntigravityAdapter(resolveRuntime, client), {
      client, sessionConfirmsLogin: true, catalogPolicy: { selectableModes: ["default"] }
    })
  };
}
