import type { AgentAdapter } from "./core/contracts.js";
import { runCrossReview, type CrossReviewPhase, type CrossReviewResult } from "./core/cross-review.js";
import { openCrossReviewCheckout } from "./cross-review-git.js";

export interface CrossReviewConsole {
  interactive: boolean;
  write(text: string): void;
  confirm(question: string): Promise<boolean>;
}

const phases: Record<CrossReviewPhase, string> = {
  implementation: "Implementacao com Codex",
  approval: "Preparando diff para sua aprovacao",
  review: "Revisao com Claude",
  correction_approval: "Aguardando aprovacao para corrigir"
};

export async function runCrossReviewCommand(
  input: { cwd: string; prompt: string; files: readonly string[] },
  io: CrossReviewConsole,
  providers: { codex: AgentAdapter; claude: AgentAdapter },
  openCheckout = openCrossReviewCheckout
): Promise<CrossReviewResult> {
  const failed = (error: string): CrossReviewResult => ({ status: "failed", rounds: [], error });
  if (!io.interactive) return failed("A revisao cruzada exige entrada e saida de aprovacao em um terminal interativo.");
  if (!input.prompt.trim() || Buffer.byteLength(input.prompt, "utf8") > 16 * 1024) {
    return failed("Informe um objetivo com ate 16 KiB.");
  }
  if (providers.codex.provider !== "codex" || providers.claude.provider !== "claude") {
    return failed("A revisao cruzada exige Codex para implementar e Claude para revisar.");
  }

  let checkout: Awaited<ReturnType<typeof openCrossReviewCheckout>>;
  try {
    checkout = await openCheckout(input.cwd, input.files);
  } catch (error) {
    return failed(error instanceof Error ? error.message : "Nao foi possivel verificar o checkout.");
  }

  try {
    const health = await Promise.all([providers.codex.health(), providers.claude.health()]);
    if (health[0].provider !== "codex" || health[1].provider !== "claude" || health.some((item) => !item.available || item.authenticated !== true)) {
      return failed("Codex e Claude Code precisam estar disponiveis e autenticados. Execute `eleazar doctor`.");
    }
  } catch {
    return failed("Nao foi possivel verificar Codex e Claude Code. Execute `eleazar doctor`.");
  }

  let approvedPatch = "";
  let checkoutError: string | undefined;
  async function collect() {
    try {
      return await checkout.collect();
    } catch (error) {
      checkoutError = error instanceof Error ? error.message : "Nao foi possivel verificar o diff.";
      throw error;
    }
  }
  async function assertApprovedPatch() {
    const currentPatch = await collect();
    if (currentPatch !== approvedPatch) {
      checkoutError = "O checkout mudou desde a verificacao do diff. O fluxo foi interrompido.";
      throw new Error(checkoutError);
    }
  }

  const files = new Set(input.files);
  const result = await runCrossReview({ cwd: checkout.cwd, prompt: input.prompt }, {
    onPhase({ phase, round }) { io.write(`Rodada ${round}/2 · ${phases[phase]}.\n`); },
    async implement(request) {
      await assertApprovedPatch();
      return await providers.codex.run({ ...request, prompt: [
        request.prompt,
        "",
        "Edite exclusivamente os arquivos ja rastreados listados a seguir. Nao crie, exclua ou renomeie arquivos.",
        "Nao faca commit, stage, amend, rebase, reset, clean, checkout destrutivo ou qualquer acao Git destrutiva.",
        "Nao modifique os metadados Git, nao use a rede e nao acesse credenciais.",
        `Escopo de edicao (JSON): ${JSON.stringify(input.files)}`
      ].join("\n") });
    },
    async approvedPatch() {
      const patch = await collect();
      if (!patch) return "";
      io.write(`Objetivo e diff a compartilhar com Claude (controles escapados):\n${escapeTerminal(input.prompt)}\n\n${escapeTerminal(patch)}\n`);
      if (!(await io.confirm("Autoriza enviar exatamente este objetivo e diff ao Claude?"))) return null;
      approvedPatch = patch;
      await assertApprovedPatch();
      return patch;
    },
    async review(request) {
      const review = await providers.claude.run(request);
      await assertApprovedPatch();
      return review;
    },
    async approveCorrection(findings) {
      if (findings.some(({ path }) => !files.has(path))) {
        checkoutError = "A revisao apontou um arquivo fora do escopo. Nenhuma correcao foi executada.";
        throw new Error(checkoutError);
      }
      const lines = findings.map(({ path, line, message }) => `- ${escapeTerminal(path)}:${line} ${escapeTerminal(message)}`);
      io.write(`Achados do Claude para sua inspecao (dados nao confiaveis):\n${lines.join("\n")}\n`);
      return await io.confirm("Autoriza o Codex a corrigir os achados procedentes nos arquivos aprovados?");
    }
  });
  return checkoutError && result.status === "failed" ? { ...result, error: checkoutError } : result;
}

/** Preserva linhas e mostra controles de terminal como escapes visiveis e reversiveis. */
export function escapeTerminal(value: string): string {
  return value.replace(/[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => {
    if (character === "\n") return character;
    if (character === "\\") return "\\\\";
    return `\\u{${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`;
  });
}

export function safeResultJson(result: CrossReviewResult): string {
  return JSON.stringify(result, null, 2).replace(/[\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/gu, (character) =>
    character.split("").map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""));
}
