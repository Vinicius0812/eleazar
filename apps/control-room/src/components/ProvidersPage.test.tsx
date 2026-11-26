import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderStatus } from "../services/contracts.js";
import { ProvidersPage, providerState } from "./ProvidersPage.js";

afterEach(cleanup);

function status(provider: string, fields: Partial<ProviderStatus> = {}): ProviderStatus {
  return { provider, label: provider.toUpperCase(), available: true, authenticated: true, version: "1.2.3", detail: "Detalhe da CLI.", executable: { path: `C:\\bin\\${provider}.exe`, source: "user" },
    transport: "acp", roles: { implementer: true, reviewer: true }, login: { command: `${provider} login`, hint: "Entre na sua conta." },
    preferences: { enabled: true, automatic: true, executablePath: null, defaultModel: null }, verification: null, fetchedAt: "2026-01-01T00:00:00.000Z",
    usage: { source: "eleazar_executions", usedPercent: null, resetAt: null, windowDurationMins: null, totalTokens: 1_200, lifetimeTokens: null, todayTokens: null }, ...fields };
}
const verification = { connected: true, authenticated: true, detail: "ok", models: [{ id: "m-a", name: "Modelo A" }], defaultModel: "m-a", checkedAt: "2026-01-01T00:00:00.000Z" };

function show(providers: ProviderStatus[], pending: string | null = null) {
  const onVerify = vi.fn(); const onChange = vi.fn(); const onRefresh = vi.fn();
  render(<ProvidersPage providers={providers} loading={false} error="" pending={pending} onRefresh={onRefresh} onVerify={onVerify} onChange={onChange} />);
  return { onVerify, onChange, onRefresh, card: (name: string) => within(screen.getByRole("article", { name })) };
}

describe("ProvidersPage", () => {
  it("shows the quota the Automatico reads and saves the daily budget", async () => {
    const quota = { usedPercent: 100, source: "budget" as const, dailyTokenBudget: 1_000, todayTokens: 1_000, state: "exhausted" as const };
    const { card, onChange } = show([status("codex", { usage: { ...status("codex").usage, todayTokens: 1_000, quota }, preferences: { enabled: true, automatic: true, executablePath: null, defaultModel: null, dailyTokenBudget: 1_000 } })]);
    const panel = within(card("CODEX").getByRole("region", { name: "Uso e cota do CODEX" }));
    expect(panel.getByText("Cota esgotada · fora do Automático")).toBeInTheDocument();
    expect(panel.getByText(/1\.000 de 1\.000 tokens hoje/)).toBeInTheDocument();
    const input = panel.getByLabelText(/Orçamento diário/);
    const user = userEvent.setup();
    await user.clear(input);
    await user.type(input, "5000");
    await user.click(panel.getByRole("button", { name: "Salvar orçamento" }));
    expect(onChange).toHaveBeenCalledWith("codex", { dailyTokenBudget: 5000 });
    await user.clear(input);
    await user.click(panel.getByRole("button", { name: "Salvar orçamento" }));
    expect(onChange).toHaveBeenLastCalledWith("codex", { dailyTokenBudget: null });
  });

  it("names the state from the reported facts", () => {
    expect(providerState(status("a")).label).toBe("Pronto");
    expect(providerState(status("a", { authenticated: null })).label).toBe("Login não confirmado");
    expect(providerState(status("a", { authenticated: false })).label).toBe("Falta entrar na conta");
    expect(providerState(status("a", { available: false, authenticated: null })).label).toBe("Não encontrado");
    expect(providerState(status("a", { verification: { ...verification, connected: false } })).label).toBe("Conexão falhou");
    expect(providerState(status("a", { preferences: { enabled: false, automatic: true, executablePath: null, defaultModel: null } })).label).toBe("Desativado");
  });

  it("shows the official login command only while the login is not confirmed, without any credential field", async () => {
    const { card, onVerify } = show([status("codex", { authenticated: false }), status("claude")]);
    expect(card("CODEX").getByText("codex login")).toBeInTheDocument();
    expect(card("CLAUDE").queryByText("claude login")).not.toBeInTheDocument();
    expect(document.querySelector("input[type=password]")).toBeNull();
    await userEvent.setup().click(card("CODEX").getByRole("button", { name: /Verificar conexão/ }));
    expect(onVerify).toHaveBeenCalledWith("codex");
  });

  it("lists any registered provider and explains why a connection failed", () => {
    const { card } = show([status("quarto", { verification: { ...verification, connected: false, detail: "A conexao ACP falhou: codigo 3" } })]);
    expect(card("QUARTO").getByText(/codigo 3/)).toBeInTheDocument();
    expect(card("QUARTO").getByText("1.200 tokens no Eleazar")).toBeInTheDocument();
  });

  it("changes participation, default model and executable path", async () => {
    const { card, onChange } = show([status("codex", { verification, preferences: { enabled: true, automatic: true, executablePath: "C:\\antigo\\codex.exe", defaultModel: null } })]);
    const user = userEvent.setup();
    await user.click(card("CODEX").getByLabelText("Participa do Automático"));
    expect(onChange).toHaveBeenLastCalledWith("codex", { automatic: false });
    await user.click(card("CODEX").getByLabelText("Ativo"));
    expect(onChange).toHaveBeenLastCalledWith("codex", { enabled: false });
    await user.selectOptions(card("CODEX").getByLabelText("Modelo padrão"), "m-a");
    expect(onChange).toHaveBeenLastCalledWith("codex", { defaultModel: "m-a" });
    const path = card("CODEX").getByLabelText("Caminho do executável");
    expect(card("CODEX").getByRole("button", { name: "Salvar caminho" })).toBeDisabled();
    await user.clear(path);
    await user.type(path, "C:\\novo\\codex.exe");
    await user.click(card("CODEX").getByRole("button", { name: "Salvar caminho" }));
    expect(onChange).toHaveBeenLastCalledWith("codex", { executablePath: "C:\\novo\\codex.exe" });
    await user.click(card("CODEX").getByRole("button", { name: "Usar detecção automática" }));
    expect(onChange).toHaveBeenLastCalledWith("codex", { executablePath: null });
  });

  it("locks the cards while a check is running", () => {
    const { card } = show([status("codex"), status("claude")], "codex");
    expect(card("CODEX").getByRole("button", { name: "Aguarde…" })).toBeDisabled();
    expect(card("CLAUDE").getByRole("button", { name: /Verificar conexão/ })).toBeDisabled();
  });
});
