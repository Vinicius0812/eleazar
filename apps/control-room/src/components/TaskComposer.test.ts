import { describe, expect, it } from "vitest";

import { titleFrom } from "./TaskComposer.js";

describe("titleFrom", () => {
  it("usa a primeira linha util da solicitacao, sem marcas de Markdown", () => {
    expect(titleFrom("\n## Corrigir o **total** do carrinho\nDetalhes")).toBe("Corrigir o total do carrinho");
    expect(titleFrom("- 1. item")).toBe("item");
    expect(titleFrom("   ")).toBe("Nova tarefa");
    expect(titleFrom("a".repeat(100))).toHaveLength(80);
  });
});
