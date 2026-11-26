import { describe, expect, it } from "vitest";

import { resolveShortcut } from "./shortcuts.js";

const key = (value: string, over: Partial<Parameters<typeof resolveShortcut>[0]> = {}) => ({ key: value, ctrlKey: false, metaKey: false, altKey: false, target: document.body, ...over });

describe("resolveShortcut", () => {
  it("resolve teclas simples e a sequência G + tecla", () => {
    expect(resolveShortcut(key("?"), false)).toEqual({ action: "help", pending: false });
    expect(resolveShortcut(key("N"), false)).toEqual({ action: "new-task", pending: false });
    expect(resolveShortcut(key("g"), false)).toEqual({ action: null, pending: true });
    expect(resolveShortcut(key("i"), true)).toEqual({ action: "go-inbox", pending: false });
    expect(resolveShortcut(key("x"), true)).toEqual({ action: null, pending: false });
  });

  it("não age enquanto o operador digita ou usa modificadores", () => {
    const input = document.createElement("textarea");
    document.body.append(input);
    expect(resolveShortcut(key("n", { target: input }), false).action).toBeNull();
    expect(resolveShortcut(key("n", { ctrlKey: true }), false).action).toBeNull();
    expect(resolveShortcut(key("i", { altKey: true }), true)).toEqual({ action: null, pending: false });
    input.remove();
  });
});
