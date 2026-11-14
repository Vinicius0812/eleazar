/**
 * Provider-neutral normalization of persisted run summaries and terminal event payloads.
 * Summaries may be plain text or a JSON object such as {"detail": "..."}; the result is
 * always plain text for React to escape, never HTML.
 */

const envelopeKeys = ["detail", "error", "message"];
// Enough for {error: {message}} and a JSON string inside `detail`, and a hard stop for hostile input.
const maxDepth = 4;

/**
 * Looks for a message in an error envelope: a string, or an object whose `detail`, `error` or
 * `message` holds one (recursively, to a bounded depth). A string that is itself a JSON object
 * is parsed once per remaining level. Returns null when nothing useful is found.
 */
function extractMessage(value: unknown, depth: number): string | null {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    if (depth > 0 && text.startsWith("{")) {
      try { return extractMessage(JSON.parse(text), depth - 1) ?? text; } catch { return text; }
    }
    return text;
  }
  if (depth <= 0 || !value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const key of envelopeKeys) {
    const found = extractMessage((value as Record<string, unknown>)[key], depth - 1);
    if (found) return found;
  }
  return null;
}

/** Returns the useful message, or null when there is nothing to show. Unknown payloads are kept as plain text. */
export function readableSummary(summary: string | null | undefined): string | null {
  const text = summary?.trim();
  if (!text) return null;
  if (text.startsWith("{")) {
    try { return extractMessage(JSON.parse(text), maxDepth) ?? text; } catch { /* Older persisted entries can contain ordinary text. */ }
  }
  return text;
}

export function readableRunSummary(summary: string | null): string {
  return readableSummary(summary) ?? "O provedor não retornou detalhes adicionais.";
}

export function readableProviderMessage(summary: string | null): string {
  return readableSummary(summary) ?? "O provedor nao retornou detalhes. Abra a tarefa e consulte os logs persistidos.";
}

/**
 * Advice for a failed run. The "newer Codex" advice depends on how the run was executed:
 * the SDK hint applies only to confirmed legacy runs, ACP runs use the CLI runtime, and
 * history without a recorded transport gets a diagnosis-first hint that assumes neither.
 */
export function failureHint(summary: string | null, transport?: "acp" | "legacy" | null): string {
  if (/requires a newer version of codex|vers[aã]o mais nova.*codex/i.test(readableRunSummary(summary))) {
    if (transport === "acp") {
      return "Verifique e atualize o runtime do Codex que o Eleazar usa (versão e origem em \"Detalhes do runtime\" no diálogo Executar) e reinicie o Control Room. Depois, confira o diagnóstico com `npm run doctor`.";
    }
    if (transport === "legacy") {
      return "Atualize o pacote @openai/codex-sdk usado pelo Eleazar e reinicie o Control Room; atualizar apenas o CLI global pode não atualizar o binário chamado pelo SDK.";
    }
    return "O Codex usado nesta execução está desatualizado. Rode `npm run doctor` para ver a versão efetiva, atualize o runtime indicado e reinicie o Control Room.";
  }
  return "Consulte a mensagem e o log abaixo antes de reenfileirar a tarefa.";
}
