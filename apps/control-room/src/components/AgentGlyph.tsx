import antigravity from "../assets/icons/agent-antigravity.svg";
import claude from "../assets/icons/agent-claude.svg";
import codex from "../assets/icons/agent-codex.svg";

const glyphs: Record<string, { url: string; name: string }> = {
  codex: { url: codex, name: "Codex" },
  claude: { url: claude, name: "Claude Code" },
  antigravity: { url: antigravity, name: "Antigravity" }
};

/** Monochrome mark for the agent that ran a task; painted with the current text color. */
export function AgentGlyph({ provider, size = 16 }: { provider: string | null | undefined; size?: number }) {
  const glyph = provider ? glyphs[provider] : undefined;
  // An agent added by descriptor has no artwork of its own; its initial identifies it.
  if (!glyph && provider) return <span className="agent-glyph initial" style={{ width: size, height: size, fontSize: Math.max(12, size * 0.6) }} role="img" aria-label={provider} title={provider}>{provider[0]!.toUpperCase()}</span>;
  if (!glyph) return <span className="agent-glyph unassigned" style={{ width: size, height: size }} role="img" aria-label="Sem agente" title="Sem agente" />;
  const mask = `url("${glyph.url}") center / contain no-repeat`;
  return <span className="agent-glyph" style={{ width: size, height: size, mask, WebkitMask: mask }} role="img" aria-label={glyph.name} title={glyph.name} />;
}
