import { describe, expect, it } from "vitest";

import { filterCommands, type CommandItem } from "./CommandPalette.js";

const item = (id: string, label: string, group = "Tarefas", hint?: string): CommandItem => ({ id, label, group, hint, run: () => undefined });

describe("filterCommands", () => {
  const items = [item("a", "Revisar autenticação", "Tarefas", "Loja · Na fila"), item("b", "Execuções", "Ir para"), item("c", "Corrigir o total", "Tarefas", "Loja · Concluída")];

  it("ignores accents and case and requires every word", () => {
    expect(filterCommands(items, "AUTENTICACAO").map((entry) => entry.id)).toEqual(["a"]);
    expect(filterCommands(items, "loja concluida").map((entry) => entry.id)).toEqual(["c"]);
    expect(filterCommands(items, "loja inexistente")).toEqual([]);
  });

  it("ranks labels that start with the query first and keeps the order otherwise", () => {
    expect(filterCommands(items, "").map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(filterCommands(items, "e").map((entry) => entry.id)[0]).toBe("b");
  });
});
