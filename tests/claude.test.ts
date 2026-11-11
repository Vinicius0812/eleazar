import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ClaudeAdapter } from "../src/adapters/claude.js";
import { runProcess, type ProcessResult } from "../src/adapters/process-runner.js";
import type { AgentRunRequest } from "../src/core/contracts.js";

const request: AgentRunRequest = { cwd: process.cwd(), prompt: "Revise o trecho aprovado.", taskKind: "review" };
const missingExecutable = Object.assign(new Error("conteudo interno"), { code: "ENOENT" });

function result(values: Partial<ProcessResult> = {}): ProcessResult {
  return { exitCode: 0, stdout: "", stderr: "", durationMs: 8, timedOut: false, ...values };
}

describe("Claude Code adapter", () => {
  it("diagnostica sem expor dados da conta ou abrir uma sessao", async () => {
    const runner = vi.fn<typeof runProcess>()
      .mockResolvedValueOnce(result({ stdout: "2.1.314 (Claude Code)\n" }))
      .mockResolvedValueOnce(result({ stdout: JSON.stringify({ loggedIn: true, email: "privado@example.test", configDirectory: "/local/secreto" }) }));

    const health = await new ClaudeAdapter(runner).health();
    expect(health).toMatchObject({ provider: "claude", available: true, authenticated: true, version: "2.1.314" });
    expect(JSON.stringify(health)).not.toMatch(/privado|secreto/);
    expect(runner.mock.calls.map(([, args]) => args)).toEqual([
      ["--version"], ["--safe-mode", "--setting-sources", "", "auth", "status"]
    ]);
  });

  it("considera indisponiveis a CLI ausente e a autenticacao nao confirmada", async () => {
    const missing = vi.fn<typeof runProcess>().mockRejectedValue(missingExecutable);
    const malformed = vi.fn<typeof runProcess>()
      .mockResolvedValueOnce(result({ stdout: "2.1.314 (Claude Code)" }))
      .mockResolvedValueOnce(result({ stdout: "conteudo interno" }));

    expect(await new ClaudeAdapter(missing).health()).toMatchObject({ available: false, authenticated: null });
    const health = await new ClaudeAdapter(malformed).health();
    expect(health).toMatchObject({ available: true, authenticated: false });
    expect(JSON.stringify(health)).not.toContain("conteudo interno");
  });

  it.skipIf(process.platform !== "win32")("usa a instalacao nativa do usuario quando o PATH nao encontra a CLI", async () => {
    const runner = vi.fn<typeof runProcess>()
      .mockRejectedValueOnce(missingExecutable)
      .mockResolvedValueOnce(result({ stdout: "2.1.314 (Claude Code)" }))
      .mockResolvedValueOnce(result({ stdout: '{"loggedIn":true}' }));
    const native = join(homedir(), ".local", "bin", "claude.exe");

    await expect(new ClaudeAdapter(runner).health()).resolves.toMatchObject({
      available: true,
      authenticated: true,
      version: "2.1.314"
    });
    expect(runner.mock.calls.map(([binary, args]) => [binary, args])).toEqual([
      ["claude.exe", ["--version"]],
      [native, ["--version"]],
      [native, ["--safe-mode", "--setting-sources", "", "auth", "status"]]
    ]);
  });

  it.skipIf(process.platform !== "win32")("reusa o fallback nativo na execucao e preserva a entrada literal", async () => {
    const runner = vi.fn<typeof runProcess>()
      .mockRejectedValueOnce(missingExecutable)
      .mockResolvedValueOnce(result({ stdout: '{"type":"result","subtype":"success","is_error":false,"result":"Revisado."}' }));

    await expect(new ClaudeAdapter(runner).run(request)).resolves.toMatchObject({ status: "success", response: "Revisado." });
    expect(runner).toHaveBeenCalledTimes(2);
    const [binary, args, options] = runner.mock.calls[1]!;
    expect(binary).toBe(join(homedir(), ".local", "bin", "claude.exe"));
    expect(args).toEqual(runner.mock.calls[0]![1]);
    expect(options?.stdin).toBe(request.prompt);
  });

  it("distingue uma falha posterior de diagnostico de uma CLI ausente", async () => {
    const runner = vi.fn<typeof runProcess>()
      .mockResolvedValueOnce(result({ stdout: "2.1.314 (Claude Code)" }))
      .mockRejectedValueOnce(missingExecutable);

    await expect(new ClaudeAdapter(runner).health()).resolves.toMatchObject({
      detail: "Nao foi possivel diagnosticar o Claude Code."
    });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("envia o texto via stdin em diretorio temporario, desabilita ferramentas e retorna somente os campos da execucao", async () => {
    const runner = vi.fn<typeof runProcess>().mockResolvedValue(result({ stdout: JSON.stringify({
      type: "result", subtype: "success", is_error: false, result: "Revisão concluída.", session_id: "nao-retomavel",
      usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
    }) }));
    const prompt = `Revise o texto literal: "aspas", $env:TESTE, & echo marcador\nSegunda linha.`;
    const outcome = await new ClaudeAdapter(runner).run({ ...request, prompt, model: "sonnet[1m]" });
    const [binary, args, options] = runner.mock.calls[0]!;
    expect(binary).toBe(process.platform === "win32" ? "claude.exe" : "claude");
    expect(args).toEqual(expect.arrayContaining(["--safe-mode", "--strict-mcp-config", "--no-chrome", "--no-session-persistence", "--disable-slash-commands"]));
    for (const [flag, value] of [["--tools", ""], ["--disallowedTools", "mcp__*"], ["--mcp-config", '{"mcpServers":{}}'], ["--permission-mode", "dontAsk"], ["--max-turns", "1"]]) {
      expect(args[args.indexOf(flag!) + 1]).toBe(value);
    }
    expect(args).toContain("--model=sonnet[1m]");
    expect(args.join(" ")).not.toContain(prompt);
    expect(options?.stdin).toBe(prompt);
    expect(options?.cwd).not.toBe(request.cwd);
    await expect(access(options!.cwd!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(outcome).toEqual({
      provider: "claude", status: "success", response: "Revisão concluída.", durationMs: 8,
      usage: { input: 5, output: 3, cacheRead: 2, total: 11 }
    });
  });

  it("recusa sessao, tarefa de implementacao e modelo em formato de flag antes de iniciar o subprocesso", async () => {
    const runner = vi.fn<typeof runProcess>();
    const adapter = new ClaudeAdapter(runner);
    for (const values of [{ sessionId: "existing" }, { taskKind: "implementation" } as const, { model: "--dangerously-skip-permissions" }]) {
      await expect(adapter.run({ ...request, ...values })).resolves.toMatchObject({ status: "error", response: "" });
    }
    expect(runner).not.toHaveBeenCalled();
  });

  it("mantem falhas de processo e de protocolo genericas e sem tentativas alternativas", async () => {
    for (const failed of [
      result({ exitCode: 2, stderr: "credencial privada" }),
      result({ stdout: "credencial privada" }),
      result({ stdout: JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "credencial privada" }) }),
      result({ timedOut: true, stdout: "credencial privada" }),
    ]) {
      const runner = vi.fn<typeof runProcess>().mockResolvedValue(failed);
      const outcome = await new ClaudeAdapter(runner).run(request);
      expect(outcome).toMatchObject({ status: "error", response: "" });
      expect(JSON.stringify(outcome)).not.toContain("credencial privada");
      expect(runner).toHaveBeenCalledTimes(1);
    }
  });
});

it("returns a process failure when a subprocess exits early without reading stdin", async () => {
  const outcome = await runProcess(process.execPath, ["-e", "process.exit(2)"], {
    stdin: "entrada ".repeat(125_000),
    timeoutMs: 5_000
  });
  expect(outcome.exitCode).toBe(2);
});
