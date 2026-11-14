import { describe, expect, it } from "vitest";

import { failureHint, readableProviderMessage, readableRunSummary, readableSummary } from "./run-messages.js";

describe("run message normalization", () => {
  it("extracts the message nested in a real provider error envelope", () => {
    const real = JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "Modelo indisponível", code: "model_not_found" } });
    expect(readableSummary(real)).toBe("Modelo indisponível");
  });

  it("still reads flat envelopes and a JSON string inside detail", () => {
    expect(readableSummary('{"detail":"Atualize o Codex"}')).toBe("Atualize o Codex");
    expect(readableSummary(JSON.stringify({ detail: JSON.stringify({ error: { message: "Interno" } }) }))).toBe("Interno");
  });

  it("keeps plain text, HTML (as inert text) and unknown payloads untouched", () => {
    expect(readableSummary("  falhou  ")).toBe("falhou");
    expect(readableSummary("<img src=x onerror=alert(1)>")).toBe("<img src=x onerror=alert(1)>");
    expect(readableSummary('{"foo":{"bar":1}}')).toBe('{"foo":{"bar":1}}');
    expect(readableSummary("[1,2]")).toBe("[1,2]");
    expect(readableSummary("{quebrado")).toBe("{quebrado");
  });

  it("stops at a bounded depth instead of unwrapping forever", () => {
    let deep: unknown = "alcancado";
    for (let level = 0; level < 20; level += 1) deep = { error: deep };
    const text = JSON.stringify(deep);
    expect(readableSummary(text)).toBe(text);
  });

  it("gives transport-aware advice for an outdated Codex and a safe default otherwise", () => {
    const outdated = '{"detail":"This model requires a newer version of Codex"}';
    expect(failureHint(outdated, "acp")).toContain("Detalhes do runtime");
    expect(failureHint(outdated, "acp")).not.toContain("codex-sdk");
    expect(failureHint(outdated, "legacy")).toContain("@openai/codex-sdk");
    const unknown = failureHint(outdated);
    expect(unknown).toContain("npm run doctor");
    expect(unknown).not.toContain("codex-sdk");
    expect(failureHint(outdated, null)).toBe(unknown);
    expect(failureHint("falha qualquer", "legacy")).toBe("Consulte a mensagem e o log abaixo antes de reenfileirar a tarefa.");
  });

  it("uses distinct fallbacks only when there is no content", () => {
    expect(readableSummary(null)).toBeNull();
    expect(readableSummary("   ")).toBeNull();
    expect(readableRunSummary(null)).toContain("não retornou detalhes adicionais");
    expect(readableProviderMessage("")).toContain("logs persistidos");
  });
});
