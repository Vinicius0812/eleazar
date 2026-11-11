import { AntigravityAdapter } from "./adapters/antigravity.js";
import { ClaudeAdapter } from "./adapters/claude.js";
import { CodexAdapter } from "./adapters/codex.js";
import { Orchestrator } from "./core/orchestrator.js";

export function createEleazar(): Orchestrator {
  return new Orchestrator([new CodexAdapter(), new AntigravityAdapter(), new ClaudeAdapter()]);
}
