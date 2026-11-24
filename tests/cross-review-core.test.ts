import { describe, expect, it, vi } from "vitest";

import type { AgentRunRequest, AgentRunResult, ProviderName } from "../src/core/contracts.js";
import {
  MAX_PATCH_LENGTH,
  parseReviewResponse,
  runCrossReview,
  type CrossReviewDependencies,
  type ReviewFinding,
  type ReviewRound
} from "../src/core/cross-review.js";

const input = { cwd: "/example/repo", prompt: "Valide entradas nulas" };
const patch = "diff --git a/src/a.ts b/src/a.ts\n+if (value == null) return;\n";
const finding: ReviewFinding = { path: "src/a.ts", line: 3, message: "Trate undefined tambem." };
const approved = JSON.stringify({ verdict: "approved", findings: [] });
const changes = JSON.stringify({ verdict: "changes_requested", findings: [finding] });

function result(provider: ProviderName, response = "", extra: Partial<AgentRunResult> = {}): AgentRunResult {
  return { provider, status: "success", durationMs: 1, response, ...extra };
}

function deps(overrides: Partial<CrossReviewDependencies> = {}) {
  const base = {
    implement: vi.fn<(request: AgentRunRequest) => Promise<AgentRunResult>>(async () => result("codex")),
    review: vi.fn<(request: AgentRunRequest) => Promise<AgentRunResult>>(async () => result("claude", approved)),
    approvedPatch: vi.fn<(round: ReviewRound) => Promise<string | null>>(async () => patch),
    approveCorrection: vi.fn<(findings: readonly ReviewFinding[]) => Promise<boolean>>(async () => true),
    onPhase: vi.fn()
  };
  return Object.assign(base, overrides);
}

describe("runCrossReview", () => {
  it("aprova na primeira rodada e registra uso de tokens", async () => {
    const d = deps({
      implement: vi.fn(async () => result("codex", "", { usage: { total: 10 } })),
      review: vi.fn(async () => result("claude", approved, { usage: { total: 5 } }))
    });
    const outcome = await runCrossReview(input, d);
    expect(outcome).toEqual({
      status: "approved",
      rounds: [{ round: 1, verdict: "approved", findings: [], usage: { implementation: { total: 10 }, review: { total: 5 } } }]
    });
    expect(d.implement).toHaveBeenCalledTimes(1);
    expect(d.implement.mock.calls[0]![0]).toMatchObject({ cwd: input.cwd, taskKind: "implementation" });
    expect(d.implement.mock.calls[0]![0].prompt).toContain("Nao faca push");
    const review = d.review.mock.calls[0]![0];
    expect(review.taskKind).toBe("review");
    expect(review.prompt).toContain(JSON.stringify({ goal: input.prompt, patch }));
    expect(d.onPhase.mock.calls.map(([event]) => event.phase)).toEqual(["implementation", "approval", "review"]);
  });

  it("corrige apos changes_requested e aprova na segunda rodada", async () => {
    const d = deps({
      review: vi.fn()
        .mockResolvedValueOnce(result("claude", changes))
        .mockResolvedValueOnce(result("claude", approved))
    });
    const outcome = await runCrossReview(input, d);
    expect(outcome.status).toBe("approved");
    expect(outcome.rounds.map((round) => round.verdict)).toEqual(["changes_requested", "approved"]);
    expect(d.approveCorrection).toHaveBeenCalledWith([finding]);
    expect(d.approvedPatch.mock.calls.map(([round]) => round)).toEqual([1, 2]);
    const correction = d.implement.mock.calls[1]![0].prompt;
    expect(correction).toContain(input.prompt);
    expect(correction).toContain(JSON.stringify({ findings: [finding] }));
    expect(correction).toContain("<untrusted_data>");
  });

  it("para em changes_requested apos duas rodadas sem pedir terceira correcao", async () => {
    const d = deps({ review: vi.fn(async () => result("claude", changes)) });
    const outcome = await runCrossReview(input, d);
    expect(outcome.status).toBe("changes_requested");
    expect(outcome.rounds).toHaveLength(2);
    expect(d.implement).toHaveBeenCalledTimes(2);
    expect(d.review).toHaveBeenCalledTimes(2);
    expect(d.approveCorrection).toHaveBeenCalledTimes(1);
  });

  it("encerra sem revisar quando o operador recusa compartilhar o diff", async () => {
    const d = deps({ approvedPatch: vi.fn(async () => null) });
    expect(await runCrossReview(input, d)).toEqual({ status: "approval_declined", rounds: [] });
    expect(d.review).not.toHaveBeenCalled();
  });

  it("encerra sem nova implementacao quando o operador recusa a correcao", async () => {
    const d = deps({
      review: vi.fn(async () => result("claude", changes)),
      approveCorrection: vi.fn(async () => false)
    });
    const outcome = await runCrossReview(input, d);
    expect(outcome.status).toBe("changes_requested");
    expect(outcome.rounds).toHaveLength(1);
    expect(d.implement).toHaveBeenCalledTimes(1);
  });

  it("retorna no_changes para diff vazio sem chamar o revisor", async () => {
    const d = deps({ approvedPatch: vi.fn(async () => "  \n") });
    expect(await runCrossReview(input, d)).toEqual({ status: "no_changes", rounds: [] });
    expect(d.review).not.toHaveBeenCalled();
  });

  it("falha quando o diff excede o limite", async () => {
    const d = deps({ approvedPatch: vi.fn(async () => "+".repeat(MAX_PATCH_LENGTH + 1)) });
    expect(await runCrossReview(input, d)).toMatchObject({ status: "failed", error: "Diff aprovado excede o limite de revisao." });
    expect(d.review).not.toHaveBeenCalled();
  });

  it("falha quando o implementador ou o revisor e um provedor inesperado", async () => {
    const wrongImplementer = deps({ implement: vi.fn(async () => result("antigravity")) });
    expect(await runCrossReview(input, wrongImplementer)).toEqual({
      status: "failed", rounds: [], error: "Provedor inesperado na etapa de implementacao."
    });
    expect(wrongImplementer.approvedPatch).not.toHaveBeenCalled();

    const wrongReviewer = deps({ review: vi.fn(async () => result("codex", approved)) });
    expect(await runCrossReview(input, wrongReviewer)).toEqual({
      status: "failed", rounds: [], error: "Provedor inesperado na etapa de revisao."
    });
  });

  it("falha quando um provedor retorna status diferente de success", async () => {
    const d = deps({ review: vi.fn(async () => result("claude", approved, { status: "error" })) });
    expect(await runCrossReview(input, d)).toMatchObject({ status: "failed", error: "O provedor falhou na etapa de revisao." });
  });

  it("falha fechada com JSON invalido do revisor", async () => {
    for (const response of ["nao e json", "```json\n{}\n```", '{"verdict":"approved"}', '{"verdict":"changes_requested","findings":[]}']) {
      const d = deps({ review: vi.fn(async () => result("claude", response)) });
      expect(await runCrossReview(input, d)).toEqual({ status: "failed", rounds: [], error: "Veredito de revisao invalido." });
      expect(d.approveCorrection).not.toHaveBeenCalled();
    }
  });

  it("converte excecoes de integracao em erro generico sem vazar a mensagem original", async () => {
    const d = deps({ implement: vi.fn(async () => { throw new Error("token sk-secreto vazou"); }) });
    const outcome = await runCrossReview(input, d);
    expect(outcome).toEqual({ status: "failed", rounds: [], error: "Falha de integracao na revisao cruzada." });
    expect(JSON.stringify(outcome)).not.toContain("sk-secreto");
  });

  it("preserva rodadas anteriores quando a segunda rodada falha", async () => {
    const d = deps({
      review: vi.fn()
        .mockResolvedValueOnce(result("claude", changes))
        .mockRejectedValueOnce(new Error("conexao caiu"))
    });
    const outcome = await runCrossReview(input, d);
    expect(outcome.status).toBe("failed");
    expect(outcome.rounds).toHaveLength(1);
    expect(outcome.error).toBe("Falha de integracao na revisao cruzada.");
  });

  it("rejeita entrada vazia antes de chamar provedores", async () => {
    const d = deps();
    expect(await runCrossReview({ cwd: " ", prompt: "x" }, d)).toMatchObject({ status: "failed", error: "Entrada invalida para revisao cruzada." });
    expect(d.implement).not.toHaveBeenCalled();
  });
});

describe("parseReviewResponse", () => {
  it("aceita resposta valida e devolve copias dos achados", () => {
    const parsed = parseReviewResponse(changes);
    expect(parsed).toEqual({ verdict: "changes_requested", findings: [finding] });
  });

  it.each([
    ["chave extra no achado", { verdict: "changes_requested", findings: [{ ...finding, extra: 1 }] }],
    ["linha zero", { verdict: "changes_requested", findings: [{ ...finding, line: 0 }] }],
    ["linha fracionada", { verdict: "changes_requested", findings: [{ ...finding, line: 1.5 }] }],
    ["mensagem com controle", { verdict: "changes_requested", findings: [{ ...finding, message: "a\nb" }] }],
    ["veredito desconhecido", { verdict: "maybe", findings: [] }],
    ["findings nao e array", { verdict: "approved", findings: {} }]
  ])("rejeita %s", (_label, value) => {
    expect(() => parseReviewResponse(JSON.stringify(value))).toThrow("Veredito de revisao invalido.");
  });
});
