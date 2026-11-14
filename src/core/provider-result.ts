import type { AgentRunResult } from "./contracts.js";

/**
 * Pure helpers that turn a provider result into what the Control Room persists:
 * - `output`: the agent's full response, byte for byte, whenever one exists (success or failure);
 *   only when there is no response does it fall back to the error text or a neutral notice.
 * - `summary`: a short, readable line. For a failure it is the reason (normalized error), never the
 *   response; for a success it is the start of the response, untouched.
 */
export const maxSummaryLength = 4_000;
export const maxOutputLength = 100_000;
export const outputTruncationMarker = "\n\n[Saida truncada pelo Eleazar apos 100.000 caracteres.]";

const noResponseNotice = "Execucao concluida sem resposta textual.";
const noErrorDetailNotice = "O provedor nao retornou detalhes do erro.";
const errorEnvelopeKeys = ["detail", "error", "message"];
const maxEnvelopeDepth = 4;

/** Cuts to `max` characters including `marker`, never leaving half of a surrogate pair. */
export function truncateWithMarker(text: string, max: number, marker: string): string {
  if (text.length <= max) return text;
  let kept = text.slice(0, Math.max(0, max - marker.length));
  const last = kept.charCodeAt(kept.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) kept = kept.slice(0, -1);
  return `${kept}${marker}`;
}

/**
 * Plain-text reason from an error string. A JSON error envelope ({"error":{"message":"..."}},
 * {"detail":"..."}) is unwrapped to a bounded depth; anything else is kept as text. Never used on
 * successful responses, and never interprets HTML.
 */
export function readableError(raw: string | undefined): string {
  const text = raw?.trim() ?? "";
  if (!text) return "";
  return unwrap(text, maxEnvelopeDepth) ?? text;
}

function unwrap(value: unknown, depth: number): string | null {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    if (depth > 0 && text.startsWith("{")) {
      try { return unwrap(JSON.parse(text), depth - 1) ?? text; } catch { return text; }
    }
    return text;
  }
  if (depth <= 0 || !value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const key of errorEnvelopeKeys) {
    const found = unwrap((value as Record<string, unknown>)[key], depth - 1);
    if (found) return found;
  }
  return null;
}

function failureReason(result: AgentRunResult): string {
  return readableError(result.error) || noErrorDetailNotice;
}

export function summarizeProviderResult(result: AgentRunResult): string {
  const text = result.status === "success" ? result.response.trim() || noResponseNotice : failureReason(result);
  return truncateWithMarker(text, maxSummaryLength, "...");
}

export function providerOutput(result: AgentRunResult): string {
  if (result.response.trim()) return truncateWithMarker(result.response, maxOutputLength, outputTruncationMarker);
  const fallback = result.status === "success" ? noResponseNotice : failureReason(result);
  return truncateWithMarker(fallback, maxOutputLength, outputTruncationMarker);
}
